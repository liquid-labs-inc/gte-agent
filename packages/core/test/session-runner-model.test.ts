import { describe, expect } from "bun:test"
import { LLM } from "@gte-agent/llm"
import { LLMClient } from "@gte-agent/llm/route"
import { ConfigProvider, DateTime, Effect } from "effect"
import { Headers } from "effect/unstable/http"
import { Model } from "@gte-agent/core/model"
import { Provider } from "@gte-agent/core/provider"
import { Project } from "@gte-agent/core/project"
import { SessionRunnerModel } from "@gte-agent/core/session/runner/model"
import { Session } from "@gte-agent/core/session"
import { AbsolutePath } from "@gte-agent/core/schema"
import { GTEAuth } from "@gte-agent/core/gte-auth"
import { it } from "./lib/effect"

type Api =
  | {
      readonly type: "aisdk"
      readonly package: string
      readonly url?: string
      readonly settings?: Record<string, unknown>
    }
  | { readonly type: "native"; readonly url?: string; readonly settings: Record<string, unknown> }

const model = (api: Api, variants: Model.Info["variants"] = []) =>
  new Model.Info({
    id: Model.ID.make("test-model"),
    providerID: Provider.ID.make("test-provider"),
    name: "Test model",
    api: { id: Model.ID.make("api-test-model"), ...api },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: {
      headers: { "x-test": "header" },
      body: { store: false, apiKey: "secret" },
    },
    variants,
    time: { released: DateTime.makeUnsafe(0) },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 100, output: 20 },
  })

const provider = (api: Provider.Info["api"]) =>
  new Provider.Info({
    id: Provider.ID.make("test-provider"),
    name: "Test provider",
    enabled: { via: "env", name: "TEST_PROVIDER_API_KEY" },
    env: ["TEST_PROVIDER_API_KEY"],
    api,
    request: { headers: {}, body: {} },
  })

