import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Catalog } from "@gte-agent/core/catalog"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { FSUtil } from "@gte-agent/core/fs-util"
import { Global } from "@gte-agent/core/global"
import { Permission } from "@gte-agent/core/permission"
import { Project } from "@gte-agent/core/project"
import { ProjectTable } from "@gte-agent/core/project/sql"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { Session } from "@gte-agent/core/session"
import { Prompt } from "@gte-agent/core/session/prompt"
import { SessionExecution } from "@gte-agent/core/session/execution"
import { SessionProjector } from "@gte-agent/core/session/projector"
import { SessionRunCoordinator } from "@gte-agent/core/session/run-coordinator"
import { SessionRunnerDefault } from "@gte-agent/core/session/runner/default"
import { SessionTable } from "@gte-agent/core/session/sql"
import { SessionStore } from "@gte-agent/core/session/store"
import { SystemContextRegistry } from "@gte-agent/core/system-context-registry"
import { ApplicationTools } from "@gte-agent/core/tool/application-tools"
import { ToolRegistry } from "@gte-agent/core/tool/registry"
import { runtimeScope } from "./fixture/runtime-scope"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

/**
 * The production gate: GTE_AGENT_LLM=demo is the ONLY way to get the
 * deterministic demo client. Layers are built inside each test because the
 * gate reads the environment at layer build time.
 */

const runtimeScopeFixture = Layer.succeed(
  RuntimeScope.Service,
  RuntimeScope.Service.of(runtimeScope({ directory: AbsolutePath.make("/project") })),
)

const stack = (home: string) => {
  const database = Database.layerFromPath(":memory:")
  const events = Event.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const permission = Layer.mock(Permission.Service, { assert: () => Effect.void })
  const registry = ToolRegistry.layer.pipe(Layer.provide(permission), Layer.provide(ApplicationTools.layer))
  const catalog = Catalog.runtimeScopeLayer.pipe(Layer.provideMerge(events), Layer.provideMerge(runtimeScopeFixture))
  const systemContext = SystemContextRegistry.layer
  const runner = SessionRunnerDefault.layer.pipe(
    Layer.provide(Layer.mergeAll(database, events, store, registry, catalog, systemContext)),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(Global.layerWith({ home })),
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
    Layer.provide(Project.defaultLayer),
    Layer.provide(execution),
  )
  return Layer.mergeAll(database, events, projector, store, sessions)
}

const sessionID = Session.ID.make("ses_runner_default")

const insertSession = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const withGate = <A, E>(value: string | undefined, body: Effect.Effect<A, E, Session.Service | Database.Service>) =>
  Effect.gen(function* () {
    const saved = {
      GTE_AGENT_LLM: process.env.GTE_AGENT_LLM,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const [name, previous] of Object.entries(saved)) {
          if (previous === undefined) delete process.env[name]
          else process.env[name] = previous
        }
      }),
    )
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    if (value === undefined) delete process.env.GTE_AGENT_LLM
    else process.env.GTE_AGENT_LLM = value
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    return yield* body.pipe(Effect.provide(stack(tmp.path)))
  })

describe("SessionRunnerDefault gate", () => {
  it.effect("GTE_AGENT_LLM=demo streams the deterministic demo response", () =>
    withGate(
      "demo",
      Effect.gen(function* () {
        yield* insertSession
        const session = yield* Session.Service
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Hello" }), resume: false })
        yield* session.resume(sessionID)
        expect(yield* session.context(sessionID)).toMatchObject([
          { type: "user", text: "Hello" },
          { type: "assistant", finish: "stop", content: [{ type: "text", text: "GTE Agent demo response." }] },
        ])
      }),
    ),
  )

  it.effect("the default (unset) path is real and fails visibly without a configured model", () =>
    withGate(
      undefined,
      Effect.gen(function* () {
        yield* insertSession
        const session = yield* Session.Service
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Hello" }), resume: false })

        const failure = yield* session.resume(sessionID).pipe(Effect.flip)
        expect(failure).toMatchObject({ _tag: "SessionRunnerModel.ModelNotSelectedError" })

        // The failure is visible in the transcript and directs the user to /models.
        expect(yield* session.context(sessionID)).toMatchObject([
          { type: "user", text: "Hello" },
          {
            type: "assistant",
            finish: "error",
            error: {
              type: "unknown",
              message:
                "No model is selected for this session and no global default is configured. Use /models to choose a model.",
            },
          },
        ])
      }),
    ),
  )

  it.effect("a non-demo value is never a demo fallback", () =>
    withGate(
      "production",
      Effect.gen(function* () {
        yield* insertSession
        const session = yield* Session.Service
        yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Hello" }), resume: false })
        const failure = yield* session.resume(sessionID).pipe(Effect.flip)
        expect(failure).toMatchObject({ _tag: "SessionRunnerModel.ModelNotSelectedError" })
      }),
    ),
  )
})
