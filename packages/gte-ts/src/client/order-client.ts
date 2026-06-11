import { createGteHttpClient, createGteWsTransport, requireGteEnv } from "../internal/config";
import type { Client } from "../internal/generated/client";
import { getHealth as httpApiServiceGetHealth } from "../internal/generated/sdk.gen";
import type { GetHealthResponse } from "../internal/generated/types.gen";
import { HyperliquidExchange } from "../internal/hyperliquid/exchange";
import { Accounts, Markets, Orders, Portfolio, Streams } from "../internal/resources";
import type { GteClientSource } from "../internal/signing/request";
import type {
  AccountsReadInterface,
  AccountsWriteInterface,
  GteOrderClientInterface,
  GteOrderClientOptions,
  MarketsInterface,
  OrdersInterface,
  PortfolioInterface,
} from "../internal/types/client";
import type { StreamsInterface } from "../internal/types/ws";
import { unwrapHttpResult } from "../internal/utils";
import type { WsTransport } from "../internal/ws";

export class GteOrderClient implements GteOrderClientInterface {
  protected _gteClient: Client;
  protected _gteWsTransport: WsTransport;

  public readonly markets: MarketsInterface;
  public readonly accounts: AccountsReadInterface & AccountsWriteInterface;
  public readonly portfolio: PortfolioInterface;
  public readonly orders: OrdersInterface;
  public readonly streams: StreamsInterface;

  constructor(options: GteOrderClientOptions) {
    requireGteEnv(options?.env);
    if (!options.signer) {
      throw new Error("GteOrderClient requires a signer");
    }

    const signerSource: GteClientSource = "hyperliquid";
    this._gteClient = createGteHttpClient(options);
    this._gteWsTransport = createGteWsTransport(options);

    // Exchange writes are signed client-side and sent directly to Hyperliquid.
    const hlExchange = new HyperliquidExchange(options.signer);

    this.markets = new Markets(this._gteClient);
    this.accounts = new Accounts(this._gteClient, options.signer, signerSource, hlExchange);
    this.portfolio = new Portfolio(this._gteClient);
    this.orders = new Orders(this._gteClient, options.signer, signerSource, hlExchange);
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

export function createGteOrderClient(options: GteOrderClientOptions): GteOrderClient {
  return new GteOrderClient(options);
}
