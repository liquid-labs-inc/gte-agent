import { describe, expect, it } from "vitest";

import { normalizeAccountId } from "./account-id";

describe("normalizeAccountId", () => {
  it("equates padded and unpadded account ids", () => {
    expect(normalizeAccountId("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe(
      normalizeAccountId("0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266"),
    );
  });

  it("preserves canonical devnet account ids across 20-byte and 32-byte forms", () => {
    expect(normalizeAccountId("0x00000000000000000000019daedb552b00000006")).toBe(
      normalizeAccountId("0x00000000000000000000000000000000000000000000019daedb552b00000006"),
    );
  });

  it("normalizes zero-like inputs to 0x0", () => {
    expect(normalizeAccountId("0x0000")).toBe("0x0");
  });
});
