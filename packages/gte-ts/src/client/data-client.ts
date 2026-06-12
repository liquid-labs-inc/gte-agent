import { createGteHttpClient, createGteWsTransport, requireGteEnv } from "../internal/config";
import type { Client } from "../internal/generated/client";
import { getHealth as httpApiServiceGetHealth } from "../internal/generated/sdk.gen";
import type { GetHealthResponse } from "../internal/generated/types.gen";
import { AccountsRead, Markets, Portfolio, Streams } from "../internal/resources";
import type {
  AccountsReadInterface,
  GteDataClientInterface,
  GteDataClientOptions,
  MarketsInterface,
  PortfolioInterface,
} from "../internal/types/client";
import type { StreamsInterface } from "../internal/types/ws";
import { unwrapHttpResult } from "../internal/utils";
import type { WsTransport } from "../internal/ws";

export class GteDataClient implements GteDataClientInterface {
  protected _gteClient: Client;
  protected _gteWsTransport: WsTransport;

  public readonly markets: MarketsInterface;
  public readonly accounts: AccountsReadInterface;
  public readonly portfolio: PortfolioInterface;
  public readonly streams: StreamsInterface;

  constructor(options: GteDataClientOptions) {
    requireGteEnv(options?.env);
    this._gteClient = createGteHttpClient(options);
    this._gteWsTransport = createGteWsTransport(options);

    this.markets = new Markets(this._gteClient);
    this.accounts = new AccountsRead(this._gteClient);
    this.portfolio = new Portfolio(this._gteClient);
    this.streams = new Streams(this._gteWsTransport);
  }

  eagerConnect(): void {
    this._gteWsTransport.eagerConnect();
  }

  onReconnect(listener: () => void): () => void {
    return this._gteWsTransport.onReconnect(listener);
  }

  async getHealth(): Promise<GetHealthResponse> {
    return unwrapHttpResult(httpApiServiceGetHealth({ client: this._gteClient }));
  }
}

export function createGteDataClient(options: GteDataClientOptions): GteDataClient {
  return new GteDataClient(options);
}
