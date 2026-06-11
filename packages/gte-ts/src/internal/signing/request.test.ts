import { describe, expect, it, vi } from "vitest";
import type { GteSigner } from "../types/signer";
import { type GteClientSource, MonotonicNonceManager, signWireRequest } from "./request";

const SIGNATURE_R = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const SIGNATURE_S = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const WALLET_SIGNATURE = `${SIGNATURE_R}${SIGNATURE_S.slice(2)}1b`;
const WIRE_SIGNATURE = JSON.stringify({
  r: SIGNATURE_R,
  s: SIGNATURE_S,
  v: 27,
});

function makeSigner(): GteSigner {
  return {
    address: "0x1234567890abcdef1234567890abcdef12345678",
    signTypedData: vi.fn(async () => WALLET_SIGNATURE as `0x${string}`),
    signMessage: vi.fn(async () => "fallback-signature" as `0x${string}`),
  };
}

describe("signWireRequest", () => {
  it("uses Hyperliquid L1 signing only for the hyperliquid source", async () => {
    const signer = makeSigner();

    const signed = await signWireRequest({
      signer,
      source: "hyperliquid",
      body: {
        orders: [{ symbol: "BTC-USD-PERP", quantity: "1" }],
      },
      options: { nonce: 123 },
      nonceManager: new MonotonicNonceManager(),
    });

    expect(signed).toEqual({
      orders: [{ symbol: "BTC-USD-PERP", quantity: "1" }],
      nonce: 123,
      signature: WIRE_SIGNATURE,
    });
    expect(signer.signTypedData).toHaveBeenCalledTimes(1);
    expect(signer.signMessage).not.toHaveBeenCalled();
  });

  it("keeps the message-signing path for future non-Hyperliquid sources", async () => {
    const signer = makeSigner();

    const signed = await signWireRequest({
      signer,
      source: "future-venue" as GteClientSource,
      body: { leverage: 3 },
      options: { nonce: 456 },
      nonceManager: new MonotonicNonceManager(),
    });

    expect(signed).toEqual({
      leverage: 3,
      nonce: 456,
      signature: "fallback-signature",
    });
    expect(signer.signTypedData).not.toHaveBeenCalled();
    expect(signer.signMessage).toHaveBeenCalledWith({
      message: '{"body":{"leverage":3,"nonce":456},"source":"future-venue"}',
    });
  });
});
