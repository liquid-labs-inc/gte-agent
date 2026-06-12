/**
 * Unit coverage for the SSE live-phase composition (live-session-events.ts):
 *
 * - durable events keep their cursors; merged ephemeral panel events have none
 * - ephemeral events are session-scoped (other sessions' panels are filtered)
 * - panel presence is refcounted to the stream lifetime (attach on start,
 *   detach when the consumer goes away)
 * - ephemeral events never enter the durable aggregate, so `?after` replay
 *   semantics are untouched
 */
// Hermetic env bootstrap MUST precede any @gte-agent/core import (core captures
// GTE_AGENT_* at module load; see httpapi-exercise/setup.ts).
import "./httpapi-exercise/setup"
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { GtePanelEvent } from "@gte-agent/core/gte-data/panel-event"
import { Session } from "@gte-agent/core/session"
import { WorkflowEvent } from "@gte-agent/core/workflow/event"
import { WorkflowSchema } from "@gte-agent/core/workflow/schema"
import { DateTime } from "effect"
import { liveSessionEvents, type Envelope } from "../src/live-session-events"

const SESSION_A = Session.ID.make("ses_live_a")
const SESSION_B = Session.ID.make("ses_live_b")

const layer = Event.layer.pipe(Layer.provide(Database.layerFromPath(":memory:")))

const run = <A>(effect: Effect.Effect<A, unknown, Event.Service>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(layer)) as Effect.Effect<A, unknown, never>)

const durableEnvelope = (cursor: number): Event.CursorEvent<never> =>
  ({
    cursor: Event.Cursor.make(cursor),
    event: { id: Event.ID.create(), type: "session.created", data: { sessionID: SESSION_A } },
  }) as unknown as Event.CursorEvent<never>

test("merges session-scoped ephemeral panel events without cursors while presence is refcounted", async () => {
  await run(
    Effect.gen(function* () {
      const events = yield* Event.Service
      let attached = 0
      let detached = 0
      const panels = {
        attach: () => Effect.sync(() => void (attached += 1)),
        detach: () => Effect.sync(() => void (detached += 1)),
      }

      // One historical durable event, then the durable phase stays open.
      const durable = Stream.concat(Stream.fromIterable([durableEnvelope(0)]), Stream.never)
      const collected: Envelope[] = []
      const sawPanelEvent = yield* Deferred.make<void>()

      const consumer = yield* liveSessionEvents({ events, panels }, { sessionID: SESSION_A, durable }).pipe(
        Stream.runForEach((envelope) =>
          Effect.gen(function* () {
            collected.push(envelope)
            const type = (envelope.event as { type?: string }).type
            if (type === "session.panel.updated") yield* Deferred.succeed(sawPanelEvent, undefined)
          }),
        ),
        Effect.forkChild,
      )

      // Wait until the stream is running (attach observed), then publish panel events.
      yield* Effect.gen(function* () {
        while (attached === 0) yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)))
      })
      // Give the live merge a beat to subscribe its pubsubs.
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))

      // Other-session events must be filtered out.
      yield* events.publish(GtePanelEvent.Updated, {
        sessionID: SESSION_B,
        panel: "book",
        key: "BTC-USD",
        data: { ignored: true },
        provenance: { env: "hyperliquid-dev", source: "ws", timestamp: "t" },
      })
      yield* events.publish(GtePanelEvent.Updated, {
        sessionID: SESSION_A,
        panel: "book",
        key: "ETH-USD",
        data: { mid: 2000 },
        provenance: { env: "hyperliquid-dev", source: "ws", timestamp: "t", symbol: "ETH-USD" },
      })

      yield* Deferred.await(sawPanelEvent)
      yield* Fiber.interrupt(consumer)

      const durableSeen = collected.filter((envelope) => envelope.cursor !== undefined)
      expect(durableSeen.length).toBe(1)
      expect(durableSeen[0].cursor).toBe(0)

      const local = collected.filter((envelope) => envelope.cursor === undefined)
      expect(local.length).toBe(1)
      const payload = local[0].event as { type: string; data: { sessionID: string; key: string } }
      expect(payload.type).toBe("session.panel.updated")
      expect(payload.data.sessionID).toBe(SESSION_A)
      expect(payload.data.key).toBe("ETH-USD")

      // Stream ended: presence released exactly once.
      expect(attached).toBe(1)
      expect(detached).toBe(1)

      // Ephemeral events never reached the durable aggregate, so replay-after
      // semantics are unchanged (no committed events for this session at all).
      const replay = yield* events.aggregateEvents({ aggregateID: SESSION_A }).pipe(
        Stream.takeUntil(() => true),
        Stream.timeout(50),
        Stream.runCollect,
        Effect.catch(() => Effect.succeed([] as Event.CursorEvent[])),
      )
      expect(replay.length).toBe(0)
    }),
  )
})

