export * as GteTools from "./tools"

import { Tool, ToolFailure, toolText, type ToolSchema } from "@gte-agent/llm"
import { Effect, Layer, Option, Schema } from "effect"
import { GteAddress } from "../../gte-data/address"
import { GteData } from "../../gte-data/gte-data"
import { GteDataSchema } from "../../gte-data/schema"
import { SessionSchema } from "../../session/schema"
import { SessionStore } from "../../session/store"
import { ToolRegistry } from "../registry"

/**
 * One-shot, read-only GTE data tools.
 *
 * Every tool returns the canonical `{ provenance, data }` snapshot from the
 * shared GteData service (HTTP only — live panels are a separate, non-tool
 * surface). Tools never produce trading recommendations, order previews, or
 * ready-to-submit order payloads. If the model needs fresher data it calls
 * the tool again.
 */

const READ_ONLY = "Read-only one-shot GTE data snapshot fetched over HTTP."
const PROVENANCE =
  "The result is { provenance, data }; provenance records the resolved GTE env, ISO timestamp, source (http), and the material query params."
const NO_ADVICE = "Returns raw exchange data only; it never produces trading recommendations or order payloads."
const ADDRESS_NOTE =
  "Address-scoped public read: pass `address` explicitly or omit it to use the session's tracked address."
const SYMBOL_NOTE = "The `symbol` argument is resolved to the canonical GTE market symbol before the request."

const describe = (summary: string, ...extra: string[]) => [summary, READ_ONLY, ...extra, PROVENANCE, NO_ADVICE].join(" ")

// --- Shared parameter fields ----------------------------------------------

const symbolField = Schema.String.annotate({
  description: "Market symbol or bare ticker. Resolved to the canonical GTE symbol; ambiguity returns an error listing candidates.",
})
const optionalSymbolField = Schema.String.pipe(Schema.optional).annotate({
  description: "Optional market symbol filter; resolved to the canonical GTE symbol when provided.",
})
const addressField = Schema.String.pipe(Schema.optional).annotate({
  description: "EVM address (0x + 40 hex characters). Optional: defaults to the session's tracked address when one is set.",
})
const limitField = Schema.Number.pipe(Schema.optional).annotate({ description: "Maximum number of items to return." })
const cursorField = Schema.String.pipe(Schema.optional).annotate({ description: "Opaque pagination cursor from a previous response." })
const subaccountField = Schema.Number.pipe(Schema.optional).annotate({ description: "Optional subaccount ID (0 is the cross-margin subaccount)." })

const Snapshot = GteDataSchema.Snapshot

const snapshotTool = <Parameters extends ToolSchema<any>>(description: string, parameters: Parameters) =>
  Tool.make({
    description,
    parameters,
    success: Snapshot,
    toModelOutput: ({ output }) => [toolText({ type: "text", text: JSON.stringify(output) })],
  })

const failure = (message: string) => new ToolFailure({ message })

// --- Quote (estimate-only output shape; intentionally no order-like fields) -

const QuoteParameters = Schema.Struct({
  symbol: symbolField,
  side: GteDataSchema.QuoteSide.annotate({ description: "Side of the hypothetical taker fill to estimate." }),
  baseSize: Schema.Number.pipe(Schema.optional).annotate({
    description: "Base-asset size to estimate. Provide exactly one of baseSize or quoteSize.",
  }),
  quoteSize: Schema.Number.pipe(Schema.optional).annotate({
    description: "Quote-asset (notional) size to estimate. Provide exactly one of baseSize or quoteSize.",
  }),
})

const QuoteSuccess = Schema.Struct({
  provenance: GteDataSchema.Provenance,
  data: Schema.Struct({
    symbol: Schema.String,
    side: GteDataSchema.QuoteSide,
    requested: Schema.Struct({
      baseSize: Schema.Number.pipe(Schema.optional),
      quoteSize: Schema.Number.pipe(Schema.optional),
    }),
    estimate: Schema.Struct({
      size: Schema.Number,
      notional: Schema.Number,
      averagePrice: Schema.Number,
    }),
    note: Schema.String,
  }),
})

