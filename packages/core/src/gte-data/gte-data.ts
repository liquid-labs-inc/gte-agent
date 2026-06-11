export * as GteData from "./gte-data"

import { Config as EffectConfig, Context, Effect, Layer } from "effect"
import {
  createGteDataClient,
  GteApiError,
  GteError,
  type AccountsReadInterface,
  type Candle,
  type GetAccountMetricsParams,
  type GetAccountMetricsResponse,
  type GetAllowanceParams,
  type GetAllowanceResponse,
  type GetBalanceHistoryParams,
  type GetBalanceHistoryResponse,
  type GetBalancesParams,
  type GetBalancesResponse,
  type GetCandlesParams,
  type GetFeesResponse,
  type GetFundingHistoryParams,
  type GetFundingHistoryResponse,
  type GetHealthResponse,
  type GetLeverageParams,
  type GetLeverageResponse,
  type GetMarketContextHistoryResponse,
  type GetMarketDataParams,
  type GetMarketParams,
  type GetMarketsParams,
  type GetMarketsResponse,
  type GetNextSubaccountParams,
  type GetNextSubaccountResponse,
  type GetOpenOrdersParams,
  type GetOpenOrdersResponse,
  type GetOrderBookParams,
  type GetOrderBookResponse,
  type GetOrdersParams,
  type GetOrdersResponse,
  type GetPnlHistoryParams,
  type GetPnlHistoryResponse,
  type GetPositionsParams,
  type GetPositionsResponse,
  type GetTradeHistoryParams,
  type GetTradeHistoryResponse,
  type GetTradesParams,
  type GetTradesResponse,
  type GetTwapHistoryParams,
  type GteEnvKey,
  type Market,
  type MarketDataPerps,
  type MarketsInterface,
  type PortfolioInterface,
  type SearchMarketsParams,
  type SearchMarketsResponse,
  type TradeSide,
} from "gte-ts"
import { ConfigError, DEFAULT_ENV, ENV_KEYS, RequestError, type Provenance } from "./schema"
import { GteSymbol } from "./symbol"

/**
 * Structural slice of the gte-ts `GteDataClient` used by this layer. The
 * active read path consumes only `createGteDataClient`; this type makes the
 * service injectable with a stub client in tests and keeps the import surface
 * strictly read-only (no order client, no signers, no write resources).
 */
export type Client = {
  readonly markets: MarketsInterface
  readonly accounts: AccountsReadInterface
  readonly portfolio: PortfolioInterface
  readonly getHealth: () => Promise<GetHealthResponse>
}

/** Every read returns the canonical `{ provenance, data }` wrapper. */
export type Snapshot<Data> = {
  readonly provenance: Provenance
  readonly data: Data
}

/** gte-ts does not export its QuoteResult type; mirror of the book-derived estimate shape. */
export type Quote = {
  readonly size: number
  readonly notional: number
  readonly averagePrice: number
}

/** Not exported by the gte-ts index; mirrors `GetMarketContextHistoryParams`. */
export type MarketContextHistoryParams = {
  readonly symbol: string
  readonly from?: string
  readonly to?: string
  readonly cursor?: string
  readonly limit?: number
}

/** Not exported by the gte-ts index; mirrors `GetFeesParams`. */
export type FeesParams = {
  readonly userAddress: string
}

/** Not exported by the gte-ts index; derived from the read interface. */
export type GetTwapHistoryResponse = Awaited<ReturnType<AccountsReadInterface["getTwapHistory"]>>

export type QuoteByBaseSizeInput = {
  readonly symbol: string
  readonly side: TradeSide
  readonly baseSize: number
}

export type QuoteByQuoteSizeInput = {
  readonly symbol: string
  readonly side: TradeSide
  readonly quoteSize: number
}

export interface Interface {
  /** Resolved gte-ts environment this service is bound to. */
  readonly env: GteEnvKey

