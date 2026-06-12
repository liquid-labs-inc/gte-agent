import { describe, expect } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { Event } from "@gte-agent/core/event"
import { ModelsDev } from "@gte-agent/core/models-dev"
import { it } from "./lib/effect"

// Milestone 7 replaced the models.dev network catalog with the curated,
// static, GTE-owned list in src/catalog-curated.ts (covered by
// catalog-curated.test.ts). ModelsDev survives only as an explicit no-op so
// the legacy plugin surface keeps compiling; these tests pin that behavior:
// no network, no disk cache, no refresh events.
describe("ModelsDev Service", () => {
  it.effect("get() returns an empty catalog", () =>
    Effect.gen(function* () {
      const svc = yield* ModelsDev.Service
      expect(yield* svc.get()).toEqual({})
    }).pipe(Effect.provide(ModelsDev.layer)),
  )

  it.effect("refresh() is a no-op and never publishes a refresh event", () =>
    Effect.gen(function* () {
      const events = yield* Event.Service
      const seen: unknown[] = []
      yield* events.subscribe(ModelsDev.ModelsDevEvent.Refreshed).pipe(
        Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
        Effect.forkScoped({ startImmediately: true }),
      )

      const svc = yield* ModelsDev.Service
      yield* svc.refresh()
      yield* svc.refresh(true)
      yield* Effect.yieldNow

      expect(seen).toEqual([])
      expect(yield* svc.get()).toEqual({})
    }).pipe(Effect.provide(Layer.mergeAll(ModelsDev.layer, Event.defaultLayer))),
  )
})
