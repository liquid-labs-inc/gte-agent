/**
 * Route-level coverage for the LLM provider auth routes (Milestone 7):
 * GET /api/auth/status, POST /api/auth/:provider/api-key, and the OpenAI
 * ChatGPT PKCE flow (oauth/start + oauth/complete).
 *
 * The OAuth network surface is stubbed: a local Bun.serve plays the token
 * issuer (selected per server instance via GTE_AGENT_OPENAI_ISSUER) and the
 * callback listener binds an ephemeral port (GTE_AGENT_OAUTH_CALLBACK_PORT=0),
 * so no scenario ever reaches a real provider.
 *
 * Every scenario that stores a credential also asserts the secret never
 * appears in any response body — not even truncated. Malformed payloads are
 * probed with sentinel secrets too: schema decode failures route through the
 * shared SchemaErrorMiddleware into both the 400 body and the daemon log
 * (routed to a file by setup.ts), and neither may carry the pasted value.
 */
import "./setup"
import { afterAll, describe } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import * as Log from "@gte-agent/core/util/log"
import { array, check, exercise, http, record, type Api } from "./dsl"

const AUTH_FILE = path.join(process.env.GTE_AGENT_TEST_HOME ?? "", ".gte-agent", "auth.json")
const PASSWORD = "auth-provider-daemon-password"

const ANTHROPIC_KEY = "sk-ant-api03-httpapi-secret-key-material"
const SETUP_TOKEN = "sk-ant-oat01-httpapi-setup-token-material"
const OPENAI_KEY = "sk-httpapi-openai-secret-key-material"
const ACCOUNT_ID = "acct_httpapi_42"
const REFRESH_TOKEN = "httpapi-refresh-token-secret-material"

const jwtPart = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const ACCESS_TOKEN = `${jwtPart({ alg: "none" })}.${jwtPart({
  "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID },
})}.httpapi-access-signature`

const SECRETS = [ANTHROPIC_KEY, SETUP_TOKEN, OPENAI_KEY, ACCESS_TOKEN, REFRESH_TOKEN]

// Sentinels for the malformed-payload regressions: each scenario plants a
// distinct secret in a payload slot that fails schema decoding, then asserts
// it reached neither the 400 body nor the daemon log.
const MALFORMED_BODY_SECRET = "sk-ant-api03-malformed-raw-body-probe-secret"
const MALFORMED_KEY_SECRET = "sk-ant-api03-malformed-array-key-probe-secret"
const MALFORMED_TYPE_SECRET = "sk-ant-api03-malformed-type-slot-probe-secret"
const MALFORMED_REDIRECT_SECRET = "authorization-code-in-malformed-redirect-probe-secret"
const CORRUPT_FILE_SECRET = "sk-ant-api03-corrupt-auth-file-probe-secret"

/**
 * Wait until this scenario's schema-rejection warn line (identified by its
 * value-suppressing message override) is flushed to the daemon log file, then
 * assert the log carries no secret material. setup.ts routes core logs to a
 * file under the scratch home, so this pins the "secrets must never be
 * logged" rule end to end.
 */
async function expectLoggedRejectionWithoutSecret(marker: string, secret: string) {
  const file = Log.file()
  check(file.length > 0, "setup.ts should route the daemon log to a file")
  const deadline = Date.now() + 5_000
  for (;;) {
    const content = existsSync(file) ? readFileSync(file, "utf8") : ""
    if (content.includes("schema rejection") && content.includes(marker)) {
      check(!content.includes(secret), "the daemon log must not contain secret material from a malformed payload")
      return
    }
    check(Date.now() <= deadline, `schema-rejection log line ("${marker}") never appeared in ${file}`)
    await Bun.sleep(25)
  }
}

/**
 * Stub ChatGPT token issuer. `code=ok-code` exchanges successfully;
 * `code=bad-code` is rejected with 401 like a consumed/invalid grant.
 */
const issuer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method !== "POST" || url.pathname !== "/oauth/token") return new Response("not found", { status: 404 })
    const params = new URLSearchParams(await request.text())
    if (params.get("grant_type") !== "authorization_code" || params.get("code") !== "ok-code") {
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 })
    }
    return new Response(
      JSON.stringify({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3600 }),
      { headers: { "content-type": "application/json" } },
    )
  },
})
afterAll(async () => void (await issuer.stop(true)))