const QUOTE_NOTE = GteDataSchema.QUOTE_ESTIMATE_NOTE

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ToolRegistry.Service
    const gte = yield* GteData.Service
    // The session store is optional so the tool layer composes in contexts
    // without durable sessions; without it only explicit addresses work.
    const store = Option.getOrUndefined(yield* Effect.serviceOption(SessionStore.Service))

    const requestFailed = (error: GteDataSchema.RequestError) =>
      failure(`GTE data request failed (${error.op}): ${error.message}`)

    /** Explicit address > session tracked address > typed error. Never guesses. */
    const resolveAddress = (explicit: string | undefined, sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        if (explicit !== undefined) {
          return yield* GteAddress.decode(explicit).pipe(Effect.mapError((error) => failure(error.message)))
        }
        const info = store === undefined ? undefined : yield* store.get(sessionID)
        if (info?.trackedAddress !== undefined) return info.trackedAddress
        return yield* Effect.fail(
          failure(
            "No address provided and this session has no tracked address. Pass an `address` argument (0x followed by 40 hex characters) or set the session tracked address first.",
          ),
        )
      })

    /** Canonical-symbol resolution; ambiguity and misses become typed tool errors the model can act on. */
    const resolveSymbol = (query: string) =>
      gte.resolveSymbol(query).pipe(
        Effect.mapError(requestFailed),
        Effect.flatMap((resolution) => {
          if (resolution.outcome === "resolved") return Effect.succeed(resolution.symbol)
          if (resolution.outcome === "ambiguous") {
            return Effect.fail(
              failure(
                `Market symbol "${query}" is ambiguous. Candidates: ${resolution.candidates.join(", ")}. Retry with the exact canonical symbol (use gte_markets to search).`,
              ),
            )
          }
          return Effect.fail(
            failure(`No GTE market found matching "${query}". Use gte_markets to search available markets.`),
          )
        }),
      )

    const resolveOptionalSymbol = (query: string | undefined) =>
      query === undefined ? Effect.succeed(undefined) : resolveSymbol(query)

    type Registration = {
      readonly tool: Tool<any, any>
      readonly execute: (input: { parameters: any; sessionID: SessionSchema.ID }) => Effect.Effect<any, ToolFailure>
    }

    const snapshot = <Parameters extends ToolSchema<any>>(
      description: string,
      parameters: Parameters,
      run: (
        parameters: Schema.Schema.Type<Parameters>,
        sessionID: SessionSchema.ID,
      ) => Effect.Effect<GteData.Snapshot<unknown>, ToolFailure | GteDataSchema.RequestError>,
    ): Registration => ({
      tool: snapshotTool(description, parameters),
      execute: ({ parameters, sessionID }) =>
        run(parameters, sessionID).pipe(Effect.catchTag("GteData.RequestError", (error) => Effect.fail(requestFailed(error)))),
    })

    const now = () => Date.now()

    const tools: Record<string, Registration> = {
      // --- Public market reads -------------------------------------------
      gte_markets: snapshot(
        describe("List GTE markets, or search them when `query` is provided."),
        Schema.Struct({
          query: Schema.String.pipe(Schema.optional).annotate({
            description: "Optional search query (ticker or name fragment). Omit to list markets.",
          }),
          // The upstream gte-ts markets.search endpoint has no pagination, so
          // limit/cursor apply to listing only.
          limit: Schema.Number.pipe(Schema.optional).annotate({
            description: "Maximum number of markets to return when listing. Ignored when `query` is provided (search is not paginated).",
          }),
          cursor: Schema.String.pipe(Schema.optional).annotate({
            description: "Opaque pagination cursor from a previous listing response. Ignored when `query` is provided.",
          }),
        }),
        ({ query, limit, cursor }) =>
          query !== undefined && query.trim().length > 0
            ? gte.searchMarkets({ query: query.trim() })
            : gte.listMarkets({ limit, cursor }),
      ),
      gte_market: snapshot(
        describe("Get one GTE market's definition and summary (price, 24h volume, config).", SYMBOL_NOTE),
        Schema.Struct({ symbol: symbolField }),
        ({ symbol }) => resolveSymbol(symbol).pipe(Effect.flatMap((resolved) => gte.getMarket({ symbol: resolved }))),
      ),
      gte_market_data: snapshot(
        describe("Get a live GTE market data snapshot (mark/index/mid price, funding rate, open interest, best bid/ask).", SYMBOL_NOTE),
        Schema.Struct({ symbol: symbolField }),
        ({ symbol }) => resolveSymbol(symbol).pipe(Effect.flatMap((resolved) => gte.getMarketData({ symbol: resolved }))),
      ),
      gte_book: snapshot(
        describe("Get the aggregated GTE order book for a market.", SYMBOL_NOTE),
        Schema.Struct({ symbol: symbolField, limit: limitField }),
        ({ symbol, limit }) =>
          resolveSymbol(symbol).pipe(Effect.flatMap((resolved) => gte.getOrderBook({ symbol: resolved, limit }))),
      ),
      gte_trades: snapshot(
        describe("Get recent public trades for a GTE market.", SYMBOL_NOTE),
        Schema.Struct({ symbol: symbolField, limit: limitField, cursor: cursorField }),
        ({ symbol, limit, cursor }) =>
          resolveSymbol(symbol).pipe(Effect.flatMap((resolved) => gte.getTrades({ symbol: resolved, limit, cursor }))),
      ),
      gte_candles: snapshot(
        describe(
          "Get OHLCV candles for a GTE market.",
          SYMBOL_NOTE,
          `Defaults: interval ${GteDataSchema.DEFAULT_CANDLE_INTERVAL}, from = now - 24h.`,
        ),
        Schema.Struct({
          symbol: symbolField,
          interval: GteDataSchema.CandleInterval.pipe(Schema.optional).annotate({
            description: `Candle interval. One of: ${GteDataSchema.CANDLE_INTERVALS.join(", ")}. Defaults to ${GteDataSchema.DEFAULT_CANDLE_INTERVAL}.`,
          }),
          from: Schema.Number.pipe(Schema.optional).annotate({
            description: "Inclusive start timestamp in epoch milliseconds. Defaults to 24 hours ago.",
          }),
          to: Schema.Number.pipe(Schema.optional).annotate({ description: "Exclusive end timestamp in epoch milliseconds." }),
          limit: limitField,
        }),
        ({ symbol, interval, from, to, limit }) =>
          resolveSymbol(symbol).pipe(
            Effect.flatMap((resolved) =>
              gte.getCandles({
                symbol: resolved,
                interval: interval ?? GteDataSchema.DEFAULT_CANDLE_INTERVAL,
                from: from ?? now() - GteDataSchema.DEFAULT_CANDLE_LOOKBACK_MS,
                to,
                limit,
              }),
            ),
          ),
      ),
      gte_market_context: snapshot(
        describe("Get public market context history (mark/index price, funding, open interest over time).", SYMBOL_NOTE),
        Schema.Struct({
          symbol: symbolField,
          from: Schema.String.pipe(Schema.optional).annotate({ description: "Start timestamp (epoch milliseconds, as a string)." }),
          to: Schema.String.pipe(Schema.optional).annotate({ description: "End timestamp (epoch milliseconds, as a string)." }),
          cursor: cursorField,
          limit: limitField,
        }),
        ({ symbol, ...params }) =>
          resolveSymbol(symbol).pipe(
            Effect.flatMap((resolved) => gte.getMarketContextHistory({ symbol: resolved, ...params })),
          ),
      ),

      // --- Address-scoped account/portfolio reads ------------------------
      gte_positions: snapshot(
        describe("Get open perp positions for an address.", ADDRESS_NOTE),
        Schema.Struct({ address: addressField, symbol: optionalSymbolField, subaccountId: subaccountField, cursor: cursorField, limit: limitField }),
        ({ address, symbol, ...params }, sessionID) =>
          Effect.all([resolveAddress(address, sessionID), resolveOptionalSymbol(symbol)]).pipe(
            Effect.flatMap(([userAddress, resolved]) => gte.getPositions({ userAddress, symbol: resolved, ...params })),
          ),
      ),
      gte_open_orders: snapshot(
        describe("Get open (resting) orders for an address.", ADDRESS_NOTE),
        Schema.Struct({ address: addressField, symbol: optionalSymbolField, subaccountId: subaccountField, cursor: cursorField, limit: limitField }),
        ({ address, symbol, ...params }, sessionID) =>
          Effect.all([resolveAddress(address, sessionID), resolveOptionalSymbol(symbol)]).pipe(
            Effect.flatMap(([userAddress, resolved]) => gte.getOpenOrders({ userAddress, symbol: resolved, ...params })),
          ),
      ),
      gte_order_history: snapshot(
        describe("Get order history for an address.", ADDRESS_NOTE),
        Schema.Struct({ address: addressField, symbol: optionalSymbolField, cursor: cursorField, limit: limitField }),
        ({ address, symbol, ...params }, sessionID) =>
          Effect.all([resolveAddress(address, sessionID), resolveOptionalSymbol(symbol)]).pipe(
            Effect.flatMap(([userAddress, resolved]) => gte.getOrders({ userAddress, symbol: resolved, ...params })),
          ),
      ),
      gte_trade_history: snapshot(
        describe("Get fill/trade history for an address.", ADDRESS_NOTE),
        Schema.Struct({
          address: addressField,
          symbol: optionalSymbolField,
          startTime: Schema.Number.pipe(Schema.optional).annotate({ description: "Start timestamp in epoch milliseconds." }),
          endTime: Schema.Number.pipe(Schema.optional).annotate({ description: "End timestamp in epoch milliseconds." }),
          cursor: cursorField,
          limit: limitField,
        }),
        ({ address, symbol, ...params }, sessionID) =>
          Effect.all([resolveAddress(address, sessionID), resolveOptionalSymbol(symbol)]).pipe(
            Effect.flatMap(([userAddress, resolved]) => gte.getTradeHistory({ userAddress, marketSymbol: resolved, ...params })),
          ),
      ),
      gte_balances: snapshot(
        describe("Get current portfolio balances for an address.", ADDRESS_NOTE),
        Schema.Struct({ address: addressField }),
        ({ address }, sessionID) =>
          resolveAddress(address, sessionID).pipe(Effect.flatMap((userAddress) => gte.getBalances({ userAddress }))),
      ),
      gte_balance_history: snapshot(
        describe("Get balance history snapshots for an address.", ADDRESS_NOTE, "Defaults to the last 7 days."),
        Schema.Struct({
          address: addressField,
          from: Schema.Number.pipe(Schema.optional).annotate({ description: "Start timestamp in epoch milliseconds. Defaults to 7 days ago." }),
          to: Schema.Number.pipe(Schema.optional).annotate({ description: "End timestamp in epoch milliseconds. Defaults to now." }),
        }),
        ({ address, from, to }, sessionID) =>
          resolveAddress(address, sessionID).pipe(
            Effect.flatMap((userAddress) => {
              const end = to ?? now()
              return gte.getBalanceHistory({ userAddress, from: from ?? end - GteDataSchema.DEFAULT_HISTORY_LOOKBACK_MS, to: end })
            }),
          ),
      ),
      gte_pnl: snapshot(
        describe("Get PnL history snapshots for an address.", ADDRESS_NOTE, "Defaults to the last 7 days."),
        Schema.Struct({
          address: addressField,
          from: Schema.Number.pipe(Schema.optional).annotate({ description: "Start timestamp in epoch milliseconds. Defaults to 7 days ago." }),
          to: Schema.Number.pipe(Schema.optional).annotate({ description: "End timestamp in epoch milliseconds. Defaults to now." }),
        }),
        ({ address, from, to }, sessionID) =>
          resolveAddress(address, sessionID).pipe(
            Effect.flatMap((userAddress) => {
              const end = to ?? now()
              return gte.getPnl({ userAddress, from: from ?? end - GteDataSchema.DEFAULT_HISTORY_LOOKBACK_MS, to: end })
            }),
          ),
      ),
      gte_funding: snapshot(
        describe("Get funding payment history for an address.", ADDRESS_NOTE),
        Schema.Struct({ address: addressField, symbol: optionalSymbolField, cursor: cursorField, limit: limitField }),
        ({ address, symbol, ...params }, sessionID) =>
          Effect.all([resolveAddress(address, sessionID), resolveOptionalSymbol(symbol)]).pipe(
            Effect.flatMap(([userAddress, resolved]) => gte.getFundingHistory({ userAddress, symbol: resolved, ...params })),
          ),
      ),
      gte_account: snapshot(
        describe("Get account metrics (equity, margin usage, leverage aggregates) for an address.", ADDRESS_NOTE),
        Schema.Struct({ address: addressField, subaccountId: subaccountField }),
        ({ address, ...params }, sessionID) =>
          resolveAddress(address, sessionID).pipe(
            Effect.flatMap((userAddress) => gte.getAccountMetrics({ userAddress, ...params })),
          ),
      ),
      gte_allowance: snapshot(
        describe("Get the trading allowance for an address on one market.", ADDRESS_NOTE, SYMBOL_NOTE),
        Schema.Struct({ address: addressField, symbol: symbolField, subaccountId: subaccountField }),
        ({ address, symbol, ...params }, sessionID) =>
          Effect.all([resolveAddress(address, sessionID), resolveSymbol(symbol)]).pipe(
            Effect.flatMap(([userAddress, resolved]) => gte.getAllowance({ userAddress, symbol: resolved, ...params })),
          ),
      ),
      gte_leverage: snapshot(
        describe("Read the configured leverage for an address on one market (read-only; never sets leverage).", ADDRESS_NOTE, SYMBOL_NOTE),
        Schema.Struct({ address: addressField, symbol: symbolField, subaccountId: subaccountField }),
        ({ address, symbol, ...params }, sessionID) =>
          Effect.all([resolveAddress(address, sessionID), resolveSymbol(symbol)]).pipe(
            Effect.flatMap(([userAddress, resolved]) => gte.getLeverage({ userAddress, symbol: resolved, ...params })),
          ),
      ),
      gte_fees: snapshot(
        describe("Get the fee tier and rates for an address.", ADDRESS_NOTE),
        Schema.Struct({ address: addressField }),
        ({ address }, sessionID) =>
          resolveAddress(address, sessionID).pipe(Effect.flatMap((userAddress) => gte.getFees({ userAddress }))),
      ),
      gte_twap_history: snapshot(
        describe("Get TWAP order history for an address (read-only; never creates or cancels TWAPs).", ADDRESS_NOTE),
        Schema.Struct({ address: addressField, symbol: optionalSymbolField, cursor: cursorField, limit: limitField }),
        ({ address, symbol, ...params }, sessionID) =>
          Effect.all([resolveAddress(address, sessionID), resolveOptionalSymbol(symbol)]).pipe(
            Effect.flatMap(([userAddress, resolved]) => gte.getTwapHistory({ userAddress, symbol: resolved, ...params })),
          ),
      ),
      gte_next_subaccount: snapshot(
        describe("Get the next available subaccount ID for an address.", ADDRESS_NOTE),
        Schema.Struct({ address: addressField }),
        ({ address }, sessionID) =>
          resolveAddress(address, sessionID).pipe(Effect.flatMap((userAddress) => gte.getNextSubaccount({ userAddress }))),
      ),

      // --- Diagnostics ----------------------------------------------------
      // Liquidations and bench metrics have no HTTP endpoints in gte-ts (they
      // are WS-stream-only), so they are intentionally absent from this
      // one-shot tool catalog; the live-panel surface covers them.
      gte_health: snapshot(
        describe("Check GTE data API health for the configured environment."),
        Schema.Struct({}),
        () => gte.getHealth(),
      ),
    }

    // gte_quote has a custom, estimate-only success schema so its output can
    // never carry balance/margin/order-payload fields.
    const quote: Registration = {
      tool: Tool.make({
        description: describe(
          "Estimate the average fill price and notional for a hypothetical taker order, derived purely from the public order book.",
          SYMBOL_NOTE,
          "Provide exactly one of baseSize or quoteSize.",
          "This is an estimate only — it is not an order preview, does not check balances or margin, and produces no order payload.",
        ),
        parameters: QuoteParameters,
        success: QuoteSuccess,
        toModelOutput: ({ output }) => [toolText({ type: "text", text: JSON.stringify(output) })],
      }),
      execute: ({ parameters }: { parameters: typeof QuoteParameters.Type; sessionID: SessionSchema.ID }) =>
        Effect.gen(function* () {
          const { symbol, side, baseSize, quoteSize } = parameters
          if ((baseSize === undefined) === (quoteSize === undefined)) {
            return yield* Effect.fail(failure("Provide exactly one of `baseSize` or `quoteSize`."))
          }
          const resolved = yield* resolveSymbol(symbol)
          const result =
            baseSize !== undefined
              ? yield* gte.quoteByBaseSize({ symbol: resolved, side, baseSize })
              : yield* gte.quoteByQuoteSize({ symbol: resolved, side, quoteSize: quoteSize! })
          return {
            provenance: result.provenance,
            data: {
              symbol: resolved,
              side,
              requested: { baseSize, quoteSize },
              estimate: result.data,
              note: QUOTE_NOTE,
            },
          }
        }).pipe(Effect.catchTag("GteData.RequestError", (error) => Effect.fail(requestFailed(error)))),
    }

    yield* registry.contribute((editor) => {
      for (const [name, registration] of Object.entries({ ...tools, gte_quote: quote })) {
        editor.set(name, {
          tool: registration.tool,
          execute: ({ parameters, sessionID }) => registration.execute({ parameters, sessionID }),
        })
      }
    })
  }),
)

/**
 * Default composition of the GTE tool contribution: `layer` bound to the
 * env-configured shared GteData service (`GTE_AGENT_GTE_ENV`, default
 * `hyperliquid-dev`).
 *
 * Config resolves eagerly at layer build, but client construction is
 * network-free (the gte-ts WS transport only connects on first stream
 * subscription, which this read-only surface never performs), so composing
 * this layer in tests stays hermetic and needs no environment variables. An
 * invalid `GTE_AGENT_GTE_ENV` surfaces as a typed `GteData.ConfigError` for
 * the composition root to handle eagerly — the server orDies it at startup
 * and the runtime-scope map orDies it at scope creation — so `gte-agent
 * serve` fails fast with the valid-keys message instead of erroring on the
 * first tool call. The session tracked-address fallback activates only where
 * the composition also provides `SessionStore`; without it, explicit
 * addresses still work.
 */
export const runtimeScopeLayer: Layer.Layer<never, GteDataSchema.ConfigError, ToolRegistry.Service> = layer.pipe(
  Layer.provide(GteData.defaultLayer),
)
