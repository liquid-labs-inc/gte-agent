import { describe, expect, it } from "vitest";
import { calculateLiquidationPrice, calculateMaxSize } from "../margin";

describe("calculateMaxSize", () => {
  it("should calculate max size correctly for normal leverage", () => {
    expect(calculateMaxSize(40, 25)).toBe(1000);
  });

  it("should calculate max size for 1x leverage", () => {
    expect(calculateMaxSize(1000, 1)).toBe(1000);
  });

  it("should calculate max size for fractional margin", () => {
    expect(calculateMaxSize(150, 5)).toBe(750);
  });

  it("should handle high leverage correctly", () => {
    expect(calculateMaxSize(30, 100)).toBe(3000);
  });

  it("should handle very small amounts", () => {
    expect(calculateMaxSize(0.5, 2)).toBe(1);
  });
});

describe("calculateLiquidationPrice", () => {
  const mmr = 0.01;

  it("returns 0 when baseSize is 0", () => {
    expect(
      calculateLiquidationPrice({
        entryPrice: 50_000,
        margin: 1000,
        side: "buy",
        baseSize: 0,
        maintenanceMarginRatio: mmr,
      }),
    ).toBe(0);
  });

  it("computes long liq price below entry", () => {
    // entry=50000, size=1, margin=5000 (10x), mmr=1%
    // liqPrice = (50000 - 5000) / (1 - 0.01) = 45000 / 0.99 = 45454.54...
    const result = calculateLiquidationPrice({
      entryPrice: 50_000,
      margin: 5000,
      side: "buy",
      baseSize: 1,
      maintenanceMarginRatio: mmr,
    });
    expect(result).toBeCloseTo(45454.55, 0);
    expect(result).toBeLessThan(50_000);
  });

  it("computes short liq price above entry", () => {
    // entry=50000, size=1, margin=5000 (10x), mmr=1%
    // liqPrice = (50000 + 5000) / (1 + 0.01) = 55000 / 1.01 = 54455.44...
    const result = calculateLiquidationPrice({
      entryPrice: 50_000,
      margin: 5000,
      side: "sell",
      baseSize: 1,
      maintenanceMarginRatio: mmr,
    });
    expect(result).toBeCloseTo(54455.45, 0);
    expect(result).toBeGreaterThan(50_000);
  });

  it("returns 0 for long when mmr >= 1/leverage (immediately liquidatable)", () => {
    // 50x leverage with mmr=0.03: margin=1000, marginPerSize=1000
    // liqPrice = (50000 - 1000) / (1 - 0.03) = 49000 / 0.97 = 50515 > entry
    const result = calculateLiquidationPrice({
      entryPrice: 50_000,
      margin: 1000,
      side: "buy",
      baseSize: 1,
      maintenanceMarginRatio: 0.03,
    });
    expect(result).toBe(0);
  });

  it("returns 0 for short when mmr would push liq below entry", () => {
    // Very high margin relative to entry makes (entry + margin/size) / (1 + mmr) < entry
    // This shouldn't normally happen, but guard is there for safety
    // With entry=100, margin=100000, size=1, mmr=0.01:
    // liqPrice = (100 + 100000) / (1 + 0.01) = 100100/1.01 = 99108.9 < entry? No, > entry.
    // For shorts, liqPrice < entry can't happen with positive margin.
    // Instead test with margin=0 which gives liqPrice = entry/(1+mmr) < entry
    const result = calculateLiquidationPrice({
      entryPrice: 100,
      margin: 0,
      side: "sell",
      baseSize: 1,
      maintenanceMarginRatio: 0.01,
    });
    expect(result).toBe(0);
  });

  it("works with correct mmr derived from maxLeverage", () => {
    // BTC: maxLeverage=50, mmr = 1/(2*50) = 0.01
    // At 50x: entry=50000, size=1, margin=1000
    // liqPrice = (50000 - 1000) / (1 - 0.01) = 49000/0.99 = 49494.9
    const result = calculateLiquidationPrice({
      entryPrice: 50_000,
      margin: 1000,
      side: "buy",
      baseSize: 1,
      maintenanceMarginRatio: 0.01,
    });
    expect(result).toBeCloseTo(49494.95, 0);
    expect(result).toBeLessThan(50_000);
  });
});
