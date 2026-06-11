import type {
  Candle,
  CandleInterval,
  FundingPayment,
  GetBalancesResponse,
  HttpBook,
  MarketDataPerps,
  PerpOrder,
  PerpPosition,
  Trade,
  TradeDirection,
} from "../generated/types.gen";
import type { PerpOpenOrder, TwapHistoryEntry } from "./params";
import type { WsLiquidationEvent } from "./ws.generated";

export {
  WsTopic,
  WsMethod,
  WsErrorCode,
  Side,
  OrderStatus,
  PositionSide,
} from "./ws.generated";

export type {
  WsBookParams,
  WsCandlesParams,
  WsTradesParams,
  WsOpenOrdersParams,
  WsOrderHistoryParams,
  WsOrdersParams,
  WsPositionsParams,
  WsMarketDataParams,
  WsUserFundingParams,
  WsMarkPriceParams,
  WsLeverageChangesParams,
  WsAccountMetricsParams,
  WsError,
  WsTradeEvent,
  WsLiquidationEvent,
  WsOrderEvent,
  WsCandleEvent,
  WsBookDelta,
  WsBookLevel,
  WsBookEvent,
  WsMarketDataEvent,
  WsLeverageChangeEvent,
  WsAccountMetricsEvent,
} from "./ws.generated";

export {
  TOPIC_TO_WIRE,
  WIRE_TO_TOPIC,
  METHOD_TO_WIRE,
  WIRE_TO_METHOD,
} from "./ws.generated";

import {
  type StreamMethod as GeneratedStreamMethod,
  type StreamTopic as GeneratedStreamTopic,
  METHOD_TO_WIRE,
  TOPIC_TO_WIRE,
  WIRE_TO_METHOD,
  WIRE_TO_TOPIC,
  WsErrorCode,
  WsMethod,
  WsTopic,
} from "./ws.generated";

export type StreamTopic = GeneratedStreamTopic | "twap_history";
export type StreamMethod = GeneratedStreamMethod;

export type StreamError = {
  code: number;
  message: string;
};

export function topicToWire(topic: WsTopic): StreamTopic {
  if (topic === WsTopic.UNSPECIFIED) {
    throw new Error("Cannot convert UNSPECIFIED topic to wire format");
  }
  return TOPIC_TO_WIRE[topic];
}

export function wireToTopic(wire: StreamTopic): WsTopic {
  if (wire === "twap_history") {
    throw new Error("twap_history does not have a generated WsTopic");
  }
  return WIRE_TO_TOPIC[wire];
}

export function methodToWire(method: WsMethod): StreamMethod {
  if (method === WsMethod.UNSPECIFIED) {
    throw new Error("Cannot convert UNSPECIFIED method to wire format");
  }
  return METHOD_TO_WIRE[method];
}

export function wireToMethod(wire: StreamMethod): WsMethod {
  return WIRE_TO_METHOD[wire];
}

export type StreamRequest = {
  id: number;
  method: StreamMethod;
  topic: StreamTopic;
  params: Record<string, unknown>;
};

export type StreamSuccessResponse<T> = { id: number; d: T };
export type StreamErrorResponse = { id: number; error: StreamError };
export type StreamResponse<T> = StreamSuccessResponse<T> | StreamErrorResponse;

export const WS_ERROR_CODES = {
  INVALID_REQUEST: WsErrorCode.INVALID_REQUEST,
  INVALID_METHOD: WsErrorCode.INVALID_METHOD,
  INVALID_TOPIC: WsErrorCode.INVALID_TOPIC,
  INVALID_PARAMS: WsErrorCode.INVALID_PARAMS,
  INTERNAL_ERROR: WsErrorCode.INTERNAL_ERROR,
} as const;

export type StreamBookParams = {
  symbol: string;
  limit?: number;
};

export type StreamCandlesParams = {
  symbol: string;
  interval: CandleInterval;
};

export type StreamTradesParams = {
  symbol?: string;
  userAddress?: string;
};

export type StreamOpenOrdersParams = {
  symbol?: string;
  userAddress?: string;
};

export type StreamPositionsParams = {
  symbol?: string;
  userAddress?: string;
};

export type StreamUserFundingParams = {
  symbol?: string;
  userAddress: string;
};

