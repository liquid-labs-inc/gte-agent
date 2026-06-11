import type { CandleInterval } from "../internal/generated/types.gen";

const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "2m": 2 * 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "10m": 10 * 60_000,
  "15m": 15 * 60_000,
  "20m": 20 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

export const CANDLE_INTERVAL_LABELS = Object.keys(INTERVAL_MS) as [
  CandleInterval,
  ...CandleInterval[],
];

export function parseCandleInterval(label: string): CandleInterval {
  if (label in INTERVAL_MS) {
    return label as CandleInterval;
  }
  throw new Error(`Unknown candle interval: ${label}`);
}

export function getCandleIntervalMs(interval: CandleInterval): number {
  return INTERVAL_MS[interval];
}
