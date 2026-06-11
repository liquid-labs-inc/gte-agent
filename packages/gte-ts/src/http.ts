import type { GteEnvKey } from "./constants";
import { resolveGteHttpClient } from "./internal/config";
import type { Client } from "./internal/generated/client";
import {
  cancelOrders as sdkCancelOrders,
  cancelTwap as sdkCancelTwap,
  createOrders as sdkCreateOrders,
  createTwap as sdkCreateTwap,
  getAccountMetrics as sdkGetAccountMetrics,
  getAllowance as sdkGetAllowance,
  getBalanceHistory as sdkGetBalanceHistory,
  getBalances as sdkGetBalances,
  getFees as sdkGetFees,
  getFundingHistory as sdkGetFundingHistory,
  getHealth as sdkGetHealth,
  getLeverage as sdkGetLeverage,
  getMarket as sdkGetMarket,
  getMarketCandles as sdkGetMarketCandles,
  getMarketConfig as sdkGetMarketConfig,
  getMarketContextHistory as sdkGetMarketContextHistory,
  getMarketData as sdkGetMarketData,
  getMarketTrades as sdkGetMarketTrades,
  getMarkets as sdkGetMarkets,
  getNextSubaccount as sdkGetNextSubaccount,
  getOpenOrders as sdkGetOpenOrders,
  getOrderBook as sdkGetOrderBook,
  getOrders as sdkGetOrders,
  getPnlHistory as sdkGetPnlHistory,
  getPositions as sdkGetPositions,
  getTwapHistory as sdkGetTwapHistory,
  getUserTrades as sdkGetUserTrades,
  replaceOrders as sdkReplaceOrders,
  searchMarkets as sdkSearchMarkets,
  setLeverage as sdkSetLeverage,
} from "./internal/generated/sdk.gen";
import type {
  CancelOrdersRequest,
  CancelOrdersResponse,
  CancelTwapRequest,
  CancelTwapResponse,
  CreateOrdersRequest,
  CreateOrdersResponse,
  CreateTwapRequest,
  CreateTwapResponse,
  GetAccountMetricsData,
  GetAccountMetricsResponse,
  GetAllowanceData,
  GetAllowanceResponse,
  GetBalanceHistoryData,
  GetBalanceHistoryResponse,
  GetBalancesData,
  GetBalancesResponse,
  GetFeesData,
  GetFeesResponse,
  GetFundingHistoryData,
  GetFundingHistoryResponse,
  GetHealthResponse,
  GetLeverageData,
  GetLeverageResponse,
  GetMarketCandlesData,
  GetMarketCandlesResponse,
  GetMarketConfigData,
  GetMarketConfigResponse,
  GetMarketContextHistoryData,
  GetMarketContextHistoryResponse,
  GetMarketData,
  GetMarketDataData,
  GetMarketDataResponse,
  GetMarketTradesData,
  GetMarketsData,
  GetMarketsResponse,
  GetNextSubaccountData,
  GetNextSubaccountResponse,
  GetOpenOrdersData,
  GetOpenOrdersResponse,
  GetOrderBookData,
  GetOrderBookResponse,
  GetOrdersData,
  GetOrdersResponse,
  GetPnlHistoryData,
  GetPnlHistoryResponse,
  GetPositionsData,
  GetPositionsResponse,
  GetTradesResponse,
  GetTwapHistoryData,
  GetTwapHistoryResponse,
  GetUserTradesData,
  GetUserTradesResponse,
  Market,
  ReplaceOrdersRequest,
  ReplaceOrdersResponse,
  SearchMarketsData,
  SearchMarketsResponse,
  SetLeverageBody,
  SetLeverageData,
  SetLeverageResponse,
} from "./internal/generated/types.gen";
import { unwrapHttpResult } from "./internal/utils";

export type GteHttpOptions = {
  env: GteEnvKey;
  httpBaseUrl?: string;
  headers?: HeadersInit;
  client?: Client;
};

function resolveClient(options: GteHttpOptions): Client {
  return resolveGteHttpClient(options);
}

