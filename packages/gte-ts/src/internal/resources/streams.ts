import { CROSS_MARGIN_SUBACCOUNT_ID } from "../../constants";
import type {
  Candle,
  FundingPayment,
  GetBalancesResponse,
  HttpBook,
  HttpBookLevel,
  MarketDataPerps,
  PerpOrder,
  PerpPosition,
  Token,
  TradeDirection,
} from "../generated/types.gen";
import type { PerpOpenOrder, TwapHistoryEntry } from "../types/params";
import type {
  AccountMetricsUpdate,
  BenchMetrics,
  LeverageChange,
  OrderUpdate,
  OrderUpdateStatus,
  StreamAccountMetricsParams,
  StreamBalancesParams,
  StreamBenchMetricsParams,
  StreamBookParams,
  StreamCandlesParams,
  StreamLeverageChangesParams,
  StreamLiquidationsParams,
  StreamMarketDataParams,
  StreamOpenOrdersParams,
  StreamOptions,
  StreamOrderHistoryParams,
  StreamOrdersParams,
  StreamPositionsParams,
  StreamTrade,
  StreamTradesParams,
  StreamTwapHistoryParams,
  StreamUserFundingParams,
  StreamsInterface,
  Unsubscribe,
} from "../types/ws";
import type {
  WsAccountMetricsEvent,
  WsBalanceEvent,
  WsBookEvent,
  WsCandleEvent,
  WsLeverageChangeEvent,
  WsLiquidationEvent,
  WsMarketDataEvent,
  WsOrderEvent,
  WsPositionEvent,
  WsTokenBalance,
  WsTradeEvent,
} from "../types/ws.generated";
import {
  CandleInterval as WsCandleInterval,
  OrderStatus as WsOrderStatus,
  OrderType as WsOrderType,
  PositionDirection as WsPositionDirection,
  PositionSide as WsPositionSide,
  Side as WsSide,
  Tpsl as WsTpsl,
} from "../types/ws.generated";
import { microsToMillis } from "../utils";
import type { WsTransport } from "../ws/transport";

function mapWsBookEventToHttpBook(event: WsBookEvent): HttpBook {
  return {
    asks: event.asks?.map(mapWsBookLevelToHttpBookLevel) ?? [],
    bids: event.bids?.map(mapWsBookLevelToHttpBookLevel) ?? [],
    timestamp: String(event.timestampUs != null ? microsToMillis(event.timestampUs) : Date.now()),
  };
}

function mapWsBookLevelToHttpBookLevel(level: {
  price: string;
  qty: string;
  numOrders?: number;
}): HttpBookLevel {
  return {
    price: Number.parseFloat(level.price),
    qty: level.qty,
    numOrders: level.numOrders ?? 0,
  };
}

function mapWsTradeEventToTrade(event: WsTradeEvent, marketSymbol?: string): StreamTrade {
  return {
    id: event.tradeId,
    marketSymbol: marketSymbol ?? event.marketId,
    maker: event.makerAccountId,
    taker: event.takerAccountId,
    side: mapWsSideToTradeSide(event.takerSide),
    price: event.price,
    size: event.quantity,
    timestamp: String(microsToMillis(event.timestampUs)),
    makerOrderId: event.makerOrderId,
    takerOrderId: event.takerOrderId,
    isLiquidation: event.isLiquidation ?? false,
    direction: mapWsDirectionToTradeDirection(event.takerDirection),
    makerDirection: mapWsDirectionToTradeDirection(event.makerDirection),
    takerDirection: mapWsDirectionToTradeDirection(event.takerDirection),
    makerRpnl: normalizeRpnlString(event.makerRpnl),
    takerRpnl: normalizeRpnlString(event.takerRpnl),
    makerLeverage: normalizePositiveNumber(event.makerLeverage),
    takerLeverage: normalizePositiveNumber(event.takerLeverage),
  };
}

function normalizePositiveNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function normalizeRpnlString(value: string | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return value;
}

function mapWsSideToTradeSide(side: unknown): "buy" | "sell" {
  const sideText = String(side).toLowerCase();
  return side === WsSide.SELL || sideText === "sell" || sideText === "side_sell" || sideText === "2"
    ? "sell"
    : "buy";
}

