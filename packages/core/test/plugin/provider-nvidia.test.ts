import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@gte-agent/core/catalog"
import { Plugin } from "@gte-agent/core/plugin"
import { ProviderPlugins } from "@gte-agent/core/plugin/provider"
import { NvidiaPlugin } from "@gte-agent/core/plugin/provider/nvidia"
import { Provider } from "@gte-agent/core/provider"
import { expectPluginRegistered, it, provider } from "./provider-helper"

describe("NvidiaPlugin", () => {
  it.effect("is registered so GTE Agent referer headers can be applied", () =>
    Effect.sync(() =>
      expectPluginRegistered(
        ProviderPlugins.map((item) => item.id),
        "nvidia",
      ),
    ),
  )

  it.effect("applies NVIDIA tracking headers only to nvidia", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const catalog = yield* Catalog.Service
      yield* plugin.add(NvidiaPlugin)
      const transform = yield* catalog.transform()
      yield* transform((catalog) => {
        const nvidia = provider("nvidia", {
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://integrate.api.nvidia.com/v1" },
          request: { headers: { Existing: "value" }, body: {} },
        })
        catalog.provider.update(nvidia.id, (draft) => {
          draft.api = nvidia.api
          draft.request = nvidia.request
        })
        catalog.provider.update(provider("openrouter").id, () => {})
      })
      expect((yield* catalog.provider.get(Provider.ID.make("nvidia"))).request.headers).toEqual({
        Existing: "value",
        "HTTP-Referer": "https://gte-agent.ai/",
        "X-Title": "gte-agent",
        "X-BILLING-INVOKE-ORIGIN": "GTE Agent",
      })
      expect((yield* catalog.provider.get(Provider.ID.openrouter)).request.headers).toEqual({})
    }),
  )

  it.effect("adds billing origin for custom NVIDIA endpoints", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const catalog = yield* Catalog.Service
      yield* plugin.add(NvidiaPlugin)
      const transform = yield* catalog.transform()
      yield* transform((catalog) => {
        const item = provider("nvidia", {
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://integrate.api.nvidia.com/v1" },
          request: { headers: {}, body: {} },
        })
        catalog.provider.update(item.id, (draft) => {
          draft.api = item.api
          draft.request = item.request
        })
      })

      expect((yield* catalog.provider.get(Provider.ID.make("nvidia"))).request.headers).toEqual({
        "HTTP-Referer": "https://gte-agent.ai/",
        "X-Title": "gte-agent",
        "X-BILLING-INVOKE-ORIGIN": "GTE Agent",
      })
    }),
  )

  it.effect("preserves an explicit NVIDIA billing origin header", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const catalog = yield* Catalog.Service
      yield* plugin.add(NvidiaPlugin)
      const transform = yield* catalog.transform()
      yield* transform((catalog) => {
        const item = provider("nvidia", {
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: "https://integrate.api.nvidia.com/v1" },
          request: {
            headers: { "X-BILLING-INVOKE-ORIGIN": "CustomOrigin" },
            body: { baseURL: "https://integrate.api.nvidia.com/v1" },
          },
        })
        catalog.provider.update(item.id, (draft) => {
          draft.api = item.api
          draft.request = item.request
        })
      })

      expect((yield* catalog.provider.get(Provider.ID.make("nvidia"))).request.headers).toEqual({
        "HTTP-Referer": "https://gte-agent.ai/",
        "X-Title": "gte-agent",
        "X-BILLING-INVOKE-ORIGIN": "CustomOrigin",
      })
    }),
  )
})
