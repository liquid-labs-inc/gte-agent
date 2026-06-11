/**
 * Typed raw-fetch wrapper for the read-only GTE data routes plus the session
 * intent/snapshot surfaces the TUI uses. The generated SDK predates these
 * routes, so this client goes straight to the canonical HTTP API through the
 * same fetch function as everything else (in-process bridge or real listener).
 *
 * Read-only by construction: every /api/gte route is a one-shot snapshot with
 * provenance; there is no mutation or signing surface here.
 */

export type GteProvenance = {
  readonly env: string
  readonly source: "http" | "ws" | "fallback"
  readonly timestamp: string
  readonly symbol?: string
  readonly address?: string
  readonly params?: Record<string, unknown>
}

export type GteSnapshot = {
  readonly provenance: GteProvenance
  readonly data: unknown
}

export type SymbolResolution =
  | { readonly outcome: "resolved"; readonly symbol: string; readonly market: unknown }
  | { readonly outcome: "ambiguous"; readonly query: string; readonly candidates: readonly string[] }
  | { readonly outcome: "notFound"; readonly query: string }

export type SnapshotSummary = {
  readonly title?: string
  readonly fields?: Record<string, string>
  readonly rows?: ReadonlyArray<Record<string, string | number | boolean | null>>
  readonly note?: string
}

export type PanelType =
  | "book"
  | "trades"
  | "candles"
  | "marketData"
  | "positions"
  | "openOrders"
  | "orders"
  | "orderHistory"
  | "balances"
  | "funding"
  | "twapHistory"
  | "leverage"
  | "accountMetrics"
  | "liquidations"
  | "benchMetrics"

export type PinnedPanel = { readonly panel: PanelType; readonly key: string }

export type IntentPatch = {
  readonly selectedMarket?: string | null
  readonly trackedAddress?: string | null
  readonly pinnedPanels?: readonly PinnedPanel[] | null
}

export class GteRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind?: string,
    readonly field?: string,
  ) {
    super(message)
    this.name = "GteRequestError"
  }
}

export const CANDLE_INTERVALS = ["1m", "2m", "3m", "5m", "10m", "15m", "20m", "30m", "1h", "4h", "1d", "1w"] as const
export type CandleInterval = (typeof CANDLE_INTERVALS)[number]

export interface GteApi {
  env(): Promise<{ env: string; validEnvs: readonly string[]; timestamp: string }>
  health(): Promise<GteSnapshot>
  markets(query?: string): Promise<GteSnapshot>
  resolveSymbol(q: string): Promise<SymbolResolution>
  market(symbol: string): Promise<GteSnapshot>
  marketData(symbol: string): Promise<GteSnapshot>
  book(symbol: string): Promise<GteSnapshot>
  trades(symbol: string): Promise<GteSnapshot>
  candles(symbol: string, interval?: CandleInterval): Promise<GteSnapshot>
  marketContext(symbol: string): Promise<GteSnapshot>
  quote(symbol: string, side: "buy" | "sell", baseSize: number): Promise<GteSnapshot>
  positions(address: string): Promise<GteSnapshot>
  openOrders(address: string): Promise<GteSnapshot>
  orders(address: string): Promise<GteSnapshot>
  tradeHistory(address: string): Promise<GteSnapshot>
  balances(address: string): Promise<GteSnapshot>
  balanceHistory(address: string): Promise<GteSnapshot>
  pnl(address: string): Promise<GteSnapshot>
  funding(address: string): Promise<GteSnapshot>
  account(address: string): Promise<GteSnapshot>
  allowance(address: string, symbol: string): Promise<GteSnapshot>
  leverage(address: string, symbol: string): Promise<GteSnapshot>
  fees(address: string): Promise<GteSnapshot>
  twapHistory(address: string): Promise<GteSnapshot>
  nextSubaccount(address: string): Promise<GteSnapshot>
  /** HTTP snapshot for a live panel's degraded fallback; undefined when no snapshot route exists. */
  panelSnapshot(panel: PanelType, key: string): Promise<GteSnapshot> | undefined
  updateIntent(sessionID: string, patch: IntentPatch): Promise<unknown>
  recordSnapshot(
    sessionID: string,
    input: {
      command: string
      panel?: PanelType
      key?: string
      summary: SnapshotSummary
      provenance: GteProvenance
    },
  ): Promise<void>
}