function mapWsDirectionToTradeDirection(direction: unknown): TradeDirection | undefined {
  const directionText = String(direction).toLowerCase();
  switch (direction) {
    case WsPositionDirection.OPEN_LONG:
      return "open_long";
    case WsPositionDirection.OPEN_SHORT:
      return "open_short";
    case WsPositionDirection.LONG_TO_SHORT:
      return "long_to_short";
    case WsPositionDirection.SHORT_TO_LONG:
      return "short_to_long";
    case WsPositionDirection.CLOSE_LONG:
      return "close_long";
    case WsPositionDirection.CLOSE_SHORT:
      return "close_short";
  }
  if (directionText === "position_direction_open_long" || directionText === "open_long") {
    return "open_long";
  }
  if (directionText === "position_direction_open_short" || directionText === "open_short") {
    return "open_short";
  }
  if (directionText === "position_direction_long_to_short" || directionText === "long_to_short") {
    return "long_to_short";
  }
  if (directionText === "position_direction_short_to_long" || directionText === "short_to_long") {
    return "short_to_long";
  }
  if (directionText === "position_direction_close_long" || directionText === "close_long") {
    return "close_long";
  }
  if (directionText === "position_direction_close_short" || directionText === "close_short") {
    return "close_short";
  }
  return undefined;
}

function mapWsOrderEventToOrderUpdate(event: WsOrderEvent, marketSymbol?: string): OrderUpdate {
  return {
    order: mapWsOrderEventToPerpOrder(event, marketSymbol),
    status: mapWsOrderStatusToUpdateStatus(event.status),
    statusTimestamp: Number(event.timestampUs),
    error: event.error,
  };
}

function mapWsOrderEventToPerpOrder(event: WsOrderEvent, marketSymbol?: string): PerpOrder {
  const displayPrice = Number(event.avgPrice) > 0 ? event.avgPrice : event.price;
  const originalSize = String(Number(event.leavesQty) + Number(event.filledQty));
  const orderValue =
    Number(displayPrice) > 0 && Number(originalSize) > 0
      ? String(Number(displayPrice) * Number(originalSize))
      : "";
  return {
    orderId: event.orderId,
    marketSymbol: marketSymbol ?? event.marketId,
    side: mapWsSideToTradeSide(event.side),
    status: mapWsOrderStatusToOrderStatus(event.status),
    price: displayPrice,
    originalSize,
    currentSize: event.leavesQty,
    orderValue,
    clientId: event.clientOrderId,
    timestamp: String(microsToMillis(event.timestampUs)),
    orderType: mapWsOrderTypeToOrderType(event.orderType),
    triggerPrice: event.triggerPrice || undefined,
    tpsl: mapWsTpslToTpsl(event.tpsl),
    isReduceOnly: event.isReduceOnly ?? false,
    leverage: normalizePositiveNumber(event.leverage)?.toString() ?? "0",
  };
}

function mapWsOrderEventToPerpOpenOrder(event: WsOrderEvent, marketSymbol?: string): PerpOpenOrder {
  const order = mapWsOrderEventToPerpOrder(event, marketSymbol);
  return {
    marketSymbol: order.marketSymbol,
    timestamp: order.timestamp,
    currentSize: order.currentSize,
    originalSize: order.originalSize,
    isReduceOnly: order.isReduceOnly,
    side: order.side,
    orderValue: order.orderValue,
    orderId: order.orderId,
    limitPrice: order.price,
    clientId: order.clientId,
    orderType: order.orderType,
    triggerPrice: order.triggerPrice,
    tpsl: order.tpsl,
  };
}