export function getHealth(options: GteHttpOptions): Promise<GetHealthResponse> {
  return unwrapHttpResult(sdkGetHealth({ client: resolveClient(options) }));
}

export function getMarkets(
  query: GetMarketsData["query"] | undefined,
  options: GteHttpOptions,
): Promise<GetMarketsResponse> {
  return unwrapHttpResult(sdkGetMarkets({ query, client: resolveClient(options) }));
}

export function searchMarkets(
  query: SearchMarketsData["query"] | undefined,
  options: GteHttpOptions,
): Promise<SearchMarketsResponse> {
  return unwrapHttpResult(sdkSearchMarkets({ query, client: resolveClient(options) }));
}

export function getMarket(path: GetMarketData["path"], options: GteHttpOptions): Promise<Market> {
  return unwrapHttpResult(sdkGetMarket({ path, client: resolveClient(options) }));
}

export function getMarketData(
  path: GetMarketDataData["path"],
  options: GteHttpOptions,
): Promise<GetMarketDataResponse> {
  return unwrapHttpResult(sdkGetMarketData({ path, client: resolveClient(options) }));
}

export function getMarketConfig(
  path: GetMarketConfigData["path"],
  options: GteHttpOptions,
): Promise<GetMarketConfigResponse> {
  return unwrapHttpResult(sdkGetMarketConfig({ path, client: resolveClient(options) }));
}

export function getMarketContextHistory(
  path: GetMarketContextHistoryData["path"],
  query: GetMarketContextHistoryData["query"] | undefined,
  options: GteHttpOptions,
): Promise<GetMarketContextHistoryResponse> {
  return unwrapHttpResult(
    sdkGetMarketContextHistory({ path, query, client: resolveClient(options) }),
  );
}

export function getOrderBook(
  path: GetOrderBookData["path"],
  query: GetOrderBookData["query"] | undefined,
  options: GteHttpOptions,
): Promise<GetOrderBookResponse> {
  return unwrapHttpResult(sdkGetOrderBook({ path, query, client: resolveClient(options) }));
}

export function getMarketTrades(
  path: GetMarketTradesData["path"],
  query: GetMarketTradesData["query"] | undefined,
  options: GteHttpOptions,
): Promise<GetTradesResponse> {
  return unwrapHttpResult(sdkGetMarketTrades({ path, query, client: resolveClient(options) }));
}

export function getMarketCandles(
  path: GetMarketCandlesData["path"],
  query: GetMarketCandlesData["query"],
  options: GteHttpOptions,
): Promise<GetMarketCandlesResponse> {
  return unwrapHttpResult(sdkGetMarketCandles({ path, query, client: resolveClient(options) }));
}

export function getOrders(
  path: GetOrdersData["path"],
  query: GetOrdersData["query"] | undefined,
  options: GteHttpOptions,
): Promise<GetOrdersResponse> {
  return unwrapHttpResult(sdkGetOrders({ path, query, client: resolveClient(options) }));
}

export function getOpenOrders(
  path: GetOpenOrdersData["path"],
  query: GetOpenOrdersData["query"] | undefined,
  options: GteHttpOptions,
): Promise<GetOpenOrdersResponse> {
  return unwrapHttpResult(sdkGetOpenOrders({ path, query, client: resolveClient(options) }));
}

export function getPositions(
  path: GetPositionsData["path"],
  query: GetPositionsData["query"] | undefined,
  options: GteHttpOptions,
): Promise<GetPositionsResponse> {
  return unwrapHttpResult(sdkGetPositions({ path, query, client: resolveClient(options) }));
}

export function getFundingHistory(
  path: GetFundingHistoryData["path"],
  query: GetFundingHistoryData["query"] | undefined,
  options: GteHttpOptions,
): Promise<GetFundingHistoryResponse> {
  return unwrapHttpResult(sdkGetFundingHistory({ path, query, client: resolveClient(options) }));
}

export function getFees(
  path: GetFeesData["path"],
  options: GteHttpOptions,
): Promise<GetFeesResponse> {
  return unwrapHttpResult(sdkGetFees({ path, client: resolveClient(options) }));
}

