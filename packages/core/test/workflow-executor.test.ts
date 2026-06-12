import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { BackgroundJob } from "@gte-agent/core/background-job"
import { Catalog } from "@gte-agent/core/catalog"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { FSUtil } from "@gte-agent/core/fs-util"
import { Global } from "@gte-agent/core/global"
import { Model } from "@gte-agent/core/model"
import { Permission } from "@gte-agent/core/permission"
import { Project } from "@gte-agent/core/project"
import { Provider } from "@gte-agent/core/provider"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { Session } from "@gte-agent/core/session"
import { SessionExecution } from "@gte-agent/core/session/execution"
import { SessionProjector } from "@gte-agent/core/session/projector"
import { SessionRunCoordinator } from "@gte-agent/core/session/run-coordinator"
import { SessionRunnerDefault } from "@gte-agent/core/session/runner/default"
import { SessionStore } from "@gte-agent/core/session/store"
import { SystemContextRegistry } from "@gte-agent/core/system-context-registry"
import { ApplicationTools } from "@gte-agent/core/tool/application-tools"
import { ToolRegistry } from "@gte-agent/core/tool/registry"
import { WorkflowExecutor } from "@gte-agent/core/workflow/executor"
import { WorkflowRuntime } from "@gte-agent/core/workflow/runtime"
import { WorkflowSchema } from "@gte-agent/core/workflow/schema"
import { runtimeScope } from "./fixture/runtime-scope"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

/**
 * Real agent execution through child sessions, against the deterministic demo
 * runner (GTE_AGENT_LLM=demo): every agent is a real Session.create + prompt +
 * drain to settlement through the run coordinator, and the demo client streams
 * "GTE Agent demo response." with 4 output tokens.
 */

const scopeRef = RuntimeScope.Ref.make({ directory: AbsolutePath.make("/project") })
const runtimeScopeFixture = Layer.succeed(RuntimeScope.Service, RuntimeScope.Service.of(runtimeScope(scopeRef)))

const stack = (home: string) => {
  const database = Database.layerFromPath(":memory:")
  const events = Event.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const projects = Layer.succeed(
    Project.Service,
    Project.Service.of({
      resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
      directories: () => Effect.succeed([]),
      commit: () => Effect.void,
    }),
  )
  const permission = Layer.mock(Permission.Service, { assert: () => Effect.void })
  const registry = ToolRegistry.layer.pipe(Layer.provide(permission), Layer.provide(ApplicationTools.layer))
  const catalog = Catalog.runtimeScopeLayer.pipe(Layer.provideMerge(events), Layer.provideMerge(runtimeScopeFixture))
  const global = Global.layerWith({ home, data: home })
  const runner = SessionRunnerDefault.layer.pipe(
    Layer.provide(Layer.mergeAll(database, events, store, registry, catalog, SystemContextRegistry.layer)),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(global),
  )
  const coordinator = SessionRunCoordinator.layer.pipe(Layer.provide(runner))
  const execution = Layer.effect(
    SessionExecution.Service,
    SessionRunCoordinator.Service.pipe(
      Effect.map((coordinator) => SessionExecution.Service.of({ resume: coordinator.run, wake: coordinator.wake })),
    ),
  ).pipe(Layer.provide(coordinator))
  const sessions = Session.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(projects),
    Layer.provide(execution),
  )
  const executor = WorkflowExecutor.layer.pipe(Layer.provide(sessions), Layer.provide(catalog))
  const runtime = WorkflowRuntime.layerWith({ snapshotTickMs: 20 }).pipe(
    Layer.provide(events),
    Layer.provide(global),
    Layer.provide(BackgroundJob.layer),
    Layer.provide(executor),
  )
  return Layer.mergeAll(database, events, projector, store, sessions, executor, runtime)
}

type Services =
  | Session.Service
  | SessionStore.Service
  | Event.Service
  | WorkflowExecutor.Service
  | WorkflowRuntime.Service

const withDemo = <A, E>(body: Effect.Effect<A, E, Services>) =>
  Effect.gen(function* () {
    const saved = process.env.GTE_AGENT_LLM
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (saved === undefined) delete process.env.GTE_AGENT_LLM
        else process.env.GTE_AGENT_LLM = saved
      }),
    )
    process.env.GTE_AGENT_LLM = "demo"
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    return yield* body.pipe(Effect.provide(stack(tmp.path)))
  })

const createParent = (model?: Model.Ref) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return yield* sessions.create({ runtimeScope: scopeRef, ...(model === undefined ? {} : { model }) })
  })

const fable = {
  id: Model.ID.make("claude-fable-5"),
  providerID: Provider.ID.anthropic,
}

const childOf = (sessionID: Session.ID | undefined) =>
  Effect.gen(function* () {
    expect(sessionID).toBeDefined()
    const store = yield* SessionStore.Service
    return yield* store.get(sessionID ?? Session.ID.make("ses_missing"))
  })

