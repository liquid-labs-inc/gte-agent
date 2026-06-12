import { describe, expect } from "bun:test"
import path from "path"
import { LLM, type ModelSchema } from "@gte-agent/llm"
import { DateTime, Effect, Layer } from "effect"
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { AuthStore } from "@gte-agent/core/auth/store"
import { Catalog } from "@gte-agent/core/catalog"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { FSUtil } from "@gte-agent/core/fs-util"
import { Global } from "@gte-agent/core/global"
import { GTEAuth } from "@gte-agent/core/gte-auth"
import { Model } from "@gte-agent/core/model"
import { ModelSelection } from "@gte-agent/core/model-selection"
import { PluginBoot } from "@gte-agent/core/plugin/boot"
import { Project } from "@gte-agent/core/project"
import { Provider } from "@gte-agent/core/provider"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { Session } from "@gte-agent/core/session"
import { SessionRunnerModel } from "@gte-agent/core/session/runner/model"
import { runtimeScope } from "./fixture/runtime-scope"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const model = (pkg: string) =>
  new Model.Info({
    id: Model.ID.make("test-model"),
    providerID: Provider.ID.make(pkg === "@ai-sdk/anthropic" ? "anthropic" : "openai"),
    name: "Test model",
    api: { id: Model.ID.make("api-test-model"), type: "aisdk", package: pkg },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    request: { headers: { "x-test": "header" }, body: {} },
    variants: [],
    time: { released: DateTime.makeUnsafe(0) },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 100, output: 20 },
  })

const applyAuth = (resolved: typeof ModelSchema.Type) =>
  resolved.route.auth.apply({
    request: LLM.request({ model: resolved, prompt: "Hello" }),
    method: "POST",
    url: "https://example.test/messages",
    body: "{}",
    headers: Headers.empty,
  })

describe("SessionRunnerModel.fromCredential", () => {
  it.effect("routes Anthropic api_key credentials through x-api-key", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCredential(model("@ai-sdk/anthropic"), {
        type: "api_key",
        key: "anthropic-key",
        source: "store",
      })
      expect(resolved.route.id).toBe("anthropic-messages")
      const headers = yield* applyAuth(resolved)
      expect(headers["x-api-key"]).toBe("anthropic-key")
      expect(headers.authorization).toBeUndefined()
      expect(resolved.route.defaults.headers).toMatchObject({ "x-test": "header" })
      expect(resolved.route.defaults.headers?.["anthropic-beta"]).toBeUndefined()
    }),
  )

  it.effect("routes Anthropic oauth credentials through an OAuth bearer plus the beta flag", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCredential(model("@ai-sdk/anthropic"), {
        type: "oauth",
        profile: { type: "oauth", access: "sk-ant-oat-setup-token", refresh: "", expires: 0 },
        source: "store",
      })
      expect(resolved.route.id).toBe("anthropic-messages")
      const headers = yield* applyAuth(resolved)
      expect(headers.authorization).toBe("Bearer sk-ant-oat-setup-token")
      expect(headers["x-api-key"]).toBeUndefined()
      expect(resolved.route.defaults.headers).toMatchObject({
        "x-test": "header",
        "anthropic-beta": "oauth-2025-04-20",
      })
    }),
  )

  it.effect("routes OpenAI api_key credentials through the official Responses API", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCredential(model("@ai-sdk/openai"), {
        type: "api_key",
        key: "openai-key",
        source: "env",
      })
      expect(resolved.route.id).toBe("openai-responses")
      const headers = yield* applyAuth(resolved)
      expect(headers.authorization).toBe("Bearer openai-key")
    }),
  )

  it.effect("routes OpenAI oauth credentials through the codex-responses backend", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCredential(model("@ai-sdk/openai"), {
        type: "oauth",
        profile: { type: "oauth", access: "chatgpt-access", refresh: "r", expires: 0, accountId: "acct_1" },
        source: "store",
      })
      expect(resolved.route.id).toBe("openai-codex-responses")
      expect(resolved.route.endpoint.baseURL).toBe("https://chatgpt.com/backend-api/codex")
      const headers = yield* applyAuth(resolved)
      expect(headers.authorization).toBe("Bearer chatgpt-access")
      expect(resolved.route.defaults.headers).toMatchObject({
        "x-test": "header",
        "chatgpt-account-id": "acct_1",
      })
      expect(resolved.route.defaults.headers?.session_id).toMatch(/^[0-9a-f-]{36}$/)
    }),
  )

  it.effect("omits the account header for OpenAI oauth credentials without an account id", () =>
    Effect.gen(function* () {
      const resolved = yield* SessionRunnerModel.fromCredential(model("@ai-sdk/openai"), {
        type: "oauth",
        profile: { type: "oauth", access: "chatgpt-access", refresh: "r", expires: 0 },
        source: "store",
      })
      expect(resolved.route.defaults.headers?.["chatgpt-account-id"]).toBeUndefined()
    }),
  )

  it.effect("rejects oauth credentials for routes without an oauth deployment", () =>
    Effect.gen(function* () {
      const compatible = new Model.Info({
        ...model("@ai-sdk/openai-compatible"),
        api: {
          id: Model.ID.make("api-test-model"),
          type: "aisdk",
          package: "@ai-sdk/openai-compatible",
          url: "https://compatible.example/v1",
        },
      })
      const failure = yield* SessionRunnerModel.fromCredential(compatible, {
        type: "oauth",
        profile: { type: "oauth", access: "a", refresh: "", expires: 0 },
        source: "store",
      }).pipe(Effect.flip)
      expect(failure).toMatchObject({ _tag: "SessionRunnerModel.UnsupportedApiError" })
    }),
  )
})

