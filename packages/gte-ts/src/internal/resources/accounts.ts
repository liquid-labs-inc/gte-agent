import { CROSS_MARGIN_SUBACCOUNT_ID } from "../../constants";
import type { Client } from "../generated/client";
import {
  getAccountMetrics as _getAccountMetrics,
  getAllowance as _getAllowance,
  getFees as _getFees,
  getFundingHistory as _getFundingHistory,
  getLeverage as _getLeverage,
  getNextSubaccount as _getNextSubaccount,
  getOpenOrders as _getOpenOrders,
  getOrders as _getOrders,
  getPositions as _getPositions,
  getTwapHistory as _getTwapHistory,
  getUserTrades as _getUserTrades,
  setLeverage as _setLeverage,
} from "../generated/sdk.gen";
import type {
  GetAccountMetricsResponse,
  GetAllowanceResponse,
  GetFeesResponse,
  GetFundingHistoryResponse,
  GetLeverageResponse,
  GetNextSubaccountResponse,
  GetOrdersResponse,
  GetPositionsResponse,
  GetTwapHistoryResponse,
  SetLeverageResponse,
} from "../generated/types.gen";
import type { HyperliquidExchange } from "../hyperliquid/exchange";
import { type GteClientSource, MonotonicNonceManager, signWireRequest } from "../signing/request";
import type { AccountsReadInterface, AccountsWriteInterface } from "../types/client";
import type {
  GetAccountMetricsParams,
  GetAllowanceParams,
  GetFeesParams,
  GetFundingHistoryParams,
  GetLeverageParams,
  GetNextSubaccountParams,
  GetOpenOrdersParams,
  GetOpenOrdersResponse,
  GetOrdersParams,
  GetPositionsParams,
  GetTradeHistoryParams,
  GetTradeHistoryResponse,
  GetTwapHistoryParams,
  SetLeverageParams,
  SignedRequestOptions,
} from "../types/params";
import type { GteSigner } from "../types/signer";
import { unwrapHttpResult } from "../utils";

export class AccountsRead implements AccountsReadInterface {
  constructor(protected gteClient: Client | null) {}

  protected get gte(): Client {
    if (!this.gteClient) throw new Error("GTE client not initialized");
    return this.gteClient;
  }

  async getPositions(params: GetPositionsParams): Promise<GetPositionsResponse> {
    const { userAddress, symbol, subaccountId, ...rest } = params;
    return unwrapHttpResult(
      _getPositions({
        path: { userAddress },
        query: {
          ...rest,
          ...(symbol && { symbol }),
          ...(subaccountId !== undefined && { subaccountId }),
        },
        client: this.gte,
      }),
    );
  }

  async getOpenOrders(params: GetOpenOrdersParams): Promise<GetOpenOrdersResponse> {
    const { userAddress, symbol, subaccountId, ...rest } = params;
    return unwrapHttpResult(
      _getOpenOrders({
        path: { userAddress },
        query: {
          ...rest,
          ...(symbol && { symbol }),
          ...(subaccountId !== undefined && { subaccountId }),
        },
        client: this.gte,
      }),
    );
  }

  async getOrders(params: GetOrdersParams): Promise<GetOrdersResponse> {
    const { userAddress, symbol, ...rest } = params;
    return unwrapHttpResult(
      _getOrders({
        path: { userAddress },
        query: {
          ...rest,
          ...(symbol && { symbol }),
        },
        client: this.gte,
      }),
    );
  }

  async getFundingHistory(params: GetFundingHistoryParams): Promise<GetFundingHistoryResponse> {
    const { userAddress, symbol, ...rest } = params;
    return unwrapHttpResult(
      _getFundingHistory({
        path: { userAddress },
        query: { ...rest, ...(symbol && { symbol }) },
        client: this.gte,
      }),
    );
  }

  async getLeverage(params: GetLeverageParams): Promise<GetLeverageResponse> {
    const { userAddress, symbol, subaccountId } = params;
    return unwrapHttpResult(
      _getLeverage({
        path: { userAddress },
        query: { symbol, ...(subaccountId !== undefined && { subaccountId }) },
        client: this.gte,
      }),
    );
  }