function mapWsOrderStatusToOrderStatus(status: unknown): PerpOrder["status"] {
  const statusText = String(status).toLowerCase();
  switch (status) {
    case WsOrderStatus.NEW:
      return "new";
    case WsOrderStatus.PARTIALLY_FILLED:
      return "partially_filled";
    case WsOrderStatus.FILLED:
      return "filled";
    case WsOrderStatus.CANCELLED:
      return "cancelled";
    case WsOrderStatus.REJECTED:
      return "rejected";
    case WsOrderStatus.EXPIRED:
      return "expired";
    case WsOrderStatus.REPLACED:
      return "replaced";
    case WsOrderStatus.PENDING_NEW:
      return "pending_new";
  }
  if (statusText === "order_status_partially_filled" || statusText === "partially_filled") {
    return "partially_filled";
  }
  if (statusText === "order_status_filled" || statusText === "filled") return "filled";
  if (statusText === "order_status_cancelled" || statusText === "cancelled") return "cancelled";
  if (statusText === "order_status_rejected" || statusText === "rejected") return "rejected";
  if (statusText === "order_status_expired" || statusText === "expired") return "expired";
  if (statusText === "order_status_replaced" || statusText === "replaced") return "replaced";
  if (statusText === "order_status_pending_new" || statusText === "pending_new") {
    return "pending_new";
  }
  return "new";
}

function mapWsOrderTypeToOrderType(orderType: unknown): PerpOrder["orderType"] {
  const orderTypeText = String(orderType).toLowerCase();
  switch (orderType) {
    case WsOrderType.MARKET:
      return "market";
    case WsOrderType.LIMIT:
      return "limit";
    case WsOrderType.STOP_LIMIT:
      return "stop_limit";
    case WsOrderType.STOP_MARKET:
      return "stop_market";
    case WsOrderType.LIQUIDATION:
      return "liquidation";
  }
  if (orderTypeText === "order_type_market" || orderTypeText === "market") return "market";
  if (orderTypeText === "order_type_stop_limit" || orderTypeText === "stop_limit") {
    return "stop_limit";
  }
  if (orderTypeText === "order_type_stop_market" || orderTypeText === "stop_market") {
    return "stop_market";
  }
  if (orderTypeText === "order_type_liquidation" || orderTypeText === "liquidation") {
    return "liquidation";
  }
  return "limit";
}

function mapWsTpslToTpsl(tpsl: unknown): PerpOpenOrder["tpsl"] | undefined {
  const tpslText = String(tpsl).toLowerCase();
  switch (tpsl) {
    case WsTpsl.TP:
      return "tp";
    case WsTpsl.SL:
      return "sl";
  }
  if (tpslText === "tpsl_tp" || tpslText === "tp") return "tp";
  if (tpslText === "tpsl_sl" || tpslText === "sl") return "sl";
  return undefined;
}

function mapWsOrderStatusToUpdateStatus(status: unknown): OrderUpdateStatus {
  const mapped = mapWsOrderStatusToOrderStatus(status);
  switch (status) {
    case WsOrderStatus.FILLED:
      return "filled";
    case WsOrderStatus.CANCELLED:
    case WsOrderStatus.EXPIRED:
    case WsOrderStatus.REPLACED:
      return "canceled";
    case WsOrderStatus.REJECTED:
      return "rejected";
  }
  if (mapped === "filled") return "filled";
  if (mapped === "cancelled" || mapped === "expired" || mapped === "replaced") return "canceled";
  if (mapped === "rejected") return "rejected";
  return "open";
}

function mapWsCandleEventToCandle(event: WsCandleEvent): Candle {
  const timestampUs = event.openTimeUs ?? event.timestampUs ?? 0;
  return {
    timestamp: String(microsToMillis(timestampUs)),
    open: Number.parseFloat(String(event.open)),
    high: Number.parseFloat(String(event.high)),
    low: Number.parseFloat(String(event.low)),
    close: Number.parseFloat(String(event.close)),
    volume: Number.parseFloat(String(event.volume)),
  };
}

function mapWsPositionSideToPositionSide(side: unknown): PerpPosition["side"] {
  if (side === WsPositionSide.SHORT) return "short";
  return "long";
}

function mapWsTokenBalanceToTokenBalance(raw: WsTokenBalance) {
  return {
    token: buildTokenMetadata(raw.tokenSymbol, raw.tokenAddress),
    totalBalance: Number.parseFloat(raw.totalBalance),
    balanceUsd: Number.parseFloat(raw.balanceUsd),
    freeCollateral: Number.parseFloat(raw.freeCollateral || "0"),
    tradingAllowance: Number.parseFloat(raw.tradingAllowance || "0"),
  };
}

