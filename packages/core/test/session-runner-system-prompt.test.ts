import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, Model, type LLMClientShape, type LLMRequest } from "@gte-agent/llm"
import * as OpenAIChat from "@gte-agent/llm/protocols/openai-chat"
import { DateTime, Effect, Layer, Stream } from "effect"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { GteData } from "@gte-agent/core/gte-data/gte-data"
import { GTEAuth } from "@gte-agent/core/gte-auth"
import { Project } from "@gte-agent/core/project"
import { ProjectTable } from "@gte-agent/core/project/sql"
import { AbsolutePath } from "@gte-agent/core/schema"
import { Session } from "@gte-agent/core/session"
import { SessionInput } from "@gte-agent/core/session/input"
import { SessionMessage } from "@gte-agent/core/session/message"
import { Prompt } from "@gte-agent/core/session/prompt"
import { SessionProjector } from "@gte-agent/core/session/projector"
import { SessionRunner } from "@gte-agent/core/session/runner"
import * as SessionRunnerLLM from "@gte-agent/core/session/runner/llm"
import { SessionRunnerModel } from "@gte-agent/core/session/runner/model"
import { SessionRunnerSystemPrompt } from "@gte-agent/core/session/runner/system-prompt"
import { SessionSchema } from "@gte-agent/core/session/schema"
import { SessionTable } from "@gte-agent/core/session/sql"
import { SessionStore } from "@gte-agent/core/session/store"
import { SystemContextRegistry } from "@gte-agent/core/system-context-registry"
import { ToolRegistry } from "@gte-agent/core/tool/registry"
import { makeStubClient } from "./lib/gte-stub"
import { it, testEffect } from "./lib/effect"

const session = (input: Partial<SessionSchema.Info> = {}) =>
  SessionSchema.Info.make({
    id: SessionSchema.ID.make("ses_system_prompt"),
    projectID: Project.ID.global,
    principalID: GTEAuth.DEV_PRINCIPAL_ID,
    authorityID: GTEAuth.DEV_AUTHORITY_ID,
    title: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    runtimeScope: { directory: AbsolutePath.make("/project") },
    ...input,
  })

