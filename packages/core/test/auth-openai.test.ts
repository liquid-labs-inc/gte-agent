import { createHash } from "crypto"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AuthOpenAI } from "@gte-agent/core/auth/openai"
import { AuthStore } from "@gte-agent/core/auth/store"
import { FSUtil } from "@gte-agent/core/fs-util"
import { Global } from "@gte-agent/core/global"
import { Provider } from "@gte-agent/core/provider"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(FetchHttpClient.layer)

const jwt = (claims: unknown) =>
  `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
    JSON.stringify(claims),
  ).toString("base64url")}.signature`

const accessToken = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } })

/** Local token-endpoint stub: records form bodies and replays canned responses. No real network. */
const tokenStub = (responses: Array<{ status?: number; body?: unknown }>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const requests: Array<{ pathname: string; params: URLSearchParams }> = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request) => {
          requests.push({ pathname: new URL(request.url).pathname, params: new URLSearchParams(await request.text()) })
          const next = responses[Math.min(requests.length - 1, responses.length - 1)]
          if (next.status !== undefined && next.status !== 200)
            return Response.json({ error: "invalid_grant" }, { status: next.status })
          return Response.json(next.body)
        },
      })
      return { requests, issuer: `http://127.0.0.1:${server.port}`, server }
    }),
    (stub) => Effect.promise(async () => void (await stub.server.stop(true))),
  )

const storeLayer = (home: string) =>
  AuthStore.layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(Global.layerWith({ home })))

const withStore = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    return yield* body.pipe(Effect.provide(storeLayer(tmp.path)))
  })

describe("AuthOpenAI PKCE", () => {
  it.effect("flow derives the S256 challenge from the verifier", () =>
    Effect.sync(() => {
      const flow = AuthOpenAI.flow()
      expect(flow.verifier.length).toBeGreaterThanOrEqual(43)
      expect(flow.challenge).toBe(createHash("sha256").update(flow.verifier).digest("base64url"))
      expect(flow.state.length).toBeGreaterThan(0)
      const other = AuthOpenAI.flow()
      expect(other.verifier).not.toBe(flow.verifier)
      expect(other.state).not.toBe(flow.state)
    }),
  )

  it.effect("authorizeUrl carries the codex sign-in parameters", () =>
    Effect.sync(() => {
      const flow = AuthOpenAI.flow()
      const url = new URL(AuthOpenAI.authorizeUrl(flow))
      expect(url.origin).toBe("https://auth.openai.com")
      expect(url.pathname).toBe("/oauth/authorize")
      expect(url.searchParams.get("response_type")).toBe("code")
      expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
      expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1455/auth/callback")
      expect(url.searchParams.get("scope")).toBe("openid profile email offline_access")
      expect(url.searchParams.get("code_challenge")).toBe(flow.challenge)
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      expect(url.searchParams.get("state")).toBe(flow.state)
      expect(url.searchParams.get("id_token_add_organizations")).toBe("true")
      expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true")
    }),
  )
})

describe("AuthOpenAI redirect parsing", () => {
  it.effect("accepts a pasted redirect URL", () =>
    Effect.gen(function* () {
      const result = yield* AuthOpenAI.parseRedirect(
        " http://localhost:1455/auth/callback?code=abc&state=expected ",
        "expected",
      )
      expect(result).toEqual({ code: "abc" })
    }),
  )

  it.effect("accepts a bare pasted query string", () =>
    Effect.gen(function* () {
      expect(yield* AuthOpenAI.parseRedirect("code=abc&state=expected", "expected")).toEqual({ code: "abc" })
      expect(yield* AuthOpenAI.parseRedirect("?state=expected&code=xyz", "expected")).toEqual({ code: "xyz" })
    }),
  )

  it.effect("rejects unparsable input, missing code/state, and state mismatch", () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(AuthOpenAI.parseRedirect("not a redirect", "s"))).reason).toBe("unparsable")
      expect(
        (yield* Effect.flip(AuthOpenAI.parseRedirect("http://localhost:1455/auth/callback?code=abc", "s"))).reason,
      ).toBe("missing_state")
      expect((yield* Effect.flip(AuthOpenAI.parseRedirect("code=abc&state=other", "s"))).reason).toBe("state_mismatch")
      expect((yield* Effect.flip(AuthOpenAI.parseRedirect("state=s", "s"))).reason).toBe("missing_code")
    }),
  )

  it.effect("surfaces provider authorization errors", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(AuthOpenAI.parseRedirect("error=access_denied&state=s", "s"))
      expect(error._tag).toBe("AuthOpenAI.AuthorizationDeniedError")
      if (error._tag === "AuthOpenAI.AuthorizationDeniedError") expect(error.reason).toBe("access_denied")
    }),
  )
})

