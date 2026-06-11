import { type AbstractWallet, signL1Action } from "@nktkas/hyperliquid/signing";
import type { GteSigner } from "../types/signer";

export type GteClientSource = "hyperliquid" | (string & {});

export type SignedRequestOptions = {
  nonce?: number;
};

export class MonotonicNonceManager {
  private lastNonce = 0;

  next(explicitNonce?: number): number {
    if (explicitNonce !== undefined) {
      this.lastNonce = Math.max(this.lastNonce, explicitNonce);
      return explicitNonce;
    }

    const nonce = Math.max(Date.now(), this.lastNonce + 1);
    this.lastNonce = nonce;
    return nonce;
  }
}

export async function signWireRequest<TBody extends Record<string, unknown>>(params: {
  signer: GteSigner;
  source: GteClientSource;
  body: TBody;
  options?: SignedRequestOptions;
  nonceManager: MonotonicNonceManager;
}): Promise<TBody & { nonce: number; signature: string }> {
  const nonce = params.nonceManager.next(params.options?.nonce);
  if (params.source === "hyperliquid") {
    const signature = await signHyperliquidWireRequest({
      signer: params.signer,
      source: "hyperliquid",
      body: params.body,
      nonce,
    });
    return { ...params.body, nonce, signature };
  }

  const bodyWithNonce = { ...params.body, nonce };
  const message = stableStringify({
    source: params.source,
    body: bodyWithNonce,
  });
  const signature = await params.signer.signMessage({ message });
  return { ...bodyWithNonce, signature };
}

async function signHyperliquidWireRequest<TBody extends Record<string, unknown>>(params: {
  signer: GteSigner;
  source: "hyperliquid";
  body: TBody;
  nonce: number;
}): Promise<string> {
  const action = normalizeHyperliquidAction({
    type: "gteWireRequest",
    source: params.source,
    body: params.body,
  });
  const signature = await signL1Action({
    wallet: toHyperliquidWallet(params.signer),
    action,
    nonce: params.nonce,
  });

  return JSON.stringify({
    r: signature.r,
    s: signature.s,
    v: signature.v,
  });
}

function toHyperliquidWallet(signer: GteSigner): AbstractWallet {
  return {
    address: signer.address,
    signTypedData(params: unknown) {
      return signer.signTypedData(params as Parameters<GteSigner["signTypedData"]>[0]);
    },
  } as AbstractWallet;
}

function normalizeHyperliquidAction(value: unknown): Record<string, unknown> {
  const normalized = normalizeHyperliquidValue(value);
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new Error("Hyperliquid wire action must be an object");
  }
  return normalized as Record<string, unknown>;
}

function normalizeHyperliquidValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeHyperliquidValue(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeHyperliquidValue(child)]),
    );
  }

  return value;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}
