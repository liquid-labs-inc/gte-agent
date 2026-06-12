import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { Event } from "@gte-agent/core/event"
import { Plugin } from "@gte-agent/core/plugin"
import { State } from "@gte-agent/core/state"
import { it } from "./lib/effect"

const events = Layer.mock(Event.Service)({
  publish: (definition, data) =>
    Effect.succeed({
      id: Event.ID.make("evt_plugin_test"),
      type: definition.type,
      data,
    }),
})
const plugins = Plugin.layer.pipe(Layer.provide(events))

function state() {
  return State.create({
    initial: () => ({ values: [] as string[] }),
    editor: (draft) => ({
      add: (value: string) => draft.values.push(value),
    }),
  })
}

describe("Plugin", () => {
  it.effect("closes plugin-owned scopes when the registry layer finalizes", () =>
    Effect.gen(function* () {
      const values = state()
      const layerScope = yield* Scope.fork(yield* Scope.Scope)
      const plugin = Context.get(yield* Layer.buildWithScope(Layer.fresh(plugins), layerScope), Plugin.Service)

      yield* plugin.add({
        id: Plugin.ID.make("scoped"),
        effect: Effect.gen(function* () {
          const transform = yield* values.transform()
          yield* transform((editor) => editor.add("scoped"))
        }),
      })
      expect(values.get().values).toEqual(["scoped"])

      yield* Scope.close(layerScope, Exit.void)
      expect(values.get().values).toEqual([])
    }),
  )

  it.effect("serializes same-ID additions and leaves one removable contribution", () =>
    Effect.gen(function* () {
      const values = state()
      const layerScope = yield* Scope.fork(yield* Scope.Scope)
      const plugin = Context.get(yield* Layer.buildWithScope(Layer.fresh(plugins), layerScope), Plugin.Service)
      const id = Plugin.ID.make("shared")
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()

      const first = yield* plugin
        .add({
          id,
          effect: Effect.gen(function* () {
            const transform = yield* values.transform()
            yield* transform((editor) => editor.add("first"))
            yield* Deferred.succeed(firstStarted, undefined)
            yield* Deferred.await(releaseFirst)
          }),
        })
        .pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)

      const second = yield* plugin
        .add({
          id,
          effect: Effect.gen(function* () {
            const transform = yield* values.transform()
            yield* transform((editor) => editor.add("second"))
          }),
        })
        .pipe(Effect.forkChild({ startImmediately: true }))
      expect(values.get().values).toEqual(["first"])

      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(values.get().values).toEqual(["second"])

      yield* plugin.remove(id)
      expect(values.get().values).toEqual([])
    }),
  )
})
