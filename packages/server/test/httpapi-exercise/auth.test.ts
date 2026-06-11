/**
 * Auth probes for the canonical server.
 *
 * Two independent layers are exercised:
 *
 * 1. Daemon transport auth (`x-gte-agent-daemon-authorization` Basic header or
 *    `auth_token` query parameter), enforced when the server is constructed
 *    with a password (`createRoutes(password)`).
 * 2. The GTE auth stub (`GTE_AGENT_AUTH_MODE`), injected per server instance
 *    via an explicit ConfigProvider (see harness.ts) because Effect's default
 *    provider snapshots process.env once per process.
 *
 * Known limitation (documented, not testable through HTTP today): the session
 * service resolves `GTEAuth.RequestContextService` once at layer build, where
 * it always sees the stub `devContext`. Bearer-mode requests therefore gate
 * route access but cannot create sessions owned by a different principal, so
 * cross-principal read/`AuthorityConflictError` (409) probes are unreachable
 * until per-request auth context propagation lands. The reachable ownership
 * probe — creating a session for an authority outside the stub grant set
 * (403 ForbiddenError) — is covered in routes.test.ts.
 */
import "./setup"
import { describe } from "bun:test"
import { check, exercise, http, record } from "./dsl"
import { scratchDirectory } from "./setup"
import { ServerAuth } from "../../src/auth"

const PASSWORD = "httpapi-secret"
const TOKEN = "httpapi-bearer-token"

const daemonHeader = (username: string, password: string) => ({
  [ServerAuth.DAEMON_AUTHORIZATION_HEADER]: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
})

describe("daemon transport auth", () => {
  exercise([
    http
      .get("/api/health", "rejects requests without daemon credentials when a password is set")
      .server({ password: PASSWORD })
      .json(401, (body) => {
        const error = record(body)
        check(error._tag === "UnauthorizedError", `expected UnauthorizedError, got ${JSON.stringify(body)}`)
        check(String(error.message).includes("Daemon transport"), "error should describe the daemon transport gate")
      }),
    http
      .get("/api/health", "rejects a wrong daemon password")
      .server({ password: PASSWORD })
      .at(() => ({ path: "/api/health", headers: daemonHeader("gte-agent", "wrong-password") }))
      .status(401),
    http
      .get("/api/health", "rejects a wrong daemon username")
      .server({ password: PASSWORD })
      .at(() => ({ path: "/api/health", headers: daemonHeader("not-gte-agent", PASSWORD) }))
      .status(401),
    http
      .get("/api/health", "accepts valid daemon credentials via the header")
      .server({ password: PASSWORD })
      .at(() => ({ path: "/api/health", headers: daemonHeader("gte-agent", PASSWORD) }))
      .json(200, (body) => {
        check(record(body).healthy === true, "authorized request should reach the route")
      }),
    http
      .get("/api/health", "accepts valid daemon credentials via the auth_token query parameter")
      .server({ password: PASSWORD })
      .at(() => ({
        path: `/api/health?auth_token=${encodeURIComponent(Buffer.from(`gte-agent:${PASSWORD}`).toString("base64"))}`,
      }))
      .json(200, (body) => {
        check(record(body).healthy === true, "query-token request should reach the route")
      }),
    http
      .post("/api/session", "gates mutating session routes behind daemon credentials")
      .server({ password: PASSWORD })
      .at(() => ({ path: "/api/session", body: {} }))
      .status(401),
    http.get("/api/health", "does not require credentials when no password is configured").json(200, (body) => {
      check(record(body).healthy === true, "passwordless server should accept anonymous requests")
    }),
  ])
})

describe("GTE auth stub (bearer mode)", () => {
  const bearer = { GTE_AGENT_AUTH_MODE: "bearer", GTE_AGENT_AUTH_TOKEN: TOKEN }

  exercise([
    http
      .get("/api/health", "rejects requests without bearer credentials")
      .server({ config: bearer })
      .json(401, (body) => {
        const error = record(body)
        check(error._tag === "UnauthorizedError", `expected UnauthorizedError, got ${JSON.stringify(body)}`)
        check(String(error.message).includes("bearer"), `error should mention bearer credentials: ${String(error.message)}`)
      }),
    http
      .get("/api/health", "rejects an invalid bearer token")
      .server({ config: bearer })
      .at(() => ({ path: "/api/health", headers: { authorization: "Bearer wrong-token" } }))
      .json(401, (body) => {
        check(record(body)._tag === "UnauthorizedError", `expected UnauthorizedError, got ${JSON.stringify(body)}`)
      }),
    http
      .get("/api/health", "accepts the configured bearer token")
      .server({ config: bearer })
      .at(() => ({ path: "/api/health", headers: { authorization: `Bearer ${TOKEN}` } }))
      .json(200, (body) => {
        check(record(body).healthy === true, "valid bearer token should reach the route")
      }),
    http
      .post("/api/session", "creates sessions once bearer auth passes")
      .server({ config: bearer })
      .seeded(async (api) => {
        const result = await api.call({ method: "POST", path: "/api/session", body: {} })
        check(result.status === 401, `unauthenticated create should be rejected, got ${result.status}`)
      })
      .at(() => ({
        path: "/api/session",
        body: { runtimeScope: { directory: scratchDirectory("bearer") } },
        headers: { authorization: `Bearer ${TOKEN}` },
      }))
      .json(200, (body) => {
        check(String(record(record(body).data).id).startsWith("ses_"), "authenticated create should succeed")
      }),
    http
      .get("/api/health", "accepts mock-prefixed tokens when no token is configured")
      .server({ config: { GTE_AGENT_AUTH_MODE: "bearer" } })
      .at(() => ({ path: "/api/health", headers: { authorization: "Bearer mock:dev" } }))
      .json(200, (body) => {
        check(record(body).healthy === true, "mock token should pass the stub")
      }),
    http
      .get("/api/health", "rejects non-mock tokens when no token is configured")
      .server({ config: { GTE_AGENT_AUTH_MODE: "bearer" } })
      .at(() => ({ path: "/api/health", headers: { authorization: "Bearer arbitrary" } }))
      .status(401),
  ])
})