function buildTokenMetadata(symbol: string, tokenAddress?: string): Token {
  return {
    symbol,
    name: symbol,
    address: tokenAddress || undefined,
    decimals: 6,
    logoUrl: "",
    tokenType: symbol.toUpperCase().includes("USD") ? "stablecoin" : "crypto",
  };
}

function mapWsAccountMetricsEventToUpdate(event: WsAccountMetricsEvent): AccountMetricsUpdate {
  return {
    userAddress: event.userAddress,
    accountValue: event.accountValue,
    unrealizedPnl: event.unrealizedPnl,
    maintenanceMargin: event.maintenanceMargin,
    crossMarginRatio: event.crossMarginRatio,
    totalMarginUsed: event.totalMarginUsed,
    totalNotional: event.totalNotional,
    freeCollateral: event.freeCollateral,
    tradingAllowance: event.tradingAllowance || "0",
    timestamp: event.timestampUs != null ? microsToMillis(event.timestampUs) : Date.now(),
  };
}

function mapWsBalanceEventToResponse(event: WsBalanceEvent): GetBalancesResponse {
  return {
    perps: event.perps?.map(mapWsTokenBalanceToTokenBalance) ?? [],
    spot: event.spot?.map(mapWsTokenBalanceToTokenBalance) ?? [],
    version: 0,
  };
}

function mapWsPositionEventToPerpPosition(event: WsPositionEvent): PerpPosition {
  return {
    accountId: event.accountId,
    marketSymbol: event.symbol,
    size: event.size,
    positionValue: event.positionValue,
    side: mapWsPositionSideToPositionSide(event.side),
    entryPrice: event.entryPrice,
    markPrice: event.markPrice,
    liquidationPrice: event.liquidationPrice,
    leverage: Number(event.leverage),
    margin: event.margin,
    funding: event.funding,
    isCross: event.subaccountId === CROSS_MARGIN_SUBACCOUNT_ID,
    subaccountId: event.subaccountId,
    unrealizedPnl: event.unrealizedPnl,
    timestamp: String(microsToMillis(event.timestampUs)),
  };
}

function mapWsMarketDataEventToMarketDataPerps(event: WsMarketDataEvent): MarketDataPerps {
  return {
    markPrice: Number.parseFloat(event.markPrice),
    indexPrice: Number.parseFloat(event.indexPrice),
    openInterest: Number.parseFloat(event.openInterest),
    fundingRate: Number.parseFloat(event.fundingRate),
    midPrice: event.midPrice ? Number.parseFloat(event.midPrice) : 0,
    prevDayPrice: event.prevDayPrice ? Number.parseFloat(event.prevDayPrice) : undefined,
    volume24h: event.volume24H ? Number.parseFloat(event.volume24H) : undefined,
  };
}

function mapWsLeverageChangeEventToLeverageChange(event: WsLeverageChangeEvent): LeverageChange {
  return {
    accountId: event.accountId,
    subaccountId: event.subaccountId,
    marketSymbol: event.symbol,
    leverage: Number(event.leverage),
    timestamp: String(microsToMillis(event.timestampUs)),
  };
}

function leverageChangeMatchesParams(
  change: LeverageChange,
  params: StreamLeverageChangesParams,
): boolean {
  if (params.userAddress && change.accountId.toLowerCase() !== params.userAddress.toLowerCase()) {
    return false;
  }
  if (params.symbol && change.marketSymbol !== params.symbol) {
    return false;
  }
  if (params.subaccountId !== undefined && change.subaccountId !== params.subaccountId) {
    return false;
  }
  return true;
}

