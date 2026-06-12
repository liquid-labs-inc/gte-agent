export * as GteSymbol from "./symbol"

import { Effect, Schema } from "effect"
import type { Market, MarketsInterface } from "gte-ts"
import { RequestError } from "./schema"

/** Maximum candidates surfaced for an ambiguous query. */
export const MAX_CANDIDATES = 10

export type Resolved = {
  readonly outcome: "resolved"
  /** Canonical symbol as returned by gte-ts. */
  readonly symbol: string
  readonly market: Market
}

export type Ambiguous = {
  readonly outcome: "ambiguous"
  readonly query: string
  readonly candidates: readonly string[]
}

export type NotFound = {
  readonly outcome: "notFound"
  readonly query: string
}

/**
 * Structured resolution result. The resolver never silently guesses: callers
 * (agent tools, slash commands) surface `ambiguous`/`notFound` so the model or
 * user can disambiguate, e.g. by calling the markets search tool themselves.
 */
export type Resolution = Resolved | Ambiguous | NotFound

/** Wire schema for the resolution result (used by the HTTP resolve-symbol route). */
export const Resolution = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("resolved"),
    symbol: Schema.String,
    market: Schema.Unknown,
  }),
  Schema.Struct({
    outcome: Schema.Literal("ambiguous"),
    query: Schema.String,
    candidates: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    outcome: Schema.Literal("notFound"),
    query: Schema.String,
  }),
]).annotate({ identifier: "GteData.SymbolResolution" })

type MarketLookup = Pick<MarketsInterface, "get" | "search">

const resolved = (market: Market): Resolved => ({ outcome: "resolved", symbol: market.symbol, market })

/** A failed exact lookup (404 or otherwise) is treated as a miss, not an error: the search fallback decides. */
const tryGet = (markets: MarketLookup, symbol: string): Effect.Effect<Market | undefined> =>
  Effect.tryPromise({
    try: () => markets.get({ symbol }),
    catch: (cause) => cause,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))

/**
 * Shared market symbol resolver for agent tools, server routes, and (later)
 * TUI slash commands.
 *
 * Order:
 * 1. Exact pass-through via `markets.get`.
 * 2. Deterministic bare-ticker normalization: uppercase only. Quote-suffix
 *    guessing is intentionally omitted because it is not deterministic; the
 *    search fallback covers partial tickers.
 * 3. `markets.search` fallback: a unique hit or an exact case-insensitive
 *    symbol match resolves; multiple hits return `ambiguous` with candidates;
 *    zero hits return `notFound`. Never silently guesses.
 */
export const resolve = (markets: MarketLookup, query: string): Effect.Effect<Resolution, RequestError> =>
  Effect.gen(function* () {
    const raw = query.trim()
    if (raw.length === 0) return { outcome: "notFound", query: raw } satisfies NotFound

    const exact = yield* tryGet(markets, raw)
    if (exact) return resolved(exact)

    const upper = raw.toUpperCase()
    if (upper !== raw) {
      const normalized = yield* tryGet(markets, upper)
      if (normalized) return resolved(normalized)
    }

    const matches = yield* Effect.tryPromise({
      try: () => markets.search({ query: raw }),
      catch: (cause) =>
        new RequestError({
          op: "markets.search",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    })
    if (matches.length === 0) return { outcome: "notFound", query: raw } satisfies NotFound
    const exactMatch = matches.find((market) => market.symbol.toUpperCase() === upper)
    if (exactMatch) return resolved(exactMatch)
    if (matches.length === 1) return resolved(matches[0])
    return {
      outcome: "ambiguous",
      query: raw,
      candidates: matches.slice(0, MAX_CANDIDATES).map((market) => market.symbol),
    } satisfies Ambiguous
  })
