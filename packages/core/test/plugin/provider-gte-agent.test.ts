import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Option } from "effect"
import { Catalog } from "@gte-agent/core/catalog"
import { Event } from "@gte-agent/core/event"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { Model } from "@gte-agent/core/model"
import { Plugin } from "@gte-agent/core/plugin"
import { GTEAgentProviderPlugin } from "@gte-agent/core/plugin/provider/gte-agent"
import { Provider } from "@gte-agent/core/provider"
import { AbsolutePath } from "@gte-agent/core/schema"
import { runtimeScope } from "../fixture/runtime-scope"
import { it, model, provider, withEnv } from "./provider-helper"

const cost = (input: number, output = 0) => [{ input, output, cache: { read: 0, write: 0 } }]
const runtimeScopeLayer = Layer.succeed(
  RuntimeScope.Service,
  RuntimeScope.Service.of(runtimeScope({ directory: AbsolutePath.make("test") })),
)

describe("GTEAgentProviderPlugin", () => {
  it.effect("uses a public key and disables paid models without credentials", () =>
    withEnv({ GTE_AGENT_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const catalog = yield* Catalog.Service
        yield* plugin.add(GTEAgentProviderPlugin)
        const transform = yield* catalog.transform()
        yield* transform((catalog) => {
          const item = provider("gte-agent")
          catalog.provider.update(item.id, () => {})
          const paid = model("gte-agent", "paid", { cost: cost(1) })
          catalog.model.update(item.id, paid.id, (draft) => {
            draft.cost = [...paid.cost]
          })
        })
        expect((yield* catalog.provider.get(Provider.ID.gteAgent)).request.body.apiKey).toBe("public")
        expect((yield* catalog.model.get(Provider.ID.gteAgent, Model.ID.make("paid"))).enabled).toBe(false)
      }),
    ),
  )

  it.effect("keeps free models without credentials", () =>
    withEnv({ GTE_AGENT_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const catalog = yield* Catalog.Service
        yield* plugin.add(GTEAgentProviderPlugin)
        const transform = yield* catalog.transform()
        yield* transform((catalog) => {
          const item = provider("gte-agent")
          catalog.provider.update(item.id, () => {})
          const free = model("gte-agent", "free", { cost: cost(0) })
          catalog.model.update(item.id, free.id, (draft) => {
            draft.cost = [...free.cost]
          })
        })
        expect((yield* catalog.provider.get(Provider.ID.gteAgent)).request.body.apiKey).toBe("public")
        expect((yield* catalog.model.get(Provider.ID.gteAgent, Model.ID.make("free"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("treats output-only cost as free without credentials", () =>
    withEnv({ GTE_AGENT_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const catalog = yield* Catalog.Service
        yield* plugin.add(GTEAgentProviderPlugin)
        const transform = yield* catalog.transform()
        yield* transform((catalog) => {
          const item = provider("gte-agent")
          catalog.provider.update(item.id, () => {})
          const outputOnly = model("gte-agent", "output-only", { cost: cost(0, 1) })
          catalog.model.update(item.id, outputOnly.id, (draft) => {
            draft.cost = [...outputOnly.cost]
          })
        })
        expect((yield* catalog.provider.get(Provider.ID.gteAgent)).request.body.apiKey).toBe("public")
        expect((yield* catalog.model.get(Provider.ID.gteAgent, Model.ID.make("output-only"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("uses GTE_AGENT_API_KEY as credentials", () =>
    withEnv({ GTE_AGENT_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const catalog = yield* Catalog.Service
        yield* plugin.add(GTEAgentProviderPlugin)
        const transform = yield* catalog.transform()
        yield* transform((catalog) => {
          const item = provider("gte-agent")
          catalog.provider.update(item.id, () => {})
          const paid = model("gte-agent", "paid", { cost: cost(1) })
          catalog.model.update(item.id, paid.id, (draft) => {
            draft.cost = [...paid.cost]
          })
        })
        expect((yield* catalog.provider.get(Provider.ID.gteAgent)).request.body.apiKey).toBeUndefined()
        expect((yield* catalog.model.get(Provider.ID.gteAgent, Model.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("uses configured provider env vars as credentials", () =>
    withEnv({ GTE_AGENT_API_KEY: undefined, CUSTOM_GTE_AGENT_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const catalog = yield* Catalog.Service
        yield* plugin.add(GTEAgentProviderPlugin)
        const transform = yield* catalog.transform()
        yield* transform((catalog) => {
          const item = provider("gte-agent", { env: ["CUSTOM_GTE_AGENT_API_KEY"] })
          catalog.provider.update(item.id, (draft) => {
            draft.env = [...item.env]
          })
          const paid = model("gte-agent", "paid", { cost: cost(1) })
          catalog.model.update(item.id, paid.id, (draft) => {
            draft.cost = [...paid.cost]
          })
        })
        expect((yield* catalog.provider.get(Provider.ID.gteAgent)).request.body.apiKey).toBeUndefined()
        expect((yield* catalog.model.get(Provider.ID.gteAgent, Model.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("uses configured apiKey as credentials", () =>
    withEnv({ GTE_AGENT_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const catalog = yield* Catalog.Service
        yield* plugin.add(GTEAgentProviderPlugin)
        const transform = yield* catalog.transform()
        yield* transform((catalog) => {
          const item = provider("gte-agent", {
            request: {
              headers: {},
              body: { apiKey: "configured" },
            },
          })
          catalog.provider.update(item.id, (draft) => {
            draft.request = item.request
          })
          const paid = model("gte-agent", "paid", { cost: cost(1) })
          catalog.model.update(item.id, paid.id, (draft) => {
            draft.cost = [...paid.cost]
          })
        })
        expect((yield* catalog.provider.get(Provider.ID.gteAgent)).request.body.apiKey).toBe("configured")
        expect((yield* catalog.model.get(Provider.ID.gteAgent, Model.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("ignores non-gte-agent providers and models", () =>
    withEnv({ GTE_AGENT_API_KEY: undefined }, () =>
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const catalog = yield* Catalog.Service
        yield* plugin.add(GTEAgentProviderPlugin)
        const transform = yield* catalog.transform()
        yield* transform((catalog) => {
          const item = provider("openai")
          catalog.provider.update(item.id, () => {})
          const paid = model("openai", "paid", { cost: cost(1) })
          catalog.model.update(item.id, paid.id, (draft) => {
            draft.cost = [...paid.cost]
          })
        })
        expect((yield* catalog.provider.get(Provider.ID.openai)).request.body.apiKey).toBeUndefined()
        expect((yield* catalog.model.get(Provider.ID.openai, Model.ID.make("paid"))).enabled).toBe(true)
      }),
    ),
  )

  it.effect("prefers gpt-5-nano as the gte-agent small model", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.gteAgent

      const transform = yield* catalog.transform()
      yield* transform((catalog) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, Model.ID.make("cheap-mini"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [...cost(1, 1)]
          model.time.released = DateTime.makeUnsafe(Date.now())
        })
        catalog.model.update(providerID, Model.ID.make("gpt-5-nano"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [...cost(10, 10)]
          model.time.released = DateTime.makeUnsafe(Date.now())
        })
      })

      const selected = yield* catalog.model.small(providerID)

      expect(Option.getOrUndefined(selected)?.id).toBe(Model.ID.make("gpt-5-nano"))
    }).pipe(
      Effect.provide(Catalog.runtimeScopeLayer.pipe(Layer.provide(Event.defaultLayer), Layer.provide(runtimeScopeLayer))),
    ),
  )
})
