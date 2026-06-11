import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { GtePanelEvent } from "@gte-agent/core/gte-data/panel-event"
import { GtePanelKey } from "@gte-agent/core/gte-data/panel-key"
import { GtePanelManager } from "@gte-agent/core/gte-data/panel-manager"
import { GteStreams } from "@gte-agent/core/gte-data/streams"
import { Project } from "@gte-agent/core/project"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { Session } from "@gte-agent/core/session"
import { SessionExecution } from "@gte-agent/core/session/execution"
import { SessionProjector } from "@gte-agent/core/session/projector"
import { SessionStore } from "@gte-agent/core/session/store"
import { testEffect } from "./lib/effect"

const ADDRESS = "0x52908400098527886e0f7030069857d2e4169ee7"
const THROTTLE_MS = 60

/** Controllable stub for the gte-ts stream surface. */
function makeStubStreams(options?: { failWith?: string }) {
  const active = new Map<string, { onData: (data: unknown) => void; onError: (error: Error) => void }>()
  const id = (panel: string, key: string) => `${panel}:${key}`
  const service = GteStreams.Service.of({
    env: "hyperliquid-dev",
    subscribe: ({ panel, key, onData, onError }) =>
      options?.failWith !== undefined
        ? Effect.fail(new GteStreams.SubscribeError({ panel, key, message: options.failWith }))
        : Effect.sync(() => {
            active.set(id(panel, key), { onData, onError })
            return () => {
              active.delete(id(panel, key))
            }
          }),
  })
  return {
    service,
    active,
    push(panel: string, key: string, data: unknown) {
      active.get(id(panel, key))?.onData(data)
    },
    fail(panel: string, key: string, message: string) {
      active.get(id(panel, key))?.onError(new Error(message))
    },
  }
}

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

function harness(options?: { failWith?: string; throttleMs?: number }) {
  const stub = makeStubStreams(options)
  const manager = GtePanelManager.layerWith({ throttleMs: options?.throttleMs ?? THROTTLE_MS }).pipe(
    Layer.provide(events),
    Layer.provide(store),
    Layer.provide(Layer.succeed(GteStreams.Service, stub.service)),
    Layer.provide(database),
  )
  const layer = Layer.mergeAll(database, events, projects, projector, store, sessions, manager)
  return { stub, layer }
}

const runtimeScope = RuntimeScope.Ref.make({ directory: AbsolutePath.make("/project") })

const sleep = (ms: number) => Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)))

const waitUntil = (predicate: () => boolean, timeoutMs = 2_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("waitUntil timed out"))
      yield* sleep(10)
    }
  })

/** Collects panel events synchronously via the event listener hook. */
const collectPanelEvents = Effect.gen(function* () {
  const bus = yield* Event.Service
  const updates: Array<Event.Data<typeof GtePanelEvent.Updated>> = []
  const statuses: Array<Event.Data<typeof GtePanelEvent.Status>> = []
  yield* bus.listen((event) =>
    Effect.sync(() => {
      if (event.type === GtePanelEvent.Updated.type) {
        updates.push(event.data as Event.Data<typeof GtePanelEvent.Updated>)
      }
      if (event.type === GtePanelEvent.Status.type) {
        statuses.push(event.data as Event.Data<typeof GtePanelEvent.Status>)
      }
    }),
  )
  return { updates, statuses }
})

const createPinnedSession = (panels: Session.PinnedPanels) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const info = yield* session.create({ runtimeScope })
    yield* session.updateIntent({ sessionID: info.id, pinnedPanels: panels })
    return info.id
  })