const ISSUER_URL = `http://127.0.0.1:${issuer.port}`
const OAUTH_SERVER = { config: { GTE_AGENT_OPENAI_ISSUER: ISSUER_URL, GTE_AGENT_OAUTH_CALLBACK_PORT: "0" } }

// A real, currently-free TCP port for the flow-restart scenario: restarting a
// sign-in must free the (fixed) callback port held by the stale flow's
// listener so the new flow can bind it again.
const FIXED_CALLBACK_PORT = await (async () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = probe.port
  await probe.stop(true)
  return port
})()
const FIXED_PORT_SERVER = {
  config: { GTE_AGENT_OPENAI_ISSUER: ISSUER_URL, GTE_AGENT_OAUTH_CALLBACK_PORT: String(FIXED_CALLBACK_PORT) },
}

/** All scenarios share one process-wide auth.json (one hermetic test home); reset per scenario. */
function resetAuth() {
  rmSync(AUTH_FILE, { force: true })
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
}

function readAuthFile(): Record<string, unknown> {
  return record(JSON.parse(readFileSync(AUTH_FILE, "utf8")), "auth.json")
}

function profileIn(file: Record<string, unknown>, key: string): Record<string, unknown> {
  return record(record(file.profiles, "profiles")[key], key)
}

function noSecrets(text: string, label: string) {
  for (const secret of SECRETS) {
    check(!text.includes(secret), `${label} must not contain secret material (found ${secret.slice(0, 12)}…)`)
  }
}

function statusEntry(body: unknown, provider: string): Record<string, unknown> {
  const entry = array(record(body, "status response").data, "status data").find(
    (item) => record(item, "status entry").provider === provider,
  )
  check(entry !== undefined, `status should include an entry for ${provider}`)
  return record(entry, `${provider} status`)
}

/** Begin a PKCE flow through the API; the anti-CSRF state is read back out of the authorize URL. */
async function startFlow(api: Api) {
  const result = await api.call({ method: "POST", path: "/api/auth/openai/oauth/start" })
  check(result.status === 200, `oauth/start seed failed: ${result.status} ${result.text}`)
  const data = record(record(result.body, "start response").data, "start data")
  const state = new URL(String(data.url)).searchParams.get("state")
  check(state !== null && state.length > 0, "authorize URL should carry the flow state")
  const callback = record(data.callback, "callback")
  return { flow: String(data.flow), url: String(data.url), state, callback }
}

const redirectFor = (code: string, state: string) => `http://localhost:1455/auth/callback?code=${code}&state=${state}`