describe("WorkflowExecutor", () => {
  it.effect("executes one agent as a real child session with the parent's scope and authority", () =>
    withDemo(
      Effect.gen(function* () {
        const parent = yield* createParent()
        const executor = yield* WorkflowExecutor.Service
        const result = yield* executor.execute({
          sessionID: parent.id,
          runID: WorkflowSchema.RunID.create(),
          agentID: "a1",
          phase: "main",
          prompt: "Summarize the funding landscape",
        })
        expect(result.text).toBe("GTE Agent demo response.")
        expect(result.tokens).toEqual({ input: 0, output: 4, reasoning: 0 })
        const child = yield* childOf(result.sessionID)
        expect(child?.parentID).toBe(parent.id)
        expect(child?.authorityID).toBe(parent.authorityID)
        expect(child?.runtimeScope.directory).toBe(parent.runtimeScope.directory)
      }),
    ),
  )

  it.effect("an unavailable model override falls back to the parent session's model, visibly", () =>
    withDemo(
      Effect.gen(function* () {
        const parent = yield* createParent(fable)
        const executor = yield* WorkflowExecutor.Service
        const result = yield* executor.execute({
          sessionID: parent.id,
          runID: WorkflowSchema.RunID.create(),
          agentID: "a1",
          phase: "main",
          prompt: "Cross-check the claims",
          model: "missing/missing-model",
        })
        expect(result.model).toBe("anthropic/claude-fable-5")
        expect(result.fallback).toContain("missing/missing-model is unavailable")
        const child = yield* childOf(result.sessionID)
        expect(child?.model).toMatchObject({ id: "claude-fable-5", providerID: "anthropic" })
      }),
    ),
  )

  it.effect("a catalog model/variant override flows through to the child session", () =>
    withDemo(
      Effect.gen(function* () {
        const parent = yield* createParent()
        const executor = yield* WorkflowExecutor.Service
        const result = yield* executor.execute({
          sessionID: parent.id,
          runID: WorkflowSchema.RunID.create(),
          agentID: "a1",
          phase: "main",
          prompt: "Audit the orderbook depth",
          model: "anthropic/claude-fable-5",
          variant: "xhigh",
        })
        expect(result.model).toBe("anthropic/claude-fable-5")
        expect(result.variant).toBe("xhigh")
        expect(result.fallback).toBeUndefined()
        const child = yield* childOf(result.sessionID)
        expect(child?.model).toMatchObject({ id: "claude-fable-5", providerID: "anthropic", variant: "xhigh" })
      }),
    ),
  )

  it.effect("an unavailable variant override falls back to the parent session's model, visibly", () =>
    withDemo(
      Effect.gen(function* () {
        const parent = yield* createParent(fable)
        const executor = yield* WorkflowExecutor.Service
        const result = yield* executor.execute({
          sessionID: parent.id,
          runID: WorkflowSchema.RunID.create(),
          agentID: "a1",
          phase: "main",
          prompt: "Cross-check the claims",
          model: "anthropic/claude-fable-5",
          variant: "no-such-variant",
        })
        expect(result.model).toBe("anthropic/claude-fable-5")
        // The parent ref carries the "default" variant sentinel (session/info fromRow).
        expect(result.variant).toBe("default")
        expect(result.fallback).toContain('variant "no-such-variant" is unavailable')
      }),
    ),
  )

  it.effect("a two-phase workflow runs end to end through the runtime against the demo runner", () =>
    withDemo(
      Effect.gen(function* () {
        const parent = yield* createParent()
        const sessions = yield* Session.Service
        const runtime = yield* WorkflowRuntime.Service
        const started = yield* runtime.start({
          sessionID: parent.id,
          name: "two-phase",
          script: [
            'const research = await phase("research", () =>',
            '  map(args.angles, (angle) => agent({ prompt: "Research " + angle })),',
            ")",
            'log("research done: " + research.length)',
            'const summary = await phase("synthesize", () =>',
            '  agent({ prompt: "Synthesize " + research.map((item) => item.text).join(" | ") }),',
            ")",
            "return summary.text",
          ].join("\n"),
          args: { angles: ["funding", "liquidity", "volume"] },
        })
        const finished = yield* runtime.wait(started.id)
        expect(finished?.status).toBe("completed")
        expect(finished?.result).toBe("GTE Agent demo response.")
        expect(finished?.phases).toMatchObject([
          { name: "research", status: "completed", agents: 3 },
          { name: "synthesize", status: "completed", agents: 1 },
        ])
        // 4 demo output tokens per child session turn.
        expect(finished?.tokens).toEqual({ input: 0, output: 16, reasoning: 0 })

        // Every agent ran as a real child session of the parent.
        const children = yield* Effect.forEach(finished?.agents ?? [], (agent) => childOf(agent.sessionID))
        expect(children.length).toBe(4)
        for (const child of children) expect(child?.parentID).toBe(parent.id)

        // The durable lifecycle is replayable from the parent session's event stream.
        const durable = yield* sessions.events({ sessionID: parent.id }).pipe(
          Stream.takeUntil((event) => event.event.type === "session.workflow.finished"),
          Stream.runCollect,
        )
        const types = durable.map((event) => event.event.type)
        expect(types).toContain("session.workflow.started")
        expect(types).toContain("session.workflow.finished")
        const finishedEvent = durable.findLast((event) => event.event.type === "session.workflow.finished")
        expect(finishedEvent?.event.data).toMatchObject({
          runID: started.id,
          name: "two-phase",
          status: "completed",
          tokens: { input: 0, output: 16, reasoning: 0 },
        })
      }),
    ),
  )
})
