import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@gte-agent/core/catalog"
import { Plugin } from "@gte-agent/core/plugin"
import { ProviderPlugins } from "@gte-agent/core/plugin/provider"
import { ZenmuxPlugin } from "@gte-agent/core/plugin/provider/zenmux"
import { Provider } from "@gte-agent/core/provider"
import { expectPluginRegistered, it, provider } from "./provider-helper"

describe("ZenmuxPlugin", () => {
  it.effect("is registered so GTE Agent referer headers can be applied", () =>
    Effect.sync(() =>
      expectPluginRegistered(
        ProviderPlugins.map((item) => item.id),
        "zenmux",
      ),
    ),
  )

  it.effect("applies the exact GTE Agent Zenmux headers", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const catalog = yield* Catalog.Service
      yield* plugin.add(ZenmuxPlugin)
      const transform = yield* catalog.transform()
      yield* transform((catalog) => {
        const item = provider("zenmux", {
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://zenmux.ai/api/v1" },
        })
        catalog.provider.update(item.id, (draft) => {
          draft.api = item.api
        })
      })
      const result = yield* catalog.provider.get(Provider.ID.make("zenmux"))
      expect(result.request.headers).toEqual({ "HTTP-Referer": "https://gte-agent.ai/", "X-Title": "gte-agent" })
      expect(Object.keys(result.request.headers).sort()).toEqual(["HTTP-Referer", "X-Title"])
    }),
  )

  it.effect("merges GTE Agent Zenmux headers with existing headers", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const catalog = yield* Catalog.Service
      yield* plugin.add(ZenmuxPlugin)
      const transform = yield* catalog.transform()
      yield* transform((catalog) => {
        const item = provider("zenmux", {
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://zenmux.ai/api/v1" },
          request: { headers: { Existing: "value" }, body: {} },
        })
        catalog.provider.update(item.id, (draft) => {
          draft.api = item.api
          draft.request = item.request
        })
      })

      expect((yield* catalog.provider.get(Provider.ID.make("zenmux"))).request.headers).toEqual({
        Existing: "value",
        "HTTP-Referer": "https://gte-agent.ai/",
        "X-Title": "gte-agent",
      })
    }),
  )

  it.effect("lets configured Zenmux GTE Agent headers override defaults", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const catalog = yield* Catalog.Service
      yield* plugin.add(ZenmuxPlugin)
      const transform = yield* catalog.transform()
      yield* transform((catalog) => {
        const item = provider("zenmux", {
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://zenmux.ai/api/v1" },
          request: {
            headers: { "HTTP-Referer": "https://example.com/", "X-Title": "custom-title" },
            body: {},
          },
        })
        catalog.provider.update(item.id, (draft) => {
          draft.api = item.api
          draft.request = item.request
        })
      })

      expect((yield* catalog.provider.get(Provider.ID.make("zenmux"))).request.headers).toEqual({
        "HTTP-Referer": "https://example.com/",
        "X-Title": "custom-title",
      })
    }),
  )

  it.effect("guards GTE Agent Zenmux headers to the exact zenmux provider id", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const catalog = yield* Catalog.Service
      yield* plugin.add(ZenmuxPlugin)
      const transform = yield* catalog.transform()
      yield* transform((catalog) => {
        const item = provider("openrouter", {
          request: {
            headers: { "HTTP-Referer": "https://example.com/", "X-Title": "custom-title" },
            body: {},
          },
        })
        catalog.provider.update(item.id, (draft) => {
          draft.request = item.request
        })
      })

      expect((yield* catalog.provider.get(Provider.ID.openrouter)).request.headers).toEqual({
        "HTTP-Referer": "https://example.com/",
        "X-Title": "custom-title",
      })
    }),
  )
})