describe("SessionRunnerModel", () => {
  it.effect("maps catalog OpenAI AI SDK models into native Responses routes", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )

      expect(resolved).toMatchObject({ id: "api-test-model", provider: "test-provider" })
      expect(resolved.route).toMatchObject({
        id: "openai-responses",
        endpoint: { baseURL: "https://openai.example/v1" },
        defaults: {
          headers: { "x-test": "header" },
          limits: { context: 100, output: 20 },
          http: { body: { store: false } },
        },
      })
    }),
  )

  it.effect("keeps catalog apiKey credentials out of provider JSON", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )
      const prepared = yield* LLMClient.prepare(LLM.request({ model: resolved, prompt: "Hello" }))

      expect(JSON.stringify(prepared.body)).not.toContain("apiKey")
      expect(JSON.stringify(prepared.body)).not.toContain("secret")
    }),
  )

  it.effect("uses merged API settings for OpenAI-compatible auth and request defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        new Model.Info({
          ...model({
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "https://compatible.example/v1",
            settings: { apiKey: "settings-secret", compatibility: "strict" },
          }),
          request: { headers: {}, body: {} },
        }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth.apply({
        request,
        method: "POST",
        url: "https://compatible.example/v1/chat/completions",
        body: "{}",
        headers: Headers.empty,
      })

      expect(headers.authorization).toBe("Bearer settings-secret")
      expect(resolved.route.defaults.http?.body).toEqual({})
    }),
  )

  it.effect("applies the selected Session variant to request options", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }, [
        {
          id: Model.VariantID.make("high"),
          headers: { "x-variant": "high" },
          body: { reasoningEffort: "high" },
        },
      ])
      const session = Session.Info.make({
        id: Session.ID.make("ses_model_variant"),
        projectID: Project.ID.global,
        principalID: GTEAuth.DEV_PRINCIPAL_ID,
        authorityID: GTEAuth.DEV_AUTHORITY_ID,
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: Model.VariantID.make("high"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        runtimeScope: { directory: AbsolutePath.make("/project") },
      })

      const resolution = yield* SessionRunnerModel.resolve(session, catalog)

      expect(resolution.model.route.defaults).toMatchObject({
        headers: { "x-test": "header", "x-variant": "high" },
        http: { body: { store: false, reasoningEffort: "high" } },
      })
      expect(resolution.providerOptions).toBeUndefined()
    }),
  )

  it.effect("carries a variant's providerOptions to the runner instead of the wire body", () =>
    Effect.gen(function* () {
      const thinking = { anthropic: { thinking: { type: "adaptive", effort: "xhigh" } } }
      const catalog = model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }, [
        {
          id: Model.VariantID.make("xhigh"),
          headers: {},
          body: { providerOptions: thinking },
        },
      ])
      const session = Session.Info.make({
        id: Session.ID.make("ses_model_variant_options"),
        projectID: Project.ID.global,
        principalID: GTEAuth.DEV_PRINCIPAL_ID,
        authorityID: GTEAuth.DEV_AUTHORITY_ID,
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: Model.VariantID.make("xhigh"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        runtimeScope: { directory: AbsolutePath.make("/project") },
      })

      const resolution = yield* SessionRunnerModel.resolve(session, catalog)

      expect(resolution.providerOptions).toEqual(thinking)
      expect(resolution.model.route.defaults.http?.body).toEqual({ store: false })
    }),
  )

  it.effect("fails visibly on a variant the model does not define", () =>
    Effect.gen(function* () {
      const catalog = model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" })
      const session = Session.Info.make({
        id: Session.ID.make("ses_model_variant_unknown"),
        projectID: Project.ID.global,
        principalID: GTEAuth.DEV_PRINCIPAL_ID,
        authorityID: GTEAuth.DEV_AUTHORITY_ID,
        title: "test",
        model: {
          id: catalog.id,
          providerID: catalog.providerID,
          variant: Model.VariantID.make("ultra"),
        },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
        runtimeScope: { directory: AbsolutePath.make("/project") },
      })

      const failure = yield* SessionRunnerModel.resolve(session, catalog).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.UnknownVariantError",
        providerID: "test-provider",
        modelID: "test-model",
        variant: "ultra",
      })
    }),
  )

  it.effect("maps catalog Anthropic AI SDK models into native routes", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/anthropic", url: "https://anthropic.example/v1" }),
      )

      expect(resolved.route).toMatchObject({
        id: "anthropic-messages",
        endpoint: { baseURL: "https://anthropic.example/v1" },
      })
    }),
  )

  it.effect("preserves environment-backed bearer auth", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCatalogModel(
        new Model.Info({
          ...model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
          request: { headers: {}, body: {} },
        }),
        provider({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
      )
      const request = LLM.request({ model: resolved, prompt: "Hello" })
      const headers = yield* resolved.route.auth
        .apply({
          request,
          method: "POST",
          url: "https://openai.example/v1/responses",
          body: "{}",
          headers: Headers.empty,
        })
        .pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { TEST_PROVIDER_API_KEY: "secret" } }))),
        )

      expect(headers.authorization).toBe("Bearer secret")
    }),
  )

  it.effect("rejects catalog APIs without a native route", () =>
    Effect.gen(function* () {
      const failure = yield* SessionRunnerModel.fromCatalogModel(
        model({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1" }),
      ).pipe(Effect.flip)

      expect(failure).toMatchObject({
        _tag: "SessionRunnerModel.UnsupportedApiError",
        providerID: "test-provider",
        modelID: "test-model",
        api: "aisdk:@ai-sdk/google",
      })
    }),
  )

  it.effect("reports whether a catalog model has a supported native route", () =>
    Effect.sync(() => {
      expect(
        SessionRunnerModel.supported(
          model({ type: "aisdk", package: "@ai-sdk/openai", url: "https://openai.example/v1" }),
        ),
      ).toBe(true)
      expect(
        SessionRunnerModel.supported(
          model({ type: "aisdk", package: "@ai-sdk/google", url: "https://google.example/v1" }),
        ),
      ).toBe(false)
      expect(SessionRunnerModel.supported(model({ type: "native", settings: {} }))).toBe(false)
    }),
  )
})