export function createGteApi(input: { baseUrl: string; fetch: typeof fetch }): GteApi {
  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await input.fetch(`${input.baseUrl}${path}`, init)
    const text = await response.text()
    let body: unknown
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      body = undefined
    }
    if (!response.ok) {
      const error = (body ?? {}) as { _tag?: string; message?: string; kind?: string; field?: string }
      const message = typeof error.message === "string" ? error.message : `Request failed: HTTP ${response.status}`
      throw new GteRequestError(message, response.status, error.kind, error.field)
    }
    return body
  }

  const snapshot = (path: string) => request(path) as Promise<GteSnapshot>
  const enc = encodeURIComponent

  const api: GteApi = {
    async env() {
      return (await request("/api/gte/env")) as { env: string; validEnvs: readonly string[]; timestamp: string }
    },
    health: () => snapshot("/api/gte/health"),
    markets: (query) =>
      snapshot(query !== undefined && query.length > 0 ? `/api/gte/markets?query=${enc(query)}` : "/api/gte/markets?limit=10"),
    async resolveSymbol(q) {
      const result = (await request(`/api/gte/resolve-symbol?q=${enc(q)}`)) as { data: SymbolResolution }
      return result.data
    },
    market: (symbol) => snapshot(`/api/gte/market/${enc(symbol)}`),
    marketData: (symbol) => snapshot(`/api/gte/market/${enc(symbol)}/data`),
    book: (symbol) => snapshot(`/api/gte/market/${enc(symbol)}/book`),
    trades: (symbol) => snapshot(`/api/gte/market/${enc(symbol)}/trades?limit=10`),
    candles: (symbol, interval) =>
      snapshot(`/api/gte/market/${enc(symbol)}/candles${interval === undefined ? "" : `?interval=${enc(interval)}`}`),
    marketContext: (symbol) => snapshot(`/api/gte/market/${enc(symbol)}/context?limit=10`),
    quote: (symbol, side, baseSize) =>
      snapshot(`/api/gte/market/${enc(symbol)}/quote?side=${side}&baseSize=${baseSize}`),
    positions: (address) => snapshot(`/api/gte/address/${enc(address)}/positions`),
    openOrders: (address) => snapshot(`/api/gte/address/${enc(address)}/open-orders`),
    orders: (address) => snapshot(`/api/gte/address/${enc(address)}/orders`),
    tradeHistory: (address) => snapshot(`/api/gte/address/${enc(address)}/trade-history?limit=10`),
    balances: (address) => snapshot(`/api/gte/address/${enc(address)}/balances`),
    balanceHistory: (address) => snapshot(`/api/gte/address/${enc(address)}/balance-history`),
    pnl: (address) => snapshot(`/api/gte/address/${enc(address)}/pnl`),
    funding: (address) => snapshot(`/api/gte/address/${enc(address)}/funding?limit=10`),
    account: (address) => snapshot(`/api/gte/address/${enc(address)}/account`),
    allowance: (address, symbol) => snapshot(`/api/gte/address/${enc(address)}/allowance?symbol=${enc(symbol)}`),
    leverage: (address, symbol) => snapshot(`/api/gte/address/${enc(address)}/leverage?symbol=${enc(symbol)}`),
    fees: (address) => snapshot(`/api/gte/address/${enc(address)}/fees`),
    twapHistory: (address) => snapshot(`/api/gte/address/${enc(address)}/twap-history?limit=10`),
    nextSubaccount: (address) => snapshot(`/api/gte/address/${enc(address)}/next-subaccount`),

    panelSnapshot(panel, key) {
      switch (panel) {
        case "book":
          return api.book(key)
        case "trades":
          return api.trades(key)
        case "candles": {
          const separator = key.indexOf("@")
          if (separator === -1) return api.candles(key, "1m")
          const interval = key.slice(separator + 1)
          const valid = CANDLE_INTERVALS.find((candidate) => candidate === interval)
          return api.candles(key.slice(0, separator), valid ?? "1m")
        }
        case "marketData":
          return api.marketData(key)
        case "positions":
          return api.positions(key)
        case "openOrders":
          return api.openOrders(key)
        case "orders":
        case "orderHistory":
          return api.orders(key)
        case "balances":
          return api.balances(key)
        case "funding":
          return api.funding(key)
        case "twapHistory":
          return api.twapHistory(key)
        case "accountMetrics":
          return api.account(key)
        // No one-shot HTTP routes exist for these; the panel stays stream-only.
        case "leverage":
        case "liquidations":
        case "benchMetrics":
        default:
          return undefined
      }
    },

    updateIntent(sessionID, patch) {
      return request(`/api/session/${enc(sessionID)}/intent`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      })
    },

    async recordSnapshot(sessionID, body) {
      await request(`/api/session/${enc(sessionID)}/snapshot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    },
  }

  return api
}