  // Public market reads.
  readonly listMarkets: (params?: GetMarketsParams) => Effect.Effect<Snapshot<GetMarketsResponse>, RequestError>
  readonly searchMarkets: (params?: SearchMarketsParams) => Effect.Effect<Snapshot<SearchMarketsResponse>, RequestError>
  readonly getMarket: (params: GetMarketParams) => Effect.Effect<Snapshot<Market>, RequestError>
  readonly getMarketData: (params: GetMarketDataParams) => Effect.Effect<Snapshot<MarketDataPerps>, RequestError>
  readonly getMarketContextHistory: (
    params: MarketContextHistoryParams,
  ) => Effect.Effect<Snapshot<GetMarketContextHistoryResponse>, RequestError>
  readonly getOrderBook: (params: GetOrderBookParams) => Effect.Effect<Snapshot<GetOrderBookResponse>, RequestError>
  readonly getCandles: (params: GetCandlesParams) => Effect.Effect<Snapshot<Candle[]>, RequestError>
  readonly getTrades: (params: GetTradesParams) => Effect.Effect<Snapshot<GetTradesResponse>, RequestError>
  readonly quoteByBaseSize: (input: QuoteByBaseSizeInput) => Effect.Effect<Snapshot<Quote>, RequestError>
  readonly quoteByQuoteSize: (input: QuoteByQuoteSizeInput) => Effect.Effect<Snapshot<Quote>, RequestError>

  // Address-scoped account reads (public data tied to an explicit address).
  readonly getPositions: (params: GetPositionsParams) => Effect.Effect<Snapshot<GetPositionsResponse>, RequestError>
  readonly getOpenOrders: (params: GetOpenOrdersParams) => Effect.Effect<Snapshot<GetOpenOrdersResponse>, RequestError>
  readonly getOrders: (params: GetOrdersParams) => Effect.Effect<Snapshot<GetOrdersResponse>, RequestError>
  readonly getFundingHistory: (
    params: GetFundingHistoryParams,
  ) => Effect.Effect<Snapshot<GetFundingHistoryResponse>, RequestError>
  readonly getLeverage: (params: GetLeverageParams) => Effect.Effect<Snapshot<GetLeverageResponse>, RequestError>
  readonly getNextSubaccount: (
    params: GetNextSubaccountParams,
  ) => Effect.Effect<Snapshot<GetNextSubaccountResponse>, RequestError>
  readonly getAllowance: (params: GetAllowanceParams) => Effect.Effect<Snapshot<GetAllowanceResponse>, RequestError>
  readonly getFees: (params: FeesParams) => Effect.Effect<Snapshot<GetFeesResponse>, RequestError>
  readonly getAccountMetrics: (
    params: GetAccountMetricsParams,
  ) => Effect.Effect<Snapshot<GetAccountMetricsResponse>, RequestError>
  readonly getTwapHistory: (
    params: GetTwapHistoryParams,
  ) => Effect.Effect<Snapshot<GetTwapHistoryResponse>, RequestError>
  readonly getTradeHistory: (
    params: GetTradeHistoryParams,
  ) => Effect.Effect<Snapshot<GetTradeHistoryResponse>, RequestError>

  // Address-scoped portfolio reads.
  readonly getBalances: (params: GetBalancesParams) => Effect.Effect<Snapshot<GetBalancesResponse>, RequestError>
  readonly getBalanceHistory: (
    params: GetBalanceHistoryParams,
  ) => Effect.Effect<Snapshot<GetBalanceHistoryResponse>, RequestError>
  readonly getPnl: (params: GetPnlHistoryParams) => Effect.Effect<Snapshot<GetPnlHistoryResponse>, RequestError>

  // Diagnostics.
  readonly getHealth: () => Effect.Effect<Snapshot<GetHealthResponse>, RequestError>

  /** Shared symbol resolution (exact -> uppercase -> search). Never guesses. */
  readonly resolveSymbol: (query: string) => Effect.Effect<GteSymbol.Resolution, RequestError>
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/GteData") {}

export type Config = {
  readonly env: GteEnvKey
}

export class ConfigService extends Context.Service<ConfigService, Config>()("@gte-agent/GteDataConfig") {
  static layer(input: Config) {
    return Layer.succeed(this, this.of(input))
  }

