import { describe, expect, it } from "vitest";

import { getCandleIntervalMs, parseCandleInterval } from "../candle-interval";

describe("parseCandleInterval", () => {
  it("accepts canonical candle interval labels", () => {
    expect(parseCandleInterval("1m")).toBe("1m");
    expect(parseCandleInterval("5m")).toBe("5m");
    expect(parseCandleInterval("15m")).toBe("15m");
    expect(parseCandleInterval("30m")).toBe("30m");
    expect(parseCandleInterval("1h")).toBe("1h");
    expect(parseCandleInterval("4h")).toBe("4h");
    expect(parseCandleInterval("1d")).toBe("1d");
    expect(parseCandleInterval("1w")).toBe("1w");
  });

  it("rejects shorthand or unknown labels", () => {
    expect(() => parseCandleInterval("CANDLE_INTERVAL_1H")).toThrow(
      "Unknown candle interval: CANDLE_INTERVAL_1H",
    );
    expect(() => parseCandleInterval("1H")).toThrow("Unknown candle interval: 1H");
    expect(() => parseCandleInterval("120")).toThrow("Unknown candle interval: 120");
    expect(() => parseCandleInterval("unknown")).toThrow("Unknown candle interval: unknown");
  });
});

describe("getCandleIntervalMs", () => {
  it("returns expected milliseconds for supported intervals", () => {
    expect(getCandleIntervalMs("1m")).toBe(60_000);
    expect(getCandleIntervalMs("5m")).toBe(300_000);
    expect(getCandleIntervalMs("1h")).toBe(3_600_000);
    expect(getCandleIntervalMs("1d")).toBe(86_400_000);
    expect(getCandleIntervalMs("1w")).toBe(604_800_000);
  });
});