describe("GtePanelManager", () => {
  {
    const { stub, layer } = harness()
    const it = testEffect(layer)
    it.live("activates pinned panels on first attach and publishes throttled updates", () =>
      Effect.gen(function* () {
        const collected = yield* collectPanelEvents
        const manager = yield* GtePanelManager.Service
        const sessionID = yield* createPinnedSession([{ panel: "book", key: "ETH-USD" }])

        yield* manager.attach(sessionID)
        yield* waitUntil(() => stub.active.has("book:ETH-USD"))
        yield* waitUntil(() => collected.statuses.some((status) => status.status === "live"))

        // Burst of five frames: leading emit + one trailing coalesced emit.
        for (let frame = 1; frame <= 5; frame++) stub.push("book", "ETH-USD", { frame })
        yield* sleep(THROTTLE_MS * 3)
        expect(collected.updates.length).toBe(2)
        expect(collected.updates[0].data).toEqual({ frame: 1 })
        expect(collected.updates[1].data).toEqual({ frame: 5 })

        const update = collected.updates[0]
        expect(update.sessionID).toBe(sessionID)
        expect(update.panel).toBe("book")
        expect(update.key).toBe("ETH-USD")
        expect(update.provenance.source).toBe("ws")
        expect(update.provenance.env).toBe("hyperliquid-dev")
        expect(update.provenance.symbol).toBe("ETH-USD")

        yield* manager.detach(sessionID)
        yield* waitUntil(() => !stub.active.has("book:ETH-USD"))
      }),
    )
  }

  {
    const { stub, layer } = harness()
    const it = testEffect(layer)
    it.live("diffs subscriptions when session intent changes", () =>
      Effect.gen(function* () {
        const collected = yield* collectPanelEvents
        const manager = yield* GtePanelManager.Service
        const session = yield* Session.Service
        const sessionID = yield* createPinnedSession([{ panel: "book", key: "ETH-USD" }])

        yield* manager.attach(sessionID)
        yield* waitUntil(() => stub.active.has("book:ETH-USD"))

        yield* session.updateIntent({
          sessionID,
          pinnedPanels: [{ panel: "trades", key: "BTC-USD" }, { panel: "balances", key: ADDRESS }],
        })
        yield* waitUntil(
          () => !stub.active.has("book:ETH-USD") && stub.active.has("trades:BTC-USD") && stub.active.has(`balances:${ADDRESS}`),
        )
        expect(
          collected.statuses.some((status) => status.panel === "book" && status.status === "closed"),
        ).toBe(true)
        const active = yield* manager.active(sessionID)
        expect(active.map((pin) => pin.panel).toSorted()).toEqual(["balances", "trades"])

        // Address panels get address provenance.
        stub.push("balances", ADDRESS, { total: 1 })
        yield* waitUntil(() => collected.updates.length > 0)
        expect(collected.updates[0].provenance.address).toBe(ADDRESS)

        yield* manager.detach(sessionID)
        yield* waitUntil(() => stub.active.size === 0)
      }),
    )
  }

  {
    const { stub, layer } = harness()
    const it = testEffect(layer)
    it.live("publishes degraded on stream error and recovers to live when data resumes", () =>
      Effect.gen(function* () {
        const collected = yield* collectPanelEvents
        const manager = yield* GtePanelManager.Service
        const sessionID = yield* createPinnedSession([{ panel: "trades", key: "ETH-USD" }])

        yield* manager.attach(sessionID)
        yield* waitUntil(() => stub.active.has("trades:ETH-USD"))

        stub.fail("trades", "ETH-USD", "ws connection lost")
        yield* waitUntil(() =>
          collected.statuses.some((status) => status.status === "degraded" && status.reason === "ws connection lost"),
        )

        stub.push("trades", "ETH-USD", [{ price: "1" }])
        yield* waitUntil(() => collected.statuses.filter((status) => status.status === "live").length >= 2)
        yield* waitUntil(() => collected.updates.length >= 1)

        yield* manager.detach(sessionID)
      }),
    )
  }

  {
    const { stub, layer } = harness({ failWith: "no network" })
    const it = testEffect(layer)
    it.live("publishes degraded when the subscription itself cannot be established", () =>
      Effect.gen(function* () {
        const collected = yield* collectPanelEvents
        const manager = yield* GtePanelManager.Service
        const sessionID = yield* createPinnedSession([{ panel: "book", key: "ETH-USD" }])

        yield* manager.attach(sessionID)
        yield* waitUntil(() => collected.statuses.some((status) => status.status === "degraded"))
        expect(collected.statuses[0].reason).toContain("no network")
        expect(stub.active.size).toBe(0)
        yield* manager.detach(sessionID)
      }),
    )
  }

  {
    // Long throttle so the trailing timer is deterministically still pending
    // when the panel is unpinned.
    const { stub, layer } = harness({ throttleMs: 500 })
    const it = testEffect(layer)
    it.live("unpinning a panel with a pending throttled update emits nothing after close", () =>
      Effect.gen(function* () {
        const collected = yield* collectPanelEvents
        const manager = yield* GtePanelManager.Service
        const session = yield* Session.Service
        const sessionID = yield* createPinnedSession([{ panel: "book", key: "ETH-USD" }])

        yield* manager.attach(sessionID)
        yield* waitUntil(() => stub.active.has("book:ETH-USD"))

        // Leading emit goes out immediately; the second frame parks in the
        // trailing throttle slot behind a 500ms timer.
        stub.push("book", "ETH-USD", { frame: 1 })
        stub.push("book", "ETH-USD", { frame: 2 })
        yield* waitUntil(() => collected.updates.length === 1)

        // Unpin while that timer is pending: the subscription must be torn
        // down and the parked frame dropped.
        yield* session.updateIntent({ sessionID, pinnedPanels: [] })
        yield* waitUntil(() => !stub.active.has("book:ETH-USD"))
        yield* waitUntil(() => collected.statuses.some((status) => status.status === "closed"))

        // Wait past the throttle window: no post-unsubscribe emission.
        yield* sleep(600)
        expect(collected.updates.length).toBe(1)
        expect(collected.updates[0].data).toEqual({ frame: 1 })

        yield* manager.detach(sessionID)
      }),
    )
  }

  {
    const { stub, layer } = harness()
    const it = testEffect(layer)
    it.live("refcounts attach/detach: panels stay live until the last consumer detaches", () =>
      Effect.gen(function* () {
        const manager = yield* GtePanelManager.Service
        const sessionID = yield* createPinnedSession([{ panel: "marketData", key: "ETH-USD" }])

        yield* manager.attach(sessionID)
        yield* manager.attach(sessionID)
        yield* waitUntil(() => stub.active.has("marketData:ETH-USD"))

        yield* manager.detach(sessionID)
        yield* sleep(50)
        expect(stub.active.has("marketData:ETH-USD")).toBe(true)

        yield* manager.detach(sessionID)
        yield* waitUntil(() => !stub.active.has("marketData:ETH-USD"))
        expect(yield* manager.active(sessionID)).toEqual([])
      }),
    )
  }
})

