import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import {
  ForbiddenError,
  InvalidRequestError,
  ProviderNotFoundError,
  ServiceUnavailableError,
  UnknownError,
} from "../errors"
import { GTEAuthorization } from "../middleware/authorization"

/**
 * LLM provider auth routes (Milestone 7). These manage credentials stored in
 * `~/.gte-agent/auth.json` through the core AuthStore: pasted API keys (and
 * Anthropic setup-tokens) plus the OpenAI ChatGPT PKCE OAuth flow.
 *
 * Responses NEVER carry secret material — not even truncated keys. Status
 * reports method and booleans only; `accountId` is a presence flag.
 */

export const ProviderAuthMethod = Schema.Literals(["api_key", "oauth", "env", "none"]).annotate({
  identifier: "ProviderAuthMethod",
})
export type ProviderAuthMethod = typeof ProviderAuthMethod.Type

export const ProviderAuthStatus = Schema.Struct({
  provider: Schema.String.annotate({ description: "Provider id (anthropic, openai)." }),
  method: ProviderAuthMethod.annotate({
    description: "Where credentials come from: a stored api_key/oauth profile, an environment variable, or none.",
  }),
  authed: Schema.Boolean.annotate({ description: "True when a usable credential exists for the provider." }),
  accountId: Schema.Boolean.annotate({
    description: "True when an oauth profile carries an account id. Presence flag only; the value is never returned.",
  }),
}).annotate({ identifier: "ProviderAuthStatus" })
export type ProviderAuthStatus = typeof ProviderAuthStatus.Type

const providerParam = {
  provider: Schema.String.annotate({ description: "LLM provider id (anthropic or openai)." }),
}

/**
 * SECURITY: credential-bearing payloads must never echo their values. Decode
 * failures flow through the shared SchemaErrorMiddleware into the 400 body AND
 * the daemon log, and the default schema formatter embeds the offending value
 * ("Expected ProviderApiKeyRequest, got \"sk-ant-…\""). Two measures keep
 * secret material out of every decode-failure message:
 *
 * 1. Every node of these payload schemas carries a complete `message`
 *    override, so a mis-shaped field (array key, secret in the `type` slot)
 *    renders the override instead of the value.
 * 2. The endpoint payload is declared with an `unknown` encoded side (see
 *    {@link secretSafeBody}): HttpApiBuilder wraps payload schemas in a
 *    single-member `Schema.Union` whose top-level type mismatch ("Expected …,
 *    got <whole body>") bypasses member `message` annotations, so a raw-string
 *    body (`'"sk-ant-…"'` — an easy curl mistake) would be echoed wholesale.
 *    With an `unknown` encoded side the union always matches and every failure
 *    happens inside our annotated nodes.
 */
const ProviderApiKeyFields = Schema.Struct({
  key: Schema.String.annotate({
    description: "The pasted credential. Never echoed back.",
    message: "key must be a string (the offending value is never echoed)",
  }),
  type: Schema.Literals(["api_key", "setup_token"])
    .annotate({ message: 'type must be "api_key" or "setup_token" (the offending value is never echoed)' })
    .pipe(Schema.optional)
    .annotate({
      description:
        "Credential kind. setup_token is Anthropic-only (stored as an oauth profile). Omit to classify the paste automatically.",
      // The `string | undefined` union built by Schema.optional reports
      // AnyOf issues against ITS annotations, not the inner schema's, so the
      // override must live on both nodes.
      message: 'type must be "api_key" or "setup_token" (the offending value is never echoed)',
    }),
}).annotate({
  identifier: "ProviderApiKeyRequest",
  message: 'Request body must be a JSON object like {"key": "..."} (the offending value is never echoed)',
})
const ProviderApiKeyRequest = Schema.Unknown.pipe(Schema.decodeTo(ProviderApiKeyFields))

