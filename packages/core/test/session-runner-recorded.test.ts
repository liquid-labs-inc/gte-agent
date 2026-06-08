import { NodeFileSystem } from "@effect/platform-node"
import { HttpRecorder } from "@gte-agent/http-recorder"
import * as OpenAIChat from "@gte-agent/llm/protocols/openai-chat"
import { Auth, LLMClient, RequestExecutor } from "@gte-agent/llm/route"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { EventTable } from "@gte-agent/core/event/sql"
import { Permission } from "@gte-agent/core/permission"
import { Project } from "@gte-agent/core/project"
import { ProjectTable } from "@gte-agent/core/project/sql"
import { AbsolutePath } from "@gte-agent/core/schema"
import { Session } from "@gte-agent/core/session"
import { Prompt } from "@gte-agent/core/session/prompt"
import { SessionProjector } from "@gte-agent/core/session/projector"
import { SessionExecution } from "@gte-agent/core/session/execution"
import { SessionRunCoordinator } from "@gte-agent/core/session/run-coordinator"
import * as SessionRunnerLLM from "@gte-agent/core/session/runner/llm"
import { SessionRunnerModel } from "@gte-agent/core/session/runner/model"
import { ToolRegistry } from "@gte-agent/core/tool/registry"
import { SessionTable } from "@gte-agent/core/session/sql"
import { SessionStore } from "@gte-agent/core/session/store"
import { SystemContextRegistry } from "@gte-agent/core/system-context-registry"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import path from "node:path"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = Event.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const cassette = HttpRecorder.cassetteLayer("session-runner/openai-chat-streams-text", {
  directory: path.resolve(import.meta.dir, "fixtures/recordings"),
  mode: process.env.RECORD === "true" ? "record" : "replay",
}).pipe(Layer.provide(NodeFileSystem.layer))
const executor = RequestExecutor.layer.pipe(Layer.provide(cassette))
const client = LLMClient.layer.pipe(Layer.provide(executor))
const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const model = OpenAIChat.route
  .with({
    endpoint: { baseURL: "https://api.openai.com/v1" },
    auth: Auth.bearer(process.env.OPENAI_API_KEY ?? "fixture"),
    generation: { maxTokens: 20, temperature: 0 },
  })
  .model({ id: "gpt-4o-mini" })
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
const systemContext = SystemContextRegistry.layer
const runner = SessionRunnerLLM.defaultLayer.pipe(
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(events),
  Layer.provide(client),
  Layer.provide(registry),
  Layer.provide(models),
  Layer.provide(systemContext),
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
const it = testEffect(
  Layer.mergeAll(
    database,
    events,
    projector,
    store,
    executor,
    client,
    permission,
    registry,
    models,
    systemContext,
    runner,
    coordinator,
    execution,
    sessions,
  ),
)
const sessionID = Session.ID.make("ses_runner_recorded")

describe("SessionRunnerLLM recorded", () => {
  it.effect("executes one recorded prompt through the recorded HTTP transport", () =>
    Effect.gen(function* () {
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
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const session = yield* Session.Service
      const prompt = yield* session.prompt({
        sessionID,
        prompt: new Prompt({ text: "Say hello in one short sentence." }),
        resume: false,
      })

      yield* session.resume(sessionID)

      const messages = yield* session.context(sessionID)
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({ id: prompt.id, type: "user", text: "Say hello in one short sentence." })
      expect(messages[1]).toMatchObject({ type: "assistant", agent: "build", finish: "stop" })
      expect(messages[1]?.type === "assistant" ? messages[1].content : []).toMatchObject([
        { type: "text", text: "Hello!" },
      ])
      expect(
        (yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .orderBy(EventTable.seq)
          .all()).map((event) => event.type),
      ).toEqual([
        "session.next.prompt.admitted.1",
        "session.next.prompt.promoted.1",
        "session.next.step.started.1",
        "session.next.text.started.1",
        "session.next.text.ended.1",
        "session.next.step.ended.2",
      ])
    }),
  )
})
