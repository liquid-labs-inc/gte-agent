import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AISDK } from "@gte-agent/core/aisdk"
import { Event } from "@gte-agent/core/event"
import { Model } from "@gte-agent/core/model"
import { Plugin } from "@gte-agent/core/plugin"
import { GooglePlugin } from "@gte-agent/core/plugin/provider/google"
import { testEffect } from "../lib/effect"
import { it, model } from "./provider-helper"

const itWithAISDK = testEffect(
  AISDK.layer.pipe(Layer.provideMerge(Plugin.runtimeScopeLayer.pipe(Layer.provide(Event.defaultLayer)))),
)

describe("GooglePlugin", () => {
  it.effect("creates a Google Generative AI SDK for @ai-sdk/google using the provider ID as SDK name", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      yield* plugin.add(GooglePlugin)
      const result = yield* plugin.trigger(
        "aisdk.sdk",
        {
          model: model("custom-google", "gemini"),
          package: "@ai-sdk/google",
          options: { name: "custom-google", apiKey: "test" },
        },
        {},
      )
      expect(result.sdk).toBeDefined()
      expect(result.sdk?.languageModel("gemini").provider).toBe("custom-google")
    }),
  )

  it.effect("ignores non-Google SDK packages", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      yield* plugin.add(GooglePlugin)
      const result = yield* plugin.trigger(
        "aisdk.sdk",
        { model: model("google", "gemini"), package: "@ai-sdk/google-vertex", options: { name: "google" } },
        {},
      )
      expect(result.sdk).toBeUndefined()
    }),
  )

  itWithAISDK.effect("uses default languageModel loading with provider ID parity", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const aisdk = yield* AISDK.Service
      yield* plugin.add(GooglePlugin)
      const language = yield* aisdk.language(
        model("custom-google", "alias", {
          api: {
            id: Model.ID.make("gemini-api"),
            type: "aisdk",
            package: "@ai-sdk/google",
          },
          request: {
            headers: {},
            body: { apiKey: "test" },
          },
        }),
      )
      expect(language.modelId).toBe("gemini-api")
      expect(language.provider).toBe("custom-google")
    }),
  )
})