export type StreamOrdersParams = {
  symbol?: string;
  userAddress?: string;
  userAddresses?: string[];
};

export type StreamOrderHistoryParams = {
  symbol?: string;
  userAddress: string;
};

export type StreamMarketDataParams = {
  symbol: string;
};

export type StreamMarkPriceParams = {
  symbol: string;
};

export type StreamBalancesParams = {
  userAddress: string;
};

export type StreamAccountMetricsParams = {
  userAddress: string;
};

export type AccountMetricsUpdate = {
  userAddress: string;
  accountValue: string;
  unrealizedPnl: string;
  maintenanceMargin: string;
  crossMarginRatio: number;
  totalMarginUsed: string;
  totalNotional: string;
  freeCollateral: string;
  tradingAllowance: string;
  timestamp: number;
};

export type StreamTwapHistoryParams = {
  userAddress: string;
};

export type BenchMetrics = {
  ordersPerSec: number;
  fillsPerSec: number;
  matchingLatencyUs: {
    p50: number;
    p99: number;
    p999: number;
    mean: number;
  };
};

export type StreamBenchMetricsParams = {
  intervalMs?: number;
};

export type StreamLiquidationsParams = {
  symbol?: string;
};

export type StreamLeverageChangesParams = {
  symbol?: string;
  userAddress?: string;
  subaccountId?: number;
};

export type LeverageChange = {
  accountId: string;
  subaccountId: number;
  marketSymbol: string;
  leverage: number;
  timestamp: string;
};

export type OrderUpdateStatus = "open" | "filled" | "canceled" | "triggered" | "rejected";

export type OrderUpdate = {
  order: PerpOrder;
  status: OrderUpdateStatus;
  statusTimestamp: number;
  error?: string;
};

export type StreamTrade = Trade & {
  makerDirection?: TradeDirection;
  takerDirection?: TradeDirection;
  makerRpnl?: string;
  takerRpnl?: string;
  makerLeverage?: number;
  takerLeverage?: number;
};

export type StreamOptions<TParams, TData> = {
  params: TParams;
  onData: (data: TData) => void;
  onError?: (error: StreamError | Error) => void;
};

export type Unsubscribe = () => void;

export interface StreamsInterface {
  book(options: StreamOptions<StreamBookParams, HttpBook>): Promise<Unsubscribe>;
  candles(options: StreamOptions<StreamCandlesParams, Candle>): Promise<Unsubscribe>;
  trades(options: StreamOptions<StreamTradesParams, StreamTrade[]>): Promise<Unsubscribe>;
  openOrders(options: StreamOptions<StreamOpenOrdersParams, PerpOpenOrder[]>): Promise<Unsubscribe>;
  positions(options: StreamOptions<StreamPositionsParams, PerpPosition[]>): Promise<Unsubscribe>;
  userFunding(
    options: StreamOptions<StreamUserFundingParams, FundingPayment[]>,
  ): Promise<Unsubscribe>;
  orders(options: StreamOptions<StreamOrdersParams, OrderUpdate[]>): Promise<Unsubscribe>;
  orderHistory(
    options: StreamOptions<StreamOrderHistoryParams, OrderUpdate[]>,
  ): Promise<Unsubscribe>;
  marketData(options: StreamOptions<StreamMarketDataParams, MarketDataPerps>): Promise<Unsubscribe>;
  balances(options: StreamOptions<StreamBalancesParams, GetBalancesResponse>): Promise<Unsubscribe>;
  twapHistory(
    options: StreamOptions<StreamTwapHistoryParams, TwapHistoryEntry[]>,
  ): Promise<Unsubscribe>;
  benchMetrics(
    options: StreamOptions<StreamBenchMetricsParams, BenchMetrics>,
  ): Promise<Unsubscribe>;
  liquidations(
    options: StreamOptions<StreamLiquidationsParams, WsLiquidationEvent[]>,
  ): Promise<Unsubscribe>;
  leverageChanges(
    options: StreamOptions<StreamLeverageChangesParams, LeverageChange>,
  ): Promise<Unsubscribe>;
  accountMetrics(
    options: StreamOptions<StreamAccountMetricsParams, AccountMetricsUpdate>,
  ): Promise<Unsubscribe>;
}
