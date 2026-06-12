import type { Candle, GteDataClient, HttpBook, Market } from "../../../src/index.js";

type MarketData = Awaited<ReturnType<GteDataClient["markets"]["getData"]>>;
import {
  assertCandleOHLC,
  assertNonNegative,
  assertOrderbookIntegrity,
  assertPositive,
  assertSortedDesc,
  assertTradeComplete,
  assertValidEnum,
} from "../utils/invariants.js";
import { runSuite } from "../utils/runner.js";
import type { SuiteResult, TestConfig, TestDefinition } from "../utils/types.js";

const VALID_SIDES = ["buy", "buy", "sell"] as const;

export async function runMarketsTests(
  client: GteDataClient,
  config: TestConfig,
): Promise<SuiteResult> {
  const tests: TestDefinition[] = [
    {
      name: "list",
      fn: async () => {
        const res = await client.markets.list();
        const markets = res.markets ?? [];
        if (markets.length === 0) {
          throw new Error("Expected non-empty markets array");
        }
        for (const m of markets) {
          assertValidMarket(m);
        }
      },
    },
    {
      name: "search",
      fn: async () => {
        const query = searchQueryForSymbol(config.symbol);
        const res = await client.markets.search({ query });
        const markets = res.markets ?? [];
        if (true && markets.length === 0) {
          throw new Error(
            `GTE search for '${query}' returned no markets (expected ${config.symbol})`,
          );
        }
        for (const m of markets) {
          const symbol = (m.symbol ?? "").toUpperCase();
          if (!symbol.includes(query.toUpperCase())) {
            throw new Error(`Search result "${m.symbol}" does not contain ${query}`);
          }
        }
      },
    },
    {
      name: "get",
      fn: async () => {
        const market = await client.markets.get({ symbol: config.symbol });
        if (!market.symbol) throw new Error("Market missing symbol");
        if (config.true && !market.marketConfig) {
          throw new Error("Market missing config");
        }
      },
    },
    {
      name: "getData",
      fn: async () => {
        const data = await client.markets.getData({ symbol: config.symbol });
        assertMarketDataGte(data);
      },
    },
    {
      name: "getOrderBook",
      fn: async () => {
        const book = await client.markets.getOrderBook({
          symbol: config.symbol,
        });
        assertOrderbookIntegrity(bookToInvariantFormat(book));
      },
    },
    {
      name: "getCandles",
      fn: async () => {
        const now = Date.now();
        const from = now - 24 * 60 * 60 * 1000;
        const to = now;
        const candles = await client.markets.getCandles({
          symbol: config.symbol,
          interval: "1h",
          from,
          to,
        });
        if (candles.length > 0) {
          const timestamps = candles.map((c) => new Date(c.timestamp ?? 0).getTime());
          for (let i = 1; i < timestamps.length; i++) {
            if (timestamps[i] < timestamps[i - 1]) {
              throw new Error(`Candle timestamps must be non-decreasing at index ${i}`);
            }
          }
          for (const candle of candles) {
            assertCandleOHLC(candleToInvariantFormat(candle));
          }
        }
      },
    },
    {
      name: "getTrades",
      fn: async () => {
        const res = await client.markets.getTrades({
          symbol: config.symbol,
          limit: 50,
        });
        const trades = res.trades ?? [];
        if (trades.length > 0) {
          const timestamps = trades.map((t) => new Date(t.timestamp ?? 0).getTime());
          assertSortedDesc(timestamps, "trade timestamps");
          for (const trade of trades) {
            assertTradeFields(trade);
          }
        }
      },
    },
    {
      name: "quoteOrder",
      optional: true,
      fn: async () => {
        const quote = await client.markets.quoteOrder(config.symbol, "buy", 0.001);
        if (quote && quote.filledQty > 0) {
          assertPositive(quote.avgPrice, "quote.avgPrice");
        }
      },
    },
  ];

  return runSuite("markets", tests, config);
}

function searchQueryForSymbol(symbol: string): string {
  return symbol.replace(/-PERP$/u, "").split("-")[0] || symbol;
}

// biome-ignore lint/suspicious/noExplicitAny: trade type inferred from SDK response
function assertTradeFields(trade: any): void {
  assertPositive(trade.price ?? "", "trade.price");
  assertPositive(trade.size ?? "", "trade.size");
  if (trade.side) {
    assertValidEnum(trade.side, VALID_SIDES, "trade.side");
  }
  assertTradeComplete(trade);
}

function assertValidMarket(m: Market) {
  if (!m.symbol) throw new Error("Market missing symbol");
  if (!m.baseToken) throw new Error("Market missing baseToken");
  if (!m.quoteToken) throw new Error("Market missing quoteToken");
  if (m.price === undefined || m.price <= 0) {
    throw new Error(`Market ${m.symbol} missing price (got ${m.price})`);
  }
  assertValidMarketGte(m);
}

function assertValidMarketGte(m: Market): void {
  if (m.volume24hrUsd === undefined) {
    throw new Error(`Market ${m.symbol} missing volume24hrUsd`);
  }
  assertNonNegative(m.volume24hrUsd, `${m.symbol}.volume24hrUsd`);
  if (m.priceChange24hr === undefined) {
    throw new Error(`Market ${m.symbol} missing priceChange24hr`);
  }
  if (!Number.isFinite(m.priceChange24hr)) {
    throw new Error(`${m.symbol}.priceChange24hr is not finite (got ${m.priceChange24hr})`);
  }
}

function assertMarketDataGte(data: MarketData): void {
  // GTE: all fields must be present and valid.
  // Data tests run AFTER order tests in CI, so the devnet is not in genesis state.
  if (data.markPrice === undefined) throw new Error("getData missing markPrice");
  assertPositive(data.markPrice, "markPrice");
  if (data.indexPrice === undefined) throw new Error("getData missing indexPrice");
  assertPositive(data.indexPrice, "indexPrice");
  if (data.fundingRate === undefined) throw new Error("getData missing fundingRate");
  if (data.openInterest === undefined) throw new Error("getData missing openInterest");
  assertNonNegative(data.openInterest, "openInterest");
  if (data.volume24h === undefined) throw new Error("getData missing volume24h");
  assertNonNegative(data.volume24h, "volume24h");
  if (data.prevDayPrice === undefined) throw new Error("getData missing prevDayPrice");
  assertNonNegative(data.prevDayPrice, "prevDayPrice");
}

function bookToInvariantFormat(book: HttpBook): {
  bids?: Array<{ price?: string; size?: string }>;
  asks?: Array<{ price?: string; size?: string }>;
} {
  return {
    bids: (book.bids ?? []).map((l) => ({
      price: l.price?.toString(),
      size: l.qty,
    })),
    asks: (book.asks ?? []).map((l) => ({
      price: l.price?.toString(),
      size: l.qty,
    })),
  };
}

function candleToInvariantFormat(candle: Candle): {
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  volume?: string;
} {
  return {
    open: candle.open?.toString(),
    high: candle.high?.toString(),
    low: candle.low?.toString(),
    close: candle.close?.toString(),
    volume: candle.volume?.toString(),
  };
}