describe("GtePanelKey", () => {
  const plain = testEffect(Layer.empty)
  plain.effect("classifies market, address, and global panel keys", () =>
    Effect.sync(() => {
      expect(GtePanelKey.targetFor("book", "ETH-USD")).toEqual({ ok: true, target: { kind: "market", symbol: "ETH-USD" } })
      expect(GtePanelKey.targetFor("candles", "ETH-USD@5m")).toEqual({
        ok: true,
        target: { kind: "market", symbol: "ETH-USD", interval: "5m" },
      })
      expect(GtePanelKey.targetFor("candles", "ETH-USD")).toEqual({
        ok: true,
        target: { kind: "market", symbol: "ETH-USD", interval: "1m" },
      })
      expect(GtePanelKey.targetFor("balances", ADDRESS)).toEqual({
        ok: true,
        target: { kind: "address", address: ADDRESS },
      })
      expect(GtePanelKey.targetFor("benchMetrics", "global")).toEqual({ ok: true, target: { kind: "global" } })
      expect(GtePanelKey.targetFor("positions", "not-an-address").ok).toBe(false)
      expect(GtePanelKey.targetFor("candles", "ETH-USD@bogus").ok).toBe(false)
      expect(GtePanelKey.candleKey("ETH-USD", "5m")).toBe("ETH-USD@5m")
    }),
  )
})
