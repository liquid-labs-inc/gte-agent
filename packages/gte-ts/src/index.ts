export const VERSION = "0.0.1";

// Constants
export { CROSS_MARGIN_SUBACCOUNT_ID } from "./constants";
export type { GteEnvKey } from "./constants";

// Clients
export { GteDataClient, createGteDataClient } from "./client/data-client";
export { GteOrderClient, createGteOrderClient } from "./client/order-client";
export * from "./http";

// Errors
export { GteError, GteApiError } from "./errors";

// Signer types and adapters
export type { GteSigner } from "./internal/types/signer";
export { fromPrivateKey, fromPrivateKeyAccount } from "./internal/signers";

// Types
export type {
  GteDataClientOptions,
  GteOrderClientOptions,
  GteDataClientInterface,
  GteOrderClientInterface,
  MarketsInterface,
  AccountsReadInterface,
  AccountsWriteInterface,
  OrdersInterface,
  PortfolioInterface,
} from "./internal/types/client";

// Param types
export type {
  GetAccountMetricsParams,
  GetMarketsParams,
  SearchMarketsParams,
  GetMarketParams,
  GetMarketDataParams,
  GetOrderBookParams,
  GetCandlesParams,
  GetTradesParams,
  GetPositionsParams,
  GetOpenOrdersParams,
  GetOrdersParams,
  GetFundingHistoryParams,
  GetLeverageParams,
  SetLeverageParams,
  GetNextSubaccountParams,
  GetAllowanceParams,
  CreateOrdersParams,
  CancelOrdersParams,
  ReplaceOrderParams,
  ReplaceOrdersParams,
  GetBalancesParams,
  GetBalanceHistoryParams,
  GetPnlHistoryParams,
  TpslType,
  NewOrderParams,
  PerpOpenOrder,
  GetOpenOrdersResponse,
  CreateTwapOrderParams,
  CancelTwapOrderParams,
  TwapOrderResult,
  TwapCancelResult,
  TwapHistoryEntry,
  GetTwapHistoryParams,
  GetTradeHistoryParams,
  GetTradeHistoryResponse,
  TradeSide,
  UserTrade,
} from "./internal/types/params";

export type { Cursor, EvmAddress, SubaccountId } from "./internal/types/common";

// Response types (re-export from generated)
export type {
  BalanceSnapshot,
  Candle,
  FeeTier,
  FundingPayment,
  GetAccountMetricsResponse,
  GetAllowanceResponse,
  GetBalanceHistoryResponse,
  GetBalancesResponse,
  GetFeesResponse,
  GetFundingHistoryResponse,
  GetHealthResponse,
  GetLeverageResponse,
  GetMarketCandlesResponse,
  GetMarketContextHistoryResponse,
  GetMarketDataResponse,
  GetMarketResponse,
  GetMarketsResponse,
  GetNextSubaccountResponse,
  GetOrderBookResponse,
  GetOrdersResponse,
  GetPnlHistoryResponse,
  GetPositionsResponse,
  GetTradesResponse,
  HttpBook,
  HttpBookLevel,
  HttpCancelOrderRequest,
  HttpNewOrderRequest,
  HttpReplaceOrderRequest,
  Market,
  MarketConfigPerps,
  MarketDataPerps,
  OrderResult,
  PerpOrder,
  PerpPosition,
  PnlSnapshot,
  SearchMarketsResponse,
  ServerHealthStatus,
  SetLeverageBody,
  SetLeverageResponse,
  Side,
  TradeDirection,
  PositionSide,
  OrderRejectReason,
  OrderStatus,
  OrderType,
  TimeInForce,
  CandleInterval,
  Token,
  TokenBalance,
  TokenType,
  MarketType,
  MarketSortBy,
  Tpsl,
  TwapStatus,
  CancelOrdersRequest,
  CancelTwapRequest,
  CancelTwapResponse,
  CreateOrdersRequest,
  CreateTwapRequest,
  CreateTwapResponse,
  ReplaceOrdersRequest,
  Trade,
  VolumeEntry,
} from "./internal/generated/types.gen";
export type {
  GetMarketCandlesResponse as GetCandlesResponse,
  SetLeverageBody as SetLeverageRequest,
} from "./internal/generated/types.gen";

// WebSocket types (proto-derived schema)
export {
  WsTopic,
  WsMethod,
  WsErrorCode,
  WS_ERROR_CODES,
  topicToWire,
  wireToTopic,
  methodToWire,
  wireToMethod,
} from "./internal/types/ws";

export type {
  StreamTopic,
  StreamMethod,
  StreamError,
  StreamBookParams,
  StreamCandlesParams,
  StreamMarketDataParams,
  StreamMarkPriceParams,
  StreamTradesParams,
  StreamOpenOrdersParams,
  StreamPositionsParams,
  StreamUserFundingParams,
  StreamOrdersParams,
  StreamOrderHistoryParams,
  StreamTwapHistoryParams,
  StreamLeverageChangesParams,
  StreamTrade,
  LeverageChange,
  StreamAccountMetricsParams,
  AccountMetricsUpdate,
  OrderUpdateStatus,
  OrderUpdate,
  StreamOptions,
  Unsubscribe,
  StreamsInterface,
  WsBookParams,
  WsCandlesParams,
  WsTradesParams,
  WsOpenOrdersParams,
  WsOrdersParams,
  WsOrderHistoryParams,
  WsPositionsParams,
  WsMarketDataParams,
  WsUserFundingParams,
  WsMarkPriceParams,
  WsLeverageChangesParams,
  WsAccountMetricsParams,
  WsError,
} from "./internal/types/ws";

export {
  calculateMaxSize,
  calculateInitialMargin,
  calculateLiquidationPrice,
} from "./utils/margin";
export { isFlatPerpPosition } from "./utils/positions";

export { calculateRsi } from "./utils/charting";

export {
  parseCandleInterval,
  getCandleIntervalMs,
  CANDLE_INTERVAL_LABELS,
} from "./utils/candle-interval";
