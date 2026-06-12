import { describe, expect, test } from "bun:test"
import { createGteApi, type PanelType, type PinnedPanel } from "../src/api/gte"
import { createModelsApi, type ModelRef } from "../src/api/models"
import { createWorkflowsApi } from "../src/api/workflows"
import { executeSlashCommand, parseSlashCommand, SLASH_COMMANDS, type CommandContext } from "../src/commands/slash"
import { createMockApi } from "./fixture/api"

const BASE_URL = "http://gte-agent.internal"
const ADDRESS = "0x52908400098527886E0F7030069857D2E4169EE7"
const LOWER = ADDRESS.toLowerCase()

describe("parseSlashCommand", () => {
  test("parses command names and arguments", () => {
    expect(parseSlashCommand("/book ETH-USD")).toEqual({ name: "book", args: ["ETH-USD"] })
    expect(parseSlashCommand("  /chart eth 5m ")).toEqual({ name: "chart", args: ["eth", "5m"] })
    expect(parseSlashCommand("/BOOK eth")).toEqual({ name: "book", args: ["eth"] })
    expect(parseSlashCommand("/")).toEqual({ name: "", args: [] })
  })

  test("returns undefined for non-slash input", () => {
    expect(parseSlashCommand("hello world")).toBeUndefined()
    expect(parseSlashCommand("what is /book?")).toBeUndefined()
  })

  test("the catalog covers the full M5 command list", () => {
    const names = SLASH_COMMANDS.map((spec) => spec.name)
    for (const expected of [
      "markets",
      "market",
      "data",
      "book",
      "trades",
      "chart",
      "context",
      "quote",
      "positions",
      "open-orders",
      "order-history",
      "trade-history",
      "balances",
      "balance-history",
      "pnl",
      "funding",
      "account",
      "fees",
      "twap-history",
      "next-subaccount",
      "allowance",
      "leverage",
      "health",
      "liquidations",
      "bench-metrics",
      "track",
      "env",
    ]) {
      expect(names).toContain(expected)
    }
  })
})

type Harness = {
  mock: ReturnType<typeof createMockApi>
  ctx: CommandContext
  infos: string[]
  errors: string[]
  focused: Array<{ panel: PanelType; key: string }>
  modelsOpened: Array<{ providerID: string; modelID: string } | undefined>
  workflowsOpened: number
  prompts: string[]
  appliedModels: ModelRef[]
  /** Session-local ultrathink toggles recorded through ctx.setUltrathink (SCOPE-A). */
  ultrathinkFlags: boolean[]
}

function makeCtx(options?: {
  markets?: string[]
  trackedAddress?: string
  selectedMarket?: string
  pinnedPanels?: PinnedPanel[]
  /** Session active model `/effort` re-selects with a variant. */
  activeModel?: ModelRef
  /** Drive the kill switch so workflow routes answer disabled. */
  workflowsDisabled?: boolean
}): Harness {
  const mock = createMockApi({ markets: options?.markets, workflowsDisabled: options?.workflowsDisabled })
  const infos: string[] = []
  const errors: string[] = []
  const focused: Array<{ panel: PanelType; key: string }> = []
  const modelsOpened: Array<{ providerID: string; modelID: string } | undefined> = []
  const prompts: string[] = []
  const appliedModels: ModelRef[] = []
  const ultrathinkFlags: boolean[] = []
  let workflowsOpened = 0
  const ctx: CommandContext = {
    gte: createGteApi({ baseUrl: BASE_URL, fetch: mock.fetch }),
    sessionID: "ses_slash",
    env: "hyperliquid-dev",
    selectedMarket: options?.selectedMarket,
    trackedAddress: options?.trackedAddress,
    pinnedPanels: options?.pinnedPanels ?? [],
    activeModel: options?.activeModel,
    focusPanel: (panel, key) => focused.push({ panel, key }),
    openModels: (target) => modelsOpened.push(target),
    openWorkflows: () => {
      workflowsOpened++
    },
    models: createModelsApi({ baseUrl: BASE_URL, fetch: mock.fetch }),
    workflows: createWorkflowsApi({ baseUrl: BASE_URL, fetch: mock.fetch }),
    prompt: (text) => prompts.push(text),
    setUltrathink: (on) => ultrathinkFlags.push(on),
    onModelApplied: (model) => appliedModels.push(model),
    info: (text) => infos.push(text),
    error: (text) => errors.push(text),
  }
  return {
    mock,
    ctx,
    infos,
    errors,
    focused,
    modelsOpened,
    prompts,
    appliedModels,
    ultrathinkFlags,
    get workflowsOpened() {
      return workflowsOpened
    },
  }
}

