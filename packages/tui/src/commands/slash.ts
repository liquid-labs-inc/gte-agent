/**
 * Slash command catalog for the read-only GTE data surface (Milestone 5).
 *
 * Parsing is pure (`parseSlashCommand`); execution (`executeSlashCommand`)
 * calls the same canonical /api/gte routes as the agent tools, records a
 * compact transcript snapshot, and — for panel commands — pins/focuses the
 * matching live panel through the session intent route.
 *
 * Read-only rules baked in here:
 * - symbols always go through /api/gte/resolve-symbol; ambiguity surfaces
 *   candidates and never guesses
 * - address-scoped commands need an explicit address or the session tracked
 *   address; otherwise they ask for one
 * - /quote is rendered as an ESTIMATE ONLY book read, never order-shaped
 */
import type { GteApi, GteProvenance, PanelType, PinnedPanel, SnapshotSummary } from "../api/gte"
import { CANDLE_INTERVALS, GteRequestError } from "../api/gte"
import type { ModelRef, ModelsApi } from "../api/models"
import { isWorkflowsDisabled, type WorkflowsApi } from "../api/workflows"
import { parseModelTarget, type ModelTarget } from "../state/models"
import { summarizeData } from "../state/summarize"

export const MAX_PINNED_PANELS = 8
export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

/** Named reasoning-effort tiers `/effort` accepts (besides the `ultrathink` resolver). */
export const EFFORT_TIERS = ["low", "medium", "high", "xhigh", "max"] as const
export type EffortTier = (typeof EFFORT_TIERS)[number]

/**
 * Minimal orchestration instruction prefixed onto a `/workflow <task>` prompt.
 * Core-side keyword handling is a separate workstream; the TUI's only job is to
 * wrap the user's task with this line so the model knows to consider fanning the
 * work out via the workflow tool.
 */
export const WORKFLOW_PROMPT_PREFIX =
  "Use the workflow tool to fan this task out across bounded subagents when it benefits from parallel research, scaling the fan-out to the task. Task:"

export type ParsedCommand = { readonly name: string; readonly args: readonly string[] }

/** Returns undefined when the text is not a slash command. */
export function parseSlashCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return undefined
  const parts = trimmed
    .slice(1)
    .split(/\s+/)
    .filter((part) => part.length > 0)
  if (parts.length === 0) return { name: "", args: [] }
  return { name: parts[0].toLowerCase(), args: parts.slice(1) }
}

type CommandKind = "market-panel" | "market-read" | "address-panel" | "address-read" | "misc"

/**
 * Arg-completion source kinds for prompt autocomplete. Adding a kind here plus
 * a data provider in `state/autocomplete.ts` (`createCompletionSources`) is
 * the whole extension surface — the dropdown wiring is source-agnostic.
 * `model-ref` completes `<provider>/<model>` refs for the upcoming /models
 * command; its provider returns nothing until the catalog surface lands.
 */
export type ArgCompletionSource = "symbol" | "model-ref"

export type CommandSpec = {
  readonly name: string
  readonly usage: string
  readonly kind: CommandKind
  /** Panel opened by this command (panel commands only). */
  readonly panel?: PanelType
  /** Positional arg-completion sources: index N completes arg N. */
  readonly argCompletions?: ReadonlyArray<ArgCompletionSource | undefined>
}