describe("status events", () => {
  test("session.panel.status flows through the live phase without a cursor", async () => {
    await run(
      Effect.gen(function* () {
        const events = yield* Event.Service
        const panels = { attach: () => Effect.void, detach: () => Effect.void }
        const sawStatus = yield* Deferred.make<Envelope>()

        const consumer = yield* liveSessionEvents(
          { events, panels },
          { sessionID: SESSION_A, durable: Stream.never },
        ).pipe(
          Stream.runForEach((envelope) =>
            (envelope.event as { type?: string }).type === "session.panel.status"
              ? Deferred.succeed(sawStatus, envelope)
              : Effect.void,
          ),
          Effect.forkChild,
        )

        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
        yield* events.publish(GtePanelEvent.Status, {
          sessionID: SESSION_A,
          panel: "trades",
          key: "ETH-USD",
          status: "degraded",
          reason: "ws unavailable",
        })

        const envelope = yield* Deferred.await(sawStatus)
        yield* Fiber.interrupt(consumer)
        expect(envelope.cursor).toBeUndefined()
        const payload = envelope.event as { data: { status: string; reason?: string } }
        expect(payload.data.status).toBe("degraded")
        expect(payload.data.reason).toBe("ws unavailable")
      }),
    )
  })
})

const runSnapshot = (sessionID: Session.ID, status: WorkflowSchema.RunStatus) =>
  WorkflowSchema.RunInfo.make({
    id: WorkflowSchema.RunID.make("wfr_live"),
    sessionID,
    name: "live-run",
    status,
    scriptPath: "/tmp/wfr_live.mjs",
    tokens: { input: 0, output: 0, reasoning: 0 },
    agentTotal: 0,
    time: { started: DateTime.makeUnsafe(0) },
    phases: [],
    agents: [],
    logs: [],
  })

describe("workflow snapshot events", () => {
  test("session.workflow.updated flows through the live phase, session-scoped and cursorless", async () => {
    await run(
      Effect.gen(function* () {
        const events = yield* Event.Service
        const panels = { attach: () => Effect.void, detach: () => Effect.void }
        const sawWorkflow = yield* Deferred.make<Envelope>()

        const consumer = yield* liveSessionEvents(
          { events, panels },
          { sessionID: SESSION_A, durable: Stream.never },
        ).pipe(
          Stream.runForEach((envelope) =>
            (envelope.event as { type?: string }).type === "session.workflow.updated"
              ? Deferred.succeed(sawWorkflow, envelope)
              : Effect.void,
          ),
          Effect.forkChild,
        )

        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
        // Another session's snapshot must be filtered out.
        yield* events.publish(WorkflowEvent.Updated, {
          sessionID: SESSION_B,
          run: runSnapshot(SESSION_B, "running"),
        })
        yield* events.publish(WorkflowEvent.Updated, {
          sessionID: SESSION_A,
          run: runSnapshot(SESSION_A, "completed"),
        })

        const envelope = yield* Deferred.await(sawWorkflow)
        yield* Fiber.interrupt(consumer)
        expect(envelope.cursor).toBeUndefined()
        const payload = envelope.event as {
          data: { sessionID: string; run: { id: string; status: string; time: { started: unknown } } }
        }
        expect(payload.data.sessionID).toBe(SESSION_A)
        expect(payload.data.run.status).toBe("completed")
        // The snapshot is encoded back to epoch millis on the wire, not a
        // decoded DateTime that JSON.stringify would render as an ISO string
        // (which the TUI's elapsed() would read as NaN).
        expect(typeof payload.data.run.time.started).toBe("number")
        expect(payload.data.run.time.started).toBe(0)
      }),
    )
  })
})