const run = (text: string, harness: Harness) => executeSlashCommand(parseSlashCommand(text)!, harness.ctx)

describe("executeSlashCommand", () => {
  test("/book resolves the symbol, records a snapshot, pins the panel, and sets the primary market", async () => {
    const harness = makeCtx()
    await run("/book eth-usd", harness)

    expect(harness.errors).toEqual([])
    expect(harness.mock.snapshots.length).toBe(1)
    const snapshot = harness.mock.snapshots[0]
    expect(snapshot.sessionID).toBe("ses_slash")
    expect(snapshot.body.command).toBe("/book")
    expect(snapshot.body.panel).toBe("book")
    expect(snapshot.body.key).toBe("ETH-USD")
    const summary = snapshot.body.summary as { rows?: unknown[] }
    expect(Array.isArray(summary.rows)).toBe(true)
    expect((summary.rows ?? []).length).toBeLessThanOrEqual(10)
    const provenance = snapshot.body.provenance as { source: string; env: string }
    expect(provenance.source).toBe("http")
    expect(provenance.env).toBe("hyperliquid-dev")

    expect(harness.mock.intentPatches.length).toBe(1)
    expect(harness.mock.intentPatches[0].patch).toEqual({
      pinnedPanels: [{ panel: "book", key: "ETH-USD" }],
      selectedMarket: "ETH-USD",
    })
    expect(harness.focused).toEqual([{ panel: "book", key: "ETH-USD" }])
  })

  test("ambiguous symbols surface candidates and never guess", async () => {
    const harness = makeCtx({ markets: ["ETH-USD", "ETH-PERP"] })
    await run("/book eth", harness)
    expect(harness.errors.length).toBe(1)
    expect(harness.errors[0]).toContain("ambiguous")
    expect(harness.errors[0]).toContain("ETH-USD")
    expect(harness.errors[0]).toContain("ETH-PERP")
    expect(harness.mock.snapshots).toEqual([])
    expect(harness.mock.intentPatches).toEqual([])
  })

  test("unknown symbols report notFound", async () => {
    const harness = makeCtx()
    await run("/book doge", harness)
    expect(harness.errors[0]).toContain("No GTE market found")
    expect(harness.mock.snapshots).toEqual([])
  })

  test("address commands prefer an explicit address over the tracked address", async () => {
    const harness = makeCtx({ trackedAddress: "0x1111111111111111111111111111111111111111" })
    await run(`/positions ${ADDRESS}`, harness)
    expect(harness.errors).toEqual([])
    expect(harness.mock.snapshots[0].body.key).toBe(LOWER)
    expect(harness.mock.intentPatches[0].patch).toEqual({ pinnedPanels: [{ panel: "positions", key: LOWER }] })
  })

  test("address commands fall back to the session tracked address", async () => {
    const harness = makeCtx({ trackedAddress: LOWER })
    await run("/balances", harness)
    expect(harness.errors).toEqual([])
    expect(harness.mock.snapshots[0].body.panel).toBe("balances")
    expect(harness.mock.snapshots[0].body.key).toBe(LOWER)
  })

  test("address commands without any address ask for one instead of guessing", async () => {
    const harness = makeCtx()
    await run("/pnl", harness)
    expect(harness.errors.length).toBe(1)
    expect(harness.errors[0]).toContain("/track")
    expect(harness.mock.snapshots).toEqual([])
  })

  test("invalid explicit addresses are rejected before any request", async () => {
    const harness = makeCtx()
    await run("/positions 0x123", harness)
    expect(harness.errors[0]).toContain("Invalid EVM address")
    expect(harness.mock.gteRequests).toEqual([])
  })

  test("/track sets and clears the tracked address through session intent", async () => {
    const harness = makeCtx()
    await run(`/track ${ADDRESS}`, harness)
    expect(harness.mock.intentPatches[0].patch).toEqual({ trackedAddress: LOWER })
    expect(harness.infos[0]).toContain(LOWER)

    await run("/track clear", harness)
    expect(harness.mock.intentPatches[1].patch).toEqual({ trackedAddress: null })
  })

  test("/chart with an interval pins a candles panel keyed SYMBOL@interval", async () => {
    const harness = makeCtx()
    await run("/chart eth-usd 5m", harness)
    expect(harness.errors).toEqual([])
    expect(harness.mock.intentPatches[0].patch).toMatchObject({
      pinnedPanels: [{ panel: "candles", key: "ETH-USD@5m" }],
    })
  })

  test("/chart rejects invalid intervals", async () => {
    const harness = makeCtx()
    await run("/chart eth-usd 7m", harness)
    expect(harness.errors[0]).toContain("Invalid interval")
    expect(harness.mock.snapshots).toEqual([])
  })

  test("/quote records an estimate-only snapshot and never opens a panel", async () => {
    const harness = makeCtx()
    await run("/quote eth-usd buy 2", harness)
    expect(harness.errors).toEqual([])
    expect(harness.mock.snapshots.length).toBe(1)
    const body = harness.mock.snapshots[0].body
    expect(body.command).toBe("/quote")
    expect(body.panel).toBeUndefined()
    const summary = body.summary as { title?: string; note?: string }
    expect(summary.title).toContain("ESTIMATE ONLY")
    expect(summary.note).toContain("not an order preview")
    expect(harness.mock.intentPatches).toEqual([])
  })

  test("panel limit (8) is enforced with a clear error", async () => {
    const pinned = Array.from({ length: 8 }, (_, index) => ({
      panel: "trades" as PanelType,
      key: `MKT-${index}`,
    }))
    const harness = makeCtx({ pinnedPanels: pinned })
    await run("/book eth-usd", harness)
    expect(harness.errors[0]).toContain("Panel limit reached")
    expect(harness.mock.intentPatches).toEqual([])
  })

  test("re-running a panel command focuses the existing panel without duplicating it", async () => {
    const harness = makeCtx({ pinnedPanels: [{ panel: "book", key: "ETH-USD" }] })
    await run("/book eth-usd", harness)
    expect(harness.errors).toEqual([])
    expect(harness.mock.intentPatches[0].patch).toMatchObject({
      pinnedPanels: [{ panel: "book", key: "ETH-USD" }],
    })
    expect(harness.focused).toEqual([{ panel: "book", key: "ETH-USD" }])
  })

  test("/allowance falls back to the selected market for its symbol", async () => {
    const harness = makeCtx({ selectedMarket: "ETH-USD" })
    await run(`/allowance ${ADDRESS}`, harness)
    expect(harness.errors).toEqual([])
    expect(harness.mock.gteRequests.some((path) => path.includes("/allowance?symbol=ETH-USD"))).toBe(true)
  })

  test("unknown commands list the catalog", async () => {
    const harness = makeCtx()
    await run("/frobnicate", harness)
    expect(harness.errors[0]).toContain("Unknown command /frobnicate")
    expect(harness.errors[0]).toContain("/book")
  })

  test("/env records env provenance", async () => {
    const harness = makeCtx()
    await run("/env", harness)
    const body = harness.mock.snapshots[0].body
    expect(body.command).toBe("/env")
    const summary = body.summary as { fields?: Record<string, string> }
    expect(summary.fields?.env).toBe("hyperliquid-dev")
    expect(summary.fields?.validEnvs).toContain("hyperliquid-prod")
  })
})

