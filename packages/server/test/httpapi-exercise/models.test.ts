/**
 * Route-level coverage for the model catalog and selection routes (Milestone 7):
 * GET /api/models and POST /api/models/select.
 *
 * Selection round-trips run against the real core ModelSelection service: a
 * select writes the global default into the hermetic home's
 * .gte-agent/config.json and (with a sessionID) publishes a durable model
 * switch that the session projector applies, so the listing's per-session
 * selection is asserted through the API. Auth-status annotations come from
 * profiles stored through the auth-provider routes and from provider env vars;
 * every credential-bearing scenario asserts no secret material reaches any
 * response body.
 */
import "./setup"
import { describe } from "bun:test"
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { array, check, exercise, http, record, type Api } from "./dsl"

const HOME = process.env.GTE_AGENT_TEST_HOME ?? ""
const CONFIG_FILE = path.join(HOME, ".gte-agent", "config.json")
const AUTH_FILE = path.join(HOME, ".gte-agent", "auth.json")
const PASSWORD = "models-daemon-password"

const ANTHROPIC_KEY = "sk-ant-api03-models-route-secret-key-material"
const OPENAI_ENV_KEY = "sk-models-route-env-openai-secret-material"

/** All scenarios share one process-wide home; reset selection + credential state per scenario. */
function reset() {
  rmSync(CONFIG_FILE, { force: true })
  rmSync(AUTH_FILE, { force: true })
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
}

function listingData(body: unknown): Record<string, unknown> {
  return record(record(body, "models response").data, "models data")
}

function providerEntry(body: unknown, id: string): Record<string, unknown> {
  const entry = array(listingData(body).providers, "providers").find((item) => record(item, "provider").id === id)
  check(entry !== undefined, `listing should include provider ${id}`)
  return record(entry, `${id} provider`)
}

function modelRows(provider: Record<string, unknown>): Record<string, unknown>[] {
  return array(provider.models, "models").map((item) => record(item, "model row"))
}

async function seedAnthropicKey(api: Api) {
  const stored = await api.call({ method: "POST", path: "/api/auth/anthropic/api-key", body: { key: ANTHROPIC_KEY } })
  check(stored.status === 200, `seed api-key failed: ${stored.status} ${stored.text}`)
}

