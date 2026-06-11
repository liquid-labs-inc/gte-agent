import type { Market } from "gte-ts"
import type { GteData } from "@gte-agent/core/gte-data/gte-data"

export const market = (symbol: string): Market => ({
  symbol,
  marketType: "perp",
  price: 100,
  volume24hrUsd: 1_000,
  priceChange24hr: 0,
})

export type StubCall = { readonly op: string; readonly params: unknown }

/** The full read-only gte_* tool catalog contributed by GteTools.layer. */
export const EXPECTED_GTE_TOOLS = [
  "gte_markets",
  "gte_market",
  "gte_market_data",
  "gte_book",
  "gte_trades",
  "gte_candles",
  "gte_market_context",
  "gte_quote",
  "gte_positions",
  "gte_open_orders",
  "gte_order_history",
  "gte_trade_history",
  "gte_balances",
  "gte_balance_history",
  "gte_pnl",
  "gte_funding",
  "gte_account",
  "gte_allowance",
  "gte_leverage",
  "gte_fees",
  "gte_twap_history",
  "gte_next_subaccount",
  "gte_health",
] as const

/**
 * Stub gte-ts data client recording every call. Known markets: BTC-USD,
 * ETH-USD. Searching "DOG" yields two candidates (ambiguity path); other
 * queries substring-match the known markets.
 */
export const makeStubClient = (calls: StubCall[] = []): GteData.Client => {
  const known = [market("BTC-USD"), market("ETH-USD")]
  const record = <T>(op: string, params: unknown, value: T): Promise<T> => {
    calls.push({ op, params })
    return Promise.resolve(value)
  }
  return {
    markets: {
      list: (params) => record("markets.list", params, { markets: known } as never),
      search: (params) => {
        const query = (params?.query ?? "").toUpperCase()
        const matches =
          query === "DOG"
            ? [market("DOGE-USD"), market("DOGS-USD")]
            : known.filter((item) => item.symbol.toUpperCase().includes(query))
        return record("markets.search", params, matches)
      },
      get: (params) => {
        calls.push({ op: "markets.get", params })
        const found = known.find((item) => item.symbol === params.symbol)
        return found ? Promise.resolve(found) : Promise.reject(new Error(`market not found: ${params.symbol}`))
      },
      getData: (params) => record("markets.getData", params, { markPrice: 100 } as never),
      getContextHistory: (params) => record("markets.getContextHistory", params, { snapshots: [] } as never),
      getOrderBook: (params) => record("markets.getOrderBook", params, { bids: [], asks: [] } as never),
      getCandles: (params) => record("markets.getCandles", params, []),
      getTrades: (params) => record("markets.getTrades", params, { trades: [] } as never),
      quoteOrderByBaseSize: (symbol, side, baseSize) =>
        record("markets.quoteOrderByBaseSize", { symbol, side, baseSize }, {
          size: baseSize,
          notional: baseSize * 100,
          averagePrice: 100,
        }),
      quoteOrderByQuoteSize: (symbol, side, quoteSize) =>
        record("markets.quoteOrderByQuoteSize", { symbol, side, quoteSize }, {
          size: quoteSize / 100,
          notional: quoteSize,
          averagePrice: 100,
        }),
    },
    accounts: {
      getPositions: (params) => record("accounts.getPositions", params, { positions: [], version: 1 } as never),
      getOpenOrders: (params) => record("accounts.getOpenOrders", params, { orders: [], version: 1 } as never),
      getOrders: (params) => record("accounts.getOrders", params, { orders: [], version: 1 } as never),
      getFundingHistory: (params) => record("accounts.getFundingHistory", params, { fundingPayments: [] } as never),
      getLeverage: (params) => record("accounts.getLeverage", params, { leverage: 5 } as never),
      getNextSubaccount: (params) => record("accounts.getNextSubaccount", params, { subaccountId: 1 }),
      getAllowance: (params) => record("accounts.getAllowance", params, { allowance: "0" } as never),
      getFees: (params) => record("accounts.getFees", params, { tier: 0 } as never),
      getAccountMetrics: (params) => record("accounts.getAccountMetrics", params, { equity: "0" } as never),
      getTwapHistory: (params) => record("accounts.getTwapHistory", params, { twaps: [] } as never),
      getTradeHistory: (params) => record("accounts.getTradeHistory", params, { trades: [] } as never),
    },
    portfolio: {
      getBalances: (params) => record("portfolio.getBalances", params, { balances: [] } as never),
      getBalanceHistory: (params) => record("portfolio.getBalanceHistory", params, { snapshots: [] } as never),
      getPnl: (params) => record("portfolio.getPnl", params, { snapshots: [] } as never),
    },
    getHealth: () => record("getHealth", undefined, { status: "ok" } as never),
  }
}