export function getBalances(
  path: GetBalancesData["path"],
  options: GteHttpOptions,
): Promise<GetBalancesResponse> {
  return unwrapHttpResult(sdkGetBalances({ path, client: resolveClient(options) }));
}

export function getAllowance(
  path: GetAllowanceData["path"],
  query: GetAllowanceData["query"],
  options: GteHttpOptions,
): Promise<GetAllowanceResponse> {
  return unwrapHttpResult(sdkGetAllowance({ path, query, client: resolveClient(options) }));
}

export function getAccountMetrics(
  path: GetAccountMetricsData["path"],
  options: GteHttpOptions,
): Promise<GetAccountMetricsResponse> {
  return unwrapHttpResult(sdkGetAccountMetrics({ path, client: resolveClient(options) }));
}

export function getUserTrades(
  path: GetUserTradesData["path"],
  query: GetUserTradesData["query"] | undefined,
  options: GteHttpOptions,
): Promise<GetUserTradesResponse> {
  return unwrapHttpResult(sdkGetUserTrades({ path, query, client: resolveClient(options) }));
}

export function getLeverage(
  path: GetLeverageData["path"],
  query: GetLeverageData["query"],
  options: GteHttpOptions,
): Promise<GetLeverageResponse> {
  return unwrapHttpResult(sdkGetLeverage({ path, query, client: resolveClient(options) }));
}

export function getNextSubaccount(
  path: GetNextSubaccountData["path"],
  options: GteHttpOptions,
): Promise<GetNextSubaccountResponse> {
  return unwrapHttpResult(sdkGetNextSubaccount({ path, client: resolveClient(options) }));
}

export function getBalanceHistory(
  path: GetBalanceHistoryData["path"],
  query: GetBalanceHistoryData["query"],
  options: GteHttpOptions,
): Promise<GetBalanceHistoryResponse> {
  return unwrapHttpResult(sdkGetBalanceHistory({ path, query, client: resolveClient(options) }));
}

export function getPnlHistory(
  path: GetPnlHistoryData["path"],
  query: GetPnlHistoryData["query"],
  options: GteHttpOptions,
): Promise<GetPnlHistoryResponse> {
  return unwrapHttpResult(sdkGetPnlHistory({ path, query, client: resolveClient(options) }));
}

export function getTwapHistory(
  path: GetTwapHistoryData["path"],
  query: GetTwapHistoryData["query"] | undefined,
  options: GteHttpOptions,
): Promise<GetTwapHistoryResponse> {
  return unwrapHttpResult(sdkGetTwapHistory({ path, query, client: resolveClient(options) }));
}

export function createOrdersRaw(
  body: CreateOrdersRequest,
  options: GteHttpOptions,
): Promise<CreateOrdersResponse> {
  return unwrapHttpResult(sdkCreateOrders({ body, client: resolveClient(options) }));
}

export function cancelOrdersRaw(
  body: CancelOrdersRequest,
  options: GteHttpOptions,
): Promise<CancelOrdersResponse> {
  return unwrapHttpResult(sdkCancelOrders({ body, client: resolveClient(options) }));
}

export function replaceOrdersRaw(
  body: ReplaceOrdersRequest,
  options: GteHttpOptions,
): Promise<ReplaceOrdersResponse> {
  return unwrapHttpResult(sdkReplaceOrders({ body, client: resolveClient(options) }));
}

export function createTwapRaw(
  body: CreateTwapRequest,
  options: GteHttpOptions,
): Promise<CreateTwapResponse> {
  return unwrapHttpResult(sdkCreateTwap({ body, client: resolveClient(options) }));
}

export function cancelTwapRaw(
  body: CancelTwapRequest,
  options: GteHttpOptions,
): Promise<CancelTwapResponse> {
  return unwrapHttpResult(sdkCancelTwap({ body, client: resolveClient(options) }));
}

export function setLeverageRaw(
  path: SetLeverageData["path"],
  body: SetLeverageBody,
  options: GteHttpOptions,
): Promise<SetLeverageResponse> {
  return unwrapHttpResult(sdkSetLeverage({ path, body, client: resolveClient(options) }));
}