/** Same value-suppression rules: the redirect carries a single-use authorization code. */
const ProviderOAuthCompleteFields = Schema.Struct({
  flow: Schema.String.annotate({
    description: "Flow handle returned by oauth/start.",
    message: "flow must be a string (the offending value is never echoed)",
  }),
  redirect: Schema.String.annotate({ message: "redirect must be a string (the offending value is never echoed)" })
    .pipe(Schema.optional)
    .annotate({
      description:
        "Pasted redirect URL (or its query string) for headless environments. Omit to wait for the localhost callback.",
      // See the `type` field above: Schema.optional's union needs its own
      // message override for AnyOf issues.
      message: "redirect must be a string (the offending value is never echoed)",
    }),
}).annotate({
  identifier: "ProviderOAuthCompleteRequest",
  message: 'Request body must be a JSON object like {"flow": "..."} (the offending value is never echoed)',
})
const ProviderOAuthCompleteRequest = Schema.Unknown.pipe(Schema.decodeTo(ProviderOAuthCompleteFields))

export const AuthProviderGroup = HttpApiGroup.make("authProvider")
  .add(
    HttpApiEndpoint.get("status", "/api/auth/status", {
      success: Schema.Struct({ data: Schema.Array(ProviderAuthStatus) }).annotate({
        identifier: "ProviderAuthStatusResponse",
      }),
      error: [UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.status",
        summary: "Get LLM provider auth status",
        description:
          "Per-provider auth state (method and booleans only). No secret material is ever included in the response.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("apiKey", "/api/auth/:provider/api-key", {
      params: providerParam,
      payload: ProviderApiKeyRequest,
      success: Schema.Struct({ data: ProviderAuthStatus }).annotate({ identifier: "ProviderApiKeyResponse" }),
      error: [ProviderNotFoundError, InvalidRequestError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.apiKey",
        summary: "Store a pasted provider credential",
        description:
          "Stores a pasted API key — or an Anthropic setup-token, which becomes an oauth-type profile — in ~/.gte-agent/auth.json (mode 0600), overwriting the provider's default profile.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("oauthStart", "/api/auth/:provider/oauth/start", {
      params: providerParam,
      success: Schema.Struct({
        data: Schema.Struct({
          flow: Schema.String.annotate({ description: "Opaque flow handle to pass to oauth/complete." }),
          url: Schema.String.annotate({ description: "Authorize URL the user must open in a browser." }),
          callback: Schema.Struct({
            listening: Schema.Boolean,
            port: Schema.Finite.pipe(Schema.optional),
          }).annotate({
            description:
              "Localhost callback listener state. When not listening (port unavailable), complete the flow with a pasted redirect URL.",
          }),
        }).annotate({ identifier: "ProviderOAuthStart" }),
      }).annotate({ identifier: "ProviderOAuthStartResponse" }),
      error: [ProviderNotFoundError, InvalidRequestError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.oauthStart",
        summary: "Begin a provider OAuth sign-in",
        description:
          "Starts the ChatGPT PKCE flow (OpenAI only): generates verifier/challenge + state, binds a transient localhost callback listener when possible, and returns the authorize URL plus a flow handle.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("oauthComplete", "/api/auth/:provider/oauth/complete", {
      params: providerParam,
      payload: ProviderOAuthCompleteRequest,
      success: Schema.Struct({ data: ProviderAuthStatus }).annotate({ identifier: "ProviderOAuthCompleteResponse" }),
      error: [ProviderNotFoundError, InvalidRequestError, ForbiddenError, ServiceUnavailableError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "auth.oauthComplete",
        summary: "Finish a provider OAuth sign-in",
        description:
          "Completes a pending PKCE flow via the captured localhost callback or a pasted redirect URL, exchanges the code for tokens, and persists the oauth profile. Tokens are never echoed.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "provider-auth",
      description: "LLM provider credential management. Responses never contain secret material.",
    }),
  )
  .middleware(GTEAuthorization)
