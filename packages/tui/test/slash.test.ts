import { describe, expect, test } from "bun:test"
import { createGteApi, type PanelType, type PinnedPanel } from "../src/api/gte"
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
}

function makeCtx(options?: {
  markets?: string[]
  trackedAddress?: string
  selectedMarket?: string
  pinnedPanels?: PinnedPanel[]
}): Harness {
  const mock = createMockApi({ markets: options?.markets })
  const infos: string[] = []
  const errors: string[] = []
  const focused: Array<{ panel: PanelType; key: string }> = []
  const modelsOpened: Array<{ providerID: string; modelID: string } | undefined> = []
  const ctx: CommandContext = {
    gte: createGteApi({ baseUrl: BASE_URL, fetch: mock.fetch }),
    sessionID: "ses_slash",
    env: "hyperliquid-dev",
    selectedMarket: options?.selectedMarket,
    trackedAddress: options?.trackedAddress,
    pinnedPanels: options?.pinnedPanels ?? [],
    focusPanel: (panel, key) => focused.push({ panel, key }),
    openModels: (target) => modelsOpened.push(target),
    info: (text) => infos.push(text),
    error: (text) => errors.push(text),
  }
  return { mock, ctx, infos, errors, focused, modelsOpened }
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