  /**
   * Reads `GTE_AGENT_GTE_ENV` (default: `hyperliquid-dev` for dev ergonomics).
   * The valid names come from the gte-ts `GteEnvKey` type; `gte-ts` itself
   * re-validates at client construction, so this check exists only to fail
   * fast with a clear message listing the valid keys.
   */
  static get defaultLayer(): Layer.Layer<ConfigService, ConfigError> {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const raw = yield* EffectConfig.string("GTE_AGENT_GTE_ENV").pipe(
          EffectConfig.withDefault(DEFAULT_ENV),
          Effect.orDie,
        )
        const env = ENV_KEYS.find((key) => key === raw)
        if (env === undefined) {
          return yield* Effect.fail(
            new ConfigError({
              message: `Invalid GTE_AGENT_GTE_ENV "${raw}". Valid values (owned by gte-ts GteEnvKey): ${ENV_KEYS.join(", ")}.`,
            }),
          )
        }
        return ConfigService.of({ env })
      }),
    )
  }
}

const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const toRequestError = (op: string, cause: unknown): RequestError => {
  if (cause instanceof GteApiError) {
    return new RequestError({ op, message: cause.message, status: cause.status, code: cause.code })
  }
  if (cause instanceof GteError) {
    return new RequestError({ op, message: cause.message, code: cause.code })
  }
  return new RequestError({ op, message: errorMessage(cause) })
}

const prune = <T extends Record<string, unknown>>(input: T): T => {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value
  }
  return output as T
}

type ProvenanceInput = {
  readonly symbol?: string
  readonly address?: string
  readonly params?: Record<string, unknown>
}

