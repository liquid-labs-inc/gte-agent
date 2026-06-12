import type { Candle, Trade } from "../generated/types.gen";

const MICROS_PER_MILLI = 1000;

export function microsToMillis(micros: bigint | number | string): number {
  return Math.floor(Number(micros) / MICROS_PER_MILLI);
}

export function millisToMicros(millis: number): number {
  return millis * MICROS_PER_MILLI;
}

export function convertCandleTimestampFromMicrosToMillis(candle: Candle): Candle {
  return {
    ...candle,
    timestamp: candle.timestamp ? String(microsToMillis(candle.timestamp)) : candle.timestamp,
  };
}

export function convertTradeTimestampFromMicrosToMillis(trade: Trade): Trade {
  return {
    ...trade,
    timestamp: trade.timestamp ? String(microsToMillis(trade.timestamp)) : trade.timestamp,
  };
}
