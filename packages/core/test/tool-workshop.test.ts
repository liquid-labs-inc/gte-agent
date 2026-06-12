import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import type { ToolCall, ToolResultValue } from "@gte-agent/llm"
import { Config } from "@gte-agent/core/config"
import { DynamicToolRuntime } from "@gte-agent/core/dynamic-tool/runtime"
import { DynamicToolSaved } from "@gte-agent/core/dynamic-tool/saved"
import { FSUtil } from "@gte-agent/core/fs-util"
import { Global } from "@gte-agent/core/global"
import { Permission } from "@gte-agent/core/permission"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { SessionSchema } from "@gte-agent/core/session/schema"
import { SessionStore } from "@gte-agent/core/session/store"
import { ApplicationTools } from "@gte-agent/core/tool/application-tools"
import { ToolRegistry } from "@gte-agent/core/tool/registry"
import { ToolWorkshopTool } from "@gte-agent/core/tool/tool-workshop"
import { runtimeScope } from "./fixture/runtime-scope"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_tool_workshop")
const childSessionID = SessionSchema.ID.make("ses_tool_workshop_child")

const permission = Layer.mock(Permission.Service, { assert: () => Effect.void })

const configWith = (info: Config.Info) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({ entries: () => Effect.succeed([new Config.Document({ type: "document", info })]) }),
  )

const sessionStore = Layer.mock(SessionStore.Service, {
  get: (id: SessionSchema.ID) =>
    Effect.succeed(
      id === childSessionID
        ? ({ id, parentID: sessionID } as unknown as SessionSchema.Info)
        : ({ id } as unknown as SessionSchema.Info),
    ),
})

type Dirs = { home: string; project: string }

/**
 * The same shape the server handlers compose, over throwaway home/project
 * directories. Layers are built per call so a test can "reboot" by providing a
 * fresh composition over the same directories, and because the kill-switch
 * flag is read from the environment when the tool layer is built.
 */
const layers = (dirs: Dirs, config: Config.Info = Config.Info.make({})) => {
  const registry = ToolRegistry.layer.pipe(Layer.provide(permission), Layer.provide(ApplicationTools.layer))
  const tool = ToolWorkshopTool.layer.pipe(
    Layer.provide(registry),
    Layer.provide(DynamicToolRuntime.layerWith({ timeoutMs: 10_000 }).pipe(Layer.provide(registry))),
    Layer.provide(sessionStore),
    Layer.provide(configWith(config)),
    Layer.provide(
      Layer.succeed(
        RuntimeScope.Service,
        RuntimeScope.Service.of(
          runtimeScope(
            { directory: AbsolutePath.make(dirs.project) },
            { projectDirectory: AbsolutePath.make(dirs.project) },
          ),
        ),
      ),
    ),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Global.layerWith({ home: dirs.home })),
  )
  return Layer.mergeAll(registry, tool)
}

const withDirs = <A, E>(use: (dirs: Dirs) => Effect.Effect<A, E, never>) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    const home = path.join(tmp.path, "home")
    const project = path.join(tmp.path, "project")
    yield* Effect.promise(() => fs.mkdir(home, { recursive: true }))
    yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))
    return yield* use({ home, project })
  })

const call = (input: Record<string, unknown>, id = "call-workshop"): ToolCall => ({
  type: "tool-call",
  id,
  name: "tool_workshop",
  input,
})

const text = (result: ToolResultValue): string => {
  expect(result.type).toBe("text")
  return String((result as { value: unknown }).value)
}

const errorText = (result: ToolResultValue): string => {
  expect(result.type).toBe("error")
  return String((result as { value: unknown }).value)
}

const toolNames = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  return (yield* registry.definitions()).map((definition) => definition.name)
})

const CREATE = {
  action: "create",
  name: "double_number",
  description: "Doubles a number",
  parameters: { value: { type: "number", description: "The number to double" } },
  code: "return params.value * 2",
}

const withFlag = <A, E, R>(value: string | undefined, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const saved = process.env.GTE_AGENT_DISABLE_DYNAMIC_TOOLS
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (saved === undefined) delete process.env.GTE_AGENT_DISABLE_DYNAMIC_TOOLS
        else process.env.GTE_AGENT_DISABLE_DYNAMIC_TOOLS = saved
      }),
    )
    if (value === undefined) delete process.env.GTE_AGENT_DISABLE_DYNAMIC_TOOLS
    else process.env.GTE_AGENT_DISABLE_DYNAMIC_TOOLS = value
    return yield* body
  })

describe("ToolWorkshopTool registration", () => {
  it.effect("contributes the workshop when the flag and config allow it", () =>
    withFlag(
      undefined,
      withDirs((dirs) => toolNames.pipe(Effect.provide(layers(dirs)))).pipe(
        Effect.map((names) => expect(names).toContain("tool_workshop")),
      ),
    ),
  )

  it.effect("GTE_AGENT_DISABLE_DYNAMIC_TOOLS=1 hides the workshop", () =>
    withFlag(
      "1",
      withDirs((dirs) => toolNames.pipe(Effect.provide(layers(dirs)))).pipe(
        Effect.map((names) => expect(names).not.toContain("tool_workshop")),
      ),
    ),
  )

  it.effect("dynamicTools.enabled: false in config hides the workshop", () =>
    withFlag(
      undefined,
      withDirs((dirs) =>
        toolNames.pipe(Effect.provide(layers(dirs, Config.Info.make({ dynamicTools: { enabled: false } })))),
      ).pipe(Effect.map((names) => expect(names).not.toContain("tool_workshop"))),
    ),
  )
})