describe("AuthOpenAI callback listener", () => {
  it.effect("captures the redirect and ignores stray probes with a bad state", () =>
    Effect.gen(function* () {
      const callback = yield* AuthOpenAI.callback({ state: "expected", port: 0 })
      const probe = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${callback.port}/auth/callback?code=evil&state=wrong`),
      )
      expect(probe.status).toBe(400)
      const missing = yield* Effect.promise(() => fetch(`http://127.0.0.1:${callback.port}/other`))
      expect(missing.status).toBe(404)
      const redirect = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${callback.port}/auth/callback?code=abc&state=expected`),
      )
      expect(redirect.status).toBe(200)
      expect(yield* callback.result).toEqual({ code: "abc" })
    }),
  )

  it.effect("surfaces provider denials delivered to the callback", () =>
    Effect.gen(function* () {
      const callback = yield* AuthOpenAI.callback({ state: "expected", port: 0 })
      const redirect = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${callback.port}/auth/callback?error=access_denied&state=expected`),
      )
      expect(redirect.status).toBe(400)
      const error = yield* Effect.flip(callback.result)
      expect(error.reason).toBe("access_denied")
    }),
  )

  it.effect("an unbindable port is a typed error so callers fall back to paste", () =>
    Effect.gen(function* () {
      const first = yield* AuthOpenAI.callback({ state: "s", port: 0 })
      const error = yield* Effect.flip(Effect.scoped(AuthOpenAI.callback({ state: "s", port: first.port })))
      expect(error._tag).toBe("AuthOpenAI.CallbackPortUnavailableError")
      if (error._tag === "AuthOpenAI.CallbackPortUnavailableError") expect(error.port).toBe(first.port)
    }),
  )
})

describe("AuthOpenAI token exchange", () => {
  it.effect("exchanges the code and extracts the account id from the JWT", () =>
    Effect.gen(function* () {
      const stub = yield* tokenStub([
        { body: { access_token: accessToken, refresh_token: "refresh-1", expires_in: 3600 } },
      ])
      const before = Date.now()
      const profile = yield* AuthOpenAI.exchange({ code: "abc", verifier: "verifier-1", issuer: stub.issuer })
      expect(profile.type).toBe("oauth")
      expect(profile.access).toBe(accessToken)
      expect(profile.refresh).toBe("refresh-1")
      expect(profile.accountId).toBe("acct_123")
      expect(profile.expires).toBeGreaterThanOrEqual(before + 3_500_000)
      expect(profile.expires).toBeLessThanOrEqual(Date.now() + 3_700_000)
      expect(stub.requests).toHaveLength(1)
      expect(stub.requests[0].pathname).toBe("/oauth/token")
      expect(Object.fromEntries(stub.requests[0].params)).toEqual({
        grant_type: "authorization_code",
        code: "abc",
        redirect_uri: "http://localhost:1455/auth/callback",
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        code_verifier: "verifier-1",
      })
    }),
  )

  it.effect("a failed exchange is a typed error without token material", () =>
    Effect.gen(function* () {
      const stub = yield* tokenStub([{ status: 400 }])
      const error = yield* Effect.flip(
        AuthOpenAI.exchange({ code: "abc", verifier: "verifier-1", issuer: stub.issuer }),
      )
      expect(error._tag).toBe("AuthOpenAI.TokenExchangeError")
      if (error._tag === "AuthOpenAI.TokenExchangeError") expect(error.reason).toBe("http_400")
      expect(JSON.stringify(error)).not.toContain("verifier-1")
    }),
  )

  it.effect("a malformed token response is a typed error", () =>
    Effect.gen(function* () {
      const stub = yield* tokenStub([{ body: { unexpected: true } }])
      const error = yield* Effect.flip(
        AuthOpenAI.exchange({ code: "abc", verifier: "verifier-1", issuer: stub.issuer }),
      )
      expect(error._tag).toBe("AuthOpenAI.TokenExchangeError")
      if (error._tag === "AuthOpenAI.TokenExchangeError") expect(error.reason).toBe("invalid_token_response")
    }),
  )

  it.effect("accountId tolerates non-JWT access tokens", () =>
    Effect.sync(() => {
      expect(AuthOpenAI.accountId("not-a-jwt")).toBeUndefined()
      expect(AuthOpenAI.accountId(jwt({ sub: "user" }))).toBeUndefined()
      expect(AuthOpenAI.accountId(accessToken)).toBe("acct_123")
    }),
  )
})