function mapCandleIntervalToWs(interval: StreamCandlesParams["interval"]): WsCandleInterval {
  switch (interval) {
    case "1m":
      return WsCandleInterval.CANDLE_INTERVAL_1M;
    case "2m":
      return WsCandleInterval.CANDLE_INTERVAL_2M;
    case "3m":
      return WsCandleInterval.CANDLE_INTERVAL_3M;
    case "5m":
      return WsCandleInterval.CANDLE_INTERVAL_5M;
    case "10m":
      return WsCandleInterval.CANDLE_INTERVAL_10M;
    case "15m":
      return WsCandleInterval.CANDLE_INTERVAL_15M;
    case "20m":
      return WsCandleInterval.CANDLE_INTERVAL_20M;
    case "30m":
      return WsCandleInterval.CANDLE_INTERVAL_30M;
    case "1h":
      return WsCandleInterval.CANDLE_INTERVAL_1H;
    case "4h":
      return WsCandleInterval.CANDLE_INTERVAL_4H;
    case "1d":
      return WsCandleInterval.CANDLE_INTERVAL_1D;
    case "1w":
      return WsCandleInterval.CANDLE_INTERVAL_1W;
  }
}

export class Streams implements StreamsInterface {
  constructor(private gteTransport: WsTransport | null) {}

  private get gte(): WsTransport {
    if (!this.gteTransport) throw new Error("GTE transport not initialized");
    return this.gteTransport;
  }

  async book(options: StreamOptions<StreamBookParams, HttpBook>): Promise<Unsubscribe> {
    return this.gte.subscribe<WsBookEvent>(
      "book",
      { symbol: options.params.symbol, limit: options.params.limit ?? 10 },
      (wsEvent) => {
        options.onData(mapWsBookEventToHttpBook(wsEvent));
      },
      options.onError,
    );
  }

  async candles(options: StreamOptions<StreamCandlesParams, Candle>): Promise<Unsubscribe> {
    return this.gte.subscribe<WsCandleEvent | WsCandleEvent[]>(
      "candles",
      {
        symbol: options.params.symbol,
        interval: mapCandleIntervalToWs(options.params.interval),
      },
      (data) => {
        if (Array.isArray(data)) {
          for (const item of data) options.onData(mapWsCandleEventToCandle(item));
        } else {
          options.onData(mapWsCandleEventToCandle(data));
        }
      },
      options.onError,
    );
  }

  async trades(options: StreamOptions<StreamTradesParams, StreamTrade[]>): Promise<Unsubscribe> {
    return this.gte.subscribe<WsTradeEvent[]>(
      "trades",
      {
        symbol: options.params.symbol,
        userAddress: options.params.userAddress,
      },
      (wsEvents) => {
        options.onData(
          wsEvents.map((event) => mapWsTradeEventToTrade(event, options.params.symbol)),
        );
      },
      options.onError,
    );
  }

  async openOrders(
    options: StreamOptions<StreamOpenOrdersParams, PerpOpenOrder[]>,
  ): Promise<Unsubscribe> {
    return this.gte.subscribe<WsOrderEvent>(
      "open_orders",
      {
        symbol: options.params.symbol,
        userAddress: options.params.userAddress,
      },
      (wsEvent) => {
        if (mapWsOrderStatusToUpdateStatus(wsEvent.status) !== "open") return;
        options.onData([mapWsOrderEventToPerpOpenOrder(wsEvent, options.params.symbol)]);
      },
      options.onError,
    );
  }

  async positions(
    options: StreamOptions<StreamPositionsParams, PerpPosition[]>,
  ): Promise<Unsubscribe> {
    let pendingPositions: PerpPosition[] = [];
    let flushScheduled = false;

    return this.gte.subscribe<WsPositionEvent>(
      "positions",
      {
        symbol: options.params.symbol,
        userAddress: options.params.userAddress,
      },
      (wsEvent) => {
        pendingPositions.push(mapWsPositionEventToPerpPosition(wsEvent));
        if (!flushScheduled) {
          flushScheduled = true;
          queueMicrotask(() => {
            const batch = pendingPositions;
            pendingPositions = [];
            flushScheduled = false;
            options.onData(batch);
          });
        }
      },
      options.onError,
    );
  }

  async userFunding(
    options: StreamOptions<StreamUserFundingParams, FundingPayment[]>,
  ): Promise<Unsubscribe> {
    return this.gte.subscribe<FundingPayment[]>(
      "user_funding",
      {
        symbol: options.params.symbol,
        userAddress: options.params.userAddress,
      },
      options.onData,
      options.onError,
    );
  }

