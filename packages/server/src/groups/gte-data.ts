import { GteDataSchema } from "@gte-agent/core/gte-data/schema"
import { GteSymbol } from "@gte-agent/core/gte-data/symbol"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, ServiceUnavailableError } from "../errors"
import { GTEAuthorization } from "../middleware/authorization"

/**
 * Read-only GTE data routes. Handlers call the same GteData service
 * operations as the agent tools, so validation, symbol resolution, and
 * provenance are identical across surfaces. Responses are the canonical
 * `{ provenance, data }` snapshot.
 */

const Snapshot = GteDataSchema.Snapshot
const errors = [InvalidRequestError, ServiceUnavailableError]

const NumberFromQuery = Schema.NumberFromString
const limit = NumberFromQuery.pipe(Schema.optional)
const cursor = Schema.String.pipe(Schema.optional)
const symbolFilter = Schema.String.pipe(Schema.optional).annotate({
  description: "Optional market symbol filter; resolved to the canonical GTE symbol when provided.",
})
const subaccountId = NumberFromQuery.pipe(Schema.optional)

const symbolParam = { symbol: Schema.String }
const addressParam = { address: Schema.String }

export const GteDataGroup = HttpApiGroup.make("gteData")
  .add(
    HttpApiEndpoint.get("env", "/api/gte/env", {
      success: Schema.Struct({
        env: GteDataSchema.Env,
        source: Schema.Literal("http"),
        timestamp: Schema.String,
        validEnvs: Schema.Array(Schema.String),
      }).annotate({ identifier: "GteEnvResponse" }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "gte.env",
        summary: "Get resolved GTE environment",
        description: "Resolved gte-ts environment for this server plus provenance basics, for TUI display.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("health", "/api/gte/health", {
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("markets", "/api/gte/markets", {
      query: Schema.Struct({
        query: Schema.String.pipe(Schema.optional).annotate({
          description: "Optional search query. Omit to list markets.",
        }),
        limit,
        cursor,
      }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("resolveSymbol", "/api/gte/resolve-symbol", {
      query: Schema.Struct({ q: Schema.String }),
      success: Schema.Struct({
        provenance: GteDataSchema.Provenance,
        data: GteSymbol.Resolution,
      }).annotate({ identifier: "GteResolveSymbolResponse" }),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "gte.resolveSymbol",
        summary: "Resolve a market symbol",
        description:
          "Shared deterministic symbol resolution (exact, uppercase, search). Returns resolved, ambiguous (with candidates), or notFound; never guesses.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("market", "/api/gte/market/:symbol", {
      params: symbolParam,
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("marketData", "/api/gte/market/:symbol/data", {
      params: symbolParam,
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("book", "/api/gte/market/:symbol/book", {
      params: symbolParam,
      query: Schema.Struct({ limit }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("trades", "/api/gte/market/:symbol/trades", {
      params: symbolParam,
      query: Schema.Struct({ limit, cursor }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("candles", "/api/gte/market/:symbol/candles", {
      params: symbolParam,
      query: Schema.Struct({
        interval: GteDataSchema.CandleInterval.pipe(Schema.optional),
        from: NumberFromQuery.pipe(Schema.optional),
        to: NumberFromQuery.pipe(Schema.optional),
        limit,
      }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("context", "/api/gte/market/:symbol/context", {
      params: symbolParam,
      query: Schema.Struct({
        from: Schema.String.pipe(Schema.optional),
        to: Schema.String.pipe(Schema.optional),
        cursor,
        limit,
      }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("quote", "/api/gte/market/:symbol/quote", {
      params: symbolParam,
      query: Schema.Struct({
        side: GteDataSchema.QuoteSide,
        baseSize: NumberFromQuery.pipe(Schema.optional),
        quoteSize: NumberFromQuery.pipe(Schema.optional),
      }),
      success: Snapshot,
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "gte.quote",
        summary: "Estimate a fill from the public order book",
        description:
          "Book-derived estimate only. Provide exactly one of baseSize or quoteSize. Not an order preview: no balance or margin checks, no order payload.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("positions", "/api/gte/address/:address/positions", {
      params: addressParam,
      query: Schema.Struct({ symbol: symbolFilter, subaccountId, cursor, limit }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("openOrders", "/api/gte/address/:address/open-orders", {
      params: addressParam,
      query: Schema.Struct({ symbol: symbolFilter, subaccountId, cursor, limit }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("orders", "/api/gte/address/:address/orders", {
      params: addressParam,
      query: Schema.Struct({ symbol: symbolFilter, cursor, limit }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("tradeHistory", "/api/gte/address/:address/trade-history", {
      params: addressParam,
      query: Schema.Struct({
        symbol: symbolFilter,
        startTime: NumberFromQuery.pipe(Schema.optional),
        endTime: NumberFromQuery.pipe(Schema.optional),
        cursor,
        limit,
      }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("balances", "/api/gte/address/:address/balances", {
      params: addressParam,
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("balanceHistory", "/api/gte/address/:address/balance-history", {
      params: addressParam,
      query: Schema.Struct({
        from: NumberFromQuery.pipe(Schema.optional),
        to: NumberFromQuery.pipe(Schema.optional),
      }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("pnl", "/api/gte/address/:address/pnl", {
      params: addressParam,
      query: Schema.Struct({
        from: NumberFromQuery.pipe(Schema.optional),
        to: NumberFromQuery.pipe(Schema.optional),
      }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("funding", "/api/gte/address/:address/funding", {
      params: addressParam,
      query: Schema.Struct({ symbol: symbolFilter, cursor, limit }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("account", "/api/gte/address/:address/account", {
      params: addressParam,
      query: Schema.Struct({ subaccountId }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("allowance", "/api/gte/address/:address/allowance", {
      params: addressParam,
      query: Schema.Struct({ symbol: Schema.String, subaccountId }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("leverage", "/api/gte/address/:address/leverage", {
      params: addressParam,
      query: Schema.Struct({ symbol: Schema.String, subaccountId }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("fees", "/api/gte/address/:address/fees", {
      params: addressParam,
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("twapHistory", "/api/gte/address/:address/twap-history", {
      params: addressParam,
      query: Schema.Struct({ symbol: symbolFilter, cursor, limit }),
      success: Snapshot,
      error: errors,
    }),
  )
  .add(
    HttpApiEndpoint.get("nextSubaccount", "/api/gte/address/:address/next-subaccount", {
      params: addressParam,
      success: Snapshot,
      error: errors,
    }),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "gte-data",
      description:
        "Read-only GTE exchange data (one-shot HTTP snapshots with provenance). No mutation or signing surface exists on these routes.",
    }),
  )
  .middleware(GTEAuthorization)
