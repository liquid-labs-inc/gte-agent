export * as GtePanelKey from "./panel-key"

import type { SessionSchema } from "../session/schema"
import { CANDLE_INTERVALS, type CandleInterval } from "./schema"

/**
 * Pinned panels persist as `{ panel, key }` (see `SessionSchema.PinnedPanel`).
 * This module owns the interpretation of `key` per panel type so the stream
 * subscription manager, the HTTP fallback path, and provenance all agree:
 *
 * - Market panels:   key is the canonical market symbol. Candle panels may
 *   append an interval as `SYMBOL@interval` (default `1m` for live charts).
 * - Address panels:  key is the lowercase EVM address.
 * - Global panels:   key is ignored (conventionally `"global"`).
 */

export const MARKET_PANELS = ["book", "trades", "candles", "marketData", "liquidations"] as const
export const ADDRESS_PANELS = [
  "positions",
  "openOrders",
  "orders",
  "orderHistory",
  "balances",
  "funding",
  "twapHistory",
  "leverage",
  "accountMetrics",
] as const
export const GLOBAL_PANELS = ["benchMetrics"] as const

type MissingPanels = Exclude<
  SessionSchema.PanelType,
  (typeof MARKET_PANELS)[number] | (typeof ADDRESS_PANELS)[number] | (typeof GLOBAL_PANELS)[number]
>
// Compile-time guard: breaks when SessionSchema.PanelType gains a panel this module does not classify.
const _panelsExhaustive: MissingPanels extends never ? true : ["panel classification is missing", MissingPanels] = true
void _panelsExhaustive

/** Default interval for live candle panels (finest supported granularity). */
export const DEFAULT_LIVE_CANDLE_INTERVAL: CandleInterval = "1m"

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

export type Target =
  | { readonly kind: "market"; readonly symbol: string; readonly interval?: CandleInterval }
  | { readonly kind: "address"; readonly address: string }
  | { readonly kind: "global" }

export type TargetResult = { readonly ok: true; readonly target: Target } | { readonly ok: false; readonly reason: string }

/** Format a candle panel key carrying an explicit interval. */
export function candleKey(symbol: string, interval?: CandleInterval): string {
  return interval === undefined ? symbol : `${symbol}@${interval}`
}

/**
 * Resolve the subscription/snapshot target encoded by a pinned panel.
 * Never throws: invalid keys surface as a reason so callers can mark the
 * panel degraded instead of crashing the manager.
 */
export function targetFor(panel: SessionSchema.PanelType, key: string): TargetResult {
  if ((GLOBAL_PANELS as readonly string[]).includes(panel)) {
    return { ok: true, target: { kind: "global" } }
  }
  if ((ADDRESS_PANELS as readonly string[]).includes(panel)) {
    if (!ADDRESS_PATTERN.test(key)) {
      return { ok: false, reason: `Panel ${panel} requires an EVM address key, got "${key}"` }
    }
    return { ok: true, target: { kind: "address", address: key.toLowerCase() } }
  }
  // Market panels.
  if (panel === "candles") {
    const separator = key.indexOf("@")
    if (separator === -1) {
      if (key.length === 0) return { ok: false, reason: "Candle panel requires a market symbol key" }
      return { ok: true, target: { kind: "market", symbol: key, interval: DEFAULT_LIVE_CANDLE_INTERVAL } }
    }
    const symbol = key.slice(0, separator)
    const interval = key.slice(separator + 1)
    const resolved = CANDLE_INTERVALS.find((candidate) => candidate === interval)
    if (symbol.length === 0 || resolved === undefined) {
      return { ok: false, reason: `Invalid candle panel key "${key}" (expected SYMBOL or SYMBOL@interval)` }
    }
    return { ok: true, target: { kind: "market", symbol, interval: resolved } }
  }
  if (key.length === 0) {
    return { ok: false, reason: `Panel ${panel} requires a market symbol key` }
  }
  return { ok: true, target: { kind: "market", symbol: key } }
}
