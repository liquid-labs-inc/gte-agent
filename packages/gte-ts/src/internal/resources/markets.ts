import { GteError } from "../../errors";
import type { Client } from "../generated/client";
import {
  getMarketCandles as _getCandles,
  getMarket as _getMarket,
  getMarketContextHistory as _getMarketContextHistory,
  getMarketData as _getMarketData,
  getMarkets as _getMarkets,
  getOrderBook as _getOrderBook,
  getMarketTrades as _getTrades,
  searchMarkets as _searchMarkets,
} from "../generated/sdk.gen";
import type {
  Candle,
  GetMarketContextHistoryResponse,
  GetMarketsResponse,
  GetTradesResponse,
  HttpBook,
  Market,
  MarketDataPerps,
  SearchMarketsResponse,
} from "../generated/types.gen";
import type {
  GetCandlesParams,
  GetMarketContextHistoryParams,
  GetMarketDataParams,
  GetMarketParams,
  GetMarketsParams,
  GetOrderBookParams,
  GetTradesParams,
  MarketsInterface,
  QuoteResult,
  SearchMarketsParams,
  TradeSide,
} from "../types";
import { unwrapHttpResult } from "../utils";

export class Markets implements MarketsInterface {
  constructor(private gteClient: Client | null) {}

  private get gte(): Client {
    if (!this.gteClient) throw new Error("GTE client not initialized");
    return this.gteClient;
  }

  async quoteOrderByBaseSize(
    symbol: string,
    side: TradeSide,
    baseSize: number,
  ): Promise<QuoteResult> {
    const book = await this.getOrderBook({ symbol });
    const result = quoteOrderByBaseSize(book, side, baseSize);
    if (!result) {
      throw new GteError(
        `Insufficient liquidity to quote order for symbol: ${symbol}`,
        "INSUFFICIENT_LIQUIDITY",
      );
    }
    return result;
  }

  async quoteOrderByQuoteSize(
    symbol: string,
    side: TradeSide,
    quoteSize: number,
  ): Promise<QuoteResult> {
    const book = await this.getOrderBook({ symbol });
    const result = quoteOrderByQuoteSize(book, side, quoteSize);
    if (!result) {
      throw new GteError(
        `Insufficient liquidity to quote order for symbol: ${symbol}`,
        "INSUFFICIENT_LIQUIDITY",
      );
    }
    return result;
  }

  async list(params?: GetMarketsParams): Promise<GetMarketsResponse> {
    const { tokenType, ...apiParams } = params ?? {};
    const result = await unwrapHttpResult(_getMarkets({ query: apiParams, client: this.gte }));

    if (tokenType) {
      return {
        ...result,
        markets: result.markets.filter((market) => market.baseToken?.tokenType === tokenType),
      };
    }

    return result;
  }

  async search(params?: SearchMarketsParams): Promise<SearchMarketsResponse> {
    const { tokenType, ...apiParams } = params ?? {};
    const result = await unwrapHttpResult(_searchMarkets({ query: apiParams, client: this.gte }));

    if (tokenType) {
      return result.filter((market) => market.baseToken?.tokenType === tokenType);
    }

    return result;
  }

  async get(params: GetMarketParams): Promise<Market> {
    return unwrapHttpResult(
      _getMarket({ path: { marketSymbol: params.symbol }, client: this.gte }),
    );
  }

  async getData(params: GetMarketDataParams): Promise<MarketDataPerps> {
    return unwrapHttpResult(
      _getMarketData({
        path: { marketSymbol: params.symbol },
        client: this.gte,
      }),
    );
  }

  async getContextHistory(
    params: GetMarketContextHistoryParams,
  ): Promise<GetMarketContextHistoryResponse> {
    const { symbol, ...query } = params;
    return unwrapHttpResult(
      _getMarketContextHistory({
        path: { marketSymbol: symbol },
        query: Object.keys(query).length > 0 ? query : undefined,
        client: this.gte,
      }),
    );
  }

  async getOrderBook(params: GetOrderBookParams): Promise<HttpBook> {
    return unwrapHttpResult(
      _getOrderBook({
        path: { marketSymbol: params.symbol },
        query: params.limit ? { limit: params.limit } : undefined,
        client: this.gte,
      }),
    );
  }

  async getCandles(params: GetCandlesParams): Promise<Candle[]> {
    const { symbol, from, to, ...rest } = params;
    const result = await unwrapHttpResult(
      _getCandles({
        path: { marketSymbol: symbol },
        query: {
          ...rest,
          from: String(from * 1000),
          ...(to !== undefined && { to: String(to * 1000) }),
        },
        client: this.gte,
      }),
    );
    return result;
  }

  async getTrades(params: GetTradesParams): Promise<GetTradesResponse> {
    const { symbol, ...query } = params;
    return unwrapHttpResult(
      _getTrades({
        path: { marketSymbol: symbol },
        query: Object.keys(query).length > 0 ? query : undefined,
        client: this.gte,
      }),
    );
  }
}

function quoteOrderByBaseSize(
  book: HttpBook,
  side: TradeSide,
  baseSize: number,
): QuoteResult | null {
  if (baseSize <= 0) return null;
  return consumeBook(book, side, baseSize, "base");
}

function quoteOrderByQuoteSize(
  book: HttpBook,
  side: TradeSide,
  quoteSize: number,
): QuoteResult | null {
  if (quoteSize <= 0) return null;
  return consumeBook(book, side, quoteSize, "quote");
}

function consumeBook(
  book: HttpBook,
  side: TradeSide,
  target: number,
  targetType: "base" | "quote",
): QuoteResult | null {
  const levels = side === "buy" ? book.asks : book.bids;
  let remaining = target;
  let size = 0;
  let notional = 0;

  for (const level of levels) {
    const price = level.price;
    const availableSize = Number.parseFloat(level.qty);
    if (!(price > 0) || !(availableSize > 0)) continue;

    const levelSize =
      targetType === "base"
        ? Math.min(remaining, availableSize)
        : Math.min(remaining / price, availableSize);
    const levelNotional = levelSize * price;

    size += levelSize;
    notional += levelNotional;
    remaining -= targetType === "base" ? levelSize : levelNotional;

    if (remaining <= 0) {
      return {
        size,
        notional,
        averagePrice: notional / size,
      };
    }
  }

  return null;
}
