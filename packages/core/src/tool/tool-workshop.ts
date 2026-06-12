export * as ToolWorkshopTool from "./tool-workshop"

import { Tool, ToolFailure, toolText } from "@gte-agent/llm"
import { Cause, Effect, Layer, Schema } from "effect"
import { DynamicToolRuntime } from "../dynamic-tool/runtime"
import { DynamicToolSaved } from "../dynamic-tool/saved"
import { DynamicToolSchema } from "../dynamic-tool/schema"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { SessionStore } from "../session/store"
import { ToolRegistry } from "./registry"

export const name = "tool_workshop"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "remove", "list"]).annotate({
    description: "create (or overwrite) a dynamic tool, remove one, or list every dynamic tool",
  }),
  name: Schema.String.pipe(Schema.optional).annotate({
    description: "Tool name for create/remove: lowercase snake_case, e.g. 'funding_spread'",
  }),
  description: Schema.String.pipe(Schema.optional).annotate({
    description: "For create: what the tool does and when to call it — this becomes the tool's model-facing description",
  }),
  parameters: Schema.Record(Schema.String, DynamicToolSchema.ParameterSpec)
    .pipe(Schema.optional)
    .annotate({
      description:
        "For create: the tool's input parameters as { name: { type: 'string' | 'number' | 'boolean', description?, enum?, required? } }; required defaults to true",
    }),
  code: Schema.String.pipe(Schema.optional).annotate({
    description:
      "For create: the body of an async JavaScript function. In scope: `params` (the decoded call arguments) and `gte(name, args)` (await it; calls a read-only gte_* data tool and resolves with its result). The resolved return value is the tool result.",
  }),
})

const ToolInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  scope: Schema.Literals(["global", "project"]),
  file: Schema.String,
})

const Success = Schema.Struct({
  message: Schema.String,
  tools: Schema.Array(ToolInfo),
})

const definition = Tool.make({
  description: [
    "Author, remove, or list this agent's self-authored tools. A created tool persists to ~/.gte-agent/tools/<name>.json, registers immediately, and is callable on your next turn.",
    "Tool code is the body of an async function with exactly two bindings:",
    "- params: the decoded call arguments, shaped by the parameters schema you declare",
    "- gte(name, args): await one read-only gte_* data tool (the same tools you can call directly) and resolve with its result",
    `Code runs in a sandbox with no filesystem, network, or shell access, capped at ${DynamicToolRuntime.MAX_GTE_CALLS} gte() calls and ${DynamicToolRuntime.TIMEOUT_MS / 1000}s per invocation. The return value must be JSON-serializable.`,
    "Create a tool when a multi-step data composition is worth reusing across turns or sessions; prefer calling the gte_* tools directly for one-off lookups.",
  ].join("\n"),
  parameters: Parameters,
  success: Success,
  toModelOutput: ({ output }) => [
    toolText({
      type: "text",
      text: [
        output.message,
        ...output.tools.map((tool) => `- ${tool.name} (${tool.scope}): ${tool.description}`),
      ].join("\n"),
    }),
  ],
})

