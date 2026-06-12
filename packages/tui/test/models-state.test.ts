import { describe, expect, test } from "bun:test"
import { createModelsApi, type CatalogProvider } from "../src/api/models"
import { formatActiveModel } from "../src/ui/status-bar"
import { makeSession } from "./fixture/api"
import {
  authLabel,
  authMethods,
  backStep,
  modelRefString,
  parseModelTarget,
  pickerEntries,
  selectableEntries,
  type WizardStep,
} from "../src/state/models"

const model = (id: string, options?: { isDefault?: boolean }) => ({
  id,
  name: id,
  status: "active" as const,
  released: 1735689600000,
  capabilities: { tools: true },
  limit: { context: 200000, output: 64000 },
  isDefault: options?.isDefault ?? false,
})

const providers: CatalogProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    auth: { authenticated: true, method: "api_key", source: "env" },
    models: [model("claude-fable-5", { isDefault: true }), model("claude-haiku-4-5")],
  },
  {
    id: "openai",
    name: "OpenAI",
    auth: { authenticated: false },
    models: [model("gpt-5.5"), model("gpt-5.4-mini")],
  },
]

describe("parseModelTarget", () => {
  test("parses provider/model refs, lowercasing the provider", () => {
    expect(parseModelTarget("anthropic/claude-fable-5")).toEqual({
      providerID: "anthropic",
      modelID: "claude-fable-5",
    })
    expect(parseModelTarget("OpenAI/gpt-5.5")).toEqual({ providerID: "openai", modelID: "gpt-5.5" })
  })

  test("rejects anything not provider/model shaped", () => {
    for (const bad of ["", "claude", "/claude", "anthropic/", "/", "a/b/c"]) {
      expect(parseModelTarget(bad)).toBeUndefined()
    }
  })
})

describe("authLabel", () => {
  test("describes credential method and source", () => {
    expect(authLabel({ authenticated: false })).toBe("needs setup")
    expect(authLabel({ authenticated: true, method: "api_key", source: "store" })).toBe("authed (api key via store)")
    expect(authLabel({ authenticated: true, method: "oauth", source: "store" })).toBe("authed (oauth via store)")
    expect(authLabel({ authenticated: true })).toBe("authed (api key)")
  })
})

describe("pickerEntries", () => {
  test("groups models under provider headers with auth, current, and default markers", () => {
    const entries = pickerEntries(providers, { current: { id: "gpt-5.5", providerID: "openai" } })
    expect(entries.map((entry) => (entry.kind === "header" ? entry.label : entry.ref))).toEqual([
      "Anthropic — authed (api key via env)",
      "anthropic/claude-fable-5",
      "anthropic/claude-haiku-4-5",
      "OpenAI — needs setup",
      "openai/gpt-5.5",
      "openai/gpt-5.4-mini",
    ])
    const rows = selectableEntries(entries)
    expect(rows.map((row) => row.authed)).toEqual([true, true, false, false])
    expect(rows.map((row) => row.isDefault)).toEqual([true, false, false, false])
    expect(rows.map((row) => row.isCurrent)).toEqual([false, false, true, false])
  })

  test("fuzzy filter keeps matching rows and drops emptied provider groups", () => {
    const entries = pickerEntries(providers, { filter: "claude" })
    expect(entries.map((entry) => (entry.kind === "header" ? entry.label : entry.ref))).toEqual([
      "Anthropic — authed (api key via env)",
      "anthropic/claude-fable-5",
      "anthropic/claude-haiku-4-5",
    ])
    expect(pickerEntries(providers, { filter: "zzz-no-match" })).toEqual([])
  })

  test("filter matches across the provider/model ref", () => {
    const rows = selectableEntries(pickerEntries(providers, { filter: "openai/gpt" }))
    expect(rows.map((row) => row.ref)).toEqual(["openai/gpt-5.5", "openai/gpt-5.4-mini"])
  })
})

describe("authMethods", () => {
  test("anthropic offers the paste flow only (key or setup-token)", () => {
    expect(authMethods("anthropic").map((option) => option.id)).toEqual(["paste"])
    expect(authMethods("anthropic")[0].label).toContain("setup-token")
  })

  test("openai offers paste and ChatGPT sign-in", () => {
    expect(authMethods("openai").map((option) => option.id)).toEqual(["paste", "oauth"])
  })

  test("unknown providers fall back to paste", () => {
    expect(authMethods("acme").map((option) => option.id)).toEqual(["paste"])
  })
})