describe("/models", () => {
  test("is registered with model-ref arg completion", () => {
    const spec = SLASH_COMMANDS.find((candidate) => candidate.name === "models")
    expect(spec).toBeDefined()
    expect(spec?.usage).toBe("/models [provider/model]")
    expect(spec?.argCompletions).toEqual(["model-ref"])
  })

  test("without args opens the picker overlay", async () => {
    const harness = makeCtx()
    await run("/models", harness)
    expect(harness.errors).toEqual([])
    expect(harness.modelsOpened).toEqual([undefined])
  })

  test("with a provider/model ref selects directly, skipping the picker", async () => {
    const harness = makeCtx()
    await run("/models anthropic/claude-fable-5", harness)
    expect(harness.errors).toEqual([])
    expect(harness.modelsOpened).toEqual([{ providerID: "anthropic", modelID: "claude-fable-5" }])
  })

  test("lowercases the provider segment but preserves the model id", async () => {
    const harness = makeCtx()
    await run("/models Anthropic/claude-fable-5", harness)
    expect(harness.modelsOpened).toEqual([{ providerID: "anthropic", modelID: "claude-fable-5" }])
  })

  test("rejects refs that are not provider/model shaped", async () => {
    for (const bad of ["bogus", "/claude", "anthropic/", "a/b/c"]) {
      const harness = makeCtx()
      await run(`/models ${bad}`, harness)
      expect(harness.modelsOpened).toEqual([])
      expect(harness.errors.length).toBe(1)
      expect(harness.errors[0]).toContain("expected <provider>/<model>")
    }
  })
})