// --- runtimeScopeLayer: strict resolution + request-time refresh ------------

const runtimeScopeLayerFixture = Layer.succeed(
  RuntimeScope.Service,
  RuntimeScope.Service.of(runtimeScope({ directory: AbsolutePath.make("test") })),
)
const database = Database.layerFromPath(":memory:")
const events = Event.layer.pipe(Layer.provide(database))

type TokenCall = { readonly url: string; readonly params: URLSearchParams }

/** Local HttpClient stub: records token-endpoint form bodies, replays canned responses. No real network. */
const httpStub = (calls: TokenCall[], responses: Array<{ status?: number; body?: unknown }>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const web = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
        calls.push({ url: request.url, params: new URLSearchParams(yield* Effect.promise(() => web.text())) })
        const next = responses[Math.min(calls.length - 1, responses.length - 1)] ?? {}
        const response =
          next.status !== undefined && next.status !== 200
            ? new Response(JSON.stringify({ error: "invalid_grant" }), { status: next.status })
            : new Response(JSON.stringify(next.body ?? {}), { headers: { "content-type": "application/json" } })
        return HttpClientResponse.fromWeb(request, response)
      }),
    ),
  )

const session = (input: Partial<Session.Info> = {}) =>
  Session.Info.make({
    id: Session.ID.make("ses_model_resolution"),
    projectID: Project.ID.global,
    principalID: GTEAuth.DEV_PRINCIPAL_ID,
    authorityID: GTEAuth.DEV_AUTHORITY_ID,
    title: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    runtimeScope: { directory: AbsolutePath.make("/project") },
    ...input,
  })

const layersFor = (home: string, http: Layer.Layer<HttpClient.HttpClient>) => {
  const catalog = Catalog.runtimeScopeLayer.pipe(
    Layer.provideMerge(events),
    Layer.provideMerge(runtimeScopeLayerFixture),
  )
  const base = Layer.mergeAll(catalog, AuthStore.layer, PluginBoot.layer, events, database, http)
  const selection = ModelSelection.layer.pipe(Layer.provide(base))
  return SessionRunnerModel.runtimeScopeLayer.pipe(
    Layer.provideMerge(Layer.mergeAll(base, selection)),
    Layer.provideMerge(FSUtil.defaultLayer),
    Layer.provideMerge(Global.layerWith({ home })),
  )
}

const withResolver = <A, E>(
  http: Layer.Layer<HttpClient.HttpClient>,
  body: (home: string) => Effect.Effect<A, E, SessionRunnerModel.Service | AuthStore.Service>,
) =>
  Effect.gen(function* () {
    const saved = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }),
    )
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.OPENAI_API_KEY
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    return yield* body(tmp.path).pipe(Effect.provide(layersFor(tmp.path, http)))
  })

const noHttp = httpStub([], [{ status: 500 }])

