/**
 * Hyperliquid exchange-write path.
 *
 * Builds native Hyperliquid L1 actions, signs them with the user's wallet, and
 * POSTs them directly to Hyperliquid's `/exchange` endpoint. This is the path
 * that unblocks perps writes against the deployed gateway, which forwards
 * exactly this envelope to Hyperliquid.
 *
 * We sign with `signL1Action` directly (rather than the high-level
 * `ExchangeClient`) because the SDK's embedded Privy/viem wallet adapter is only
 * compatible with this lower-level signing path; `ExchangeClient` fails to sign
 * typed data with that wallet. Action key-ordering for the signature is
 * guaranteed by parsing through the SDK's request schemas (valibot).
 *
 * Mainnet is hardcoded on purpose (testnet support is deprecated). Asset-index
 * resolution uses the SDK's built-in `SymbolConverter`; prices come from the
 * caller — the SDK never fetches them.
 */
import { HttpTransport } from "@nktkas/hyperliquid";
import {
  CancelRequest,
  ModifyRequest,
  OrderRequest,
  TwapCancelRequest,
  TwapOrderRequest,
  UpdateLeverageRequest,
} from "@nktkas/hyperliquid/api/exchange";
import { type AbstractWallet, signL1Action } from "@nktkas/hyperliquid/signing";
import { SymbolConverter, formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import * as v from "valibot";
import type {
  CreateOrdersResponse,
  OrderResult,
  OrderStatus,
  OrderType,
  Side,
  TimeInForce,
} from "../generated/types.gen";
import type {
  CancelOrdersParams,
  CancelTwapOrderParams,
  CreateOrdersParams,
  CreateTwapOrderParams,
  ReplaceOrdersParams,
  TpslType,
  TwapCancelResult,
  TwapOrderResult,
} from "../types/params";
import type { GteSigner } from "../types/signer";

const HL_MAINNET_URL = "https://api.hyperliquid.xyz";
const HL_EXCHANGE_URL = `${HL_MAINNET_URL}/exchange`;

// OrderResult.rejectReason is a required enum with no "none" member; Hyperliquid
// does not return a GTE reject reason on success, so we use a placeholder that
// callers never read on the success path (they branch on `status`/`error`).
const PLACEHOLDER_REJECT_REASON = "invalid_order" as const;

// Market orders carry a reference price; cross it by this slippage to produce a
// marketable limit when the order doesn't specify its own.
const DEFAULT_MARKET_SLIPPAGE_BPS = 800;

/** Structural subset of an order needed to build a Hyperliquid order wire. */
type OrderWireInput = {
  symbol?: string;
  side: Side;
  orderType: OrderType;
  price?: string;
  quantity?: string;
  reduceOnly?: boolean | null;
  timeInForce?: TimeInForce;
  tpsl?: TpslType | null;
  slippageBps?: number | null;
  tpslLimitPrice?: string;
};

type HlOrderType =
  | { limit: { tif: "Gtc" | "Ioc" | "Alo" | "FrontendMarket" } }
  | { trigger: { triggerPx: string; isMarket: boolean; tpsl: "tp" | "sl" } };

type HlStatusEntry =
  | { resting: { oid: number; cloid?: string } }
  | { filled: { totalSz: string; avgPx: string; oid: number; cloid?: string } }
  | { error: string }
  | "waitingForFill"
  | "waitingForTrigger";

type HlExchangeResponse = {
  status?: "ok" | "err";
  response?: string | { type?: string; data?: { statuses?: HlStatusEntry[] } };
};

let sharedTransport: HttpTransport | null = null;
function getTransport(): HttpTransport {
  if (!sharedTransport) sharedTransport = new HttpTransport();
  return sharedTransport;
}

let converterPromise: Promise<SymbolConverter> | null = null;
function getSymbolConverter(): Promise<SymbolConverter> {
  if (!converterPromise) {
    converterPromise = SymbolConverter.create({ transport: getTransport() }).catch(
      (error: unknown) => {
        // Never cache a rejection: a transient meta-fetch failure would
        // otherwise break every subsequent exchange write until page reload.
        converterPromise = null;
        throw error;
      },
    );
  }
  return converterPromise;
}

// Monotonic nonce so batched/parallel actions never collide within the same ms.
let lastNonce = 0;
function nextNonce(): number {
  const nonce = Math.max(Date.now(), lastNonce + 1);
  lastNonce = nonce;
  return nonce;
}

/** Test-only: clears module-level caches (transport, symbol metadata, nonce). */
export function _resetHyperliquidExchangeForTesting(): void {
  sharedTransport = null;
  converterPromise = null;
  lastNonce = 0;
}

/** "BTC-USD-PERP" -> "BTC" (keeps a builder-dex prefix like "xyz:TSLA" intact). */
function getCoinFromSymbol(symbol: string): string {
  return symbol.split("-")[0] ?? symbol;
}

function requireAssetId(converter: SymbolConverter, symbol: string): number {
  const id = converter.getAssetId(getCoinFromSymbol(symbol));
  if (id === undefined) {
    throw new Error(`Unknown Hyperliquid asset for symbol "${symbol}"`);
  }
  return id;
}

function isStopOrder(orderType: OrderType): boolean {
  return orderType === "stop_limit" || orderType === "stop_market";
}

function mapTimeInForceToHl(tif: TimeInForce | undefined): "Gtc" | "Ioc" | "Alo" {
  switch (tif) {
    case "ioc":
      return "Ioc";
    case "fok":
      return "Ioc"; // Hyperliquid has no FOK; degrade to IOC.
    default:
      return "Gtc";
  }
}

function mapOrderTypeToHl(
  orderType: OrderType,
  timeInForce: TimeInForce | undefined,
  triggerPrice: number | undefined,
  side: Side,
  tpsl: TpslType | undefined,
): HlOrderType {
  switch (orderType) {
    case "limit":
      return { limit: { tif: mapTimeInForceToHl(timeInForce) } };
    case "market":
      return { limit: { tif: "FrontendMarket" } };
    case "stop_limit":
    case "stop_market":
      if (triggerPrice === undefined) {
        throw new Error("triggerPrice is required for stop orders");
      }
      return {
        trigger: {
          triggerPx: String(triggerPrice),
          isMarket: orderType === "stop_market",
          tpsl: tpsl ?? (side === "sell" ? "sl" : "tp"),
        },
      };
    default:
      return { limit: { tif: "Gtc" } };
  }
}

/** Marketable limit price for a market order: cross the reference by the order's slippage. */
function resolveMarketPrice(order: OrderWireInput, referencePrice: number): number {
  const bps = order.slippageBps ?? DEFAULT_MARKET_SLIPPAGE_BPS;
  const factor = order.side === "buy" ? 1 + bps / 10000 : 1 - bps / 10000;
  return referencePrice * factor;
}

function buildOrderWire(order: OrderWireInput, converter: SymbolConverter) {
  const symbol = order.symbol ?? "";
  const coin = getCoinFromSymbol(symbol);
  const assetIndex = converter.getAssetId(coin);
  const szDecimals = converter.getSzDecimals(coin);
  if (assetIndex === undefined || szDecimals === undefined) {
    throw new Error(`Unknown Hyperliquid asset for symbol "${symbol}"`);
  }

  let limitPrice: number;
  if (order.tpslLimitPrice) {
    limitPrice = Number(order.tpslLimitPrice);
  } else if (order.orderType === "market") {
    const reference = Number(order.price ?? 0);
    if (!Number.isFinite(reference) || reference <= 0) {
      throw new Error("Market orders require a positive reference price from the caller");
    }
    limitPrice = resolveMarketPrice(order, reference);
  } else {
    limitPrice = Number(order.price ?? 0);
  }

  const triggerPrice = isStopOrder(order.orderType) ? Number(order.price ?? 0) : undefined;

  return {
    a: assetIndex,
    b: order.side === "buy",
    p: formatPrice(limitPrice, szDecimals),
    s: formatSize(Number(order.quantity ?? 0), szDecimals),
    r: order.reduceOnly ?? false,
    t: mapOrderTypeToHl(
      order.orderType,
      order.timeInForce,
      triggerPrice,
      order.side,
      order.tpsl ?? undefined,
    ),
  };
}

function resolveGrouping(orders: CreateOrdersParams): "na" | "normalTpsl" | "positionTpsl" {
  const hasTrigger = orders.some((order) => isStopOrder(order.orderType));
  const hasEntry = orders.some((order) => !isStopOrder(order.orderType));
  if (hasTrigger && hasEntry) return "normalTpsl";
  if (hasTrigger) return "positionTpsl";
  return "na";
}

function mapStatusToOrderResult(
  entry: HlStatusEntry | undefined,
  clientOrderId: string,
): OrderResult {
  if (entry && typeof entry === "object" && "error" in entry && entry.error) {
    return {
      orderId: "0",
      clientOrderId,
      status: "rejected",
      timestamp: String(Date.now()),
      error: entry.error,
      rejectReason: PLACEHOLDER_REJECT_REASON,
    };
  }

  let orderId = "0";
  let status: OrderStatus = "new";
  if (entry && typeof entry === "object") {
    if ("resting" in entry) {
      orderId = String(entry.resting.oid);
      status = "new";
    } else if ("filled" in entry) {
      orderId = String(entry.filled.oid);
      status = "filled";
    }
  }

  return {
    orderId,
    clientOrderId,
    status,
    timestamp: String(Date.now()),
    rejectReason: PLACEHOLDER_REJECT_REASON,
  };
}

function responseStatuses(response: HlExchangeResponse): HlStatusEntry[] {
  return typeof response.response === "object" ? (response.response?.data?.statuses ?? []) : [];
}

/**
 * Signs an L1 action and POSTs it to Hyperliquid's `/exchange` endpoint.
 * Throws on transport failure or an `err` response.
 */
async function executeL1Action<T extends HlExchangeResponse>(
  signer: GteSigner,
  action: Record<string, unknown>,
): Promise<T> {
  const nonce = nextNonce();
  const signature = await signL1Action({
    wallet: signer as unknown as AbstractWallet,
    action,
    nonce,
  });

  const response = await fetch(HL_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, nonce, signature }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Hyperliquid API error: ${response.status} ${response.statusText} - ${body}`);
  }

  const result = (await response.json()) as T;
  if (result.status === "err") {
    const message = typeof result.response === "string" ? result.response : "Unknown error";
    throw new Error(`Hyperliquid API error: ${message}`);
  }
  return result;
}

export class HyperliquidExchange {
  constructor(private readonly signer: GteSigner) {}

  async placeOrders(params: CreateOrdersParams): Promise<CreateOrdersResponse> {
    const converter = await getSymbolConverter();
    const orders = params.map((order) => buildOrderWire(order, converter));

    // v.parse normalizes key ordering to the schema, which the L1 signature depends on.
    const action = v.parse(OrderRequest.entries.action, {
      type: "order",
      orders,
      grouping: resolveGrouping(params),
    });

    const response = await executeL1Action(this.signer, action as Record<string, unknown>);
    const statuses = responseStatuses(response);
    const results = params.map((order, index) =>
      mapStatusToOrderResult(statuses[index], order.clientOrderId ?? String(index)),
    );
    return { results };
  }

  async cancelOrders(params: CancelOrdersParams): Promise<CreateOrdersResponse> {
    const converter = await getSymbolConverter();
    const cancels = params.map((order) => {
      const orderId = order.origOrderId ?? order.origClientOrderId;
      return { a: requireAssetId(converter, order.symbol ?? ""), o: orderId ? Number(orderId) : 0 };
    });

    const action = v.parse(CancelRequest.entries.action, { type: "cancel", cancels });
    await executeL1Action(this.signer, action as Record<string, unknown>);

    // A non-throwing cancel means Hyperliquid accepted every cancel in the batch.
    const results = params.map((order) => ({
      orderId: order.origOrderId ?? order.origClientOrderId ?? "0",
      clientOrderId: order.clientOrderId,
      status: "cancelled" as const,
      timestamp: String(Date.now()),
      rejectReason: PLACEHOLDER_REJECT_REASON,
    }));
    return { results };
  }

  async replaceOrders(params: ReplaceOrdersParams): Promise<CreateOrdersResponse> {
    const converter = await getSymbolConverter();
    const results = await Promise.all(
      params.map(async (order) => {
        const originalOrderId = order.originalOrderId ?? order.originalClientOrderId;
        const action = v.parse(ModifyRequest.entries.action, {
          type: "modify",
          oid: originalOrderId ? Number(originalOrderId) : 0,
          order: buildOrderWire(order, converter),
        });
        const response = await executeL1Action(this.signer, action as Record<string, unknown>);
        return mapStatusToOrderResult(responseStatuses(response)[0], order.clientOrderId);
      }),
    );
    return { results };
  }

  async createTwap(params: CreateTwapOrderParams): Promise<TwapOrderResult> {
    const converter = await getSymbolConverter();
    const coin = getCoinFromSymbol(params.symbol);
    const assetIndex = converter.getAssetId(coin);
    const szDecimals = converter.getSzDecimals(coin);
    if (assetIndex === undefined || szDecimals === undefined) {
      throw new Error(`Unknown Hyperliquid asset for symbol "${params.symbol}"`);
    }

    const action = v.parse(TwapOrderRequest.entries.action, {
      type: "twapOrder",
      twap: {
        a: assetIndex,
        b: params.side === "buy",
        s: formatSize(Number(params.quantity ?? 0), szDecimals),
        r: params.reduceOnly ?? false,
        m: params.twap.duration,
        t: params.twap.randomize ?? true,
      },
    });

    const response = await executeL1Action(this.signer, action as Record<string, unknown>);
    const status = (
      response.response as
        | { data?: { status?: { running?: { twapId: number }; error?: string } } }
        | undefined
    )?.data?.status;
    if (status && typeof status === "object") {
      if ("running" in status && status.running) return { twapId: String(status.running.twapId) };
      if ("error" in status && status.error) throw new Error(status.error);
    }
    throw new Error("Hyperliquid TWAP order failed");
  }

  async cancelTwap(params: CancelTwapOrderParams): Promise<TwapCancelResult> {
    const converter = await getSymbolConverter();
    const action = v.parse(TwapCancelRequest.entries.action, {
      type: "twapCancel",
      a: requireAssetId(converter, params.symbol),
      t: Number(params.twapId),
    });

    const response = await executeL1Action(this.signer, action as Record<string, unknown>);
    const status = (response.response as { data?: { status?: { error?: string } } } | undefined)
      ?.data?.status;
    if (status && typeof status === "object" && "error" in status && status.error) {
      throw new Error(status.error);
    }
    return { status: "success" };
  }

  async setLeverage(symbol: string, leverage: number, isCross: boolean): Promise<void> {
    const converter = await getSymbolConverter();
    const action = v.parse(UpdateLeverageRequest.entries.action, {
      type: "updateLeverage",
      asset: requireAssetId(converter, symbol),
      isCross,
      leverage,
    });

    await executeL1Action(this.signer, action as Record<string, unknown>);
  }
}