describe("auth.status", () => {
  exercise([
    http
      .get("/api/auth/status", "reports none for both providers on a fresh store")
      .seeded(async () => {
        resetAuth()
        return undefined
      })
      .json(200, (body) => {
        const data = array(record(body).data, "status data")
        check(data.length === 2, `status should cover exactly anthropic and openai: ${JSON.stringify(data)}`)
        for (const provider of ["anthropic", "openai"]) {
          const entry = statusEntry(body, provider)
          check(entry.method === "none", `${provider} should report method none: ${JSON.stringify(entry)}`)
          check(entry.authed === false, `${provider} should not be authed`)
          check(entry.accountId === false, `${provider} should not report an account id`)
          check(
            Object.keys(entry).sort().join(",") === "accountId,authed,method,provider",
            `status entries must carry exactly the documented fields: ${JSON.stringify(entry)}`,
          )
        }
      }),
    http
      .get("/api/auth/status", "reports env credentials without echoing them")
      .seeded(async () => {
        resetAuth()
        process.env.ANTHROPIC_API_KEY = ANTHROPIC_KEY
        return undefined
      })
      .json(200, (body, _ctx, result) => {
        try {
          const anthropic = statusEntry(body, "anthropic")
          check(anthropic.method === "env", `anthropic should report method env: ${JSON.stringify(anthropic)}`)
          check(anthropic.authed === true, "env credentials should count as authed")
          check(statusEntry(body, "openai").method === "none", "openai should stay none")
          noSecrets(result.text, "status response")
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      }),
    http
      .get("/api/auth/status", "reflects a stored key (status flips from none to api_key)")
      .seeded(async (api) => {
        resetAuth()
        const before = await api.call({ path: "/api/auth/status" })
        check(before.status === 200, `status seed failed: ${before.status}`)
        check(statusEntry(before.body, "anthropic").method === "none", "store should start empty")
        const stored = await api.call({
          method: "POST",
          path: "/api/auth/anthropic/api-key",
          body: { key: ANTHROPIC_KEY },
        })
        check(stored.status === 200, `api-key seed failed: ${stored.status} ${stored.text}`)
        return undefined
      })
      .json(200, (body, _ctx, result) => {
        const anthropic = statusEntry(body, "anthropic")
        check(anthropic.method === "api_key", `anthropic should report api_key: ${JSON.stringify(anthropic)}`)
        check(anthropic.authed === true, "stored key should count as authed")
        noSecrets(result.text, "status response")
      }),
    // Pins that the authProvider group sits behind the GTEAuthorization
    // daemon middleware (regression guard for dropping `.middleware(...)`
    // from the group definition).
    http
      .get("/api/auth/status", "sits behind the daemon authorization middleware")
      .server({ password: PASSWORD })
      .json(401, (body) => {
        const error = record(body)
        check(error._tag === "UnauthorizedError", `expected UnauthorizedError, got ${JSON.stringify(body)}`)
      }),
    http
      .get("/api/auth/status", "maps an unreadable auth store to an opaque 500 without leaking file contents")
      .seeded(async () => {
        resetAuth()
        mkdirSync(path.dirname(AUTH_FILE), { recursive: true })
        // Truncated JSON containing a secret: the store's decode fails, and
        // neither the file contents nor the typed error may reach the client.
        writeFileSync(
          AUTH_FILE,
          `{"version":1,"profiles":{"anthropic:default":{"type":"api_key","key":"${CORRUPT_FILE_SECRET}"`,
        )
        return undefined
      })
      .json(500, (body, _ctx, result) => {
        try {
          const error = record(body)
          check(error._tag === "UnknownError", `expected UnknownError, got ${JSON.stringify(body)}`)
          check(
            error.message === "Unexpected server error. Check server logs for details.",
            `the 500 must carry only the fixed opaque message: ${JSON.stringify(body)}`,
          )
          check(
            typeof error.ref === "string" && error.ref.startsWith("err_"),
            `the 500 should carry a log ref: ${JSON.stringify(body)}`,
          )
          check(!result.text.includes(CORRUPT_FILE_SECRET), "auth.json contents must not leak into the response")
          check(!result.text.includes("InvalidAuthFileError"), "internal error tags must not leak into the response")
          check(!result.text.includes(AUTH_FILE), "the auth.json path must not leak into the response")
        } finally {
          rmSync(AUTH_FILE, { force: true })
        }
      }),
  ])
})

describe("auth.apiKey", () => {
  exercise([
    http
      .post("/api/auth/anthropic/api-key", "stores a pasted API key without echoing it")
      .seeded(async () => {
        resetAuth()
        return undefined
      })
      .at(() => ({ path: "/api/auth/anthropic/api-key", body: { key: ANTHROPIC_KEY } }))
      .json(200, (body, _ctx, result) => {
        const data = record(record(body).data, "api-key data")
        check(data.provider === "anthropic", "response should name the provider")
        check(data.method === "api_key", `pasted key should store an api_key profile: ${JSON.stringify(data)}`)
        check(data.authed === true, "stored key should count as authed")
        noSecrets(result.text, "api-key response")
        const profile = profileIn(readAuthFile(), "anthropic:default")
        check(profile.type === "api_key" && profile.key === ANTHROPIC_KEY, "auth.json should hold the exact key")
        check((statSync(AUTH_FILE).mode & 0o777) === 0o600, "auth.json must be written with mode 0600")
      }),
    http
      .post("/api/auth/anthropic/api-key", "classifies a pasted setup-token as an oauth profile")
      .seeded(async () => {
        resetAuth()
        return undefined
      })
      .at(() => ({ path: "/api/auth/anthropic/api-key", body: { key: SETUP_TOKEN } }))
      .json(200, (body, _ctx, result) => {
        check(record(record(body).data).method === "oauth", "setup-token paste should report an oauth profile")
        noSecrets(result.text, "setup-token response")
        const profile = profileIn(readAuthFile(), "anthropic:default")
        check(profile.type === "oauth", "setup-token should be stored as an oauth profile")
        check(profile.access === SETUP_TOKEN, "oauth profile should hold the token as the access credential")
        check(profile.refresh === "" && profile.expires === 0, "setup-tokens are non-refreshable and never expire")
      }),
    http
      .post("/api/auth/anthropic/api-key", "honors an explicit setup_token payload type")
      .seeded(async () => {
        resetAuth()
        return undefined
      })
      .at(() => ({
        path: "/api/auth/anthropic/api-key",
        body: { key: "unprefixed-setup-token-secret", type: "setup_token" },
      }))
      .json(200, (body) => {
        check(record(record(body).data).method === "oauth", "explicit setup_token type should win over classification")
        check(profileIn(readAuthFile(), "anthropic:default").type === "oauth", "profile should be oauth-typed")
      }),
    http
      .post("/api/auth/anthropic/api-key", "honors an explicit api_key type for a setup-token-shaped paste")
      .seeded(async () => {
        resetAuth()
        return undefined
      })
      .at(() => ({ path: "/api/auth/anthropic/api-key", body: { key: SETUP_TOKEN, type: "api_key" } }))
      .json(200, (body) => {
        check(record(record(body).data).method === "api_key", "explicit api_key type should win over classification")
        check(profileIn(readAuthFile(), "anthropic:default").type === "api_key", "profile should be api_key-typed")
      }),
    http
      .post("/api/auth/openai/api-key", "stores an OpenAI key and overwrites on re-auth")
      .seeded(async (api) => {
        resetAuth()
        const first = await api.call({
          method: "POST",
          path: "/api/auth/openai/api-key",
          body: { key: "sk-old-key-to-overwrite" },
        })
        check(first.status === 200, `first api-key seed failed: ${first.status}`)
        return undefined
      })
      .at(() => ({ path: "/api/auth/openai/api-key", body: { key: OPENAI_KEY } }))
      .json(200, (body) => {
        check(record(record(body).data).method === "api_key", "re-auth should report api_key")
        const profile = profileIn(readAuthFile(), "openai:default")
        check(profile.key === OPENAI_KEY, "re-authing should overwrite the default profile")
      }),
    http
      .post("/api/auth/openai/api-key", "rejects a setup token for openai")
      .at(() => ({ path: "/api/auth/openai/api-key", body: { key: "whatever-token", type: "setup_token" } }))
      .json(400, (body) => {
        const error = record(body)
        check(error._tag === "InvalidRequestError", `expected InvalidRequestError, got ${JSON.stringify(body)}`)
        check(error.field === "type", "error should point at the payload type")
      }),
    http
      .post("/api/auth/anthropic/api-key", "rejects a blank key")
      .at(() => ({ path: "/api/auth/anthropic/api-key", body: { key: "   " } }))
      .json(400, (body) => {
        const error = record(body)
        check(error._tag === "InvalidRequestError", `expected InvalidRequestError, got ${JSON.stringify(body)}`)
        check(error.field === "key", "error should point at the key field")
      }),
    http
      .post("/api/auth/anthropic/api-key", "rejects a payload without a key")
      .at(() => ({ path: "/api/auth/anthropic/api-key", body: {} }))
      .json(400, (body) => {
        check(record(body)._tag === "InvalidRequestError", `schema rejection expected: ${JSON.stringify(body)}`)
      }),
    // Malformed-payload regressions: schema decode failures flow through the
    // shared SchemaErrorMiddleware into the 400 body AND the daemon log, and
    // the default formatter would echo the offending value. The payload
    // schema suppresses values on every node; these scenarios plant sentinel
    // secrets in each failing slot and assert neither surface carries them.
    http
      .post("/api/auth/anthropic/api-key", "never echoes a key pasted as a raw JSON string body")
      .at(() => ({ path: "/api/auth/anthropic/api-key", body: MALFORMED_BODY_SECRET }))
      .json(400, async (body, _ctx, result) => {
        const error = record(body)
        check(error._tag === "InvalidRequestError", `schema rejection expected: ${JSON.stringify(body)}`)
        check(error.kind === "Payload", `payload-kind rejection expected: ${JSON.stringify(body)}`)
        check(!result.text.includes(MALFORMED_BODY_SECRET), "a raw-string body must not be echoed in the 400")
        await expectLoggedRejectionWithoutSecret("Request body must be a JSON object", MALFORMED_BODY_SECRET)
      }),
    http
      .post("/api/auth/anthropic/api-key", "never echoes a non-string key value")
      .at(() => ({ path: "/api/auth/anthropic/api-key", body: { key: [MALFORMED_KEY_SECRET] } }))
      .json(400, async (body, _ctx, result) => {
        const error = record(body)
        check(error._tag === "InvalidRequestError", `schema rejection expected: ${JSON.stringify(body)}`)
        check(!result.text.includes(MALFORMED_KEY_SECRET), "a mis-typed key value must not be echoed in the 400")
        await expectLoggedRejectionWithoutSecret("key must be a string", MALFORMED_KEY_SECRET)
      }),
    http
      .post("/api/auth/anthropic/api-key", "never echoes a secret pasted into the type slot")
      .at(() => ({ path: "/api/auth/anthropic/api-key", body: { key: "ok", type: MALFORMED_TYPE_SECRET } }))
      .json(400, async (body, _ctx, result) => {
        const error = record(body)
        check(error._tag === "InvalidRequestError", `schema rejection expected: ${JSON.stringify(body)}`)
        check(!result.text.includes(MALFORMED_TYPE_SECRET), "a mis-placed credential must not be echoed in the 400")
        await expectLoggedRejectionWithoutSecret('type must be "api_key" or "setup_token"', MALFORMED_TYPE_SECRET)
      }),
    http
      .post("/api/auth/:provider/api-key", "rejects an unknown provider")
      .at(() => ({ path: "/api/auth/not-a-provider/api-key", body: { key: "irrelevant" } }))
      .json(404, (body) => {
        const error = record(body)
        check(error._tag === "ProviderNotFoundError", `expected ProviderNotFoundError, got ${JSON.stringify(body)}`)
        check(error.providerID === "not-a-provider", "error should carry the unknown provider id")
      }),
  ])
})

describe("auth.oauth", () => {
  exercise([
    http
      .post("/api/auth/anthropic/oauth/start", "rejects OAuth for anthropic (paste flows only)")
      .at(() => ({ path: "/api/auth/anthropic/oauth/start" }))
      .json(400, (body) => {
        const error = record(body)
        check(error._tag === "InvalidRequestError", `expected InvalidRequestError, got ${JSON.stringify(body)}`)
        check(String(error.message).includes("setup token"), "error should direct anthropic users to paste flows")
      }),
    http
      .post("/api/auth/openai/oauth/start", "returns an authorize URL, flow handle, and callback state")
      .server(OAUTH_SERVER)
      .json(200, (body, _ctx, result) => {
        const data = record(record(body).data, "start data")
        check(
          Object.keys(data).sort().join(",") === "callback,flow,url",
          `start response must carry exactly flow/url/callback: ${JSON.stringify(Object.keys(data))}`,
        )
        check(String(data.flow).length > 0, "flow handle should be present")
        const url = new URL(String(data.url))
        check(
          String(data.url).startsWith(`${ISSUER_URL}/oauth/authorize`),
          `authorize URL should target the issuer: ${String(data.url)}`,
        )
        check(
          (url.searchParams.get("code_challenge") ?? "").length > 0,
          "authorize URL should carry the PKCE challenge",
        )
        check(url.searchParams.get("code_challenge_method") === "S256", "challenge method should be S256")
        check((url.searchParams.get("state") ?? "").length > 0, "authorize URL should carry the anti-CSRF state")
        check(!result.text.includes("verifier"), "the PKCE verifier must never leave the server")
        // The verifier is a 86-char base64url token (the challenge and state
        // are 43). Any 43+-char base64url run in the response other than the
        // challenge/state would be leaked secret material — most importantly
        // the verifier itself.
        const challenge = url.searchParams.get("code_challenge") ?? ""
        const state = url.searchParams.get("state") ?? ""
        for (const token of result.text.match(/[A-Za-z0-9_-]{43,}/g) ?? []) {
          check(
            token === challenge || token === state,
            `unexpected high-entropy token in the start response (the PKCE verifier must never leave the server): ${token.slice(0, 8)}…`,
          )
        }
        const callback = record(data.callback, "callback")
        check(callback.listening === true, "ephemeral callback listener should bind")
        check(typeof callback.port === "number" && callback.port > 0, "listener port should be reported")
      }),
    http
      .post(
        "/api/auth/openai/oauth/start",
        "restarting a sign-in discards the stale flow and rebinds its callback port",
      )
      .server(FIXED_PORT_SERVER)
      .seeded(async (api) => {
        resetAuth()
        // First sign-in attempt: its listener holds the fixed callback port.
        const flow = await startFlow(api)
        check(flow.callback.listening === true, "the first flow should bind the fixed callback port")
        check(flow.callback.port === FIXED_CALLBACK_PORT, "the first flow should report the fixed port")
        return flow
      })
      .at(() => ({ path: "/api/auth/openai/oauth/start" }))
      .json(200, async (body, ctx) => {
        const data = record(record(body).data, "start data")
        const callback = record(data.callback, "callback")
        // Before the one-flow-per-provider discard, the stale listener kept
        // the port bound and the restarted sign-in degraded to paste-only.
        check(callback.listening === true, "a restarted sign-in should rebind the callback port")
        check(callback.port === FIXED_CALLBACK_PORT, "the restarted flow should listen on the same fixed port")
        const stale = await ctx.api.call({
          method: "POST",
          path: "/api/auth/openai/oauth/complete",
          body: { flow: ctx.state.flow, redirect: redirectFor("ok-code", ctx.state.state) },
        })
        check(stale.status === 400, `the stale flow handle must be discarded: ${stale.status} ${stale.text}`)
        // The browser redirect for the NEW flow lands on the new listener and
        // completes the sign-in end to end.
        const state = new URL(String(data.url)).searchParams.get("state") ?? ""
        const redirect = await fetch(
          `http://127.0.0.1:${FIXED_CALLBACK_PORT}/auth/callback?code=ok-code&state=${state}`,
        )
        check(redirect.status === 200, `the new listener should accept the redirect: ${redirect.status}`)
        const completed = await ctx.api.call({
          method: "POST",
          path: "/api/auth/openai/oauth/complete",
          body: { flow: String(data.flow) },
        })
        check(completed.status === 200, `the restarted flow should complete: ${completed.status} ${completed.text}`)
      }),
    http
      .post("/api/auth/openai/oauth/complete", "never echoes a non-string redirect value")
      .server(OAUTH_SERVER)
      .at(() => ({
        path: "/api/auth/openai/oauth/complete",
        body: { flow: "irrelevant", redirect: [MALFORMED_REDIRECT_SECRET] },
      }))
      .json(400, async (body, _ctx, result) => {
        const error = record(body)
        check(error._tag === "InvalidRequestError", `schema rejection expected: ${JSON.stringify(body)}`)
        check(
          !result.text.includes(MALFORMED_REDIRECT_SECRET),
          "a mis-typed redirect (carrying the authorization code) must not be echoed in the 400",
        )
        await expectLoggedRejectionWithoutSecret("redirect must be a string", MALFORMED_REDIRECT_SECRET)
      }),
    http
      .post("/api/auth/openai/oauth/complete", "completes via a pasted redirect URL and stores the oauth profile")
      .server(OAUTH_SERVER)
      .seeded(async (api) => {
        resetAuth()
        return startFlow(api)
      })
      .at(({ state }) => ({
        path: "/api/auth/openai/oauth/complete",
        body: { flow: state.flow, redirect: redirectFor("ok-code", state.state) },
      }))
      .json(200, async (body, ctx, result) => {
        const data = record(record(body).data, "complete data")
        check(
          data.provider === "openai" && data.method === "oauth",
          `expected an oauth profile: ${JSON.stringify(data)}`,
        )
        check(data.authed === true, "completed sign-in should count as authed")
        check(data.accountId === true, "account id presence should be reported (as a boolean only)")
        noSecrets(result.text, "complete response")
        check(!result.text.includes(ACCOUNT_ID), "the account id value must not be echoed")
        const profile = profileIn(readAuthFile(), "openai:default")
        check(profile.access === ACCESS_TOKEN, "auth.json should hold the access token")
        check(profile.refresh === REFRESH_TOKEN, "auth.json should hold the refresh token")
        check(profile.accountId === ACCOUNT_ID, "auth.json should hold the JWT-derived account id")
        const status = await ctx.api.call({ path: "/api/auth/status" })
        check(statusEntry(status.body, "openai").method === "oauth", "status should reflect the oauth profile")
        noSecrets(status.text, "status response after sign-in")
      }),
    http
      .post("/api/auth/openai/oauth/complete", "completes via the localhost callback listener")
      .server(OAUTH_SERVER)
      .seeded(async (api) => {
        resetAuth()
        const flow = await startFlow(api)
        check(flow.callback.listening === true, "callback listener should be active for this scenario")
        const port = Number(flow.callback.port)
        const probe = await fetch(`http://127.0.0.1:${port}/auth/callback?code=ok-code&state=wrong-state`)
        check(probe.status === 400, "a wrong-state probe must be rejected without completing the flow")
        const redirect = await fetch(`http://127.0.0.1:${port}/auth/callback?code=ok-code&state=${flow.state}`)
        check(redirect.status === 200, `browser redirect should be accepted: ${redirect.status}`)
        return flow
      })
      .at(({ state }) => ({ path: "/api/auth/openai/oauth/complete", body: { flow: state.flow } }))
      .json(200, (body, _ctx, result) => {
        const data = record(record(body).data, "complete data")
        check(
          data.method === "oauth" && data.authed === true,
          `callback completion should auth: ${JSON.stringify(data)}`,
        )
        noSecrets(result.text, "complete response")
        check(profileIn(readAuthFile(), "openai:default").access === ACCESS_TOKEN, "tokens should be persisted")
      }),
    http
      .post("/api/auth/openai/oauth/complete", "rejects a state-mismatched redirect but keeps the flow alive")
      .server(OAUTH_SERVER)
      .seeded(async (api) => {
        resetAuth()
        return startFlow(api)
      })
      .at(({ state }) => ({
        path: "/api/auth/openai/oauth/complete",
        body: { flow: state.flow, redirect: redirectFor("ok-code", "not-the-state") },
      }))
      .json(400, async (body, ctx) => {
        const error = record(body)
        check(error._tag === "InvalidRequestError", `expected InvalidRequestError, got ${JSON.stringify(body)}`)
        check(error.field === "redirect", "error should point at the pasted redirect")
        check(String(error.message).includes("state_mismatch"), `reason should be surfaced: ${String(error.message)}`)
        const retry = await ctx.api.call({
          method: "POST",
          path: "/api/auth/openai/oauth/complete",
          body: { flow: ctx.state.flow, redirect: redirectFor("ok-code", ctx.state.state) },
        })
        check(
          retry.status === 200,
          `flow should survive a paste typo and complete on retry: ${retry.status} ${retry.text}`,
        )
      }),
    http
      .post("/api/auth/openai/oauth/complete", "rejects an unknown flow handle")
      .server(OAUTH_SERVER)
      .at(() => ({ path: "/api/auth/openai/oauth/complete", body: { flow: "not-a-flow" } }))
      .json(400, (body) => {
        const error = record(body)
        check(error._tag === "InvalidRequestError", `expected InvalidRequestError, got ${JSON.stringify(body)}`)
        check(error.field === "flow", "error should point at the flow handle")
      }),
    http
      .post("/api/auth/openai/oauth/complete", "maps a denied authorization to 403 and ends the flow")
      .server(OAUTH_SERVER)
      .seeded(async (api) => {
        resetAuth()
        return startFlow(api)
      })
      .at(({ state }) => ({
        path: "/api/auth/openai/oauth/complete",
        body: {
          flow: state.flow,
          redirect: `http://localhost:1455/auth/callback?error=access_denied&state=${state.state}`,
        },
      }))
      .json(403, async (body, ctx) => {
        const error = record(body)
        check(error._tag === "ForbiddenError", `expected ForbiddenError, got ${JSON.stringify(body)}`)
        check(String(error.message).includes("access_denied"), "denial reason should be surfaced")
        const retry = await ctx.api.call({
          method: "POST",
          path: "/api/auth/openai/oauth/complete",
          body: { flow: ctx.state.flow, redirect: redirectFor("ok-code", ctx.state.state) },
        })
        check(retry.status === 400, `a denied flow must be discarded: ${retry.status} ${retry.text}`)
        check(profileMissing(), "no profile should be stored after a denial")
      }),
    http
      .post("/api/auth/openai/oauth/complete", "maps a failed token exchange to 503 without leaking details")
      .server(OAUTH_SERVER)
      .seeded(async (api) => {
        resetAuth()
        return startFlow(api)
      })
      .at(({ state }) => ({
        path: "/api/auth/openai/oauth/complete",
        body: { flow: state.flow, redirect: redirectFor("bad-code", state.state) },
      }))
      .json(503, (body, _ctx, result) => {
        const error = record(body)
        check(error._tag === "ServiceUnavailableError", `expected ServiceUnavailableError, got ${JSON.stringify(body)}`)
        check(String(error.message).includes("http_401"), `coarse reason expected: ${String(error.message)}`)
        check(!result.text.includes("invalid_grant"), "upstream response bodies must not be echoed")
        check(profileMissing(), "no profile should be stored after a failed exchange")
      }),
    http
      .post("/api/auth/openai/oauth/complete", "directs to the paste fallback when no listener is active")
      // Point the callback listener at the stub issuer's port, which is
      // already bound: the PKCE flow still starts, but without a listener.
      .server({
        config: { GTE_AGENT_OPENAI_ISSUER: ISSUER_URL, GTE_AGENT_OAUTH_CALLBACK_PORT: String(issuer.port) },
      })
      .seeded(async (api) => {
        resetAuth()
        const flow = await startFlow(api)
        check(flow.callback.listening === false, "listener should be unavailable on an occupied port")
        check(flow.callback.port === undefined, "no port should be reported when not listening")
        return flow
      })
      .at(({ state }) => ({ path: "/api/auth/openai/oauth/complete", body: { flow: state.flow } }))
      .json(400, async (body, ctx) => {
        const error = record(body)
        check(error._tag === "InvalidRequestError", `expected InvalidRequestError, got ${JSON.stringify(body)}`)
        check(String(error.message).includes("paste"), "error should direct the user to the paste fallback")
        const pasted = await ctx.api.call({
          method: "POST",
          path: "/api/auth/openai/oauth/complete",
          body: { flow: ctx.state.flow, redirect: redirectFor("ok-code", ctx.state.state) },
        })
        check(pasted.status === 200, `paste fallback should complete the same flow: ${pasted.status} ${pasted.text}`)
      }),
    http
      .post("/api/auth/openai/oauth/complete", "times out waiting for the browser and suggests the paste fallback")
      .server({
        config: {
          GTE_AGENT_OPENAI_ISSUER: ISSUER_URL,
          GTE_AGENT_OAUTH_CALLBACK_PORT: "0",
          GTE_AGENT_OAUTH_WAIT_MS: "50",
        },
      })
      .seeded(async (api) => {
        resetAuth()
        return startFlow(api)
      })
      .at(({ state }) => ({ path: "/api/auth/openai/oauth/complete", body: { flow: state.flow } }))
      .json(400, (body) => {
        const error = record(body)
        check(error._tag === "InvalidRequestError", `expected InvalidRequestError, got ${JSON.stringify(body)}`)
        check(String(error.message).includes("Timed out"), `timeout should be surfaced: ${String(error.message)}`)
      }),
  ])
})

function profileMissing() {
  if (!existsSync(AUTH_FILE)) return true
  const profiles = readAuthFile().profiles
  return profiles === undefined || record(profiles, "profiles")["openai:default"] === undefined
}

describe("auth secrets never leak into sessions", () => {
  exercise([
    http
      .get("/api/session/:sessionID/event", "stored credentials never appear in session events or messages")
      .seeded(async (api) => {
        resetAuth()
        const session = await api.createSession()
        for (const [provider, key] of [
          ["anthropic", ANTHROPIC_KEY],
          ["openai", OPENAI_KEY],
        ]) {
          const stored = await api.call({ method: "POST", path: `/api/auth/${provider}/api-key`, body: { key } })
          check(stored.status === 200, `api-key seed failed: ${stored.status} ${stored.text}`)
        }
        await api.prompt(String(session.id))
        await api.awaitAssistant(String(session.id))
        return { id: String(session.id) }
      })
      .at(({ state }) => ({ path: `/api/session/${state.id}/event` }))
      .sse({ until: (events) => events.length >= 3, timeoutMs: 15_000 }, async (outcome, ctx) => {
        check(outcome.events.length >= 3, "expected replayed session events")
        for (const event of outcome.events) noSecrets(event.raw, "session event")
        const messages = await ctx.api.call({ path: `/api/session/${ctx.state.id}/message?order=asc` })
        check(messages.status === 200, `messages read failed: ${messages.status}`)
        noSecrets(messages.text, "session messages")
      }),
  ])
})
