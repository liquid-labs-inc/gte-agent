export * as GteDataSchema from "./schema"

import { Schema } from "effect"
import type { GetCandlesParams, GteEnvKey, TradeSide } from "gte-ts"

/**
 * Valid GTE environment names.
 *
 * The authoritative list is the `GteEnvKey` type owned by `gte-ts`. The
 * runtime env -> URL map (`GTE_ENV_ENDPOINTS`) is intentionally not exported
 * by the package, so this value list exists only for config validation and
 * error messages — it never maps environments to URLs. The `satisfies`
 * clause plus the exhaustiveness assertion below fail compilation whenever
 * upstream adds or removes an environment, so the list cannot silently
 * drift from `gte-ts`.
 */
export const ENV_KEYS = ["hyperliquid-dev", "hyperliquid-prod"] as const satisfies readonly GteEnvKey[]

type MissingEnvKeys = Exclude<GteEnvKey, (typeof ENV_KEYS)[number]>
// Compile-time guard: this assignment breaks when ENV_KEYS misses a GteEnvKey.
const _envKeysExhaustive: MissingEnvKeys extends never ? true : ["ENV_KEYS is missing", MissingEnvKeys] = true
void _envKeysExhaustive

/**
 * Default environment when `GTE_AGENT_GTE_ENV` is unset. Defaults to the dev
 * environment for local development ergonomics; production deployments must
 * set `GTE_AGENT_GTE_ENV=hyperliquid-prod` explicitly.
 */
export const DEFAULT_ENV: GteEnvKey = "hyperliquid-dev"

export const Env = Schema.Literals(ENV_KEYS)
export type Env = typeof Env.Type

/** Candle intervals supported by the GTE gateway, mirrored from `gte-ts`. */
export const CANDLE_INTERVALS = [
  "1m",
  "2m",
  "3m",
  "5m",
  "10m",
  "15m",
  "20m",
  "30m",
  "1h",
  "4h",
  "1d",
  "1w",
] as const satisfies readonly GetCandlesParams["interval"][]

type MissingIntervals = Exclude<GetCandlesParams["interval"], (typeof CANDLE_INTERVALS)[number]>
const _intervalsExhaustive: MissingIntervals extends never ? true : ["CANDLE_INTERVALS is missing", MissingIntervals] =
  true
void _intervalsExhaustive

export const CandleInterval = Schema.Literals(CANDLE_INTERVALS)
export type CandleInterval = typeof CandleInterval.Type

export const QUOTE_SIDES = ["buy", "sell"] as const satisfies readonly TradeSide[]
type MissingSides = Exclude<TradeSide, (typeof QUOTE_SIDES)[number]>
const _sidesExhaustive: MissingSides extends never ? true : ["QUOTE_SIDES is missing", MissingSides] = true
void _sidesExhaustive

export const QuoteSide = Schema.Literals(QUOTE_SIDES)
export type QuoteSide = typeof QuoteSide.Type

/**
 * Disclaimer attached to every quote estimate by both the agent tool and the
 * HTTP route. Centralized so the read-only boundary language cannot drift
 * between surfaces.
 */
export const QUOTE_ESTIMATE_NOTE =
  "Book-derived estimate only: computed from the public order book snapshot. Not an order preview; no balances, margin, or order parameters were inspected or generated."

/** Defaults shared by agent tools and server routes for windowed queries. */
export const DEFAULT_CANDLE_INTERVAL: CandleInterval = "1h"
export const DEFAULT_CANDLE_LOOKBACK_MS = 24 * 60 * 60 * 1000
export const DEFAULT_HISTORY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Provenance attached to every read-only GTE data snapshot so transcripts and
 * panels can audit where data came from. This layer is HTTP one-shot only, so
 * `source` is always `"http"`; stream snapshots (a later milestone) will carry
 * their own source tag.
 */
export const Provenance = Schema.Struct({
  /** Resolved gte-ts environment name (`GTE_AGENT_GTE_ENV`). */
  env: Env,
  /** Transport that produced the snapshot. This layer only performs one-shot HTTP reads. */
  source: Schema.Literal("http"),
  /** ISO-8601 timestamp at which the snapshot was taken. */
  timestamp: Schema.String,
  /** Canonical market symbol, when the read is market-scoped. */
  symbol: Schema.String.pipe(Schema.optional),
  /** Lowercased EVM address, when the read is address-scoped. */
  address: Schema.String.pipe(Schema.optional),
  /** Query parameters that materially shape the result (interval, limit, cursor, from, to, ...). */
  params: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
}).annotate({ identifier: "GteData.Provenance" })
export type Provenance = typeof Provenance.Type

/** Canonical `{ provenance, data }` wrapper shared by tools and HTTP routes. */
export const Snapshot = Schema.Struct({
  provenance: Provenance,
  data: Schema.Unknown,
}).annotate({ identifier: "GteData.Snapshot" })
export type Snapshot = typeof Snapshot.Type

export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("GteData.ConfigError", {
  message: Schema.String,
}) {}

export class RequestError extends Schema.TaggedErrorClass<RequestError>()("GteData.RequestError", {
  /** The GteData operation that failed, e.g. "markets.get". */
  op: Schema.String,
  message: Schema.String,
  status: Schema.Number.pipe(Schema.optional),
  code: Schema.String.pipe(Schema.optional),
}) {}
