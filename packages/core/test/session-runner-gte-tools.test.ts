import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@gte-agent/llm"
import * as OpenAIChat from "@gte-agent/llm/protocols/openai-chat"
import { asc, eq } from "drizzle-orm"
import { Effect, Layer, Stream } from "effect"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { EventTable } from "@gte-agent/core/event/sql"
import { GteData } from "@gte-agent/core/gte-data/gte-data"
import { Permission } from "@gte-agent/core/permission"
import { Project } from "@gte-agent/core/project"
import { ProjectTable } from "@gte-agent/core/project/sql"
import { AbsolutePath } from "@gte-agent/core/schema"
import { Session } from "@gte-agent/core/session"
import { Prompt } from "@gte-agent/core/session/prompt"
import { SessionExecution } from "@gte-agent/core/session/execution"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@gte-agent/core/session/sql"
import { SessionProjector } from "@gte-agent/core/session/projector"
import { SessionRunCoordinator } from "@gte-agent/core/session/run-coordinator"
import * as SessionRunnerLLM from "@gte-agent/core/session/runner/llm"
import { SessionRunnerModel } from "@gte-agent/core/session/runner/model"
import { SessionStore } from "@gte-agent/core/session/store"
import { SystemContextRegistry } from "@gte-agent/core/system-context-registry"
import { ApplicationTools } from "@gte-agent/core/tool/application-tools"
import { GteTools } from "@gte-agent/core/tool/gte/tools"
import { ToolRegistry } from "@gte-agent/core/tool/registry"
import { EXPECTED_GTE_TOOLS, makeStubClient, type StubCall } from "./lib/gte-stub"
import { testEffect } from "./lib/effect"

/**
 * A full multi-step tool-calling turn against the read-only GTE data tool
 * catalog: tools advertised to the model, two sequential local tool
 * settlements, durable projection, and an explicit continuation turn per
 * settlement — all against a stubbed LLM stream (never a provider network).
 */

const database = Database.layerFromPath(":memory:")
const events = Event.layer.pipe(Layer.provide(database))
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))

const requests: LLMRequest[] = []
let responses: LLMEvent[][] = []
const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      return Stream.fromIterable(responses.shift() ?? [])
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

const model = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const models = SessionRunnerModel.layerWith(() => Effect.succeed(model))
const permission = Layer.mock(Permission.Service, { assert: () => Effect.void })
const registry = ToolRegistry.layer.pipe(Layer.provide(permission), Layer.provide(ApplicationTools.layer))
const stubCalls: StubCall[] = []
const gteData = GteData.layerFromClient("hyperliquid-dev", makeStubClient(stubCalls))
const gteTools = GteTools.layer.pipe(Layer.provide(Layer.mergeAll(registry, gteData, store)))
const systemContext = SystemContextRegistry.layer
const runner = SessionRunnerLLM.layer.pipe(
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
  Layer.mergeAll(database, events, projector, store, client, registry, gteTools, models, systemContext, sessions),
)

const sessionID = Session.ID.make("ses_runner_gte_tools")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  requests.length = 0
  responses = []
  stubCalls.length = 0
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

const replaySessionProjection = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const events = yield* Event.Service
  const recorded = yield* db
    .select()
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  yield* events.remove(sessionID)
  yield* db.delete(SessionInputTable).where(eq(SessionInputTable.session_id, sessionID)).run().pipe(Effect.orDie)
  yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, sessionID)).run().pipe(Effect.orDie)
  yield* events.replayAll(
    recorded.map((event) => ({
      id: event.id,
      aggregateID: event.aggregate_id,
      seq: event.seq,
      type: event.type,
      data: event.data,
    })),
  )
})

describe("SessionRunnerLLM with GTE tools", () => {
  it.effect("advertises the gte_* catalog and settles a multi-step tool-calling turn durably", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* Session.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "What is BTC trading at?" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-market", name: "gte_market", input: { symbol: "btc-usd" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-book", name: "gte_book", input: { symbol: "BTC-USD" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "BTC-USD trades at 100." }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      // The full read-only catalog was advertised to the model on every turn.
      expect(requests).toHaveLength(3)
      const advertised = requests[0]?.tools.map((tool) => tool.name).sort()
      expect(advertised).toEqual([...EXPECTED_GTE_TOOLS].sort())

      // Each settlement produced an explicit continuation turn with the tool result.
      expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
      expect(requests[2]?.messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "tool",
        "assistant",
        "tool",
      ])

      // The stubbed exchange client really served the snapshots (no provider network).
      expect(stubCalls.map((call) => call.op)).toContain("markets.get")
      expect(stubCalls.map((call) => call.op)).toContain("markets.getOrderBook")

      const expectedContext = [
        { type: "user", text: "What is BTC trading at?" },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-market",
              name: "gte_market",
              state: {
                status: "completed",
                structured: {
                  provenance: { env: "hyperliquid-dev", source: "http" },
                  data: { symbol: "BTC-USD" },
                },
              },
            },
          ],
        },
        {
          type: "assistant",
          finish: "tool-calls",
          content: [
            {
              type: "tool",
              id: "call-book",
              name: "gte_book",
              state: { status: "completed", structured: { provenance: { env: "hyperliquid-dev" } } },
            },
          ],
        },
        { type: "assistant", finish: "stop", content: [{ type: "text", text: "BTC-USD trades at 100." }] },
      ]
      expect(yield* session.context(sessionID)).toMatchObject(expectedContext)

      // Durability: replaying the recorded events reproduces the same projection.
      yield* replaySessionProjection
      expect(yield* session.context(sessionID)).toMatchObject(expectedContext)
    }),
  )

  it.effect("settles a failing gte tool call as a typed tool error and still finishes the turn", () =>
    Effect.gen(function* () {
      yield* setup
      const session = yield* Session.Service
      yield* session.prompt({ sessionID, prompt: new Prompt({ text: "Quote DOG" }), resume: false })
      responses = [
        [
          LLMEvent.stepStart({ index: 0 }),
          // "DOG" resolves ambiguously in the stub client -> typed tool failure.
          LLMEvent.toolCall({ id: "call-ambiguous", name: "gte_market", input: { symbol: "DOG" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ]

      yield* session.resume(sessionID)

      expect(requests).toHaveLength(2)
      const context = yield* session.context(sessionID)
      expect(context[1]).toMatchObject({
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call-ambiguous",
            name: "gte_market",
            state: { status: "error" },
          },
        ],
      })
    }),
  )
})
