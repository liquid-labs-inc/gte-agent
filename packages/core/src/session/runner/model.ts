export * as SessionRunnerModel from "./model"

import { type ModelSchema } from "@gte-agent/llm"
import * as AnthropicMessages from "@gte-agent/llm/protocols/anthropic-messages"
import * as OpenAICodexResponses from "@gte-agent/llm/protocols/openai-codex-responses"
import * as OpenAICompatibleChat from "@gte-agent/llm/protocols/openai-compatible-chat"
import * as OpenAIResponses from "@gte-agent/llm/protocols/openai-responses"
import { Auth, type AnyRoute } from "@gte-agent/llm/route"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import { produce } from "immer"
import { AuthAnthropic } from "../../auth/anthropic"
import { AuthOpenAI } from "../../auth/openai"
import { AuthStore } from "../../auth/store"
import { Catalog } from "../../catalog"
import { Model } from "../../model"
import { ModelSelection } from "../../model-selection"
import { PluginBoot } from "../../plugin/boot"
import { Provider } from "../../provider"
import { SessionSchema } from "../schema"

type ResolvedModel = typeof ModelSchema.Type

export class ModelNotSelectedError extends Schema.TaggedErrorClass<ModelNotSelectedError>()(
  "SessionRunnerModel.ModelNotSelectedError",
  {
    sessionID: SessionSchema.ID,
  },
) {}

export class UnsupportedApiError extends Schema.TaggedErrorClass<UnsupportedApiError>()(
  "SessionRunnerModel.UnsupportedApiError",
  {
    providerID: Provider.ID,
    modelID: Model.ID,
    api: Schema.String,
  },
) {}

export type Error =
  | Catalog.ProviderNotFoundError
  | Catalog.ModelNotFoundError
  | ModelNotSelectedError
  | UnsupportedApiError
  | AuthStore.MissingCredentialsError
  | AuthStore.Error
  | AuthOpenAI.RefreshError

export interface Interface {
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<ResolvedModel, Error>
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/SessionRunnerModel") {}

/** Test or embedding seam for supplying a model resolver directly. */
export const layerWith = (resolve: Interface["resolve"]) => Layer.succeed(Service, Service.of({ resolve }))

const apiKey = (model: Model.Info, provider?: Provider.Info) => {
  const value = explicitApiKey(model)
  if (typeof value === "string") return Auth.value(value)
  return provider?.enabled !== false && provider?.enabled.via === "env" ? Auth.config(provider.enabled.name) : undefined
}

/** Explicit per-model config credential; wins over auth.json and env vars. */
const explicitApiKey = (model: Model.Info) => {
  const value = model.request.body.apiKey ?? model.api.settings?.apiKey
  return typeof value === "string" ? value : undefined
}

const withDefaults = (model: Model.Info, route: AnyRoute) =>
  route.with({
    provider: model.providerID,
    endpoint: model.api.url === undefined ? undefined : { baseURL: model.api.url },
    headers: model.request.headers,
    http: {
      body: Object.fromEntries(Object.entries(model.request.body).filter(([key]) => key !== "apiKey")),
    },
    limits: { context: model.limit.context, output: model.limit.output },
  })

const withVariant = (model: Model.Info, variantID: Model.VariantID | undefined) => {
  const id = variantID === "default" || variantID === undefined ? model.request.variant : variantID
  const variant = model.variants.find((item) => item.id === id)
  if (!variant) return model
  return produce(model, (draft) => {
    Object.assign(draft.request.headers, variant.headers)
    Object.assign(draft.request.body, variant.body)
  })
}

const apiName = (model: Model.Info) =>
  model.api.type === "aisdk" ? `${model.api.type}:${model.api.package}` : model.api.type

export const fromCatalogModel = (
  model: Model.Info,
  provider?: Provider.Info,
): Effect.Effect<ResolvedModel, UnsupportedApiError> => {
  const key = apiKey(model, provider)
  if (model.api.type === "aisdk" && model.api.package === "@ai-sdk/openai") {
    return Effect.succeed(
      withDefaults(model, OpenAIResponses.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: model.api.id }),
    )
  }
  if (model.api.type === "aisdk" && model.api.package === "@ai-sdk/anthropic") {
    return Effect.succeed(
      withDefaults(model, AnthropicMessages.route)
        .with({ auth: key === undefined ? Auth.none : Auth.header("x-api-key", key) })
        .model({ id: model.api.id }),
    )
  }
  if (model.api.type === "aisdk" && model.api.package === "@ai-sdk/openai-compatible" && model.api.url) {
    return Effect.succeed(
      withDefaults(model, OpenAICompatibleChat.route)
        .with({ auth: key === undefined ? Auth.none : Auth.bearer(key) })
        .model({ id: model.api.id }),
    )
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: model.providerID,
      modelID: model.id,
      api: apiName(model),
    }),
  )
}

/**
 * Builds the provider route for a resolved credential. Credential-type
 * routing per Milestone 7:
 *
 * - Anthropic api_key  -> official Messages API, `x-api-key` header.
 * - Anthropic oauth    -> official Messages API, OAuth bearer plus the
 *   required `anthropic-beta` flag instead of `x-api-key` (setup-tokens).
 * - OpenAI api_key     -> official Responses API, bearer.
 * - OpenAI oauth       -> ChatGPT codex-responses backend, bearer access
 *   token plus `chatgpt-account-id` (when known) and a per-turn `session_id`.
 * - OpenAI-compatible  -> bearer api_key only.
 */
