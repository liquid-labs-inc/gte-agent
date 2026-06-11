import { describe, expect, it } from "vitest";

import { isFlatPerpPosition } from "../positions";

describe("isFlatPerpPosition", () => {
  it("returns true for integer zero sizes", () => {
    expect(isFlatPerpPosition({ size: "0" })).toBe(true);
  });

  it("returns true for fixed-point zero sizes", () => {
    expect(isFlatPerpPosition({ size: "0.00000000" })).toBe(true);
  });

  it("returns false for non-zero sizes", () => {
    expect(isFlatPerpPosition({ size: "0.00000001" })).toBe(false);
  });

  it("returns false when size is missing", () => {
    expect(isFlatPerpPosition({ size: undefined })).toBe(false);
  });
});
