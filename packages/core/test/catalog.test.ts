import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Option } from "effect"
import { Catalog } from "@gte-agent/core/catalog"
import { Event } from "@gte-agent/core/event"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { Model } from "@gte-agent/core/model"
import { Plugin } from "@gte-agent/core/plugin"
import { Policy } from "@gte-agent/core/policy"
import { Project } from "@gte-agent/core/project"
import { Provider } from "@gte-agent/core/provider"
import { AbsolutePath } from "@gte-agent/core/schema"
import { runtimeScope } from "./fixture/runtime-scope"
import { testEffect } from "./lib/effect"

const runtimeScopeLayer = Layer.succeed(
  RuntimeScope.Service,
  RuntimeScope.Service.of(runtimeScope({ directory: AbsolutePath.make("test") })),
)
const it = testEffect(
  Catalog.runtimeScopeLayer.pipe(Layer.provideMerge(Event.defaultLayer), Layer.provideMerge(runtimeScopeLayer)),
)

describe("Catalog", () => {
  it.effect("normalizes provider baseURL into api url", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("test")
      const transform = yield* catalog.transform()

      yield* transform((catalog) =>
        catalog.provider.update(providerID, (provider) => {
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://default.example.com",
          }
          provider.request.body.baseURL = "https://override.example.com"
        }),
      )

      expect((yield* catalog.provider.get(providerID)).api).toEqual({
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "https://override.example.com",
      })
    }),
  )

  it.effect("normalizes model baseURL into api url", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("test")
      const modelID = Model.ID.make("model")
      const transform = yield* catalog.transform()

      yield* transform((catalog) => {
        catalog.provider.update(providerID, (provider) => {
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://provider.example.com",
          }
        })
        catalog.model.update(providerID, modelID, (model) => {
          model.api = {
            id: modelID,
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://model.example.com",
          }
          model.request.body.baseURL = "https://override.example.com"
        })
      })

      expect((yield* catalog.model.get(providerID, modelID)).api).toEqual({
        id: modelID,
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "https://override.example.com",
        settings: {},
      })
    }),
  )

  it.effect("resolves default model api from provider api", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("test")
      const modelID = Model.ID.make("model")
      const transform = yield* catalog.transform()

      yield* transform((catalog) => {
        catalog.provider.update(providerID, (provider) => {
          provider.api = {
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://provider.example.com",
          }
        })
        catalog.model.update(providerID, modelID, () => {})
      })

      expect((yield* catalog.model.get(providerID, modelID)).api).toEqual({
        id: modelID,
        type: "aisdk",
        package: "@ai-sdk/openai-compatible",
        url: "https://provider.example.com",
      })
    }),
  )

  it.effect("runs catalog transform hooks after baseURL is normalized", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const plugin = yield* Plugin.Service
      const providerID = Provider.ID.make("test")
      const seen: unknown[] = []
      const transform = yield* catalog.transform()

      yield* plugin.add({
        id: Plugin.ID.make("test"),
        effect: Effect.succeed({
          "catalog.transform": (evt) =>
            Effect.sync(() => {
              const item = evt.provider.get(providerID)
              if (!item) return
              seen.push(item.provider.api.type)
              if (item?.provider.api.type === "aisdk") seen.push(item.provider.api.url)
              seen.push(item?.provider.request.body.baseURL)
            }),
        }),
      })
      yield* transform((catalog) =>
        catalog.provider.update(providerID, (provider) => {
          provider.api = { type: "aisdk", package: "@ai-sdk/openai-compatible" }
          provider.request.body.baseURL = "https://provider.example.com"
        }),
      )

      expect(seen).toEqual(["aisdk", "https://provider.example.com", undefined])
    }),
  )

  it.effect("runs catalog transform when a plugin is added", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const plugin = yield* Plugin.Service
      const providerID = Provider.ID.make("test")
      const transform = yield* catalog.transform()

      yield* transform((catalog) =>
        catalog.provider.update(providerID, (provider) => {
          provider.name = "Before"
        }),
      )
      yield* plugin.add({
        id: Plugin.ID.make("test-transform"),
        effect: Effect.succeed({
          "catalog.transform": (evt) =>
            Effect.sync(() =>
              evt.provider.update(providerID, (provider) => {
                provider.name = "After"
              }),
            ),
        }),
      })
      yield* Effect.yieldNow

      expect((yield* catalog.provider.get(providerID)).name).toBe("After")
    }),
  )

  it.effect("ignores plugin additions from another runtime scope", () =>
    Effect.gen(function* () {
      const events = yield* Event.Service
      const plugin = yield* Plugin.Service
      let invoked = 0

      yield* plugin.add({
        id: Plugin.ID.make("test-transform"),
        effect: Effect.succeed({
          "catalog.transform": () => Effect.sync(() => invoked++),
        }),
      })
      yield* Effect.yieldNow
      expect(invoked).toBe(1)

      yield* events.publish(
        Plugin.PluginEvent.Added,
        { id: Plugin.ID.make("test-transform") },
        {
          runtimeScope: {
            directory: AbsolutePath.make("other"),
          },
        },
      )
      yield* Effect.yieldNow

      expect(invoked).toBe(1)
    }),
  )

  it.effect("resolves provider and model request merges", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("test")
      const modelID = Model.ID.make("model")
      const transform = yield* catalog.transform()

      yield* transform((catalog) => {
        catalog.provider.update(providerID, (provider) => {
          provider.request.headers.provider = "provider"
          provider.request.headers.shared = "provider"
          provider.request.body.provider = true
        })
        catalog.model.update(providerID, modelID, (model) => {
          model.request.headers.model = "model"
          model.request.headers.shared = "model"
          model.request.body.model = true
          model.request.body.request = true
        })
      })

      const model = yield* catalog.model.get(providerID, modelID)
      expect(model.request.headers).toEqual({ provider: "provider", shared: "model", model: "model" })
      expect(model.request.body).toEqual({ provider: true, model: true, request: true })
    }),
  )

  it.effect("falls back to newest available model when no default is configured", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("test")
      const transform = yield* catalog.transform()

      yield* transform((catalog) => {
        catalog.provider.update(providerID, (provider) => {
          provider.enabled = { via: "custom", data: {} }
        })
        catalog.model.update(providerID, Model.ID.make("old"), (model) => {
          model.time.released = DateTime.makeUnsafe(1000)
        })
        catalog.model.update(providerID, Model.ID.make("new"), (model) => {
          model.time.released = DateTime.makeUnsafe(2000)
        })
      })

      expect(Option.getOrUndefined(yield* catalog.model.default())?.id).toMatch("new")
    }),
  )

  it.effect("uses a transform-provided default model until that transform is replaced", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("test")
      const old = Model.ID.make("old")
      const newest = Model.ID.make("new")
      const transform = yield* catalog.transform()

      const models = (catalog: Catalog.Editor) => {
        catalog.provider.update(providerID, (provider) => {
          provider.enabled = { via: "custom", data: {} }
        })
        catalog.model.update(providerID, old, (model) => {
          model.time.released = DateTime.makeUnsafe(1000)
        })
        catalog.model.update(providerID, newest, (model) => {
          model.time.released = DateTime.makeUnsafe(2000)
        })
      }

      yield* transform((catalog) => {
        models(catalog)
        catalog.model.default.set(providerID, old)
      })
      expect(Option.getOrUndefined(yield* catalog.model.default())?.id).toBe(old)

      yield* transform(models)
      expect(Option.getOrUndefined(yield* catalog.model.default())?.id).toBe(newest)
    }),
  )

  it.effect("small model prefers small keyword candidates before cost scoring", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("test")
      const transform = yield* catalog.transform()

      yield* transform((catalog) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, Model.ID.make("cheap-large"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [{ input: 1, output: 1, cache: { read: 0, write: 0 } }]
          model.time.released = DateTime.makeUnsafe(Date.now())
        })
        catalog.model.update(providerID, Model.ID.make("expensive-mini"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [{ input: 10, output: 10, cache: { read: 0, write: 0 } }]
          model.time.released = DateTime.makeUnsafe(Date.now())
        })
      })

      expect(Option.getOrUndefined(yield* catalog.model.small(providerID))?.id).toMatch("expensive-mini")
    }),
  )

  it.effect("removes providers denied by policy after loading", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const policy = yield* Policy.Service
      const providerID = Provider.ID.make("blocked")
      const transform = yield* catalog.transform()

      yield* policy.load([new Policy.Info({ effect: "deny", action: "provider.use", resource: "blocked" })])
      yield* transform((catalog) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, Model.ID.make("model"), () => {})
      })

      expect(yield* catalog.provider.all()).toEqual([])
      expect(yield* catalog.model.all()).toEqual([])
      expect(yield* catalog.provider.get(providerID).pipe(Effect.option)).toEqual(Option.none())
    }),
  )
})
