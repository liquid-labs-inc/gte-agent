/**
 * Milestone 9: the tool workshop must reach the model through the production
 * tool registry, gated on its kill switch — the same wiring law the workflow
 * tool and the web tools are pinned to. This test composes the registry the
 * way the server handlers do (see ../src/handlers.ts `toolWorkshop`) and
 * asserts the workshop is contributed exactly when the kill switch allows it.
 */
// Hermetic env bootstrap MUST precede any @gte-agent/core import.
import "./httpapi-exercise/setup"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Scope } from "effect"
import { Config } from "@gte-agent/core/config"
import { DynamicToolRuntime } from "@gte-agent/core/dynamic-tool/runtime"
import { FSUtil } from "@gte-agent/core/fs-util"
import { Global } from "@gte-agent/core/global"
import { Permission } from "@gte-agent/core/permission"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { SessionStore } from "@gte-agent/core/session/store"
import { ApplicationTools } from "@gte-agent/core/tool/application-tools"
import { ToolRegistry } from "@gte-agent/core/tool/registry"
import { ToolWorkshopTool } from "@gte-agent/core/tool/tool-workshop"

const permission = Layer.mock(Permission.Service, { assert: () => Effect.void })

const configWith = (info: Config.Info) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({ entries: () => Effect.succeed([new Config.Document({ type: "document", info })]) }),
  )

/**
 * The same shape the server handlers compose. Layers are built per call
 * because the kill-switch flag is read from the environment at build time.
 */
const registryDefinitions = (config: Config.Info) =>
  Effect.gen(function* () {
    const registry = ToolRegistry.layer.pipe(Layer.provide(permission), Layer.provide(ApplicationTools.layer))
    const tool = ToolWorkshopTool.layer.pipe(
      Layer.provide(registry),
      Layer.provide(DynamicToolRuntime.layer.pipe(Layer.provide(registry))),
      Layer.provide(Layer.mock(SessionStore.Service, { get: () => Effect.succeed(undefined) })),
      Layer.provide(configWith(config)),
      Layer.provide(
        Layer.succeed(
          RuntimeScope.Service,
          RuntimeScope.Service.of(RuntimeScope.fromRef({ directory: AbsolutePath.make(process.cwd()) })),
        ),
      ),
      Layer.provide(FSUtil.defaultLayer),
      Layer.provide(Global.defaultLayer),
    )
    return yield* Effect.gen(function* () {
      const resolved = yield* ToolRegistry.Service
      return (yield* resolved.definitions()).map((definition) => definition.name)
    }).pipe(Effect.provide(Layer.mergeAll(registry, tool)))
  })

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

const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(body.pipe(Effect.scoped))

describe("tool workshop in the production registry", () => {
  test("is contributed when the flag is unset and config does not disable it", async () => {
    const names = await run(withFlag(undefined, registryDefinitions(Config.Info.make({}))))
    expect(names).toContain("tool_workshop")
  })

  test("GTE_AGENT_DISABLE_DYNAMIC_TOOLS=1 keeps it out of the registry", async () => {
    const names = await run(withFlag("1", registryDefinitions(Config.Info.make({}))))
    expect(names).not.toContain("tool_workshop")
  })

  test("dynamicTools.enabled: false keeps it out of the registry", async () => {
    const names = await run(
      withFlag(undefined, registryDefinitions(Config.Info.make({ dynamicTools: { enabled: false } }))),
    )
    expect(names).not.toContain("tool_workshop")
  })
})
