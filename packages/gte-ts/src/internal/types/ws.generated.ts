// AUTO-GENERATED from ws.proto + common.proto via buf - DO NOT EDIT
// Run 'just generate' to regenerate this file

// Common enums (from common.proto, used by ws message fields)
export enum Side {
  UNSPECIFIED = 0,
  BUY = 1,
  SELL = 2,
}

export enum OrderType {
  UNSPECIFIED = 0,
  MARKET = 1,
  LIMIT = 2,
  STOP_LIMIT = 3,
  STOP_MARKET = 4,
  LIQUIDATION = 5,
}

export enum Tpsl {
  UNSPECIFIED = 0,
  TP = 1,
  SL = 2,
}

export enum OrderStatus {
  UNSPECIFIED = 0,
  NEW = 1,
  PARTIALLY_FILLED = 2,
  FILLED = 3,
  CANCELLED = 4,
  REJECTED = 5,
  EXPIRED = 6,
  REPLACED = 7,
  PENDING_NEW = 8,
}

export enum PositionDirection {
  UNSPECIFIED = 0,
  OPEN_LONG = 1,
  OPEN_SHORT = 2,
  LONG_TO_SHORT = 3,
  SHORT_TO_LONG = 4,
  CLOSE_LONG = 5,
  CLOSE_SHORT = 6,
}

export enum PositionSide {
  FLAT = 0,
  LONG = 1,
  SHORT = 2,
}

export enum CandleInterval {
  UNSPECIFIED = 0,
  CANDLE_INTERVAL_1M = 1,
  CANDLE_INTERVAL_2M = 2,
  CANDLE_INTERVAL_3M = 3,
  CANDLE_INTERVAL_5M = 4,
  CANDLE_INTERVAL_10M = 5,
  CANDLE_INTERVAL_15M = 6,
  CANDLE_INTERVAL_20M = 7,
  CANDLE_INTERVAL_30M = 8,
  CANDLE_INTERVAL_1H = 9,
  CANDLE_INTERVAL_4H = 10,
  CANDLE_INTERVAL_1D = 11,
  CANDLE_INTERVAL_1W = 12,
}

export enum WsTopic {
  UNSPECIFIED = 0,
  BOOK = 1,
  CANDLES = 2,
  TRADES = 3,
  OPEN_ORDERS = 4,
  ORDERS = 5,
  POSITIONS = 6,
  MARKET_DATA = 7,
  USER_FUNDING = 8,
  MARK_PRICE = 9,
  LIQUIDATIONS = 10,
  BALANCES = 11,
  BENCH_METRICS = 14,
  LEVERAGE_CHANGES = 16,
  ORDER_HISTORY = 17,
  ACCOUNT_METRICS = 18,
}

export enum WsMethod {
  UNSPECIFIED = 0,
  SUBSCRIBE = 1,
  UNSUBSCRIBE = 2,
}

export enum WsErrorCode {
  UNSPECIFIED = 0,
  INVALID_REQUEST = 4000,
  INVALID_METHOD = 4001,
  INVALID_TOPIC = 4002,
  INVALID_PARAMS = 4003,
  INTERNAL_ERROR = 5000,
}

export interface WsBookParams {
  symbol: string;
  limit?: number;
}

export interface WsCandlesParams {
  symbol: string;
  interval: CandleInterval;
}

export interface WsTradesParams {
  symbol?: string;
  userAddress?: string;
  unsampled?: boolean;
}

export interface WsOpenOrdersParams {
  symbol?: string;
  userAddress?: string;
}

export interface WsOrdersParams {
  userAddress?: string;
  symbol?: string;
  userAddresses: string[];
}

export interface WsOrderHistoryParams {
  userAddress: string;
  symbol?: string;
}

export interface WsPositionsParams {
  symbol?: string;
  userAddress?: string;
}

export interface WsMarketDataParams {
  symbol: string;
}

export interface WsUserFundingParams {
  userAddress: string;
  symbol?: string;
}

export interface WsMarkPriceParams {
  symbol: string;
}

export interface WsBalancesParams {
  userAddress: string;
}

export interface WsBenchMetricsParams {
  intervalMs?: number;
}

export type WsLeverageChangesParams = Record<string, never>;

export interface WsAccountMetricsParams {
  userAddress: string;
}

export interface WsTradeEvent {
  tradeId: string;
  marketId: string;
  makerAccountId: string;
  takerAccountId: string;
  takerSide: Side;
  price: string;
  quantity: string;
  blockHeight: bigint;
  timestampUs: bigint;
  makerOrderId?: string;
  takerOrderId?: string;
  isLiquidation: boolean;
  liquidatorAccountId?: string;
  liquidateeAccountId?: string;
  makerDirection: PositionDirection;
  takerDirection: PositionDirection;
  makerRpnl: string;
  takerRpnl: string;
  makerLeverage: bigint;
  takerLeverage: bigint;
}

export interface WsLiquidationEvent {
  tradeId: string;
  marketId: string;
  symbol: string;
  liquidatorAccountId: string;
  liquidateeAccountId: string;
  price: string;
  quantity: string;
  side: Side;
  timestampUs: bigint;
}

