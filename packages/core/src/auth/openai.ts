export * as AuthOpenAI from "./openai"

import { createHash, randomBytes } from "crypto"
import { Deferred, Effect, Exit, Option, Schema } from "effect"
import type { Scope } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Provider } from "../provider"
import type { AuthSchema } from "./schema"
import { AuthStore } from "./store"

// Constants from the ChatGPT codex sign-in flow. Verified against the codex CLI
// PKCE implementation; the consent page expects the codex-specific switches in
// the authorize URL.
export const ISSUER = "https://auth.openai.com"
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const CALLBACK_PORT = 1455
export const CALLBACK_PATH = "/auth/callback"
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`
export const SCOPES = "openid profile email offline_access"

/** Access tokens are refreshed when within this window of expiry. */
export const EXPIRY_SKEW_MS = 60_000

export class CallbackPortUnavailableError extends Schema.TaggedErrorClass<CallbackPortUnavailableError>()(
  "AuthOpenAI.CallbackPortUnavailableError",
  { port: Schema.Finite },
) {}

export class AuthorizationDeniedError extends Schema.TaggedErrorClass<AuthorizationDeniedError>()(
  "AuthOpenAI.AuthorizationDeniedError",
  { reason: Schema.String },
) {}

export class RedirectParseError extends Schema.TaggedErrorClass<RedirectParseError>()(
  "AuthOpenAI.RedirectParseError",
  { reason: Schema.Literals(["unparsable", "missing_code", "missing_state", "state_mismatch"]) },
) {}

export class TokenExchangeError extends Schema.TaggedErrorClass<TokenExchangeError>()(
  "AuthOpenAI.TokenExchangeError",
  { reason: Schema.String },
) {}

export class RefreshError extends Schema.TaggedErrorClass<RefreshError>()("AuthOpenAI.RefreshError", {
  reason: Schema.String,
}) {}

export interface Flow {
  readonly verifier: string
  readonly challenge: string
  readonly state: string
}

/** Generates the PKCE verifier/challenge pair (S256) and the anti-CSRF state. */
export function flow(): Flow {
  const verifier = randomBytes(64).toString("base64url")
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    state: randomBytes(32).toString("base64url"),
  }
}

export function authorizeUrl(input: Pick<Flow, "challenge" | "state">, issuer = ISSUER): string {
  const url = new URL("/oauth/authorize", issuer)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  }).toString()
  return url.toString()
}

export interface Callback {
  readonly port: number
  /** Resolves once the browser redirect lands on the listener. */
  readonly result: Effect.Effect<{ readonly code: string }, AuthorizationDeniedError>
}

/**
 * Transient callback listener on 127.0.0.1 capturing the OAuth redirect; the
 * server stops when the scope closes. Requests without the expected state are
 * rejected without completing the flow, so stray probes can neither hijack nor
 * kill a pending sign-in. A bind failure (port in use) is a typed error: the
 * caller falls back to the pasted-redirect-URL flow via `parseRedirect`.
 */
export const callback = (options: {
  readonly state: string
  readonly port?: number
}): Effect.Effect<Callback, CallbackPortUnavailableError, Scope.Scope> =>
  Effect.gen(function* () {
    const port = options.port ?? CALLBACK_PORT
    const deferred = Deferred.makeUnsafe<{ readonly code: string }, AuthorizationDeniedError>()
    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            hostname: "127.0.0.1",
            port,
            fetch(request) {
              const url = new URL(request.url)
              if (url.pathname !== CALLBACK_PATH) return new Response("Not found", { status: 404 })
              if (url.searchParams.get("state") !== options.state)
                return new Response("Invalid state. You can close this tab.", { status: 400 })
              const denied = url.searchParams.get("error")
              if (denied) {
                Deferred.doneUnsafe(deferred, Exit.fail(new AuthorizationDeniedError({ reason: denied })))
                return new Response("Sign-in failed. You can close this tab.", { status: 400 })
              }
              const code = url.searchParams.get("code")
              if (!code) return new Response("Missing code. You can close this tab.", { status: 400 })
              Deferred.doneUnsafe(deferred, Exit.succeed({ code }))
              return new Response("Signed in to ChatGPT. You can close this tab and return to the terminal.")
            },
          }),
        catch: () => new CallbackPortUnavailableError({ port }),
      }),
      (server) => Effect.promise(async () => void (await server.stop(true))),
    )
    return { port: server.port ?? port, result: Deferred.await(deferred) }
  })

/**
 * Parses a pasted redirect URL (or its bare query string) into the
 * authorization code, validating the anti-CSRF state. First-class fallback for
 * headless boxes or when the callback port cannot bind.
 */
export function parseRedirect(
  pasted: string,
  expectedState: string,
): Effect.Effect<{ readonly code: string }, RedirectParseError | AuthorizationDeniedError> {
  const url = parseRedirectUrl(pasted.trim())
  if (!url) return Effect.fail(new RedirectParseError({ reason: "unparsable" }))
  const denied = url.searchParams.get("error")
  if (denied) return Effect.fail(new AuthorizationDeniedError({ reason: denied }))
  const state = url.searchParams.get("state")
  if (!state) return Effect.fail(new RedirectParseError({ reason: "missing_state" }))
  if (state !== expectedState) return Effect.fail(new RedirectParseError({ reason: "state_mismatch" }))
  const code = url.searchParams.get("code")
  if (!code) return Effect.fail(new RedirectParseError({ reason: "missing_code" }))
  return Effect.succeed({ code })
}

function parseRedirectUrl(value: string) {
  if (URL.canParse(value)) return new URL(value)
  // Accept a bare query string ("code=…&state=…") pasted without the URL.
  if (value.includes("code=") || value.includes("state=") || value.includes("error="))
    return new URL(`${REDIRECT_URI}?${value.replace(/^\?/, "")}`)
  return undefined
}

/**
 * Exchanges the authorization code for tokens, deriving the ChatGPT account id
 * from the access-token JWT claims. Requires `HttpClient.HttpClient`.
 */
export const exchange = Effect.fn("AuthOpenAI.exchange")(function* (options: {
  readonly code: string
  readonly verifier: string
  readonly issuer?: string
}) {
  const response = yield* token(options.issuer ?? ISSUER, {
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: options.verifier,
  })
  return profileFromTokens(response, undefined)
})

/** OAuth profiles with `expires: 0` never expire (setup-token style markers). */
export function expired(profile: AuthSchema.OAuthProfile, now = Date.now()): boolean {
  return profile.expires > 0 && profile.expires <= now + EXPIRY_SKEW_MS
}

/** Single refresh attempt via the token endpoint; never a retry loop. */
export const refresh = Effect.fn("AuthOpenAI.refresh")(function* (options: {
  readonly profile: AuthSchema.OAuthProfile
  readonly issuer?: string
}) {
  if (options.profile.refresh.length === 0) return yield* new RefreshError({ reason: "no_refresh_token" })
  const response = yield* token(options.issuer ?? ISSUER, {
    grant_type: "refresh_token",
    refresh_token: options.profile.refresh,
    client_id: CLIENT_ID,
    scope: "openid profile email",
  }).pipe(Effect.mapError((error) => new RefreshError({ reason: error.reason })))
  return profileFromTokens(response, options.profile)
})

/**
 * Returns a request-ready profile: refreshes when within the expiry window and
 * atomically persists the rotated refresh token through the auth store.
 * Refresh failure surfaces as a typed error, never a retry loop.
 */
export const refreshIfNeeded = Effect.fn("AuthOpenAI.refreshIfNeeded")(function* (options: {
  readonly profile: AuthSchema.OAuthProfile
  readonly issuer?: string
  readonly now?: number
}) {
  if (!expired(options.profile, options.now)) return options.profile
  const store = yield* AuthStore.Service
  const rotated = yield* refresh({ profile: options.profile, issuer: options.issuer })
  yield* store.set(Provider.ID.openai, rotated)
  return rotated
})

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Finite),
})

const token = Effect.fn("AuthOpenAI.token")(function* (issuer: string, params: Record<string, string>) {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
  const json = yield* HttpClientRequest.post(new URL("/oauth/token", issuer).toString()).pipe(
    HttpClientRequest.bodyText(new URLSearchParams(params).toString(), "application/x-www-form-urlencoded"),
    client.execute,
    Effect.flatMap((response) => response.json),
    Effect.timeout("30 seconds"),
    // Keep failure details coarse: never echo request or response bodies, which carry secrets.
    Effect.mapError((error) => new TokenExchangeError({ reason: failureReason(error) })),
  )
  const decoded = Schema.decodeUnknownOption(TokenResponse, { onExcessProperty: "ignore" })(json)
  if (Option.isNone(decoded)) return yield* new TokenExchangeError({ reason: "invalid_token_response" })
  return decoded.value
})

function failureReason(error: unknown): string {
  const tagged = error as { readonly _tag?: unknown; readonly response?: { readonly status?: unknown } }
  if (typeof tagged.response?.status === "number") return `http_${tagged.response.status}`
  return typeof tagged._tag === "string" ? tagged._tag : "unknown"
}

function profileFromTokens(
  response: typeof TokenResponse.Type,
  previous: AuthSchema.OAuthProfile | undefined,
): AuthSchema.OAuthProfile {
  const account = accountId(response.access_token) ?? previous?.accountId
  return {
    type: "oauth",
    access: response.access_token,
    refresh: response.refresh_token ?? previous?.refresh ?? "",
    expires: response.expires_in === undefined ? 0 : Date.now() + response.expires_in * 1000,
    ...(account === undefined ? {} : { accountId: account }),
  }
}

const JwtAuthClaims = Schema.Struct({
  "https://api.openai.com/auth": Schema.optional(Schema.Struct({ chatgpt_account_id: Schema.optional(Schema.String) })),
})

/** Extracts the ChatGPT account id from the access-token JWT claims, when present. */
export function accountId(accessToken: string): string | undefined {
  const payload = accessToken.split(".")[1]
  if (!payload) return undefined
  const claims = Option.flatMap(
    Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(Buffer.from(payload, "base64url").toString("utf8")),
    Schema.decodeUnknownOption(JwtAuthClaims, { onExcessProperty: "ignore" }),
  )
  return Option.getOrUndefined(claims)?.["https://api.openai.com/auth"]?.chatgpt_account_id
}