describe("models.list", () => {
  exercise([
    http
      .get("/api/models", "lists the curated catalog grouped by provider with no default on a fresh home")
      .seeded(async () => {
        reset()
        return undefined
      })
      .json(200, (body) => {
        const data = listingData(body)
        // Optional response fields encode as null when unset.
        check(data.default == null, `fresh home must not report a global default: ${JSON.stringify(data.default)}`)
        check(data.session == null, "session selection must be absent without a sessionID query")

        const anthropic = providerEntry(body, "anthropic")
        check(anthropic.name === "Anthropic", `anthropic should carry its display name: ${JSON.stringify(anthropic)}`)
        check(
          record(anthropic.auth, "anthropic auth").authenticated === false,
          "fresh home must report anthropic unauthenticated",
        )
        const anthropicModels = modelRows(anthropic)
        check(
          anthropicModels.some((row) => row.id === "claude-fable-5"),
          `anthropic models should include claude-fable-5: ${JSON.stringify(anthropicModels.map((row) => row.id))}`,
        )
        // The listing carries each model's reasoning-effort variant ids so the
        // TUI's /effort can resolve ultrathink to the highest tier (xhigh here).
        const fable = record(
          anthropicModels.find((row) => row.id === "claude-fable-5"),
          "claude-fable-5 row",
        )
        const fableVariants = array(fable.variants, "claude-fable-5 variants")
        check(
          fableVariants.includes("xhigh") && fableVariants.includes("max"),
          `claude-fable-5 should expose its effort variants: ${JSON.stringify(fableVariants)}`,
        )

        const openai = providerEntry(body, "openai")
        check(
          record(openai.auth, "openai auth").authenticated === false,
          "fresh home must report openai unauthenticated",
        )
        const openaiModels = modelRows(openai)
        check(
          openaiModels.some((row) => row.id === "gpt-5.5"),
          `openai models should include gpt-5.5: ${JSON.stringify(openaiModels.map((row) => row.id))}`,
        )

        for (const row of [...anthropicModels, ...openaiModels]) {
          check(typeof row.name === "string" && row.name.length > 0, `model row needs a name: ${JSON.stringify(row)}`)
          check(row.isDefault === false, `no row may be flagged default on a fresh home: ${JSON.stringify(row)}`)
          check(row.status === "active", `curated rows are active: ${JSON.stringify(row)}`)
          check(record(row.capabilities, "capabilities").tools === true, "curated models support tool calling")
          const limit = record(row.limit, "limit")
          check(
            Number(limit.context) > 0 && Number(limit.output) > 0,
            `limits must be populated: ${JSON.stringify(row)}`,
          )
          check(Number(row.released) > 0, `released must be epoch millis: ${JSON.stringify(row)}`)
        }
      }),

    http
      .get("/api/models", "annotates provider auth status from stored profiles and env vars without leaking secrets")
      .seeded(async (api) => {
        reset()
        await seedAnthropicKey(api)
        // AuthStore env fallbacks read process.env directly (not the harness
        // ConfigProvider), so this is visible to the server under test.
        process.env.OPENAI_API_KEY = OPENAI_ENV_KEY
        return undefined
      })
      .json(200, (body, _ctx, result) => {
        check(!result.text.includes(ANTHROPIC_KEY), "listing must not contain the stored key material")
        check(!result.text.includes(OPENAI_ENV_KEY), "listing must not contain env-var key material")
        const anthropic = record(providerEntry(body, "anthropic").auth, "anthropic auth")
        check(
          anthropic.authenticated === true && anthropic.method === "api_key" && anthropic.source === "store",
          `anthropic should be store-authenticated: ${JSON.stringify(anthropic)}`,
        )
        const openai = record(providerEntry(body, "openai").auth, "openai auth")
        check(
          openai.authenticated === true && openai.method === "api_key" && openai.source === "env",
          `openai should be env-authenticated: ${JSON.stringify(openai)}`,
        )
      }),

    http
      .get("/api/models", "rejects an unknown sessionID with 404")
      .seeded(async () => {
        reset()
        return undefined
      })
      .at(() => ({ path: "/api/models?sessionID=ses_models_missing" }))
      .json(404, (body) => {
        const error = record(body, "error body")
        check(error._tag === "SessionNotFoundError", `expected SessionNotFoundError, got ${JSON.stringify(body)}`)
      }),

    http
      .get("/api/models", "requires daemon credentials when a password is set")
      .server({ password: PASSWORD })
      .json(401, (body) => {
        const error = record(body, "error body")
        check(error._tag === "UnauthorizedError", `expected UnauthorizedError, got ${JSON.stringify(body)}`)
      }),
  ])
})