const FABLE: ModelRef = { providerID: "anthropic", id: "claude-fable-5" }
const HAIKU: ModelRef = { providerID: "anthropic", id: "claude-haiku-4-5" }
const GPT: ModelRef = { providerID: "openai", id: "gpt-5.5" }

describe("/workflows", () => {
  test("opens the overlay", async () => {
    const harness = makeCtx()
    await run("/workflows", harness)
    expect(harness.errors).toEqual([])
    expect(harness.workflowsOpened).toBe(1)
  })
})

describe("/effort", () => {
  test("a named tier re-selects the active model with that variant", async () => {
    const harness = makeCtx({ activeModel: FABLE })
    await run("/effort high", harness)
    expect(harness.errors).toEqual([])
    expect(harness.mock.selections).toEqual([
      { providerID: "anthropic", modelID: "claude-fable-5", variant: "high", sessionID: "ses_slash" },
    ])
    expect(harness.appliedModels[0]).toMatchObject({ providerID: "anthropic", id: "claude-fable-5", variant: "high" })
    expect(harness.infos[0]).toContain("Effort set to high")
  })

  test("rejects an unknown tier and never selects", async () => {
    const harness = makeCtx({ activeModel: FABLE })
    await run("/effort turbo", harness)
    expect(harness.mock.selections).toEqual([])
    expect(harness.errors[0]).toContain('Unknown effort tier "turbo"')
  })

  test("with no active model asks the user to pick one", async () => {
    const harness = makeCtx()
    await run("/effort high", harness)
    expect(harness.mock.selections).toEqual([])
    expect(harness.errors[0]).toContain("No active model")
  })

  test("a named tier the model does not offer is reported up front and never persists", async () => {
    // Haiku offers high/max only; xhigh must be refused before any select call,
    // so a dangling variant never reaches the session.
    const harness = makeCtx({ activeModel: HAIKU })
    await run("/effort xhigh", harness)
    expect(harness.mock.selections).toEqual([])
    expect(harness.appliedModels).toEqual([])
    expect(harness.infos).toEqual([])
    expect(harness.errors[0]).toContain('Effort "xhigh" is not available')
    expect(harness.errors[0]).toContain("high, max")
  })

  test("ultrathink picks xhigh when the model offers it and turns on the session flag", async () => {
    const harness = makeCtx({ activeModel: FABLE })
    await run("/effort ultrathink", harness)
    expect(harness.errors).toEqual([])
    expect(harness.mock.selections).toEqual([
      { providerID: "anthropic", modelID: "claude-fable-5", variant: "xhigh", sessionID: "ses_slash" },
    ])
    // SCOPE-A: the session-local flag, not a durable intent row.
    expect(harness.ultrathinkFlags).toEqual([true])
    expect(harness.mock.intentPatches.some((entry) => entry.patch.ultrathink === true)).toBe(false)
    expect(harness.infos[0]).toContain("Ultrathink enabled")
    expect(harness.infos[0]).toContain("xhigh")
    expect(harness.infos[0]).toContain("ultrathink mode")
  })

  test("ultrathink falls back to max when the model has no xhigh", async () => {
    const harness = makeCtx({ activeModel: HAIKU })
    await run("/effort ultrathink", harness)
    expect(harness.mock.selections[0]).toMatchObject({ modelID: "claude-haiku-4-5", variant: "max" })
    expect(harness.ultrathinkFlags).toEqual([true])
  })

  test("ultrathink on a model with no variants sets only the session flag", async () => {
    const harness = makeCtx({ activeModel: GPT })
    await run("/effort ultrathink", harness)
    expect(harness.mock.selections).toEqual([])
    expect(harness.ultrathinkFlags).toEqual([true])
    expect(harness.mock.intentPatches.some((entry) => entry.patch.ultrathink === true)).toBe(false)
    expect(harness.infos[0]).toContain("No reasoning variants exist")
  })

  test("ultrathink reports the kill switch when workflows are disabled and never flags", async () => {
    const harness = makeCtx({ activeModel: FABLE, workflowsDisabled: true })
    await run("/effort ultrathink", harness)
    expect(harness.mock.selections).toEqual([])
    expect(harness.ultrathinkFlags).toEqual([])
    expect(harness.errors).toEqual(["workflows are disabled"])
  })
})