const render = (value: unknown) => {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2) ?? String(value)
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    // Kill switch (flag or config): when disabled the workshop is never
    // contributed and saved tools stay dormant on disk.
    if (!(yield* DynamicToolRuntime.enabled)) return
    const registry = yield* ToolRegistry.Service
    const runtime = yield* DynamicToolRuntime.Service
    const store = yield* SessionStore.Service
    // Persistence runs inside execute handlers, whose Entry signature has no
    // requirements channel; the layer's context supplies FSUtil and Global.
    const context = yield* Effect.context<FSUtil.Service | Global.Service>()

    // The workshop owns one scoped registry slot: every apply() replaces the
    // slot's transform with the full current contribution (workshop + every
    // dynamic tool), so removals fall out of the replay naturally and other
    // contributors' entries are never touched.
    const update = yield* registry.transform()
    const dynamic = new Map<string, DynamicToolSaved.Saved>()

    const entry = (saved: DynamicToolSaved.Saved): ToolRegistry.Entry => ({
      tool: Tool.make({
        description: saved.definition.description,
        jsonSchema: DynamicToolSchema.toJsonSchema(saved.definition.parameters),
        toModelOutput: ({ output }) => [toolText({ type: "text", text: render(output) })],
      }),
      execute: ({ parameters, sessionID, assertPermission }) =>
        Effect.gen(function* () {
          yield* assertPermission({ action: saved.definition.name, resources: [saved.definition.name] })
          return yield* runtime.execute({
            sessionID,
            name: saved.definition.name,
            code: saved.definition.code,
            params: parameters,
          })
        }).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause)
            if (error instanceof ToolFailure) return Effect.fail(error)
            return Effect.fail(
              new ToolFailure({ message: `Unable to run ${saved.definition.name}`, error }),
            )
          }),
        ),
    })

    const apply = () =>
      update((editor) => {
        editor.set(name, { tool: definition, execute })
        for (const saved of dynamic.values()) editor.set(saved.definition.name, entry(saved))
      })

    const listed = () => ({
      tools: [...dynamic.values()]
        .toSorted((a, b) => a.definition.name.localeCompare(b.definition.name))
        .map((saved) => ({
          name: saved.definition.name,
          description: saved.definition.description,
          scope: saved.scope,
          file: saved.file,
        })),
    })

    const execute: ToolRegistry.Entry<typeof Parameters, typeof Success>["execute"] = ({
      parameters,
      sessionID,
      assertPermission,
    }) =>
      Effect.gen(function* () {
        if (parameters.action === "list")
          return { message: dynamic.size === 0 ? "No dynamic tools yet." : "Dynamic tools:", ...listed() }
        // Workflow agents are child sessions; the shared registry must not be
        // mutated from fan-out work (the nested-workflow guard, same reason).
        const session = yield* store.get(sessionID)
        if (session?.parentID !== undefined)
          return yield* new ToolFailure({ message: "Workflow agents cannot create or remove tools" })
        const toolName = parameters.name?.trim()
        if (!toolName) return yield* new ToolFailure({ message: `${parameters.action} requires a tool name` })
        yield* assertPermission({ action: name, resources: [toolName], metadata: { action: parameters.action } })

        if (parameters.action === "remove") {
          const saved = dynamic.get(toolName)
          if (!saved) return yield* new ToolFailure({ message: `No dynamic tool named ${toolName}` })
          if (saved.scope === "project")
            return yield* new ToolFailure({
              message: `${toolName} is a project file (${saved.file}); remove it from the repository instead`,
            })
          yield* DynamicToolSaved.remove(toolName).pipe(Effect.provide(context))
          dynamic.delete(toolName)
          yield* apply()
          return { message: `Removed ${toolName}.`, ...listed() }
        }

        if (!DynamicToolSchema.validName(toolName))
          return yield* new ToolFailure({
            message: "Tool names must be lowercase snake_case (max 64 chars), and gte_ is reserved for shipped tools",
          })
        const description = parameters.description?.trim()
        if (!description) return yield* new ToolFailure({ message: "create requires a description" })
        if (!parameters.code?.trim()) return yield* new ToolFailure({ message: "create requires code" })
        const invalid = DynamicToolSchema.validateCode(parameters.code)
        if (invalid !== undefined) return yield* new ToolFailure({ message: invalid.reason })
        // A dynamic tool may overwrite itself, never a shipped or application
        // tool: those own their names (registry precedence notwithstanding,
        // shadowing would only confuse the model).
        const taken = (yield* registry.definitions()).some((existing) => existing.name === toolName)
        if (taken && !dynamic.has(toolName))
          return yield* new ToolFailure({ message: `A tool named ${toolName} already exists` })
        const saved = yield* DynamicToolSaved.save({
          name: toolName,
          description,
          parameters: parameters.parameters ?? {},
          code: parameters.code,
        }).pipe(Effect.provide(context))
        dynamic.set(toolName, saved)
        yield* apply()
        return {
          message: `Created ${toolName} (${saved.file}). It is callable as ${toolName} from your next turn.`,
          ...listed(),
        }
      }).pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause)
          if (error instanceof ToolFailure) return Effect.fail(error)
          return Effect.fail(new ToolFailure({ message: "Unable to update the tool workshop", error }))
        }),
      )

    // Boot: re-discover saved definitions and contribute them with the
    // workshop in one transform. Invalid files were already skip-warned.
    for (const saved of yield* DynamicToolSaved.discover()) dynamic.set(saved.definition.name, saved)
    yield* apply()
  }),
)
