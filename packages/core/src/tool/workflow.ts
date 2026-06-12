export * as WorkflowTool from "./workflow"

import { Tool, ToolFailure, toolText } from "@gte-agent/llm"
import { Cause, Effect, Layer, Schema } from "effect"
import { SessionStore } from "../session/store"
import { WorkflowExecutor } from "../workflow/executor"
import { WorkflowRuntime } from "../workflow/runtime"
import { WorkflowSchema } from "../workflow/schema"
import { ToolRegistry } from "./registry"

export const name = "workflow"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({
    description: "Short kebab-case name for this run, e.g. 'cross-check-funding'",
  }),
  script: Schema.String.annotate({
    description:
      "JavaScript orchestration script: the body of an async function whose only bindings are the injected workflow API. Its resolved return value is the run result.",
  }),
  args: Schema.Unknown.pipe(Schema.optional).annotate({
    description: "Structured input exposed to the script as `args`",
  }),
  background: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Run in the background and return { runID, scriptPath } immediately; completion surfaces through the background job registry. Default false: the tool settles when the run finishes.",
  }),
})

const Success = Schema.Struct({
  runID: WorkflowSchema.RunID,
  scriptPath: Schema.String,
  status: WorkflowSchema.RunStatus.pipe(Schema.optional),
  result: Schema.String.pipe(Schema.optional),
  tokens: WorkflowSchema.Tokens.pipe(Schema.optional),
})

const modelOutput = (output: typeof Success.Encoded) => {
  if (output.status === undefined)
    return [
      `Workflow ${output.runID} is running in the background (script: ${output.scriptPath}).`,
      "Do not poll for it or duplicate its work; completion surfaces through the background job registry.",
    ].join("\n")
  const tokens = output.tokens ?? { input: 0, output: 0, reasoning: 0 }
  return [
    output.result || "(the workflow returned no result)",
    "",
    `Workflow ${output.runID} ${output.status}. Tokens: ${tokens.input} in / ${tokens.output} out. Script: ${output.scriptPath}`,
  ].join("\n")
}

const definition = Tool.make({
  description: [
    "Run a dynamic multi-agent workflow: submit a small JavaScript orchestration script and the runtime executes it in a sandboxed worker, spawning each requested agent as a real child session with this session's scope and authority.",
    "The script is the body of an async function; its only bindings are the injected API:",
    "- phase(name, fn): group agents for observation; phases cannot nest",
    "- agent({ prompt, type?, model?, variant? }): spawn one agent, resolves { text, tokens }; model is 'providerID/modelID' and an unavailable model/variant falls back to this session's model",
    "- map(items, fn, { concurrency? }): bounded fan-out over an array",
    "- log(message): emit a progress line",
    "- args: the structured invocation input",
    "The script only coordinates — it has no filesystem, network, or shell access; agents do all reading and acting. Make agent prompts self-contained. Scale fan-out to the task: agents cost real tokens.",
    `Caps: min(16, max(2, cores - 2)) concurrent agents, ${WorkflowRuntime.MAX_AGENTS_PER_RUN} agents per run. The script persists to disk and the path is returned.`,
  ].join("\n"),
  parameters: Parameters,
  success: Success,
  toModelOutput: ({ output }) => [toolText({ type: "text", text: modelOutput(output) })],
})

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    // Kill switch (flag or config): when disabled the tool is simply never
    // contributed, so the model does not see it and calls report unknown tool.
    if (!(yield* WorkflowRuntime.enabled)) return
    const registry = yield* ToolRegistry.Service
    const runtime = yield* WorkflowRuntime.Service
    const store = yield* SessionStore.Service

    yield* registry.contribute((editor) =>
      editor.set(name, {
        tool: definition,
        execute: ({ parameters, sessionID, assertPermission }) =>
          Effect.gen(function* () {
            yield* assertPermission({ action: name, resources: [parameters.name] })
            // Workflow agents are child sessions; letting them start runs of
            // their own would allow unbounded recursive fan-out.
            const session = yield* store.get(sessionID)
            if (session?.parentID !== undefined)
              return yield* new ToolFailure({ message: "Workflow agents cannot start nested workflows" })
            const started = yield* runtime.start({
              sessionID,
              name: parameters.name,
              script: parameters.script,
              ...(parameters.args === undefined ? {} : { args: parameters.args }),
            })
            if (parameters.background) return { runID: started.id, scriptPath: started.scriptPath }
            const finished = yield* runtime.wait(started.id)
            if (finished === undefined || finished.status !== "completed")
              return yield* new ToolFailure({
                message: finished?.error ?? `Workflow ${finished?.status ?? "failed"}`,
              })
            return {
              runID: finished.id,
              scriptPath: finished.scriptPath,
              status: finished.status,
              result: finished.result ?? "",
              tokens: finished.tokens,
            }
          }).pipe(
            Effect.catchTag("WorkflowScript.InvalidScriptError", (error) =>
              Effect.fail(new ToolFailure({ message: error.reason })),
            ),
            Effect.catchCause((cause) => {
              const error = Cause.squash(cause)
              if (error instanceof ToolFailure) return Effect.fail(error)
              return Effect.fail(
                new ToolFailure({
                  message: `Unable to run workflow: ${WorkflowExecutor.describeFailure(error)}`,
                  error,
                }),
              )
            }),
          ),
      }),
    )
  }),
)
