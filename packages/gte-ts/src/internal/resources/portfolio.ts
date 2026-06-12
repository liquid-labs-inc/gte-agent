import type { Client } from "../generated/client";
import {
  getBalanceHistory as _getBalanceHistory,
  getBalances as _getBalances,
  getPnlHistory as _getPnlHistory,
} from "../generated/sdk.gen";
import type {
  GetBalanceHistoryResponse,
  GetBalancesResponse,
  GetPnlHistoryResponse,
} from "../generated/types.gen";
import type {
  GetBalanceHistoryParams,
  GetBalancesParams,
  GetPnlHistoryParams,
  PortfolioInterface,
} from "../types/index";
import { unwrapHttpResult } from "../utils";

export class Portfolio implements PortfolioInterface {
  constructor(private gteClient: Client | null) {}

  private get gte(): Client {
    if (!this.gteClient) throw new Error("GTE client not initialized");
    return this.gteClient;
  }

  async getBalances(params: GetBalancesParams): Promise<GetBalancesResponse> {
    return unwrapHttpResult(
      _getBalances({
        path: { userAddress: params.userAddress },
        client: this.gte,
      }),
    );
  }

  async getBalanceHistory(params: GetBalanceHistoryParams): Promise<GetBalanceHistoryResponse> {
    const { userAddress, from, to } = params;
    return unwrapHttpResult(
      _getBalanceHistory({
        path: { userAddress },
        query: { from: String(from), to: String(to) },
        client: this.gte,
      }),
    );
  }

  async getPnl(params: GetPnlHistoryParams): Promise<GetPnlHistoryResponse> {
    const { userAddress, from, to } = params;
    return unwrapHttpResult(
      _getPnlHistory({
        path: { userAddress },
        query: { from: String(from), to: String(to) },
        client: this.gte,
      }),
    );
  }
}