describe("/workflow", () => {
  test("wraps the task with the orchestration prefix, leads with the ultrathink keyword, and sends it", async () => {
    const harness = makeCtx()
    await run("/workflow compare ETH and BTC liquidity", harness)
    expect(harness.errors).toEqual([])
    expect(harness.prompts.length).toBe(1)
    expect(harness.prompts[0]).toContain("compare ETH and BTC liquidity")
    expect(harness.prompts[0]).toContain("workflow tool")
    // The literal keyword must lead so the server-side detector fires.
    expect(harness.prompts[0]).toContain("ultrathink")
  })

  test("without a task reports usage and sends nothing", async () => {
    const harness = makeCtx()
    await run("/workflow", harness)
    expect(harness.prompts).toEqual([])
    expect(harness.errors[0]).toContain("Usage:")
  })

  test("is gated on the kill switch: disabled workflows report and send nothing", async () => {
    const harness = makeCtx({ workflowsDisabled: true })
    await run("/workflow compare ETH and BTC liquidity", harness)
    expect(harness.prompts).toEqual([])
    expect(harness.errors).toEqual(["workflows are disabled"])
  })
})

describe("/deep-research", () => {
  test("injects an instruction to run the bundled deep-research workflow with the question", async () => {
    const harness = makeCtx()
    await run("/deep-research what is ETH funding doing across perps", harness)
    expect(harness.errors).toEqual([])
    expect(harness.prompts.length).toBe(1)
    expect(harness.prompts[0]).toContain("workflow tool")
    expect(harness.prompts[0]).toContain("deep-research")
    expect(harness.prompts[0]).toContain("what is ETH funding doing across perps")
  })

  test("without a question reports usage and sends nothing", async () => {
    const harness = makeCtx()
    await run("/deep-research", harness)
    expect(harness.prompts).toEqual([])
    expect(harness.errors[0]).toContain("Usage:")
  })

  test("is gated on the kill switch: disabled workflows report and send nothing", async () => {
    const harness = makeCtx({ workflowsDisabled: true })
    await run("/deep-research what is ETH funding doing", harness)
    expect(harness.prompts).toEqual([])
    expect(harness.errors).toEqual(["workflows are disabled"])
  })
})