describe("AuthOpenAI token refresh", () => {
  const expiredProfile = { type: "oauth", access: "old-access", refresh: "refresh-0", expires: 1000 } as const

  it.effect("refreshes an expired profile and persists the rotated tokens atomically", () =>
    withStore(
      Effect.gen(function* () {
        const stub = yield* tokenStub([
          { body: { access_token: accessToken, refresh_token: "refresh-1", expires_in: 1800 } },
        ])
        const rotated = yield* AuthOpenAI.refreshIfNeeded({ profile: expiredProfile, issuer: stub.issuer })
        expect(rotated.refresh).toBe("refresh-1")
        expect(rotated.access).toBe(accessToken)
        expect(rotated.accountId).toBe("acct_123")
        expect(Object.fromEntries(stub.requests[0].params)).toEqual({
          grant_type: "refresh_token",
          refresh_token: "refresh-0",
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          scope: "openid profile email",
        })
        const store = yield* AuthStore.Service
        expect(yield* store.get(Provider.ID.openai)).toEqual(rotated)
      }),
    ),
  )

  it.effect("keeps the previous refresh token when the endpoint does not rotate it", () =>
    withStore(
      Effect.gen(function* () {
        const stub = yield* tokenStub([{ body: { access_token: accessToken, expires_in: 1800 } }])
        const rotated = yield* AuthOpenAI.refreshIfNeeded({ profile: expiredProfile, issuer: stub.issuer })
        expect(rotated.refresh).toBe("refresh-0")
      }),
    ),
  )

  it.effect("a fresh profile is returned as-is without touching the endpoint", () =>
    withStore(
      Effect.gen(function* () {
        const stub = yield* tokenStub([{ status: 500 }])
        const profile = { ...expiredProfile, expires: Date.now() + 3_600_000 }
        const result = yield* AuthOpenAI.refreshIfNeeded({ profile, issuer: stub.issuer })
        expect(result).toEqual(profile)
        expect(stub.requests).toHaveLength(0)
      }),
    ),
  )

  it.effect("setup-token style profiles (expires 0) never refresh", () =>
    withStore(
      Effect.gen(function* () {
        const stub = yield* tokenStub([{ status: 500 }])
        const profile = { type: "oauth", access: "long-lived", refresh: "", expires: 0 } as const
        expect(yield* AuthOpenAI.refreshIfNeeded({ profile, issuer: stub.issuer })).toEqual(profile)
        expect(stub.requests).toHaveLength(0)
      }),
    ),
  )

  it.effect("refresh failure is a single typed error, never a retry loop", () =>
    withStore(
      Effect.gen(function* () {
        const stub = yield* tokenStub([{ status: 401 }])
        const error = yield* Effect.flip(AuthOpenAI.refreshIfNeeded({ profile: expiredProfile, issuer: stub.issuer }))
        expect(error._tag).toBe("AuthOpenAI.RefreshError")
        if (error._tag === "AuthOpenAI.RefreshError") expect(error.reason).toBe("http_401")
        expect(stub.requests).toHaveLength(1)
        const store = yield* AuthStore.Service
        expect(yield* store.get(Provider.ID.openai)).toBeUndefined()
      }),
    ),
  )

  it.effect("an expired profile without a refresh token fails typed", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        AuthOpenAI.refresh({ profile: { type: "oauth", access: "a", refresh: "", expires: 1 } }),
      )
      expect(error._tag).toBe("AuthOpenAI.RefreshError")
      if (error._tag === "AuthOpenAI.RefreshError") expect(error.reason).toBe("no_refresh_token")
    }),
  )
})
