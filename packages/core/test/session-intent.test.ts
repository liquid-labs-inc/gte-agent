import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Option, Schema, Stream } from "effect"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { EventTable } from "@gte-agent/core/event/sql"
import { GTEAuth } from "@gte-agent/core/gte-auth"
import { Project } from "@gte-agent/core/project"
import { ProjectTable } from "@gte-agent/core/project/sql"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { Session } from "@gte-agent/core/session"
import { SessionSchema } from "@gte-agent/core/session/schema"
import { SessionEvent } from "@gte-agent/core/session/event"
import { SessionExecution } from "@gte-agent/core/session/execution"
import { SessionProjector } from "@gte-agent/core/session/projector"
import { SessionTable } from "@gte-agent/core/session/sql"
import { SessionStore } from "@gte-agent/core/session/store"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = Event.layer.pipe(Layer.provide(database))
const projects = Layer.succeed(
  Project.Service,
  Project.Service.of({
    resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = Session.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(SessionExecution.noopLayer),
)
const sessionsWithAuth = (auth: GTEAuth.RequestContext) =>
  Session.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(projects),
    Layer.provide(SessionExecution.noopLayer),
    Layer.provide(GTEAuth.RequestContextService.layer(auth)),
  )
const it = testEffect(
  Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessions),
)
const principalID = GTEAuth.PrincipalID.make("user_test")
const authorityID = GTEAuth.AuthorityID.make("ta_test")
const authReadOnly = {
  principalID,
  authorities: [{ authorityID, read: true, act: false }],
  authDisabled: false,
}
const authDenied = {
  principalID,
  authorities: [{ authorityID, read: false, act: false }],
  authDisabled: false,
}
const itReadOnly = testEffect(
  Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessionsWithAuth(authReadOnly)),
)
const itDenied = testEffect(
  Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessionsWithAuth(authDenied)),
)
const runtimeScope = RuntimeScope.Ref.make({ directory: AbsolutePath.make("/project") })
const address = SessionSchema.TrackedAddress.make("0x52908400098527886e0f7030069857d2e4169ee7".toLowerCase())
const panels = [
  { panel: "book", key: "ETH-USD" },
  { panel: "balances", key: "0x52908400098527886e0f7030069857d2e4169ee7" },
] satisfies SessionSchema.PinnedPanels
const insertSession = (input: {
  sessionID: Session.ID
  principalID: GTEAuth.PrincipalID
  authorityID: GTEAuth.AuthorityID
}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: runtimeScope.directory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: input.sessionID,
        project_id: Project.ID.global,
        principal_id: input.principalID,
        authority_id: input.authorityID,
        slug: "test",
        directory: runtimeScope.directory,
        title: "test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })

describe("Session intent schema", () => {
  const decodeAddress = Schema.decodeUnknownOption(SessionSchema.TrackedAddress)
  const decodePanels = Schema.decodeUnknownOption(SessionSchema.PinnedPanels)

  it.effect("rejects malformed tracked addresses", () =>
    Effect.sync(() => {
      const malformed = [
        "",
        "0x",
        "52908400098527886e0f7030069857d2e4169ee7",
        "0x52908400098527886e0f7030069857d2e4169ee", // 39 hex chars
        "0x52908400098527886e0f7030069857d2e4169ee71", // 41 hex chars
        "0xzz908400098527886e0f7030069857d2e4169ee7", // non-hex
      ]
      for (const input of malformed) {
        expect(Option.isNone(decodeAddress(input))).toBe(true)
      }
    }),
  )

  it.effect("normalizes mixed-case tracked addresses to lowercase", () =>
    Effect.sync(() => {
      expect(String(Option.getOrThrow(decodeAddress("0x52908400098527886E0F7030069857D2E4169EE7")))).toBe(
        "0x52908400098527886e0f7030069857d2e4169ee7",
      )
    }),
  )

  it.effect("make rejects non-normalized tracked addresses", () =>
    Effect.sync(() => {
      // `make` skips the decode transform, so it must refuse mixed case outright;
      // otherwise live projection and durable-event encoding would diverge.
      expect(() => SessionSchema.TrackedAddress.make("0x52908400098527886E0F7030069857D2E4169EE7")).toThrow()
      expect(SessionSchema.TrackedAddress.make("0x52908400098527886e0f7030069857d2e4169ee7")).toBe(address)
    }),
  )

  it.effect("rejects more pinned panels than the cap", () =>
    Effect.sync(() => {
      const panel = { panel: "book", key: "ETH-USD" }
      const atCap = Array.from({ length: SessionSchema.MAX_PINNED_PANELS }, () => panel)

      expect(Option.isSome(decodePanels(atCap))).toBe(true)
      expect(Option.isNone(decodePanels([...atCap, panel]))).toBe(true)
    }),
  )

  it.effect("rejects unknown panel types", () =>
    Effect.sync(() => {
      expect(Option.isNone(decodePanels([{ panel: "fileTree", key: "src" }]))).toBe(true)
    }),
  )
})

describe("Session.updateIntent", () => {
  it.effect("persists intent fields and returns the updated session", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ runtimeScope })

      expect(created.selectedMarket).toBeUndefined()
      expect(created.trackedAddress).toBeUndefined()
      expect(created.pinnedPanels).toBeUndefined()

      const updated = yield* session.updateIntent({
        sessionID: created.id,
        selectedMarket: "ETH-USD",
        trackedAddress: address,
        pinnedPanels: panels,
      })

      expect(updated).toMatchObject({
        id: created.id,
        selectedMarket: "ETH-USD",
        trackedAddress: address,
        pinnedPanels: panels,
      })
      expect(yield* session.get(created.id)).toMatchObject({
        selectedMarket: "ETH-USD",
        trackedAddress: address,
        pinnedPanels: panels,
      })
    }),
  )

  it.effect("leaves omitted fields unchanged and clears explicit nulls", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ runtimeScope })
      yield* session.updateIntent({
        sessionID: created.id,
        selectedMarket: "ETH-USD",
        trackedAddress: address,
        pinnedPanels: panels,
      })

      const patched = yield* session.updateIntent({ sessionID: created.id, selectedMarket: "BTC-USD" })
      expect(patched).toMatchObject({
        selectedMarket: "BTC-USD",
        trackedAddress: address,
        pinnedPanels: panels,
      })

      const cleared = yield* session.updateIntent({
        sessionID: created.id,
        trackedAddress: null,
        pinnedPanels: null,
      })
      expect(cleared.selectedMarket).toBe("BTC-USD")
      expect(cleared.trackedAddress).toBeUndefined()
      expect(cleared.pinnedPanels).toBeUndefined()
    }),
  )

  it.effect("round-trips intent through the session row projection", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ runtimeScope })
      yield* session.updateIntent({
        sessionID: created.id,
        selectedMarket: "ETH-USD",
        trackedAddress: address,
        pinnedPanels: panels,
      })

      expect(
        yield* db
          .select({
            selected_market: SessionTable.selected_market,
            tracked_address: SessionTable.tracked_address,
            pinned_panels: SessionTable.pinned_panels,
          })
          .from(SessionTable)
          .where(eq(SessionTable.id, created.id))
          .get()
          .pipe(Effect.orDie),
      ).toEqual({
        selected_market: "ETH-USD",
        tracked_address: address,
        pinned_panels: panels,
      })
    }),
  )

  it.effect("publishes a durable session.intent.updated event", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ runtimeScope })
      yield* session.updateIntent({ sessionID: created.id, selectedMarket: "ETH-USD", trackedAddress: address })

      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(2), Stream.runCollect)),
      ).toMatchObject([
        { cursor: 0, event: { type: "session.created", data: { sessionID: created.id } } },
        {
          cursor: 1,
          event: {
            type: "session.intent.updated",
            data: { sessionID: created.id, selectedMarket: "ETH-USD", trackedAddress: address },
          },
        },
      ])
      expect(
        (yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie))
          .map((event) => event.type)
          .at(-1),
      ).toBe(Event.versionedType(SessionEvent.IntentUpdated.type, 1))
    }),
  )

  it.effect("publishes the merged full intent state so replay cannot drop omitted fields", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ runtimeScope })
      yield* session.updateIntent({
        sessionID: created.id,
        selectedMarket: "ETH-USD",
        trackedAddress: address,
        pinnedPanels: panels,
      })
      yield* session.updateIntent({ sessionID: created.id, selectedMarket: "BTC-USD" })

      const last = (yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .all()
        .pipe(Effect.orDie)).at(-1)
      expect(last?.type).toBe(Event.versionedType(SessionEvent.IntentUpdated.type, 1))
      // Omitted-in-patch fields must still be present in the durable event payload.
      expect(last?.data).toMatchObject({
        selectedMarket: "BTC-USD",
        trackedAddress: address,
        pinnedPanels: panels,
      })
    }),
  )

  it.effect("treats an intent event without fields as clearing all intent state", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* Event.Service
      const created = yield* session.create({ runtimeScope })
      yield* session.updateIntent({
        sessionID: created.id,
        selectedMarket: "ETH-USD",
        trackedAddress: address,
        pinnedPanels: panels,
      })

      // Full-state semantics: an event with every field absent projects to cleared state.
      yield* events.publish(SessionEvent.IntentUpdated, {
        sessionID: created.id,
        timestamp: DateTime.makeUnsafe(Date.now()),
      })

      const cleared = yield* session.get(created.id)
      expect(cleared.selectedMarket).toBeUndefined()
      expect(cleared.trackedAddress).toBeUndefined()
      expect(cleared.pinnedPanels).toBeUndefined()
    }),
  )

  it.effect("does not publish an event for an empty patch", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ runtimeScope })
      yield* session.updateIntent({ sessionID: created.id, selectedMarket: "ETH-USD" })
      const before = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .all()
        .pipe(Effect.orDie)

      const unchanged = yield* session.updateIntent({ sessionID: created.id })
      expect(unchanged.selectedMarket).toBe("ETH-USD")

      const after = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .all()
        .pipe(Effect.orDie)
      expect(after.length).toBe(before.length)
    }),
  )

  it.effect("survives concurrent patches without corrupting state", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ runtimeScope })
      yield* Effect.all(
        [
          session.updateIntent({ sessionID: created.id, selectedMarket: "ETH-USD" }),
          session.updateIntent({ sessionID: created.id, trackedAddress: address }),
        ],
        { concurrency: "unbounded" },
      )
      // Whole-intent last-write-wins is acceptable; both events must commit cleanly.
      const final = yield* session.get(created.id)
      const sawMarket = final.selectedMarket === "ETH-USD"
      const sawAddress = final.trackedAddress === address
      expect(sawMarket || sawAddress).toBe(true)
    }),
  )

  it.effect("fails with NotFoundError for unknown sessions", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const error = yield* session
        .updateIntent({ sessionID: Session.ID.create(), selectedMarket: "ETH-USD" })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(Session.NotFoundError)
    }),
  )

  itReadOnly.effect("denies intent updates when the principal cannot act for the authority", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const sessionID = Session.ID.create()
      yield* insertSession({ sessionID, principalID, authorityID })
      const error = yield* session.updateIntent({ sessionID, selectedMarket: "ETH-USD" }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(GTEAuth.MutationDeniedError)
    }),
  )

  itDenied.effect("denies intent updates when the principal lacks read access", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const sessionID = Session.ID.create()
      yield* insertSession({ sessionID, principalID, authorityID })
      const error = yield* session.updateIntent({ sessionID, selectedMarket: "ETH-USD" }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(GTEAuth.ReadDeniedError)
    }),
  )
})
