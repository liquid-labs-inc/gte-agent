import { describe, expect } from "bun:test"
import path from "path"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { AuthStore } from "@gte-agent/core/auth/store"
import { Catalog } from "@gte-agent/core/catalog"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { EventTable } from "@gte-agent/core/event/sql"
import { FSUtil } from "@gte-agent/core/fs-util"
import { Global } from "@gte-agent/core/global"
import { Model } from "@gte-agent/core/model"
import { ModelSelection } from "@gte-agent/core/model-selection"
import { Provider } from "@gte-agent/core/provider"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { Session } from "@gte-agent/core/session"
import { runtimeScope } from "./fixture/runtime-scope"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const runtimeScopeLayer = Layer.succeed(
  RuntimeScope.Service,
  RuntimeScope.Service.of(runtimeScope({ directory: AbsolutePath.make("test") })),
)
const database = Database.layerFromPath(":memory:")
const events = Event.layer.pipe(Layer.provide(database))

const layersFor = (home: string) =>
  ModelSelection.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Catalog.runtimeScopeLayer.pipe(Layer.provideMerge(events), Layer.provideMerge(runtimeScopeLayer)),
        AuthStore.layer,
        events,
        database,
      ),
    ),
    Layer.provideMerge(FSUtil.defaultLayer),
    Layer.provideMerge(Global.layerWith({ home })),
  )

/** Runs the body against a fresh isolated home with provider env vars cleared. */
const withSelection = <A, E>(
  body: (home: string) => Effect.Effect<A, E, ModelSelection.Service | AuthStore.Service | Database.Service>,
) =>
  Effect.gen(function* () {
    const saved = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }),
    )
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    return yield* body(tmp.path).pipe(Effect.provide(layersFor(tmp.path)))
  })

const ref = (providerID: string, modelID: string) => ({
  providerID: Provider.ID.make(providerID),
  modelID: Model.ID.make(modelID),
})

describe("ModelSelection", () => {
  it.effect("lists curated models with unauthenticated status when no credentials exist", () =>
    withSelection((_home) =>
      Effect.gen(function* () {
        const selection = yield* ModelSelection.Service
        const entries = yield* selection.list()
        expect(entries.length).toBeGreaterThanOrEqual(7)
        expect(entries.every((entry) => entry.auth.authenticated === false)).toBe(true)
        expect(entries.every((entry) => entry.isDefault === false)).toBe(true)
      }),
    ),
  )

  it.effect("annotates auth status per provider from auth.json profiles without leaking key material", () =>
    withSelection((_home) =>
      Effect.gen(function* () {
        const store = yield* AuthStore.Service
        yield* store.set(Provider.ID.anthropic, { type: "api_key", key: "sk-ant-secret-material" })
        yield* store.set(Provider.ID.openai, { type: "oauth", access: "oauth-access-secret", refresh: "r", expires: 0 })
        const selection = yield* ModelSelection.Service
        const entries = yield* selection.list()
        const anthropic = entries.filter((entry) => entry.model.providerID === Provider.ID.anthropic)
        const openai = entries.filter((entry) => entry.model.providerID === Provider.ID.openai)
        expect(anthropic.every((entry) => entry.auth.authenticated)).toBe(true)
        expect(anthropic[0]?.auth).toEqual({ authenticated: true, method: "api_key", source: "store" })
        expect(openai[0]?.auth).toEqual({ authenticated: true, method: "oauth", source: "store" })
        const serialized = JSON.stringify(entries)
        expect(serialized).not.toContain("sk-ant-secret-material")
        expect(serialized).not.toContain("oauth-access-secret")
      }),
    ),
  )

  it.effect("annotates env-var credentials as env-sourced", () =>
    withSelection((_home) =>
      Effect.gen(function* () {
        process.env.ANTHROPIC_API_KEY = "env-key"
        const selection = yield* ModelSelection.Service
        const status = yield* selection.authStatus(Provider.ID.anthropic)
        expect(status).toEqual({ authenticated: true, method: "api_key", source: "env" })
      }),
    ),
  )

  it.effect("rejects a selection that is not in the curated catalog", () =>
    withSelection((_home) =>
      Effect.gen(function* () {
        const selection = yield* ModelSelection.Service
        const missingModel = yield* selection.select(ref("anthropic", "claude-1")).pipe(Effect.flip)
        expect(missingModel).toMatchObject({ _tag: "Catalog.ModelNotFound" })
        const missingProvider = yield* selection.select(ref("mistral", "mistral-large")).pipe(Effect.flip)
        expect(missingProvider).toMatchObject({ _tag: "Catalog.ProviderNotFound" })
      }),
    ),
  )

  it.effect("writes the global default to ~/.gte-agent/config.json and reads it back", () =>
    withSelection((home) =>
      Effect.gen(function* () {
        const selection = yield* ModelSelection.Service
        expect(yield* selection.defaultRef()).toBeUndefined()

        const selected = yield* selection.select(ref("anthropic", "claude-fable-5"))
        expect(selected.id).toBe(Model.ID.make("claude-fable-5"))

        const file = path.join(home, ".gte-agent", "config.json")
        const stored = yield* Effect.promise(() => Bun.file(file).json())
        expect(stored).toEqual({ model: "anthropic/claude-fable-5" })
        expect(yield* selection.defaultRef()).toEqual({
          id: Model.ID.make("claude-fable-5"),
          providerID: Provider.ID.anthropic,
        })

        const entries = yield* selection.list()
        const flagged = entries.filter((entry) => entry.isDefault)
        expect(flagged.map((entry) => `${entry.model.providerID}/${entry.model.id}`)).toEqual([
          "anthropic/claude-fable-5",
        ])
      }),
    ),
  )

  it.effect("preserves unrelated config.json keys when updating the default", () =>
    withSelection((home) =>
      Effect.gen(function* () {
        const file = path.join(home, ".gte-agent", "config.json")
        yield* Effect.promise(async () => {
          await Bun.write(file, JSON.stringify({ username: "moses", model: "anthropic/claude-haiku-4-5" }, null, 2))
        })
        const selection = yield* ModelSelection.Service
        yield* selection.select(ref("openai", "gpt-5.5"))
        const stored = yield* Effect.promise(() => Bun.file(file).json())
        expect(stored).toEqual({ username: "moses", model: "openai/gpt-5.5" })
      }),
    ),
  )

  it.effect("persists a session selection as a durable model switch event", () =>
    withSelection((_home) =>
      Effect.gen(function* () {
        const sessionID = Session.ID.make("ses_model_selection")
        const selection = yield* ModelSelection.Service
        yield* selection.select({ ...ref("anthropic", "claude-sonnet-4-6"), sessionID })
        const { db } = yield* Database.Service
        const recorded = yield* db
          .select({ type: EventTable.type, data: EventTable.data })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        expect(recorded).toHaveLength(1)
        expect(recorded[0]?.type).toBe("session.next.model.switched.1")
        expect(recorded[0]?.data).toMatchObject({
          model: { id: "claude-sonnet-4-6", providerID: "anthropic" },
        })
      }),
    ),
  )
})
