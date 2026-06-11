import type { Client } from "../generated/client";
import {
  cancelOrders as _cancelOrders,
  cancelTwap as _cancelTwap,
  createOrders as _createOrders,
  createTwap as _createTwap,
  replaceOrders as _replaceOrders,
} from "../generated/sdk.gen";
import type {
  CreateOrdersResponse,
  HttpCancelOrderRequest,
  HttpNewOrderRequest,
  HttpReplaceOrderRequest,
} from "../generated/types.gen";
import type { HyperliquidExchange } from "../hyperliquid/exchange";
import { type GteClientSource, MonotonicNonceManager, signWireRequest } from "../signing/request";
import type { OrdersInterface } from "../types/client";
import type {
  CancelOrdersParams,
  CancelTwapOrderParams,
  CreateOrdersParams,
  CreateTwapOrderParams,
  ReplaceOrdersParams,
  SignedRequestOptions,
  TwapCancelResult,
  TwapOrderResult,
} from "../types/params";
import type { GteSigner } from "../types/signer";
import { unwrapHttpResult } from "../utils";

export class Orders implements OrdersInterface {
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

  private get signerAddress(): string {
    if (!this.signer) throw new Error("Signer required for GTE orders");
    return this.signer.address;
  }

  async create(
    params: CreateOrdersParams,
    options?: SignedRequestOptions,
  ): Promise<CreateOrdersResponse> {
    if (this.hlExchange) {
      return this.hlExchange.placeOrders(params);
    }
    const orders: HttpNewOrderRequest[] = params.map((order) =>
      buildGteCreateOrderRequest(order, this.signerAddress),
    );
    const body = await this.signBody({ orders }, options);
    return unwrapHttpResult(_createOrders({ body, client: this.gte }));
  }

  async cancel(
    params: CancelOrdersParams,
    options?: SignedRequestOptions,
  ): Promise<CreateOrdersResponse> {
    if (this.hlExchange) {
      return this.hlExchange.cancelOrders(params);
    }
    const orders: HttpCancelOrderRequest[] = params.map((order) =>
      buildGteCancelOrderRequest(order, this.signerAddress),
    );
    const body = await this.signBody({ orders }, options);
    return unwrapHttpResult(_cancelOrders({ body, client: this.gte }));
  }

  async replace(
    params: ReplaceOrdersParams,
    options?: SignedRequestOptions,
  ): Promise<CreateOrdersResponse> {
    if (this.hlExchange) {
      return this.hlExchange.replaceOrders(params);
    }
    const orders: HttpReplaceOrderRequest[] = params.map((order) =>
      buildGteReplaceOrderRequest(order, this.signerAddress),
    );
    const body = await this.signBody({ orders }, options);
    return unwrapHttpResult(_replaceOrders({ body, client: this.gte }));
  }

  async createTwap(
    params: CreateTwapOrderParams,
    options?: SignedRequestOptions,
  ): Promise<TwapOrderResult> {
    if (this.hlExchange) {
      return this.hlExchange.createTwap(params);
    }
    const body = await this.signBody(
      {
        ...params,
        account: params.account ?? this.signerAddress,
      },
      options,
    );
    return unwrapHttpResult(
      _createTwap({
        body,
        client: this.gte,
      }),
    );
  }

  async cancelTwap(
    params: CancelTwapOrderParams,
    options?: SignedRequestOptions,
  ): Promise<TwapCancelResult> {
    if (this.hlExchange) {
      return this.hlExchange.cancelTwap(params);
    }
    const body = await this.signBody(
      {
        ...params,
        account: params.account ?? this.signerAddress,
      },
      options,
    );
    return unwrapHttpResult(
      _cancelTwap({
        body,
        client: this.gte,
      }),
    );
  }

  private signBody<TBody extends Record<string, unknown>>(
    body: TBody,
    options?: SignedRequestOptions,
  ): Promise<TBody & { nonce: number; signature: string }> {
    if (!this.signer) throw new Error("Signer required for GTE orders");
    return signWireRequest({
      signer: this.signer,
      source: this.source,
      body,
      options,
      nonceManager: this.nonceManager,
    });
  }
}

function buildGteCreateOrderRequest(
  order: CreateOrdersParams[number],
  signerAddress: string,
): HttpNewOrderRequest {
  const {
    account,
    tpslLimitPrice: _tpslLimitPrice,
    ...rest
  } = order as CreateOrdersParams[number] & { tpslLimitPrice?: unknown };
  return {
    ...rest,
    account: account ?? signerAddress,
  };
}

function buildGteCancelOrderRequest(
  order: CancelOrdersParams[number],
  signerAddress: string,
): HttpCancelOrderRequest {
  const { account, ...rest } = order;
  return {
    ...rest,
    account: account ?? signerAddress,
  };
}

function buildGteReplaceOrderRequest(
  order: ReplaceOrdersParams[number],
  signerAddress: string,
): HttpReplaceOrderRequest {
  const {
    account,
    tpslLimitPrice: _tpslLimitPrice,
    ...rest
  } = order as ReplaceOrdersParams[number] & { tpslLimitPrice?: unknown };
  return {
    ...rest,
    account: account ?? signerAddress,
  };
}