  async orders(options: StreamOptions<StreamOrdersParams, OrderUpdate[]>): Promise<Unsubscribe> {
    const userAddresses = options.params.userAddresses?.filter(Boolean) ?? [];
    if (!options.params.userAddress && userAddresses.length === 0) {
      throw new Error("userAddress or userAddresses is required for order updates");
    }

    return this.gte.subscribe<WsOrderEvent>(
      "orders",
      {
        symbol: options.params.symbol,
        ...(options.params.userAddress ? { userAddress: options.params.userAddress } : {}),
        ...(userAddresses.length > 0 ? { userAddresses } : {}),
      },
      (wsEvent) => {
        options.onData([mapWsOrderEventToOrderUpdate(wsEvent, options.params.symbol)]);
      },
      options.onError,
    );
  }

  async orderHistory(
    options: StreamOptions<StreamOrderHistoryParams, OrderUpdate[]>,
  ): Promise<Unsubscribe> {
    return this.gte.subscribe<WsOrderEvent>(
      "order_history",
      {
        symbol: options.params.symbol,
        userAddress: options.params.userAddress,
      },
      (wsEvent) => {
        options.onData([mapWsOrderEventToOrderUpdate(wsEvent, options.params.symbol)]);
      },
      options.onError,
    );
  }

  async marketData(
    options: StreamOptions<StreamMarketDataParams, MarketDataPerps>,
  ): Promise<Unsubscribe> {
    return this.gte.subscribe<WsMarketDataEvent>(
      "market_data",
      { symbol: options.params.symbol },
      (wsEvent) => {
        options.onData(mapWsMarketDataEventToMarketDataPerps(wsEvent));
      },
      options.onError,
    );
  }

  async balances(
    options: StreamOptions<StreamBalancesParams, GetBalancesResponse>,
  ): Promise<Unsubscribe> {
    return this.gte.subscribe<WsBalanceEvent>(
      "balances",
      { userAddress: options.params.userAddress },
      (wsEvent) => {
        options.onData(mapWsBalanceEventToResponse(wsEvent));
      },
      options.onError,
    );
  }

  async twapHistory(
    options: StreamOptions<StreamTwapHistoryParams, TwapHistoryEntry[]>,
  ): Promise<Unsubscribe> {
    return this.gte.subscribe<TwapHistoryEntry[]>(
      "twap_history",
      { userAddress: options.params.userAddress },
      options.onData,
      options.onError,
    );
  }

  async benchMetrics(
    options: StreamOptions<StreamBenchMetricsParams, BenchMetrics>,
  ): Promise<Unsubscribe> {
    return this.gte.subscribe<BenchMetrics>(
      "bench_metrics",
      {
        intervalMs: options.params.intervalMs,
      },
      options.onData,
      options.onError,
    );
  }

  async liquidations(
    options: StreamOptions<StreamLiquidationsParams, WsLiquidationEvent[]>,
  ): Promise<Unsubscribe> {
    return this.gte.subscribe<WsLiquidationEvent[]>(
      "liquidations",
      {
        symbol: options.params.symbol,
      },
      options.onData,
      options.onError,
    );
  }

  async leverageChanges(
    options: StreamOptions<StreamLeverageChangesParams, LeverageChange>,
  ): Promise<Unsubscribe> {
    return this.gte.subscribe<WsLeverageChangeEvent | WsLeverageChangeEvent[]>(
      "leverage_changes",
      {},
      (payload) => {
        const events = Array.isArray(payload) ? payload : [payload];
        for (const event of events) {
          const change = mapWsLeverageChangeEventToLeverageChange(event);
          if (leverageChangeMatchesParams(change, options.params)) {
            options.onData(change);
          }
        }
      },
      options.onError,
    );
  }

  async accountMetrics(
    options: StreamOptions<StreamAccountMetricsParams, AccountMetricsUpdate>,
  ): Promise<Unsubscribe> {
    return this.gte.subscribe<WsAccountMetricsEvent>(
      "account_metrics",
      { userAddress: options.params.userAddress },
      (wsEvent) => {
        options.onData(mapWsAccountMetricsEventToUpdate(wsEvent));
      },
      options.onError,
    );
  }
}