  async getNextSubaccount(params: GetNextSubaccountParams): Promise<GetNextSubaccountResponse> {
    return unwrapHttpResult(
      _getNextSubaccount({
        path: { userAddress: params.userAddress },
        client: this.gte,
      }),
    );
  }

  async getAllowance(params: GetAllowanceParams): Promise<GetAllowanceResponse> {
    return unwrapHttpResult(
      _getAllowance({
        path: { userAddress: params.userAddress },
        query: { symbol: params.symbol, subaccountId: params.subaccountId },
        client: this.gte,
      }),
    );
  }

  async getFees(params: GetFeesParams): Promise<GetFeesResponse> {
    return unwrapHttpResult(
      _getFees({
        path: { userAddress: params.userAddress },
        client: this.gte,
      }),
    );
  }

  async getAccountMetrics(params: GetAccountMetricsParams): Promise<GetAccountMetricsResponse> {
    return unwrapHttpResult(
      _getAccountMetrics({
        path: { userAddress: params.userAddress },
        client: this.gte,
      }),
    );
  }

  async getTwapHistory(params: GetTwapHistoryParams): Promise<GetTwapHistoryResponse> {
    const { userAddress, ...query } = params;
    return unwrapHttpResult(
      _getTwapHistory({
        path: { userAddress },
        query: Object.keys(query).length > 0 ? query : undefined,
        client: this.gte,
      }),
    );
  }

  async getTradeHistory(params: GetTradeHistoryParams): Promise<GetTradeHistoryResponse> {
    return unwrapHttpResult(
      _getUserTrades({
        client: this.gte,
        path: { userAddress: params.userAddress },
        query: {
          symbol: params.marketSymbol,
          startTime: params.startTime?.toString(),
          endTime: params.endTime?.toString(),
          cursor: params.cursor,
          limit: params.limit,
        },
      }),
    );
  }
}

export class AccountsWrite implements AccountsWriteInterface {
  private readonly nonceManager = new MonotonicNonceManager();

  constructor(
    private gteClient: Client | null,
    private signer: GteSigner | null,
    private source: GteClientSource = "hyperliquid",
    private hlExchange: HyperliquidExchange | null = null,
  ) {}

  private get gte(): Client {
    if (!this.gteClient) throw new Error("GTE client not initialized");
    return this.gteClient;
  }

  async setLeverage(
    params: SetLeverageParams,
    options?: SignedRequestOptions,
  ): Promise<SetLeverageResponse> {
    if (!this.signer) throw new Error("Signer required for GTE account writes");
    if (this.hlExchange) {
      const subaccountId = params.subaccountId ?? CROSS_MARGIN_SUBACCOUNT_ID;
      await this.hlExchange.setLeverage(
        params.symbol,
        params.leverage,
        subaccountId === CROSS_MARGIN_SUBACCOUNT_ID,
      );
      return { success: true, leverage: params.leverage };
    }
    const body = await signWireRequest({
      signer: this.signer,
      source: this.source,
      body: {
        symbol: params.symbol,
        leverage: params.leverage,
        subaccountId: params.subaccountId ?? CROSS_MARGIN_SUBACCOUNT_ID,
      },
      options,
      nonceManager: this.nonceManager,
    });
    return unwrapHttpResult(
      _setLeverage({
        path: { userAddress: params.userAddress },
        body,
        client: this.gte,
      }),
    );
  }
}

export class Accounts
  extends AccountsRead
  implements AccountsReadInterface, AccountsWriteInterface
{
  private writeClient: AccountsWrite;

  constructor(
    gteClient: Client | null,
    signer: GteSigner | null,
    source: GteClientSource = "hyperliquid",
    hlExchange: HyperliquidExchange | null = null,
  ) {
    super(gteClient);
    this.writeClient = new AccountsWrite(gteClient, signer, source, hlExchange);
  }

  async setLeverage(
    params: SetLeverageParams,
    options?: SignedRequestOptions,
  ): Promise<SetLeverageResponse> {
    return this.writeClient.setLeverage(params, options);
  }
}
