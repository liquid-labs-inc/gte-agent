/**
 * Fix-list item 1: the workflow tool must reach the model through the
 * production tool registry. The merged core registered it only into
 * `BuiltInTools.runtimeScopeLayer`, which the server never composes — the
 * runner builds its registry from `ToolRegistry.layer + ApplicationTools +
 * GteTools` (see ../src/handlers.ts). This test composes the registry the same
 * way the server handlers do and asserts the `workflow` tool is contributed
 * exactly when the kill switch allows it.
 */
// Hermetic env bootstrap MUST precede any @gte-agent/core import.
import "./httpapi-exercise/setup"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Scope } from "effect"
import { BackgroundJob } from "@gte-agent/core/background-job"
import { Config } from "@gte-agent/core/config"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { Global } from "@gte-agent/core/global"
import { Permission } from "@gte-agent/core/permission"
import { SessionStore } from "@gte-agent/core/session/store"
import { ApplicationTools } from "@gte-agent/core/tool/application-tools"
import { ToolRegistry } from "@gte-agent/core/tool/registry"
import { WorkflowTool } from "@gte-agent/core/tool/workflow"
import { WorkflowExecutor } from "@gte-agent/core/workflow/executor"
import { WorkflowRuntime } from "@gte-agent/core/workflow/runtime"

const permission = Layer.mock(Permission.Service, { assert: () => Effect.void })

const configWith = (info: Config.Info) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({ entries: () => Effect.succeed([new Config.Document({ type: "document", info })]) }),
  )

const echo: WorkflowExecutor.Interface["execute"] = (request) =>
  Effect.succeed({ text: `${request.prompt}:ok`, tokens: { input: 0, output: 0, reasoning: 0 } })

/**
 * The same shape the server handlers compose: `ToolRegistry.layer` over the
 * allow-all permission stub, with `WorkflowTool.layer` provided its runtime,
 * background-job registry, session store, and config. Layers are built per call
 * because the kill-switch flag is read from the environment at build time.
 */
const registryDefinitions = (config: Config.Info) =>
  Effect.gen(function* () {
    const database = Database.layerFromPath(":memory:")
    const events = Event.layer.pipe(Layer.provide(database))
    const registry = ToolRegistry.layer.pipe(Layer.provide(permission), Layer.provide(ApplicationTools.layer))
    const runtime = WorkflowRuntime.layerWith({ snapshotTickMs: 20 }).pipe(
      Layer.provide(events),
      Layer.provide(Global.defaultLayer),
      Layer.provide(Layer.succeed(WorkflowExecutor.Service, WorkflowExecutor.Service.of({ execute: echo }))),
    )
    const tool = WorkflowTool.layer.pipe(
      Layer.provide(registry),
      Layer.provide(runtime),
      Layer.provide(BackgroundJob.layer),
      Layer.provide(Layer.mock(SessionStore.Service, { get: () => Effect.succeed(undefined) })),
      Layer.provide(configWith(config)),
    )
    return yield* Effect.gen(function* () {
      const resolved = yield* ToolRegistry.Service
      return (yield* resolved.definitions()).map((definition) => definition.name)
    }).pipe(Effect.provide(Layer.mergeAll(registry, tool)))
  })

const withFlag = <A, E, R>(value: string | undefined, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const saved = process.env.GTE_AGENT_DISABLE_WORKFLOWS
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (saved === undefined) delete process.env.GTE_AGENT_DISABLE_WORKFLOWS
        else process.env.GTE_AGENT_DISABLE_WORKFLOWS = saved
      }),
    )
    if (value === undefined) delete process.env.GTE_AGENT_DISABLE_WORKFLOWS
    else process.env.GTE_AGENT_DISABLE_WORKFLOWS = value
    return yield* body
  })

const run = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(body.pipe(Effect.scoped))

describe("workflow tool in the production registry", () => {
  test("is contributed when the flag is unset and config does not disable it", async () => {
    const names = await run(withFlag(undefined, registryDefinitions(Config.Info.make({}))))
    expect(names).toContain("workflow")
  })

  test("GTE_AGENT_DISABLE_WORKFLOWS=1 keeps it out of the registry", async () => {
    const names = await run(withFlag("1", registryDefinitions(Config.Info.make({}))))
    expect(names).not.toContain("workflow")
  })

  test("workflows.enabled: false keeps it out of the registry", async () => {
    const names = await run(
      withFlag(undefined, registryDefinitions(Config.Info.make({ workflows: { enabled: false } }))),
    )
    expect(names).not.toContain("workflow")
  })
})