describe("ToolWorkshopTool create", () => {
  it.live("registers the tool, persists it globally, and makes it callable", () =>
    withDirs((dirs) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const created = yield* registry.execute({ sessionID, call: call(CREATE) })
        expect(text(created)).toContain("Created double_number")

        expect(yield* toolNames).toContain("double_number")
        const file = path.join(dirs.home, DynamicToolSaved.DIRECTORY, "double_number.json")
        expect(JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8"))).name).toBe("double_number")

        const run = yield* registry.execute({
          sessionID,
          call: { type: "tool-call", id: "call-created", name: "double_number", input: { value: 21 } },
        })
        expect(text(run)).toBe("42")
      }).pipe(Effect.provide(layers(dirs))),
    ),
  )

  it.live("created tools survive a reboot through saved-definition discovery", () =>
    withDirs((dirs) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          yield* registry.execute({ sessionID, call: call(CREATE) })
        }).pipe(Effect.provide(layers(dirs)))
        // Fresh composition over the same directories = process restart.
        const names = yield* toolNames.pipe(Effect.provide(layers(dirs)))
        expect(names).toContain("double_number")
      }),
    ),
  )

  it.live("rejects invalid names, missing fields, invalid code, and taken names", () =>
    withDirs((dirs) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const created = (input: Record<string, unknown>) => registry.execute({ sessionID, call: call(input) })

        expect(errorText(yield* created({ ...CREATE, name: "Bad-Name" }))).toContain("lowercase snake_case")
        expect(errorText(yield* created({ ...CREATE, name: "gte_fake" }))).toContain("gte_ is reserved")
        expect(errorText(yield* created({ ...CREATE, name: undefined }))).toContain("requires a tool name")
        expect(errorText(yield* created({ ...CREATE, description: " " }))).toContain("requires a description")
        expect(errorText(yield* created({ ...CREATE, code: "eval('1')" }))).toContain("cannot use eval")
        expect(errorText(yield* created({ ...CREATE, name: "tool_workshop" }))).toContain("already exists")
      }).pipe(Effect.provide(layers(dirs))),
    ),
  )

  it.live("a dynamic tool may overwrite itself", () =>
    withDirs((dirs) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        yield* registry.execute({ sessionID, call: call(CREATE) })
        const updated = yield* registry.execute({
          sessionID,
          call: call({ ...CREATE, code: "return params.value * 3" }),
        })
        expect(text(updated)).toContain("Created double_number")
        const run = yield* registry.execute({
          sessionID,
          call: { type: "tool-call", id: "call-updated", name: "double_number", input: { value: 10 } },
        })
        expect(text(run)).toBe("30")
      }).pipe(Effect.provide(layers(dirs))),
    ),
  )

  it.live("workflow agents (child sessions) cannot create or remove tools", () =>
    withDirs((dirs) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const denied = yield* registry.execute({ sessionID: childSessionID, call: call(CREATE) })
        expect(errorText(denied)).toContain("Workflow agents cannot create or remove tools")
      }).pipe(Effect.provide(layers(dirs))),
    ),
  )
})

describe("ToolWorkshopTool remove and list", () => {
  it.live("remove deletes the registry entry and the global file", () =>
    withDirs((dirs) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        yield* registry.execute({ sessionID, call: call(CREATE) })
        const removed = yield* registry.execute({
          sessionID,
          call: call({ action: "remove", name: "double_number" }),
        })
        expect(text(removed)).toContain("Removed double_number")
        expect(yield* toolNames).not.toContain("double_number")
        const file = path.join(dirs.home, DynamicToolSaved.DIRECTORY, "double_number.json")
        expect(yield* Effect.promise(() => Bun.file(file).exists())).toBe(false)
      }).pipe(Effect.provide(layers(dirs))),
    ),
  )

  it.live("refuses to remove a repo-owned project tool", () =>
    withDirs((dirs) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(dirs.project, DynamicToolSaved.DIRECTORY), { recursive: true })
          await fs.writeFile(
            path.join(dirs.project, DynamicToolSaved.DIRECTORY, "repo_tool.json"),
            JSON.stringify({ name: "repo_tool", description: "from repo", parameters: {}, code: "return 1" }),
          )
        })
        yield* Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          expect(yield* toolNames).toContain("repo_tool")
          const refused = yield* registry.execute({
            sessionID,
            call: call({ action: "remove", name: "repo_tool" }),
          })
          expect(errorText(refused)).toContain("project file")
        }).pipe(Effect.provide(layers(dirs)))
      }),
    ),
  )

  it.live("list reports every dynamic tool with its scope", () =>
    withDirs((dirs) =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const empty = yield* registry.execute({ sessionID, call: call({ action: "list" }) })
        expect(text(empty)).toContain("No dynamic tools yet")
        yield* registry.execute({ sessionID, call: call(CREATE) })
        const listed = yield* registry.execute({ sessionID, call: call({ action: "list" }) })
        expect(text(listed)).toContain("double_number (global): Doubles a number")
      }).pipe(Effect.provide(layers(dirs))),
    ),
  )
})