describe("SessionRunnerSystemPrompt", () => {
  it.effect("renders the full minimal GTE system prompt (snapshot)", () =>
    Effect.sync(() => {
      expect(
        SessionRunnerSystemPrompt.render({
          gteEnv: "hyperliquid-dev",
          trackedAddress: "0x52908400098527886e0f7030069857d2e4169ee7",
          selectedMarket: "BTC-USD",
        }),
      ).toMatchSnapshot()
    }),
  )

  it.effect("renders the no-context prompt with explicit absence markers (snapshot)", () =>
    Effect.sync(() => {
      expect(SessionRunnerSystemPrompt.render({})).toMatchSnapshot()
    }),
  )

  it.effect("always states the read-only boundary and tool guidance", () =>
    Effect.sync(() => {
      const text = SessionRunnerSystemPrompt.render({})
      expect(text).toContain("read-only trading-data assistant")
      expect(text).toContain("You cannot place, modify, or cancel orders")
      expect(text).toContain("Never produce trading recommendations")
      expect(text).toContain("gte_* tools")
      expect(text).toContain("{ provenance, data }")
      expect(text).toContain("GTE environment: unknown")
      expect(text).toContain("Tracked address: none")
      expect(text).toContain("Selected market: none")
    }),
  )

  it.effect("appends the workflow orchestration instruction only when flagged", () =>
    Effect.sync(() => {
      const without = SessionRunnerSystemPrompt.render({})
      expect(without).not.toContain("Ultrathink mode is active")
      const orchestrated = SessionRunnerSystemPrompt.render({ workflowOrchestration: true })
      expect(orchestrated).toContain("Ultrathink mode is active for this request")
      expect(orchestrated).toContain("launch it with the `workflow` tool")
      // The instruction follows the session context, leaving the rest unchanged.
      expect(orchestrated.startsWith(without)).toBe(true)
    }),
  )

  it.effect("detects the literal ultrathink keyword on a word boundary", () =>
    Effect.sync(() => {
      expect(SessionRunnerSystemPrompt.mentionsUltrathink("please ultrathink this")).toBe(true)
      expect(SessionRunnerSystemPrompt.mentionsUltrathink("ULTRATHINK now")).toBe(true)
      expect(SessionRunnerSystemPrompt.mentionsUltrathink("ultrathink.")).toBe(true)
      expect(SessionRunnerSystemPrompt.mentionsUltrathink("no special mode here")).toBe(false)
      // Not a standalone word.
      expect(SessionRunnerSystemPrompt.mentionsUltrathink("ultrathinking")).toBe(false)
      expect(SessionRunnerSystemPrompt.mentionsUltrathink("superultrathink")).toBe(false)
    }),
  )

  const withGteData = testEffect(
    SessionRunnerSystemPrompt.layer.pipe(
      Layer.provideMerge(GteData.layerFromClient("hyperliquid-dev", makeStubClient())),
    ),
  )

  withGteData.effect("derives env from GteData and session context from the session row", () =>
    Effect.gen(function* () {
      const prompt = yield* SessionRunnerSystemPrompt.Service
      const baseline = yield* prompt.baseline(
        session({
          trackedAddress: SessionSchema.TrackedAddress.make("0x52908400098527886e0f7030069857d2e4169ee7"),
          selectedMarket: "ETH-USD",
        }),
      )
      expect(baseline).toContain("GTE environment: hyperliquid-dev")
      expect(baseline).toContain("Tracked address: 0x52908400098527886e0f7030069857d2e4169ee7")
      expect(baseline).toContain("Selected market: ETH-USD")
    }),
  )

  const withoutGteData = testEffect(SessionRunnerSystemPrompt.layer)

  withoutGteData.effect("composes without any GteData surface", () =>
    Effect.gen(function* () {
      const prompt = yield* SessionRunnerSystemPrompt.Service
      const baseline = yield* prompt.baseline(session())
      expect(baseline).toContain("GTE environment: unknown")
    }),
  )

  withoutGteData.effect("adds the orchestration instruction when the latest user text mentions ultrathink", () =>
    Effect.gen(function* () {
      const prompt = yield* SessionRunnerSystemPrompt.Service
      const plain = yield* prompt.baseline(session(), "summarize BTC funding")
      expect(plain).not.toContain("Ultrathink mode is active")
      const ultra = yield* prompt.baseline(session(), "ultrathink: compare funding across every perp")
      expect(ultra).toContain("Ultrathink mode is active for this request")
    }),
  )

  it.effect("does not add the orchestration instruction when the kill-switch flag disables workflows", () =>
    Effect.gen(function* () {
      const saved = process.env.GTE_AGENT_DISABLE_WORKFLOWS
      process.env.GTE_AGENT_DISABLE_WORKFLOWS = "1"
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (saved === undefined) delete process.env.GTE_AGENT_DISABLE_WORKFLOWS
          else process.env.GTE_AGENT_DISABLE_WORKFLOWS = saved
        }),
      )
      // The layer reads the kill switch at build, so build it here under the flag.
      const baseline = yield* Effect.gen(function* () {
        const prompt = yield* SessionRunnerSystemPrompt.Service
        return yield* prompt.baseline(session(), "ultrathink: compare funding across every perp")
      }).pipe(Effect.provide(SessionRunnerSystemPrompt.layer))
      expect(baseline).not.toContain("Ultrathink mode is active")
    }).pipe(Effect.scoped),
  )

  // --- runner integration: the GTE prompt leads the provider request -------

  const database = Database.layerFromPath(":memory:")
  const events = Event.layer.pipe(Layer.provide(database))
  const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
  const store = SessionStore.layer.pipe(Layer.provide(database))
  const requests: LLMRequest[] = []
  const client = Layer.succeed(
    LLMClient.Service,
    LLMClient.Service.of({
      prepare: () => Effect.die("unused"),
      stream: ((request: LLMRequest) => {
        requests.push(request)
        return Stream.fromIterable([
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ] as LLMEvent[])
      }) as unknown as LLMClientShape["stream"],
      generate: () => Effect.die("unused"),
    }),
  )
  const fake = Model.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
  const runner = SessionRunnerLLM.layer.pipe(
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(events),
    Layer.provide(client),
    Layer.provide(ToolRegistry.emptyLayer),
    Layer.provide(SessionRunnerModel.layerWith(() => Effect.succeed(fake))),
    Layer.provide(SystemContextRegistry.layer),
    Layer.provide(SessionRunnerSystemPrompt.layer),
  )
  const runnerIt = testEffect(Layer.mergeAll(database, events, projector, store, runner))

  runnerIt.effect("leads the provider request system parts with the GTE prompt", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = Session.ID.make("ses_system_prompt_runner")
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
      const runner = yield* SessionRunner.Service
      yield* runner.run({ sessionID, force: true })

      expect(requests).toHaveLength(1)
      expect(requests[0]?.system[0]?.text).toContain("You are GTE Agent, a read-only trading-data assistant")
      expect(requests[0]?.system[0]?.text).toContain("GTE environment: unknown")
    }),
  )

  // A real user message carrying the ultrathink keyword, driven through llm.ts,
  // lands the workflow-orchestration instruction in the actual provider request.
  runnerIt.effect("lands the orchestration instruction in the request when a user message mentions ultrathink", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* Event.Service
      const sessionID = Session.ID.make("ses_system_prompt_ultra")
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
      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID,
        prompt: new Prompt({ text: "ultrathink: compare funding across every perp" }),
        delivery: "steer",
      })
      requests.length = 0
      yield* (yield* SessionRunner.Service).run({ sessionID })
      expect(requests).toHaveLength(1)
      const system = requests[0]?.system.map((part) => part.text).join("\n") ?? ""
      expect(system).toContain("Ultrathink mode is active for this request")
      expect(system).toContain("launch it with the `workflow` tool")
    }),
  )
})
