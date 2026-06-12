import type {
  GetOpenOrdersResponse as BaseGetOpenOrdersResponse,
  PerpOpenOrder as BasePerpOpenOrder,
  CancelTwapRequest,
  CreateTwapRequest,
  GetMarketCandlesData,
  GetMarketContextHistoryData,
  GetMarketsData,
  GetTwapHistoryData,
  GetUserTradesResponse,
  HttpCancelOrderRequest,
  HttpNewOrderRequest,
  HttpReplaceOrderRequest,
  MarketSortBy,
  MarketType,
  Side,
  TokenType,
  TradeDirection,
  TwapHistoryEntry,
  UserTrade,
} from "../generated/types.gen";
import type { SignedRequestOptions } from "../signing/request";
import type { Cursor, EvmAddress, SubaccountId } from "./common";

type GatewayMarketCandlesQuery = NonNullable<GetMarketCandlesData["query"]>;
type GatewayMarketContextHistoryQuery = NonNullable<GetMarketContextHistoryData["query"]>;
type GatewayMarketsQuery = NonNullable<GetMarketsData["query"]>;
type GatewayTwapHistoryQuery = NonNullable<GetTwapHistoryData["query"]>;
type UnsignedAccountRequest<T extends { account: string }> = Omit<
  T,
  "account" | "nonce" | "signature"
> & {
  account?: string;
};

export type TradeSide = Side;
export type { TradeDirection, MarketSortBy, MarketType, TokenType, TwapHistoryEntry, UserTrade };
export type { SignedRequestOptions };
export type PerpOpenOrder = BasePerpOpenOrder;
export type GetOpenOrdersResponse = BaseGetOpenOrdersResponse;

export type GetMarketsParams = Omit<GatewayMarketsQuery, "marketType" | "sortBy"> & {
  marketType?: MarketType;
  sortBy?: MarketSortBy;
  tokenType?: TokenType;
};

export type SearchMarketsParams = {
  query?: string;
  marketType?: MarketType;
  tokenType?: TokenType;
};

export type GetMarketParams = {
  symbol: string;
};

export type GetMarketDataParams = {
  symbol: string;
};

export type GetMarketContextHistoryParams = {
  symbol: string;
} & GatewayMarketContextHistoryQuery;

export type GetOrderBookParams = {
  symbol: string;
  limit?: number;
};

export type GetCandlesParams = {
  symbol: string;
  from: number;
  to?: number;
  interval: NonNullable<GatewayMarketCandlesQuery["interval"]>;
  limit?: number;
};

export type GetTradesParams = {
  symbol: string;
  user?: string;
  cursor?: Cursor;
  limit?: number;
  offset?: number;
};

export type GetPositionsParams = {
  userAddress: EvmAddress;
  symbol?: string;
  subaccountId?: SubaccountId;
  cursor?: Cursor;
  limit?: number;
};

export type GetOpenOrdersParams = {
  userAddress: EvmAddress;
  symbol?: string;
  subaccountId?: SubaccountId;
  cursor?: Cursor;
  clientId?: string;
  limit?: number;
};

export type GetOrdersParams = {
  userAddress: EvmAddress;
  symbol?: string;
  cursor?: Cursor;
  limit?: number;
};

export type GetFundingHistoryParams = {
  userAddress: EvmAddress;
  symbol?: string;
  cursor?: Cursor;
  limit?: number;
};

export type GetLeverageParams = {
  userAddress: EvmAddress;
  symbol: string;
  subaccountId?: SubaccountId;
};

export type SetLeverageParams = {
  userAddress: EvmAddress;
  symbol: string;
  leverage: number;
  subaccountId: SubaccountId;
};

export type GetNextSubaccountParams = {
  userAddress: EvmAddress;
};

export type GetAllowanceParams = {
  userAddress: EvmAddress;
  symbol: string;
  subaccountId?: number;
};

export type GetFeesParams = {
  userAddress: EvmAddress;
};

export type GetAccountMetricsParams = {
  userAddress: EvmAddress;
  subaccountId?: SubaccountId;
};

export type TpslType = HttpNewOrderRequest["tpsl"];

export type NewOrderParams = UnsignedAccountRequest<HttpNewOrderRequest>;
export type CreateOrdersParams = NewOrderParams[];
export type CancelOrdersParams = UnsignedAccountRequest<HttpCancelOrderRequest>[];
export type ReplaceOrderParams = UnsignedAccountRequest<HttpReplaceOrderRequest>;
export type ReplaceOrdersParams = ReplaceOrderParams[];

export type GetBalancesParams = {
  userAddress: EvmAddress;
};

export type GetBalanceHistoryParams = {
  userAddress: EvmAddress;
  from: number;
  to: number;
};

export type GetPnlHistoryParams = {
  userAddress: EvmAddress;
  from: number;
  to: number;
};

export type CreateTwapOrderParams = UnsignedAccountRequest<CreateTwapRequest>;
export type CancelTwapOrderParams = UnsignedAccountRequest<CancelTwapRequest>;

export type TwapOrderResult = { twapId: string };
export type TwapCancelResult = { status: "success" };

export type GetTwapHistoryParams = {
  userAddress: EvmAddress;
} & GatewayTwapHistoryQuery;

export type GetTradeHistoryParams = {
  userAddress: EvmAddress;
  marketSymbol?: string;
  startTime?: number;
  endTime?: number;
  cursor?: Cursor;
  limit?: number;
};

export type GetTradeHistoryResponse = GetUserTradesResponse;
