import type { GteEnvKey } from "../../constants";
import type {
  Candle,
  CreateOrdersResponse,
  GetAccountMetricsResponse,
  GetAllowanceResponse,
  GetBalanceHistoryResponse,
  GetBalancesResponse,
  GetFeesResponse,
  GetFundingHistoryResponse,
  GetHealthResponse,
  GetLeverageResponse,
  GetMarketContextHistoryResponse,
  GetMarketsResponse,
  GetNextSubaccountResponse,
  GetOrdersResponse,
  GetPnlHistoryResponse,
  GetPositionsResponse,
  GetTradesResponse,
  GetTwapHistoryResponse,
  HttpBook,
  Market,
  MarketDataPerps,
  SearchMarketsResponse,
  SetLeverageResponse,
} from "../generated/types.gen";
import type {
  CancelOrdersParams,
  CancelTwapOrderParams,
  CreateOrdersParams,
  CreateTwapOrderParams,
  GetAccountMetricsParams,
  GetAllowanceParams,
  GetBalanceHistoryParams,
  GetBalancesParams,
  GetCandlesParams,
  GetFeesParams,
  GetFundingHistoryParams,
  GetLeverageParams,
  GetMarketContextHistoryParams,
  GetMarketDataParams,
  GetMarketParams,
  GetMarketsParams,
  GetNextSubaccountParams,
  GetOpenOrdersParams,
  GetOpenOrdersResponse,
  GetOrderBookParams,
  GetOrdersParams,
  GetPnlHistoryParams,
  GetPositionsParams,
  GetTradeHistoryParams,
  GetTradeHistoryResponse,
  GetTradesParams,
  GetTwapHistoryParams,
  ReplaceOrdersParams,
  SearchMarketsParams,
  SetLeverageParams,
  SignedRequestOptions,
  TradeSide,
  TwapCancelResult,
  TwapOrderResult,
} from "./params";
import type { GteSigner } from "./signer";
import type { StreamsInterface } from "./ws";

export type ClientResult<TData, TError = unknown> = Promise<
  | { data: TData; error: undefined; request: Request; response: Response }
  | { data: undefined; error: TError; request: Request; response: Response }
>;

export type GteDataClientOptions = {
  env: GteEnvKey;
  httpBaseUrl?: string;
  wsBaseUrl?: string;
  headers?: HeadersInit;
  /** Whether to automatically reconnect on disconnect. Default: true */
  wsReconnect?: boolean;
  /** Base reconnect interval in ms (used with exponential backoff). Default: 1000 */
  wsReconnectInterval?: number;
  /** Maximum reconnect interval in ms (backoff cap). Default: 30000 */
  wsMaxReconnectInterval?: number;
  /** Maximum number of reconnection attempts before giving up. Default: 10 */
  wsMaxReconnectAttempts?: number;
  /** Connection timeout in ms per attempt. Default: 10000 */
  wsConnectionTimeout?: number;
  /** If no message received within this many ms, trigger reconnect. Default: 60000 */
  wsLivenessTimeout?: number;
};

export type GteOrderClientOptions = GteDataClientOptions & {
  /**
   * Signer for authenticated operations (signing orders, etc.).
   *
   * Use the adapter functions to create a signer:
   * - `fromPrivateKey("0x...")` - from a private key string
   * - `fromPrivateKeyAccount(account)` - from a viem PrivateKeyAccount
   */
  signer: GteSigner;
};

export type QuoteResult = {
  size: number;
  notional: number;
  averagePrice: number;
};

export interface MarketsInterface {
  list(params?: GetMarketsParams): Promise<GetMarketsResponse>;
  search(params?: SearchMarketsParams): Promise<SearchMarketsResponse>;
  get(params: GetMarketParams): Promise<Market>;
  getData(params: GetMarketDataParams): Promise<MarketDataPerps>;
  getContextHistory(
    params: GetMarketContextHistoryParams,
  ): Promise<GetMarketContextHistoryResponse>;
  getOrderBook(params: GetOrderBookParams): Promise<HttpBook>;
  getCandles(params: GetCandlesParams): Promise<Candle[]>;
  getTrades(params: GetTradesParams): Promise<GetTradesResponse>;
  quoteOrderByBaseSize(symbol: string, side: TradeSide, baseSize: number): Promise<QuoteResult>;
  quoteOrderByQuoteSize(symbol: string, side: TradeSide, quoteSize: number): Promise<QuoteResult>;
}

export interface AccountsReadInterface {
  getPositions(params: GetPositionsParams): Promise<GetPositionsResponse>;
  getOpenOrders(params: GetOpenOrdersParams): Promise<GetOpenOrdersResponse>;
  getOrders(params: GetOrdersParams): Promise<GetOrdersResponse>;
  getFundingHistory(params: GetFundingHistoryParams): Promise<GetFundingHistoryResponse>;
  getLeverage(params: GetLeverageParams): Promise<GetLeverageResponse>;
  getNextSubaccount(params: GetNextSubaccountParams): Promise<GetNextSubaccountResponse>;
  getAllowance(params: GetAllowanceParams): Promise<GetAllowanceResponse>;
  getFees(params: GetFeesParams): Promise<GetFeesResponse>;
  getAccountMetrics(params: GetAccountMetricsParams): Promise<GetAccountMetricsResponse>;
  getTwapHistory(params: GetTwapHistoryParams): Promise<GetTwapHistoryResponse>;
  getTradeHistory(params: GetTradeHistoryParams): Promise<GetTradeHistoryResponse>;
}

export interface AccountsWriteInterface {
  setLeverage(
    params: SetLeverageParams,
    options?: SignedRequestOptions,
  ): Promise<SetLeverageResponse>;
}

export interface OrdersInterface {
  create(params: CreateOrdersParams, options?: SignedRequestOptions): Promise<CreateOrdersResponse>;
  cancel(params: CancelOrdersParams, options?: SignedRequestOptions): Promise<CreateOrdersResponse>;
  replace(
    params: ReplaceOrdersParams,
    options?: SignedRequestOptions,
  ): Promise<CreateOrdersResponse>;
  createTwap(
    params: CreateTwapOrderParams,
    options?: SignedRequestOptions,
  ): Promise<TwapOrderResult>;
  cancelTwap(
    params: CancelTwapOrderParams,
    options?: SignedRequestOptions,
  ): Promise<TwapCancelResult>;
}

export interface PortfolioInterface {
  getBalances(params: GetBalancesParams): Promise<GetBalancesResponse>;
  getBalanceHistory(params: GetBalanceHistoryParams): Promise<GetBalanceHistoryResponse>;
  getPnl(params: GetPnlHistoryParams): Promise<GetPnlHistoryResponse>;
}

export interface GteDataClientInterface {
  readonly markets: MarketsInterface;
  readonly accounts: AccountsReadInterface;
  readonly portfolio: PortfolioInterface;
  readonly streams: StreamsInterface;
  eagerConnect(): void;
  onReconnect(listener: () => void): () => void;
  getHealth(): Promise<GetHealthResponse>;
}

export interface GteOrderClientInterface extends GteDataClientInterface {
  readonly orders: OrdersInterface;
  readonly accounts: AccountsReadInterface & AccountsWriteInterface;
  readonly streams: StreamsInterface;
}