describe("SessionRunnerModel.runtimeScopeLayer", () => {
  it.effect("fails visibly when neither the session nor the global default selects a model", () =>
    withResolver(noHttp, () =>
      Effect.gen(function* () {
        const models = yield* SessionRunnerModel.Service
        // The curated catalog is non-empty; strictness means no silent fallback to it.
        const failure = yield* models.resolve(session()).pipe(Effect.flip)
        expect(failure).toMatchObject({ _tag: "SessionRunnerModel.ModelNotSelectedError" })
      }),
    ),
  )

  it.effect("fails visibly when the selected model is not in the catalog", () =>
    withResolver(noHttp, () =>
      Effect.gen(function* () {
        const models = yield* SessionRunnerModel.Service
        const failure = yield* models
          .resolve(session({ model: { id: Model.ID.make("claude-2"), providerID: Provider.ID.anthropic } }))
          .pipe(Effect.flip)
        expect(failure).toMatchObject({ _tag: "Catalog.ModelNotFound" })
      }),
    ),
  )

  it.effect("fails visibly when the provider has no credentials anywhere", () =>
    withResolver(noHttp, () =>
      Effect.gen(function* () {
        const models = yield* SessionRunnerModel.Service
        const failure = yield* models
          .resolve(session({ model: { id: Model.ID.make("claude-fable-5"), providerID: Provider.ID.anthropic } }))
          .pipe(Effect.flip)
        expect(failure).toMatchObject({
          _tag: "AuthStore.MissingCredentialsError",
          providerID: "anthropic",
        })
      }),
    ),
  )

  it.effect("inherits the global default for sessions without a model", () =>
    withResolver(noHttp, (home) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await Bun.write(
            path.join(home, ".gte-agent", "config.json"),
            JSON.stringify({ model: "anthropic/claude-fable-5" }),
          )
        })
        const store = yield* AuthStore.Service
        yield* store.set(Provider.ID.anthropic, { type: "api_key", key: "k" })
        const models = yield* SessionRunnerModel.Service
        const resolved = yield* models.resolve(session())
        expect(resolved).toMatchObject({ id: "claude-fable-5" })
        expect(resolved.route.id).toBe("anthropic-messages")
      }),
    ),
  )

  it.effect("resolves env credentials through the provider env var", () =>
    withResolver(noHttp, () =>
      Effect.gen(function* () {
        process.env.ANTHROPIC_API_KEY = "env-anthropic-key"
        const models = yield* SessionRunnerModel.Service
        const resolved = yield* models.resolve(
          session({ model: { id: Model.ID.make("claude-haiku-4-5"), providerID: Provider.ID.anthropic } }),
        )
        const headers = yield* resolved.route.auth.apply({
          request: LLM.request({ model: resolved, prompt: "Hello" }),
          method: "POST",
          url: "https://example.test/messages",
          body: "{}",
          headers: Headers.empty,
        })
        expect(headers["x-api-key"]).toBe("env-anthropic-key")
      }),
    ),
  )

  it.effect("refreshes an expired ChatGPT oauth profile at request time and persists the rotation", () =>
    Effect.gen(function* () {
      const calls: TokenCall[] = []
      const http = httpStub(calls, [
        { body: { access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 } },
      ])
      yield* withResolver(http, () =>
        Effect.gen(function* () {
          const store = yield* AuthStore.Service
          yield* store.set(Provider.ID.openai, {
            type: "oauth",
            access: "expired-access",
            refresh: "old-refresh",
            expires: Date.now() - 1000,
            accountId: "acct_9",
          })
          const models = yield* SessionRunnerModel.Service
          const resolved = yield* models.resolve(
            session({ model: { id: Model.ID.make("gpt-5.5"), providerID: Provider.ID.openai } }),
          )
          expect(resolved.route.id).toBe("openai-codex-responses")
          const headers = yield* resolved.route.auth.apply({
            request: LLM.request({ model: resolved, prompt: "Hello" }),
            method: "POST",
            url: "https://example.test/responses",
            body: "{}",
            headers: Headers.empty,
          })
          expect(headers.authorization).toBe("Bearer rotated-access")
          expect(calls).toHaveLength(1)
          expect(calls[0]?.url).toBe("https://auth.openai.com/oauth/token")
          expect(calls[0]?.params.get("grant_type")).toBe("refresh_token")
          expect(calls[0]?.params.get("refresh_token")).toBe("old-refresh")
          const stored = yield* store.get(Provider.ID.openai)
          expect(stored).toMatchObject({ type: "oauth", access: "rotated-access", refresh: "rotated-refresh" })
        }),
      )
    }),
  )

  it.effect("surfaces a failed refresh as a typed auth error, not a retry loop", () =>
    Effect.gen(function* () {
      const calls: TokenCall[] = []
      const http = httpStub(calls, [{ status: 401 }])
      yield* withResolver(http, () =>
        Effect.gen(function* () {
          const store = yield* AuthStore.Service
          yield* store.set(Provider.ID.openai, {
            type: "oauth",
            access: "expired-access",
            refresh: "old-refresh",
            expires: Date.now() - 1000,
          })
          const models = yield* SessionRunnerModel.Service
          const failure = yield* models
            .resolve(session({ model: { id: Model.ID.make("gpt-5.5"), providerID: Provider.ID.openai } }))
            .pipe(Effect.flip)
          expect(failure).toMatchObject({ _tag: "AuthOpenAI.RefreshError", reason: "http_401" })
          expect(calls).toHaveLength(1)
        }),
      )
    }),
  )

  it.effect("does not refresh non-expiring oauth profiles", () =>
    Effect.gen(function* () {
      const calls: TokenCall[] = []
      const http = httpStub(calls, [{ status: 500 }])
      yield* withResolver(http, () =>
        Effect.gen(function* () {
          const store = yield* AuthStore.Service
          yield* store.set(Provider.ID.openai, { type: "oauth", access: "long-lived", refresh: "", expires: 0 })
          const models = yield* SessionRunnerModel.Service
          const resolved = yield* models.resolve(
            session({ model: { id: Model.ID.make("gpt-5.4"), providerID: Provider.ID.openai } }),
          )
          expect(resolved.route.id).toBe("openai-codex-responses")
          expect(calls).toHaveLength(0)
        }),
      )
    }),
  )
})