describe("backStep", () => {
  const target = { providerID: "openai", modelID: "gpt-5.5" }

  test("backs out exactly one step from the picker entry point", () => {
    const oauth: WizardStep = { kind: "oauth", target }
    const method = backStep(oauth, "picker")
    expect(method).toEqual({ kind: "method", target })
    expect(backStep(method!, "picker")).toEqual({ kind: "picker" })
    expect(backStep({ kind: "picker" }, "picker")).toBeUndefined()
  })

  test("paste backs out to the method picker", () => {
    expect(backStep({ kind: "paste", target }, "picker")).toEqual({ kind: "method", target })
  })

  test("direct /models <ref> entry closes from the method picker (the picker was skipped)", () => {
    expect(backStep({ kind: "method", target }, "direct")).toBeUndefined()
    expect(backStep({ kind: "paste", target }, "direct")).toEqual({ kind: "method", target })
  })

  test("confirm closes", () => {
    expect(backStep({ kind: "confirm", message: "done" }, "picker")).toBeUndefined()
  })
})

describe("modelRefString", () => {
  test("formats provider/model", () => {
    expect(modelRefString({ id: "claude-fable-5", providerID: "anthropic" })).toBe("anthropic/claude-fable-5")
  })
})

describe("formatActiveModel", () => {
  const ref = { id: "claude-fable-5", providerID: "anthropic" }

  test("the session's own selection wins", () => {
    expect(formatActiveModel(makeSession({ id: "ses_x", model: { id: "gpt-5.5", providerID: "openai" } }), ref)).toBe(
      "model openai/gpt-5.5",
    )
  })

  test("sessions without a selection inherit the global default", () => {
    expect(formatActiveModel(makeSession({ id: "ses_x" }), ref)).toBe("model anthropic/claude-fable-5 (default)")
    expect(formatActiveModel(makeSession({ id: "ses_x", model: null }), ref)).toBe(
      "model anthropic/claude-fable-5 (default)",
    )
  })

  test("with neither set, the line points at /models", () => {
    expect(formatActiveModel(makeSession({ id: "ses_x" }), undefined)).toBe("model not set — /models")
    expect(formatActiveModel(undefined, undefined)).toBe("model not set — /models")
  })

  test("a null wire default (no global default configured) never crashes", () => {
    // The HTTP API serializes an absent default as null; a fresh install hits
    // this on the very first session open.
    expect(formatActiveModel(makeSession({ id: "ses_x", model: null }), null)).toBe("model not set — /models")
    expect(formatActiveModel(undefined, null)).toBe("model not set — /models")
  })

  test("appends the reasoning-effort variant in parentheses when the model carries one", () => {
    expect(
      formatActiveModel(
        makeSession({ id: "ses_x", model: { id: "claude-fable-5", providerID: "anthropic", variant: "xhigh" } }),
        ref,
      ),
    ).toBe("model anthropic/claude-fable-5 (xhigh)")
    // The inherited default's variant shows too, before the (default) marker.
    expect(formatActiveModel(makeSession({ id: "ses_x" }), { ...ref, variant: "max" })).toBe(
      "model anthropic/claude-fable-5 (max) (default)",
    )
    // An empty-string variant is treated as no variant.
    expect(
      formatActiveModel(
        makeSession({ id: "ses_x", model: { id: "claude-fable-5", providerID: "anthropic", variant: "" } }),
        ref,
      ),
    ).toBe("model anthropic/claude-fable-5")
  })
})

describe("createModelsApi.list null normalization", () => {
  const listFetch = (body: unknown) =>
    (async () => new Response(JSON.stringify({ data: body }), { status: 200 })) as unknown as typeof fetch

  test("null default and session (fresh install) normalize to absent", async () => {
    const api = createModelsApi({
      baseUrl: "http://gte-agent.internal",
      fetch: listFetch({ providers, default: null, session: null }),
    })
    const catalog = await api.list()
    expect(catalog.providers).toHaveLength(2)
    expect("default" in catalog).toBe(false)
    expect("session" in catalog).toBe(false)
  })

  test("a session with a null model keeps the id and drops the model", async () => {
    const api = createModelsApi({
      baseUrl: "http://gte-agent.internal",
      fetch: listFetch({ providers, default: null, session: { id: "ses_x", model: null } }),
    })
    const catalog = await api.list(`ses_x`)
    expect(catalog.session).toEqual({ id: "ses_x" })
  })

  test("present default and session model pass through", async () => {
    const ref = { id: "claude-fable-5", providerID: "anthropic" }
    const api = createModelsApi({
      baseUrl: "http://gte-agent.internal",
      fetch: listFetch({ providers, default: ref, session: { id: "ses_x", model: ref } }),
    })
    const catalog = await api.list("ses_x")
    expect(catalog.default).toEqual(ref)
    expect(catalog.session).toEqual({ id: "ses_x", model: ref })
  })
})