export const make = (env: GteEnvKey, client: Client): Interface => {
  const provenance = (input: ProvenanceInput = {}): Provenance => {
    const params = input.params === undefined ? undefined : prune(input.params)
    return prune({
      env,
      source: "http" as const,
      timestamp: new Date().toISOString(),
      symbol: input.symbol,
      address: input.address,
      params: params !== undefined && Object.keys(params).length > 0 ? params : undefined,
    })
  }

  const call = <Data>(
    op: string,
    run: () => Promise<Data>,
    input: ProvenanceInput = {},
  ): Effect.Effect<Snapshot<Data>, RequestError> =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => toRequestError(op, cause),
    }).pipe(Effect.map((data) => ({ provenance: provenance(input), data })))

  return Service.of({
    env,

    listMarkets: (params) => call("markets.list", () => client.markets.list(params), { params: { ...params } }),
    searchMarkets: (params) => call("markets.search", () => client.markets.search(params), { params: { ...params } }),
    getMarket: ({ symbol }) => call("markets.get", () => client.markets.get({ symbol }), { symbol }),
    getMarketData: ({ symbol }) => call("markets.getData", () => client.markets.getData({ symbol }), { symbol }),
    getMarketContextHistory: ({ symbol, ...params }) =>
      call("markets.getContextHistory", () => client.markets.getContextHistory({ symbol, ...params }), {
        symbol,
        params: { ...params },
      }),
    getOrderBook: ({ symbol, ...params }) =>
      call("markets.getOrderBook", () => client.markets.getOrderBook({ symbol, ...params }), {
        symbol,
        params: { ...params },
      }),
    getCandles: ({ symbol, ...params }) =>
      call("markets.getCandles", () => client.markets.getCandles({ symbol, ...params }), {
        symbol,
        params: { ...params },
      }),
    getTrades: ({ symbol, ...params }) =>
      call("markets.getTrades", () => client.markets.getTrades({ symbol, ...params }), {
        symbol,
        params: { ...params },
      }),
    quoteByBaseSize: ({ symbol, side, baseSize }) =>
      call("markets.quoteOrderByBaseSize", () => client.markets.quoteOrderByBaseSize(symbol, side, baseSize), {
        symbol,
        params: { side, baseSize },
      }),
    quoteByQuoteSize: ({ symbol, side, quoteSize }) =>
      call("markets.quoteOrderByQuoteSize", () => client.markets.quoteOrderByQuoteSize(symbol, side, quoteSize), {
        symbol,
        params: { side, quoteSize },
      }),

    getPositions: ({ userAddress, ...params }) =>
      call("accounts.getPositions", () => client.accounts.getPositions({ userAddress, ...params }), {
        address: userAddress,
        symbol: params.symbol,
        params: { ...params },
      }),
    getOpenOrders: ({ userAddress, ...params }) =>
      call("accounts.getOpenOrders", () => client.accounts.getOpenOrders({ userAddress, ...params }), {
        address: userAddress,
        symbol: params.symbol,
        params: { ...params },
      }),
    getOrders: ({ userAddress, ...params }) =>
      call("accounts.getOrders", () => client.accounts.getOrders({ userAddress, ...params }), {
        address: userAddress,
        symbol: params.symbol,
        params: { ...params },
      }),
    getFundingHistory: ({ userAddress, ...params }) =>
      call("accounts.getFundingHistory", () => client.accounts.getFundingHistory({ userAddress, ...params }), {
        address: userAddress,
        symbol: params.symbol,
        params: { ...params },
      }),
    getLeverage: ({ userAddress, ...params }) =>
      call("accounts.getLeverage", () => client.accounts.getLeverage({ userAddress, ...params }), {
        address: userAddress,
        symbol: params.symbol,
        params: { ...params },
      }),
    getNextSubaccount: ({ userAddress }) =>
      call("accounts.getNextSubaccount", () => client.accounts.getNextSubaccount({ userAddress }), {
        address: userAddress,
      }),
    getAllowance: ({ userAddress, ...params }) =>
      call("accounts.getAllowance", () => client.accounts.getAllowance({ userAddress, ...params }), {
        address: userAddress,
        symbol: params.symbol,
        params: { ...params },
      }),
    getFees: ({ userAddress }) =>
      call("accounts.getFees", () => client.accounts.getFees({ userAddress }), { address: userAddress }),
    getAccountMetrics: ({ userAddress, ...params }) =>
      call("accounts.getAccountMetrics", () => client.accounts.getAccountMetrics({ userAddress, ...params }), {
        address: userAddress,
        params: { ...params },
      }),
    getTwapHistory: ({ userAddress, ...params }) =>
      call("accounts.getTwapHistory", () => client.accounts.getTwapHistory({ userAddress, ...params }), {
        address: userAddress,
        symbol: params.symbol,
        params: { ...params },
      }),
    getTradeHistory: ({ userAddress, ...params }) =>
      call("accounts.getTradeHistory", () => client.accounts.getTradeHistory({ userAddress, ...params }), {
        address: userAddress,
        symbol: params.marketSymbol,
        params: { ...params },
      }),

    getBalances: ({ userAddress }) =>
      call("portfolio.getBalances", () => client.portfolio.getBalances({ userAddress }), { address: userAddress }),
    getBalanceHistory: ({ userAddress, ...params }) =>
      call("portfolio.getBalanceHistory", () => client.portfolio.getBalanceHistory({ userAddress, ...params }), {
        address: userAddress,
        params: { ...params },
      }),
    getPnl: ({ userAddress, ...params }) =>
      call("portfolio.getPnl", () => client.portfolio.getPnl({ userAddress, ...params }), {
        address: userAddress,
        params: { ...params },
      }),

    getHealth: () => call("getHealth", () => client.getHealth()),

    resolveSymbol: (query) => GteSymbol.resolve(client.markets, query),
  })
}

/** Test/injection layer: bind the service to an explicit env and (stub) client. */
export const layerFromClient = (env: GteEnvKey, client: Client): Layer.Layer<Service> =>
  Layer.succeed(Service, make(env, client))

/**
 * Builds one shared read-only data client from `ConfigService`. Construction
 * is network-free: the HTTP client is plain configuration and the gte-ts WS
 * transport only connects on first stream subscription (this layer never
 * subscribes). gte-ts re-validates the env at construction and is the
 * authoritative rejection path for unknown environments.
 */
export const layer: Layer.Layer<Service, ConfigError, ConfigService> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* ConfigService
    const client = yield* Effect.try({
      try: () => createGteDataClient({ env: config.env }),
      catch: (cause) => new ConfigError({ message: `Failed to construct GTE data client: ${errorMessage(cause)}` }),
    })
    return make(config.env, client)
  }),
)

export const defaultLayer: Layer.Layer<Service, ConfigError> = layer.pipe(Layer.provide(ConfigService.defaultLayer))