export interface WsOrderEvent {
  orderId: string;
  accountId: string;
  marketId: string;
  side: Side;
  status: OrderStatus;
  filledQty: string;
  leavesQty: string;
  price: string;
  blockHeight: bigint;
  timestampUs: bigint;
  clientOrderId?: string;
  error?: string;
  confirmedHeight: bigint;
  avgPrice: string;
  orderType: OrderType;
  triggerPrice?: string;
  tpsl?: Tpsl;
  isReduceOnly: boolean;
  leverage: bigint;
}

export interface WsCandleEvent {
  marketId: string;
  interval: CandleInterval;
  openTimeUs: bigint;
  closeTimeUs: bigint;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  numTrades: number;
  isClosed: boolean;
  timestampUs: bigint;
}

export interface WsBookDelta {
  side: Side;
  price: string;
  qty: string;
}

export interface WsBookLevel {
  price: string;
  qty: string;
  numOrders?: number;
}

export interface WsBookEvent {
  marketId: string;
  deltas: WsBookDelta[];
  timestampUs: bigint;
  asks: WsBookLevel[];
  bids: WsBookLevel[];
}

export interface WsMarketDataEvent {
  marketId: string;
  markPrice: string;
  indexPrice: string;
  openInterest: string;
  fundingRate: string;
  timestampUs: bigint;
  lastFundingTimeUs: bigint;
  fundingIntervalUs: bigint;
  midPrice?: string;
  prevDayPrice?: string;
  volume24H?: string;
}

export interface WsBalanceEvent {
  userAddress: string;
  perps: WsTokenBalance[];
  spot: WsTokenBalance[];
  timestampUs: bigint;
}

export interface WsTokenBalance {
  tokenSymbol: string;
  tokenAddress: string;
  totalBalance: string;
  balanceUsd: string;
  freeCollateral: string;
  tradingAllowance: string;
}

export interface WsPositionEvent {
  accountId: string;
  subaccountId: number;
  marketId: string;
  symbol: string;
  side: PositionSide;
  size: string;
  positionValue: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string;
  margin: string;
  unrealizedPnl: string;
  funding: string;
  timestampUs: bigint;
  leverage: string;
  isOptimistic: boolean;
}

export interface WsLeverageChangeEvent {
  accountId: string;
  subaccountId: number;
  symbol: string;
  leverage: bigint;
  timestampUs: bigint;
}

export interface WsAccountMetricsEvent {
  userAddress: string;
  accountValue: string;
  unrealizedPnl: string;
  maintenanceMargin: string;
  crossMarginRatio: number;
  totalMarginUsed: string;
  totalNotional: string;
  timestampUs: bigint;
  freeCollateral: string;
  tradingAllowance: string;
}

export interface WsError {
  code: number;
  message: string;
}

export type StreamTopic =
  | "book"
  | "candles"
  | "trades"
  | "open_orders"
  | "orders"
  | "positions"
  | "market_data"
  | "user_funding"
  | "mark_price"
  | "liquidations"
  | "balances"
  | "bench_metrics"
  | "leverage_changes"
  | "order_history"
  | "account_metrics";

export const TOPIC_TO_WIRE: Record<Exclude<WsTopic, WsTopic.UNSPECIFIED>, StreamTopic> = {
  [WsTopic.BOOK]: "book",
  [WsTopic.CANDLES]: "candles",
  [WsTopic.TRADES]: "trades",
  [WsTopic.OPEN_ORDERS]: "open_orders",
  [WsTopic.ORDERS]: "orders",
  [WsTopic.POSITIONS]: "positions",
  [WsTopic.MARKET_DATA]: "market_data",
  [WsTopic.USER_FUNDING]: "user_funding",
  [WsTopic.MARK_PRICE]: "mark_price",
  [WsTopic.LIQUIDATIONS]: "liquidations",
  [WsTopic.BALANCES]: "balances",
  [WsTopic.BENCH_METRICS]: "bench_metrics",
  [WsTopic.LEVERAGE_CHANGES]: "leverage_changes",
  [WsTopic.ORDER_HISTORY]: "order_history",
  [WsTopic.ACCOUNT_METRICS]: "account_metrics",
};

export const WIRE_TO_TOPIC: Record<StreamTopic, WsTopic> = {
  book: WsTopic.BOOK,
  candles: WsTopic.CANDLES,
  trades: WsTopic.TRADES,
  open_orders: WsTopic.OPEN_ORDERS,
  orders: WsTopic.ORDERS,
  positions: WsTopic.POSITIONS,
  market_data: WsTopic.MARKET_DATA,
  user_funding: WsTopic.USER_FUNDING,
  mark_price: WsTopic.MARK_PRICE,
  liquidations: WsTopic.LIQUIDATIONS,
  balances: WsTopic.BALANCES,
  bench_metrics: WsTopic.BENCH_METRICS,
  leverage_changes: WsTopic.LEVERAGE_CHANGES,
  order_history: WsTopic.ORDER_HISTORY,
  account_metrics: WsTopic.ACCOUNT_METRICS,
};

export type StreamMethod = "subscribe" | "unsubscribe";

export const METHOD_TO_WIRE: Record<Exclude<WsMethod, WsMethod.UNSPECIFIED>, StreamMethod> = {
  [WsMethod.SUBSCRIBE]: "subscribe",
  [WsMethod.UNSUBSCRIBE]: "unsubscribe",
};

export const WIRE_TO_METHOD: Record<StreamMethod, WsMethod> = {
  subscribe: WsMethod.SUBSCRIBE,
  unsubscribe: WsMethod.UNSUBSCRIBE,
};