export const fromCredential = (
  model: Model.Info,
  credential: AuthStore.Credential,
): Effect.Effect<ResolvedModel, UnsupportedApiError> => {
  if (model.api.type === "aisdk" && model.api.package === "@ai-sdk/anthropic") {
    if (credential.type === "oauth") {
      return Effect.succeed(
        withDefaults(model, AnthropicMessages.route)
          .with({
            auth: Auth.bearer(Auth.value(credential.profile.access, "anthropic oauth access token")),
            headers: { "anthropic-beta": AuthAnthropic.OAUTH_BETA },
          })
          .model({ id: model.api.id }),
      )
    }
    return Effect.succeed(
      withDefaults(model, AnthropicMessages.route)
        .with({ auth: Auth.header("x-api-key", Auth.value(credential.key, credential.source)) })
        .model({ id: model.api.id }),
    )
  }
  if (model.api.type === "aisdk" && model.api.package === "@ai-sdk/openai") {
    if (credential.type === "oauth") {
      // The codex backend has its own base URL; a configured official API url
      // must not override it, so this branch never applies `model.api.url`.
      return Effect.succeed(
        OpenAICodexResponses.route
          .with({
            provider: model.providerID,
            headers: model.request.headers,
            http: {
              body: Object.fromEntries(Object.entries(model.request.body).filter(([key]) => key !== "apiKey")),
            },
            limits: { context: model.limit.context, output: model.limit.output },
          })
          .with({
            auth: Auth.bearer(Auth.value(credential.profile.access, "chatgpt oauth access token")),
            headers: {
              session_id: crypto.randomUUID(),
              ...(credential.profile.accountId === undefined
                ? {}
                : { "chatgpt-account-id": credential.profile.accountId }),
            },
          })
          .model({ id: model.api.id }),
      )
    }
    return Effect.succeed(
      withDefaults(model, OpenAIResponses.route)
        .with({ auth: Auth.bearer(Auth.value(credential.key, credential.source)) })
        .model({ id: model.api.id }),
    )
  }
  if (
    model.api.type === "aisdk" &&
    model.api.package === "@ai-sdk/openai-compatible" &&
    model.api.url &&
    credential.type === "api_key"
  ) {
    return Effect.succeed(
      withDefaults(model, OpenAICompatibleChat.route)
        .with({ auth: Auth.bearer(Auth.value(credential.key, credential.source)) })
        .model({ id: model.api.id }),
    )
  }
  return Effect.fail(
    new UnsupportedApiError({
      providerID: model.providerID,
      modelID: model.id,
      api: credential.type === "oauth" ? `${apiName(model)} (oauth)` : apiName(model),
    }),
  )
}

export const resolve = (session: SessionSchema.Info, model: Model.Info, provider?: Provider.Info) =>
  fromCatalogModel(withVariant(model, session.model?.variant), provider)

export const supported = (model: Model.Info) =>
  model.api.type === "aisdk" &&
  (model.api.package === "@ai-sdk/openai" ||
    model.api.package === "@ai-sdk/anthropic" ||
    (model.api.package === "@ai-sdk/openai-compatible" && model.api.url !== undefined))

/**
 * Resolves models from the catalog belonging to the current RuntimeScope
 * runtime, strictly: the session's persisted model, else the global default
 * from `~/.gte-agent/config.json` — never a silent fallback to some other
 * catalog model. Credentials resolve through the auth store (explicit
 * per-model config value -> auth.json profile -> provider env var) and OpenAI
 * OAuth tokens are refreshed at request time; every failure is a typed error
 * the runner surfaces to the transcript.
 */
export const runtimeScopeLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const boot = yield* PluginBoot.Service
    const auth = yield* AuthStore.Service
    const selection = yield* ModelSelection.Service
    const http = yield* HttpClient.HttpClient
    // refreshIfNeeded persists rotated tokens through the auth store and talks
    // to the token endpoint; both services are bound here so the resolver
    // interface stays requirement-free.
    const refresh = (credential: Extract<AuthStore.Credential, { type: "oauth" }>) =>
      AuthOpenAI.refreshIfNeeded({ profile: credential.profile }).pipe(
        Effect.provideService(AuthStore.Service, auth),
        Effect.provideService(HttpClient.HttpClient, http),
      )
    return Service.of({
      resolve: Effect.fn("SessionRunnerModel.resolve")(function* (session) {
        // RuntimeScope plugins populate and filter the catalog asynchronously during layer startup.
        yield* boot.wait()
        const ref = session.model ?? (yield* selection.defaultRef())
        if (!ref) return yield* new ModelNotSelectedError({ sessionID: session.id })
        const selected = yield* catalog.model.get(ref.providerID, ref.id)
        const model = withVariant(selected, session.model?.variant)
        const provider = Option.getOrUndefined(yield* catalog.provider.get(model.providerID).pipe(Effect.option))
        const credential = yield* auth.resolve({
          providerID: model.providerID,
          ...(explicitApiKey(model) === undefined ? {} : { explicit: explicitApiKey(model) }),
          ...(provider !== undefined && provider.enabled !== false && provider.enabled.via === "env"
            ? { env: [provider.enabled.name] }
            : {}),
        })
        // OpenAI ChatGPT sign-ins refresh transparently at request time; a
        // failed refresh is a visible auth error, never a retry loop.
        const ready =
          credential.type === "oauth" && model.providerID === Provider.ID.openai
            ? { ...credential, profile: yield* refresh(credential) }
            : credential
        return yield* fromCredential(model, ready)
      }),
    })
  }),
)