export const SLASH_COMMANDS: readonly CommandSpec[] = [
  { name: "markets", usage: "/markets [query]", kind: "market-read" },
  { name: "market", usage: "/market <symbol>", kind: "market-read", argCompletions: ["symbol"] },
  { name: "data", usage: "/data <symbol>", kind: "market-panel", panel: "marketData", argCompletions: ["symbol"] },
  { name: "book", usage: "/book <symbol>", kind: "market-panel", panel: "book", argCompletions: ["symbol"] },
  { name: "trades", usage: "/trades <symbol>", kind: "market-panel", panel: "trades", argCompletions: ["symbol"] },
  {
    name: "chart",
    usage: "/chart <symbol> [interval]",
    kind: "market-panel",
    panel: "candles",
    argCompletions: ["symbol"],
  },
  { name: "context", usage: "/context <symbol>", kind: "market-read", argCompletions: ["symbol"] },
  { name: "quote", usage: "/quote <symbol> <buy|sell> <size>", kind: "market-read", argCompletions: ["symbol"] },
  {
    name: "liquidations",
    usage: "/liquidations <symbol>",
    kind: "market-panel",
    panel: "liquidations",
    argCompletions: ["symbol"],
  },
  { name: "positions", usage: "/positions [address]", kind: "address-panel", panel: "positions" },
  { name: "open-orders", usage: "/open-orders [address]", kind: "address-panel", panel: "openOrders" },
  { name: "order-history", usage: "/order-history [address]", kind: "address-panel", panel: "orderHistory" },
  { name: "trade-history", usage: "/trade-history [address]", kind: "address-read" },
  { name: "balances", usage: "/balances [address]", kind: "address-panel", panel: "balances" },
  { name: "balance-history", usage: "/balance-history [address]", kind: "address-read" },
  { name: "pnl", usage: "/pnl [address]", kind: "address-read" },
  { name: "funding", usage: "/funding [address]", kind: "address-panel", panel: "funding" },
  { name: "account", usage: "/account [address]", kind: "address-panel", panel: "accountMetrics" },
  { name: "fees", usage: "/fees [address]", kind: "address-read" },
  { name: "twap-history", usage: "/twap-history [address]", kind: "address-panel", panel: "twapHistory" },
  { name: "next-subaccount", usage: "/next-subaccount [address]", kind: "address-read" },
  {
    name: "allowance",
    usage: "/allowance <address> [symbol]",
    kind: "address-read",
    argCompletions: [undefined, "symbol"],
  },
  {
    name: "leverage",
    usage: "/leverage <address> <symbol>",
    kind: "address-read",
    argCompletions: [undefined, "symbol"],
  },
  { name: "models", usage: "/models [provider/model]", kind: "misc", argCompletions: ["model-ref"] },
  { name: "workflows", usage: "/workflows", kind: "misc" },
  { name: "effort", usage: "/effort <low|medium|high|xhigh|max|ultrathink>", kind: "misc" },
  { name: "workflow", usage: "/workflow <task>", kind: "misc" },
  { name: "health", usage: "/health", kind: "misc" },
  { name: "bench-metrics", usage: "/bench-metrics", kind: "misc" },
  { name: "track", usage: "/track <address>|clear", kind: "misc" },
  { name: "env", usage: "/env", kind: "misc" },
]

const commandByName = new Map(SLASH_COMMANDS.map((spec) => [spec.name, spec]))

export function commandSpec(name: string): CommandSpec | undefined {
  return commandByName.get(name)
}

export type CommandContext = {
  readonly gte: GteApi
  readonly sessionID: string
  /** Resolved GTE env name for provenance on stream-only snapshots. */
  readonly env: string
  readonly selectedMarket?: string
  readonly trackedAddress?: string
  readonly pinnedPanels: readonly PinnedPanel[]
  readonly focusPanel: (panel: PanelType, key: string) => void
  /**
   * Open the /models overlay. Without a target it shows the picker; with one
   * (from `/models <provider>/<model>`) it selects directly — chaining into
   * the auth wizard when the provider needs setup. Validation against the
   * curated catalog happens inside the overlay via the strict select route.
   */
  readonly openModels: (target?: ModelTarget) => void
  /** Open the /workflows overlay (run list → run view → agent detail). */
  readonly openWorkflows: () => void
  /** Models client for `/effort` variant re-selection and catalog variant lookup. */
  readonly models: ModelsApi
  /** Workflows client; `/effort ultrathink` probes it for the kill switch. */
  readonly workflows: WorkflowsApi
  /** The session's active model (its own selection, else the inherited default). */
  readonly activeModel?: ModelRef
  /** Send a prompt through the normal prompt path (used by `/workflow`). */
  readonly prompt: (text: string) => void
  /** Mirror an applied model back into the app store so the status line stays correct. */
  readonly onModelApplied: (model: ModelRef) => void
  /** Local (non-persisted) command feedback line in the transcript. */
  readonly info: (text: string) => void
  readonly error: (text: string) => void
}

