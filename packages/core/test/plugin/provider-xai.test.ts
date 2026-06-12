import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Event } from "@gte-agent/core/event"
import { Model } from "@gte-agent/core/model"
import { Plugin } from "@gte-agent/core/plugin"
import { XAIPlugin } from "@gte-agent/core/plugin/provider/xai"
import { Provider } from "@gte-agent/core/provider"
import { testEffect } from "../lib/effect"
import { fakeSelectorSdk } from "./provider-helper"

const it = testEffect(Plugin.runtimeScopeLayer.pipe(Layer.provide(Event.defaultLayer)))

const model = new Model.Info({
  ...Model.Info.empty(Provider.ID.make("xai"), Model.ID.make("grok-4")),
  api: {
    id: Model.ID.make("grok-4"),
    type: "aisdk",
    package: "@ai-sdk/xai",
  },
})

describe("XAIPlugin", () => {
  it.effect("creates an xAI SDK only for @ai-sdk/xai", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      yield* plugin.add(XAIPlugin)

      const ignored = yield* plugin.trigger(
        "aisdk.sdk",
        { model, package: "@ai-sdk/openai-compatible", options: {} },
        {},
      )

      const result = yield* plugin.trigger("aisdk.sdk", { model, package: "@ai-sdk/xai", options: {} }, {})

      expect(ignored.sdk).toBeUndefined()
      expect(typeof result.sdk?.responses).toBe("function")
    }),
  )

  it.effect("creates xAI SDKs for custom provider IDs", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const providers: string[] = []

      yield* plugin.add(XAIPlugin)
      yield* plugin.add(
        Plugin.define({
          id: Plugin.ID.make("xai-sdk-name-observer"),
          effect: Effect.gen(function* () {
            return {
              "aisdk.sdk": Effect.fn(function* (evt) {
                if (!evt.sdk) return
                providers.push(evt.sdk.responses("grok-4").provider)
              }),
            }
          }),
        }),
      )

      yield* plugin.trigger(
        "aisdk.sdk",
        {
          model: new Model.Info({ ...model, providerID: Provider.ID.make("custom-xai") }),
          package: "@ai-sdk/xai",
          options: {},
        },
        {},
      )

      expect(providers).toEqual(["xai.responses"])
    }),
  )

  it.effect("uses responses with the model api.id for xAI language models", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const calls: string[] = []

      yield* plugin.add(XAIPlugin)
      const result = yield* plugin.trigger(
        "aisdk.language",
        {
          model: new Model.Info({ ...model, id: Model.ID.make("alias") }),
          sdk: fakeSelectorSdk(calls),
          options: {},
        },
        {},
      )

      expect(calls).toEqual(["responses:grok-4"])
      expect(result.language).toBeDefined()
    }),
  )

  it.effect("ignores non-xAI providers", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const calls: string[] = []

      yield* plugin.add(XAIPlugin)
      const result = yield* plugin.trigger(
        "aisdk.language",
        {
          model: new Model.Info({ ...model, providerID: Provider.ID.openai }),
          sdk: fakeSelectorSdk(calls),
          options: {},
        },
        {},
      )

      expect(calls).toEqual([])
      expect(result.language).toBeUndefined()
    }),
  )
})
