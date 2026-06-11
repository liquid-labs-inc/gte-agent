import { describe, expect, it } from "vitest";
import type { Candle } from "../../internal/generated/types.gen";
import { calculateRsi } from "../charting";

function makeCandles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    timestamp: `2024-01-${i + 1}`,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
  }));
}

describe("calculateRsi", () => {
  it("returns empty array when candles.length <= n", () => {
    const candles = makeCandles([100, 101, 102]);
    const result = calculateRsi(candles, 14);

    expect(result).toEqual([]);
  });

  it("returns n+1 values for n+1 candles", () => {
    const closes = [44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84];
    const candles = makeCandles(closes);
    const result = calculateRsi(candles, 5);

    expect(result).toHaveLength(closes.length - 5);
    expect(result[0]).toBeGreaterThanOrEqual(0);
  });

  it("calculates RSI correctly for uptrend", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const candles = makeCandles(closes);
    const result = calculateRsi(candles, 14);

    const lastRsi = result[result.length - 1];
    expect(lastRsi).toBe(100);
  });

  it("calculates RSI correctly for downtrend", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i);
    const candles = makeCandles(closes);
    const result = calculateRsi(candles, 14);

    const lastRsi = result[result.length - 1];
    expect(lastRsi).toBe(0);
  });

  it("calculates RSI around 50 for mixed movement", () => {
    const closes = [100, 102, 100, 102, 100, 102, 100, 102, 100, 102, 100, 102, 100, 102, 100];
    const candles = makeCandles(closes);
    const result = calculateRsi(candles, 14);

    const lastRsi = result[result.length - 1];
    expect(lastRsi).toBeCloseTo(50, 0);
  });

  it("returns 50 for flat prices", () => {
    const closes = Array.from({ length: 15 }, () => 100);
    const candles = makeCandles(closes);
    const result = calculateRsi(candles, 14);

    expect(result[0]).toBe(50);
  });

  it("uses default n=14", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const candles = makeCandles(closes);
    const result = calculateRsi(candles);

    expect(result).toHaveLength(6);
  });

  it("returns length of candles - n", () => {
    const candles = makeCandles(Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 10));
    const result = calculateRsi(candles, 14);

    expect(result).toHaveLength(16);
  });
});
