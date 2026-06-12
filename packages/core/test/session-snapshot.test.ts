import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { GTEAuth } from "@gte-agent/core/gte-auth"
import { Project } from "@gte-agent/core/project"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { Session } from "@gte-agent/core/session"
import { SessionEvent } from "@gte-agent/core/session/event"
import { SessionExecution } from "@gte-agent/core/session/execution"
import { SessionProjector } from "@gte-agent/core/session/projector"
import { SessionSchema } from "@gte-agent/core/session/schema"
import { SessionSnapshot } from "@gte-agent/core/session/snapshot"
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

const snapshotsWith = (auth?: GTEAuth.RequestContext) =>
  SessionSnapshot.layer.pipe(
    Layer.provide(events),
    Layer.provide(store),
    Layer.provide(database),
    auth === undefined ? Layer.provide(Layer.empty) : Layer.provide(GTEAuth.RequestContextService.layer(auth)),
  )

const baseLayer = Layer.mergeAll(database, events, projects, projector, store, sessions)
const it = testEffect(Layer.mergeAll(baseLayer, snapshotsWith()))

const runtimeScope = RuntimeScope.Ref.make({ directory: AbsolutePath.make("/project") })

const SUMMARY: SessionEvent.SnapshotSummary = {
  title: "ETH-USD book",
  fields: { mid: "2000.5", spread: "0.1" },
  rows: [{ side: "bid", price: "2000.4", size: "3" }],
}
const PROVENANCE: SessionEvent.SnapshotProvenance = {
  env: "hyperliquid-dev",
  source: "http",
  timestamp: "2026-06-11T00:00:00.000Z",
  symbol: "ETH-USD",
}

describe("SessionSnapshot", () => {
  it.effect("records a durable session.snapshot.recorded event that replays with a cursor", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const snapshots = yield* SessionSnapshot.Service
      const bus = yield* Event.Service
      const info = yield* session.create({ runtimeScope })

      const recorded = yield* snapshots.record({
        sessionID: info.id,
        command: "/book",
        panel: "book",
        key: "ETH-USD",
        summary: SUMMARY,
        provenance: PROVENANCE,
      })
      expect(recorded.seq).toBe(1)

      // Durable replay (cursor-ordered aggregate read) must include the snapshot.
      const replayed = yield* bus
        .aggregateEvents({ aggregateID: info.id })
        .pipe(Stream.take(2), Stream.runCollect)
      const snapshot = replayed.find((item) => item.event.type === "session.snapshot.recorded")
      expect(snapshot).toBeDefined()
      expect(Number(snapshot!.cursor)).toBe(1)
      const data = snapshot!.event.data as SessionEvent.SnapshotRecorded["data"]
      expect(data.command).toBe("/book")
      expect(data.panel).toBe("book")
      expect(data.key).toBe("ETH-USD")
      expect(data.summary).toEqual(SUMMARY)
      expect(data.provenance).toEqual(PROVENANCE)
    }),
  )

  it.effect("fails with NotFoundError for an unknown session", () =>
    Effect.gen(function* () {
      const snapshots = yield* SessionSnapshot.Service
      const error = yield* snapshots
        .record({
          sessionID: SessionSchema.ID.make("ses_missing"),
          command: "/markets",
          summary: {},
          provenance: PROVENANCE,
        })
        .pipe(Effect.flip)
      expect(error._tag).toBe("Session.NotFoundError")
    }),
  )
})

describe("SessionSnapshot ownership", () => {
  const principalID = GTEAuth.PrincipalID.make("user_test")
  const authorityID = GTEAuth.AuthorityID.make("ta_test")
  const seed = Effect.gen(function* () {
    const session = yield* Session.Service
    return yield* session.create({ runtimeScope, authorityID })
  })

  const readOnly: GTEAuth.RequestContext = {
    principalID,
    authorities: [{ authorityID, read: true, act: false }],
    authDisabled: false,
  }
  const denied: GTEAuth.RequestContext = {
    principalID,
    authorities: [{ authorityID, read: false, act: false }],
    authDisabled: false,
  }
  const acting: GTEAuth.RequestContext = {
    principalID,
    authorities: [{ authorityID, read: true, act: true }],
    authDisabled: false,
  }

  const sessionsActing = Session.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(projects),
    Layer.provide(SessionExecution.noopLayer),
    Layer.provide(GTEAuth.RequestContextService.layer(acting)),
  )
  const base = Layer.mergeAll(database, events, projects, projector, store, sessionsActing)

  const attempt = (auth: GTEAuth.RequestContext) =>
    Effect.gen(function* () {
      const info = yield* seed
      const snapshots = yield* SessionSnapshot.Service
      return { info, error: yield* snapshots
        .record({ sessionID: info.id, command: "/balances", summary: {}, provenance: PROVENANCE })
        .pipe(Effect.flip) }
    })

  testEffect(Layer.mergeAll(base, snapshotsWith(readOnly))).effect(
    "rejects a read-only principal with MutationDeniedError (like updateIntent)",
    () =>
      Effect.gen(function* () {
        const { error } = yield* attempt(readOnly)
        expect(error._tag).toBe("GTEAuth.MutationDeniedError")
      }),
  )

  testEffect(Layer.mergeAll(base, snapshotsWith(denied))).effect(
    "rejects a principal without read access with ReadDeniedError",
    () =>
      Effect.gen(function* () {
        const { error } = yield* attempt(denied)
        expect(error._tag).toBe("GTEAuth.ReadDeniedError")
      }),
  )
})