const describeError = (error: unknown): string => {
  if (error instanceof GteRequestError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/** Explicit address > session tracked address > ask. Returns undefined after reporting. */
function resolveAddress(ctx: CommandContext, candidate: string | undefined, usage: string): string | undefined {
  if (candidate !== undefined) {
    if (!ADDRESS_PATTERN.test(candidate)) {
      ctx.error(`Invalid EVM address "${candidate}" — expected 0x followed by 40 hex characters. Usage: ${usage}`)
      return undefined
    }
    return candidate.toLowerCase()
  }
  if (ctx.trackedAddress !== undefined) return ctx.trackedAddress
  ctx.error(
    `No address given and no tracked address set. Pass an address or set one with /track <address>. Usage: ${usage}`,
  )
  return undefined
}

/** Shared symbol resolution; reports ambiguity/misses and never guesses. */
async function resolveSymbol(ctx: CommandContext, query: string): Promise<string | undefined> {
  const resolution = await ctx.gte.resolveSymbol(query)
  if (resolution.outcome === "resolved") return resolution.symbol
  if (resolution.outcome === "ambiguous") {
    ctx.error(`Symbol "${query}" is ambiguous. Candidates: ${resolution.candidates.join(", ")}`)
    return undefined
  }
  ctx.error(`No GTE market found matching "${query}".`)
  return undefined
}

async function recordSnapshot(
  ctx: CommandContext,
  input: { command: string; panel?: PanelType; key?: string; summary: SnapshotSummary; provenance: GteProvenance },
): Promise<void> {
  await ctx.gte.recordSnapshot(ctx.sessionID, input)
}

/**
 * Pin (or focus) a live panel via durable session intent. Market panels also
 * set the session's primary selected market.
 */
async function openPanel(
  ctx: CommandContext,
  panel: PanelType,
  key: string,
  options?: { selectedMarket?: string },
): Promise<boolean> {
  const exists = ctx.pinnedPanels.some((pin) => pin.panel === panel && pin.key === key)
  if (!exists && ctx.pinnedPanels.length >= MAX_PINNED_PANELS) {
    ctx.error(
      `Panel limit reached (${MAX_PINNED_PANELS} pinned). Close a panel first (update intent) before opening another.`,
    )
    return false
  }
  const pinnedPanels = exists ? ctx.pinnedPanels : [...ctx.pinnedPanels, { panel, key }]
  await ctx.gte.updateIntent(ctx.sessionID, {
    pinnedPanels,
    ...(options?.selectedMarket === undefined ? {} : { selectedMarket: options.selectedMarket }),
  })
  ctx.focusPanel(panel, key)
  return true
}

const streamProvenance = (ctx: CommandContext, symbol?: string): GteProvenance => ({
  env: ctx.env,
  source: "ws",
  timestamp: new Date().toISOString(),
  ...(symbol === undefined ? {} : { symbol }),
})

export async function executeSlashCommand(parsed: ParsedCommand, ctx: CommandContext): Promise<void> {
  const spec = commandByName.get(parsed.name)
  if (!spec) {
    ctx.error(`Unknown command /${parsed.name}. Available: ${SLASH_COMMANDS.map((item) => `/${item.name}`).join(" ")}`)
    return
  }
  try {
    await run(spec, parsed.args, ctx)
  } catch (error) {
    ctx.error(`/${spec.name} failed: ${describeError(error)}`)
  }
}

async function run(spec: CommandSpec, args: readonly string[], ctx: CommandContext): Promise<void> {
  const { gte } = ctx

  /** One-shot read + compact transcript snapshot (pure-read commands). */
  const snap = async (
    command: string,
    fetch: () => Promise<{ provenance: GteProvenance; data: unknown }>,
    title: string,
    extras?: { panel?: PanelType; key?: string; note?: string },
  ) => {
    const result = await fetch()
    const summary = summarizeData(result.data, title)
    await recordSnapshot(ctx, {
      command,
      ...(extras?.panel === undefined ? {} : { panel: extras.panel }),
      ...(extras?.key === undefined ? {} : { key: extras.key }),
      summary:
        extras?.note === undefined
          ? summary
          : { ...summary, note: summary.note === undefined ? extras.note : `${extras.note} · ${summary.note}` },
      provenance: result.provenance,
    })
  }

  /** Market panel command: resolve, snapshot, pin+focus, set primary market. */
  const marketPanel = async (panel: PanelType, query: string | undefined, key?: (symbol: string) => string) => {
    const usage = spec.usage
    if (query === undefined) {
      ctx.error(`Usage: ${usage}`)
      return
    }
    const symbol = await resolveSymbol(ctx, query)
    if (symbol === undefined) return
    const panelKey = key === undefined ? symbol : key(symbol)
    const fallback = gte.panelSnapshot(panel, panelKey)
    if (fallback !== undefined) {
      await snap(`/${spec.name}`, () => fallback, `${symbol} ${panel}`, { panel, key: panelKey })
    } else {
      await recordSnapshot(ctx, {
        command: `/${spec.name}`,
        panel,
        key: panelKey,
        summary: { title: `${symbol} ${panel}`, note: "live stream panel opened (no one-shot HTTP route)" },
        provenance: streamProvenance(ctx, symbol),
      })
    }
    await openPanel(ctx, panel, panelKey, { selectedMarket: symbol })
  }

  /** Address panel command: resolve address, snapshot, pin+focus. */
  const addressPanel = async (panel: PanelType, candidate: string | undefined) => {
    const address = resolveAddress(ctx, candidate, spec.usage)
    if (address === undefined) return
    const fallback = gte.panelSnapshot(panel, address)
    if (fallback !== undefined) {
      await snap(`/${spec.name}`, () => fallback, `${panel} ${address}`, { panel, key: address })
    } else {
      await recordSnapshot(ctx, {
        command: `/${spec.name}`,
        panel,
        key: address,
        summary: { title: `${panel} ${address}`, note: "live stream panel opened (no one-shot HTTP route)" },
        provenance: { env: ctx.env, source: "ws", timestamp: new Date().toISOString(), address },
      })
    }
    await openPanel(ctx, panel, address)
  }

  /** Address pure-read command. */
  const addressRead = async (
    fetch: (address: string) => Promise<{ provenance: GteProvenance; data: unknown }>,
    label: string,
    candidate: string | undefined,
  ) => {
    const address = resolveAddress(ctx, candidate, spec.usage)
    if (address === undefined) return
    await snap(`/${spec.name}`, () => fetch(address), `${label} ${address}`)
  }

  switch (spec.name) {
    case "markets":
      await snap(
        "/markets",
        () => gte.markets(args.join(" ") || undefined),
        args.length > 0 ? `markets matching "${args.join(" ")}"` : "markets",
      )
      return
    case "market": {
      if (args[0] === undefined) return ctx.error(`Usage: ${spec.usage}`)
      const symbol = await resolveSymbol(ctx, args[0])
      if (symbol === undefined) return
      await snap("/market", () => gte.market(symbol), `market ${symbol}`)
      await gte.updateIntent(ctx.sessionID, { selectedMarket: symbol })
      return
    }
    case "data":
      return marketPanel("marketData", args[0])
    case "book":
      return marketPanel("book", args[0])
    case "trades":
      return marketPanel("trades", args[0])
    case "chart": {
      const interval = args[1]
      if (interval !== undefined && CANDLE_INTERVALS.find((candidate) => candidate === interval) === undefined) {
        return ctx.error(`Invalid interval "${interval}". Valid: ${CANDLE_INTERVALS.join(", ")}`)
      }
      return marketPanel("candles", args[0], (symbol) => (interval === undefined ? symbol : `${symbol}@${interval}`))
    }
    case "context": {
      if (args[0] === undefined) return ctx.error(`Usage: ${spec.usage}`)
      const symbol = await resolveSymbol(ctx, args[0])
      if (symbol === undefined) return
      await snap("/context", () => gte.marketContext(symbol), `context ${symbol}`)
      return
    }
    case "quote": {
      const [rawSymbol, rawSide, rawSize] = args
      const side = rawSide?.toLowerCase()
      const size = rawSize === undefined ? Number.NaN : Number(rawSize)
      if (rawSymbol === undefined || (side !== "buy" && side !== "sell") || !Number.isFinite(size) || size <= 0) {
        return ctx.error(`Usage: ${spec.usage}`)
      }
      const symbol = await resolveSymbol(ctx, rawSymbol)
      if (symbol === undefined) return
      await snap("/quote", () => gte.quote(symbol, side, size), `ESTIMATE ONLY: ${side} ${size} ${symbol}`, {
        note: "Book-derived estimate only — not an order preview; no balances or margin inspected, no order payload.",
      })
      return
    }
    case "liquidations":
      return marketPanel("liquidations", args[0])
    case "positions":
      return addressPanel("positions", args[0])
    case "open-orders":
      return addressPanel("openOrders", args[0])
    case "order-history":
      return addressPanel("orderHistory", args[0])
    case "balances":
      return addressPanel("balances", args[0])
    case "funding":
      return addressPanel("funding", args[0])
    case "account":
      return addressPanel("accountMetrics", args[0])
    case "twap-history":
      return addressPanel("twapHistory", args[0])
    case "trade-history":
      return addressRead((address) => gte.tradeHistory(address), "trade history", args[0])
    case "balance-history":
      return addressRead((address) => gte.balanceHistory(address), "balance history", args[0])
    case "pnl":
      return addressRead((address) => gte.pnl(address), "pnl", args[0])
    case "fees":
      return addressRead((address) => gte.fees(address), "fees", args[0])
    case "next-subaccount":
      return addressRead((address) => gte.nextSubaccount(address), "next subaccount", args[0])
    case "allowance": {
      const address = resolveAddress(ctx, args[0], spec.usage)
      if (address === undefined) return
      const symbolQuery = args[1] ?? ctx.selectedMarket
      if (symbolQuery === undefined) {
        return ctx.error(`Allowance needs a market symbol (no selected market set). Usage: ${spec.usage}`)
      }
      const symbol = await resolveSymbol(ctx, symbolQuery)
      if (symbol === undefined) return
      await snap("/allowance", () => gte.allowance(address, symbol), `allowance ${symbol} ${address}`)
      return
    }
    case "leverage": {
      const address = resolveAddress(ctx, args[0], spec.usage)
      if (address === undefined) return
      const symbolQuery = args[1] ?? ctx.selectedMarket
      if (symbolQuery === undefined) {
        return ctx.error(`Leverage needs a market symbol (no selected market set). Usage: ${spec.usage}`)
      }
      const symbol = await resolveSymbol(ctx, symbolQuery)
      if (symbol === undefined) return
      await snap("/leverage", () => gte.leverage(address, symbol), `leverage ${symbol} ${address}`)
      return
    }
    case "models": {
      if (args[0] === undefined) return ctx.openModels()
      const target = parseModelTarget(args[0])
      if (target === undefined) {
        return ctx.error(`Invalid model ref "${args[0]}" — expected <provider>/<model>. Usage: ${spec.usage}`)
      }
      ctx.openModels(target)
      return
    }
    case "workflows":
      ctx.openWorkflows()
      return
    case "effort":
      return runEffort(ctx, args[0], spec.usage)
    case "workflow": {
      const task = args.join(" ").trim()
      if (task.length === 0) return ctx.error(`Usage: ${spec.usage}`)
      ctx.prompt(`${WORKFLOW_PROMPT_PREFIX} ${task}`)
      return
    }
    case "health":
      await snap("/health", () => gte.health(), "GTE data API health")
      return
    case "bench-metrics": {
      await recordSnapshot(ctx, {
        command: "/bench-metrics",
        panel: "benchMetrics",
        key: "global",
        summary: { title: "bench metrics", note: "live diagnostic metrics panel opened (no one-shot HTTP route)" },
        provenance: streamProvenance(ctx),
      })
      await openPanel(ctx, "benchMetrics", "global")
      return
    }
    case "track": {
      const target = args[0]
      if (target === undefined) {
        return ctx.error(
          `Usage: ${spec.usage}${ctx.trackedAddress === undefined ? "" : ` (currently tracking ${ctx.trackedAddress})`}`,
        )
      }
      if (target.toLowerCase() === "clear") {
        await gte.updateIntent(ctx.sessionID, { trackedAddress: null })
        ctx.info("Tracked address cleared.")
        return
      }
      if (!ADDRESS_PATTERN.test(target)) {
        return ctx.error(`Invalid EVM address "${target}" — expected 0x followed by 40 hex characters.`)
      }
      const address = target.toLowerCase()
      await gte.updateIntent(ctx.sessionID, { trackedAddress: address })
      ctx.info(`Tracking address ${address} — address-scoped commands default to it.`)
      return
    }
    case "env": {
      const result = await gte.env()
      await recordSnapshot(ctx, {
        command: "/env",
        summary: {
          title: "GTE environment",
          fields: { env: result.env, validEnvs: result.validEnvs.join(", ") },
        },
        provenance: { env: result.env, source: "http", timestamp: result.timestamp },
      })
      return
    }
  }
}

/**
 * `/effort <tier>` re-selects the active model with a reasoning-effort variant.
 *
 * Named tiers (low/medium/high/xhigh/max) select that exact variant. `ultrathink`
 * resolves to the highest variant the active model offers (xhigh, else max, else
 * high) and turns on the session ultrathink intent flag; a model with no
 * reasoning variants gets the flag only with an info line. The kill switch is
 * probed through the workflows client so `ultrathink` reports the feature
 * disabled rather than silently selecting nothing.
 */
async function runEffort(ctx: CommandContext, tier: string | undefined, usage: string): Promise<void> {
  const requested = tier?.toLowerCase()
  if (requested === undefined) return ctx.error(`Usage: ${usage}`)
  if (requested !== "ultrathink" && !EFFORT_TIERS.includes(requested as EffortTier)) {
    return ctx.error(`Unknown effort tier "${tier}". Choose one of: ${EFFORT_TIERS.join(", ")}, ultrathink.`)
  }
  const active = ctx.activeModel
  if (active === undefined || active === null) {
    return ctx.error("No active model — pick one with /models before setting an effort tier.")
  }

  const select = async (variant: string) => {
    const result = await ctx.models.select({
      providerID: active.providerID,
      modelID: active.id,
      variant,
      sessionID: ctx.sessionID,
    })
    ctx.onModelApplied(result.model)
    return result
  }

  if (requested !== "ultrathink") {
    const result = await select(requested)
    ctx.info(`Effort set to ${requested} for ${result.model.providerID}/${result.model.id}.`)
    return
  }

  // ultrathink: gated on the workflow kill switch, then highest-variant + intent flag.
  const disabled = await workflowsDisabled(ctx)
  if (disabled) return ctx.error("workflows are disabled")

  const variants = await activeModelVariants(ctx, active)
  const highest = ["xhigh", "max", "high"].find((candidate) => variants.includes(candidate))
  await ctx.gte.updateIntent(ctx.sessionID, { ultrathink: true })
  if (highest === undefined) {
    ctx.info(
      `No reasoning variants exist for ${active.providerID}/${active.id}; ultrathink intent enabled without a variant change.`,
    )
    return
  }
  const result = await select(highest)
  ctx.info(`Ultrathink enabled — ${result.model.providerID}/${result.model.id} set to ${highest}.`)
}

/** Reasoning variants the active model exposes in the curated catalog (empty when none). */
async function activeModelVariants(ctx: CommandContext, active: ModelRef): Promise<readonly string[]> {
  const catalog = await ctx.models.list(ctx.sessionID)
  const provider = catalog.providers.find((candidate) => candidate.id === active.providerID)
  return provider?.models.find((candidate) => candidate.id === active.id)?.variants ?? []
}

/** True when the workflow routes report the kill-switch disabled error. */
async function workflowsDisabled(ctx: CommandContext): Promise<boolean> {
  try {
    await ctx.workflows.list(ctx.sessionID)
    return false
  } catch (error) {
    if (isWorkflowsDisabled(error)) return true
    return false
  }
}