describe("models.select", () => {
  exercise([
    http
      .post("/api/models/select", "applies a session selection and writes the global default")
      .seeded(async (api) => {
        reset()
        const session = await api.createSession()
        return { id: String(session.id) }
      })
      .at(({ state }) => ({
        path: "/api/models/select",
        body: { providerID: "anthropic", modelID: "claude-fable-5", sessionID: state.id },
      }))
      .json(200, async (body, ctx) => {
        const data = record(record(body, "select response").data, "select data")
        const model = record(data.model, "selected model")
        check(
          model.id === "claude-fable-5" && model.providerID === "anthropic",
          `selection should echo the ref: ${JSON.stringify(model)}`,
        )
        check(data.name === "Claude Fable 5", `selection should carry the display name: ${JSON.stringify(data)}`)
        check(
          record(data.auth, "selection auth").authenticated === false,
          "selecting an unauthenticated provider succeeds and reports the auth gap",
        )

        // Global default persisted for new sessions.
        const stored = record(JSON.parse(readFileSync(CONFIG_FILE, "utf8")), "config.json")
        check(
          stored.model === "anthropic/claude-fable-5",
          `global default should be written: ${JSON.stringify(stored)}`,
        )

        // The listing reflects the default immediately and the per-session
        // selection once the durable model switch projects.
        const deadline = Date.now() + 10_000
        for (;;) {
          const result = await ctx.api.call({ path: `/api/models?sessionID=${ctx.state.id}` })
          check(result.status === 200, `listing after select failed: ${result.status} ${result.text}`)
          const listing = listingData(result.body)
          const fallback = record(listing.default ?? {}, "default ref")
          check(
            fallback.id === "claude-fable-5" && fallback.providerID === "anthropic",
            `listing should report the new default: ${JSON.stringify(listing.default)}`,
          )
          const flagged = modelRows(providerEntry(result.body, "anthropic")).filter((row) => row.isDefault === true)
          check(
            flagged.length === 1 && flagged[0]?.id === "claude-fable-5",
            `exactly the selected row is flagged default: ${JSON.stringify(flagged)}`,
          )
          const sessionState = record(listing.session, "session selection")
          check(sessionState.id === ctx.state.id, "listing should echo the queried session")
          if (sessionState.model != null && record(sessionState.model, "session model").id === "claude-fable-5") {
            return
          }
          check(Date.now() <= deadline, `session model switch never projected: ${JSON.stringify(listing)}`)
          await Bun.sleep(25)
        }
      }),

    http
      .post("/api/models/select", "writes the global default without a sessionID")
      .seeded(async () => {
        reset()
        return undefined
      })
      .at(() => ({ path: "/api/models/select", body: { providerID: "openai", modelID: "gpt-5.5" } }))
      .json(200, (body) => {
        const model = record(record(record(body, "select response").data, "select data").model, "selected model")
        check(
          model.id === "gpt-5.5" && model.providerID === "openai",
          `selection should echo the ref: ${JSON.stringify(model)}`,
        )
        const stored = record(JSON.parse(readFileSync(CONFIG_FILE, "utf8")), "config.json")
        check(stored.model === "openai/gpt-5.5", `global default should be written: ${JSON.stringify(stored)}`)
      }),

    http
      .post("/api/models/select", "rejects a model that is not in the curated catalog")
      .seeded(async () => {
        reset()
        return undefined
      })
      .at(() => ({ path: "/api/models/select", body: { providerID: "anthropic", modelID: "claude-1" } }))
      .json(404, (body) => {
        const error = record(body, "error body")
        check(error._tag === "ModelNotFoundError", `expected ModelNotFoundError, got ${JSON.stringify(body)}`)
        check(
          error.providerID === "anthropic" && error.modelID === "claude-1",
          `error should carry the ref: ${JSON.stringify(body)}`,
        )
        check(!existsSync(CONFIG_FILE), "a rejected selection must not write the global default")
      }),

    http
      .post("/api/models/select", "rejects a variant the model does not offer with a 404")
      .seeded(async () => {
        reset()
        return undefined
      })
      .at(() => ({
        path: "/api/models/select",
        // Haiku offers high/max only; xhigh would dangle and brick later turns.
        body: { providerID: "anthropic", modelID: "claude-haiku-4-5", variant: "xhigh" },
      }))
      .json(404, (body) => {
        const error = record(body, "error body")
        check(error._tag === "VariantNotFoundError", `expected VariantNotFoundError, got ${JSON.stringify(body)}`)
        check(error.variant === "xhigh", `error should carry the variant: ${JSON.stringify(body)}`)
        check(!existsSync(CONFIG_FILE), "a rejected variant selection must not write the global default")
      }),

    http
      .post("/api/models/select", "rejects a provider that is not in the curated catalog")
      .seeded(async () => {
        reset()
        return undefined
      })
      .at(() => ({ path: "/api/models/select", body: { providerID: "mistral", modelID: "mistral-large" } }))
      .json(404, (body) => {
        const error = record(body, "error body")
        check(error._tag === "ProviderNotFoundError", `expected ProviderNotFoundError, got ${JSON.stringify(body)}`)
        check(!existsSync(CONFIG_FILE), "a rejected selection must not write the global default")
      }),

    http
      .post("/api/models/select", "rejects an unknown session before applying any side effect")
      .seeded(async () => {
        reset()
        return undefined
      })
      .at(() => ({
        path: "/api/models/select",
        body: { providerID: "anthropic", modelID: "claude-fable-5", sessionID: "ses_models_select_missing" },
      }))
      .json(404, (body) => {
        const error = record(body, "error body")
        check(error._tag === "SessionNotFoundError", `expected SessionNotFoundError, got ${JSON.stringify(body)}`)
        check(!existsSync(CONFIG_FILE), "a selection rejected on the session must not write the global default")
      }),
  ])
})
