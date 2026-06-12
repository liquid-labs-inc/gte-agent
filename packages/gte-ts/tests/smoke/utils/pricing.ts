import type { TestConfig } from "./types.js";

const DEFAULT_REFERENCE_PRICE = 100;

function formatPrice(value: number): string {
  return value.toFixed(8).replace(/\.?0+$/u, "");
}

function referencePrice(config: TestConfig): number {
  return config.referencePrice ?? DEFAULT_REFERENCE_PRICE;
}

export function matchingPrice(config: TestConfig): string {
  return formatPrice(referencePrice(config));
}

export function restingBuyPrice(config: TestConfig): string {
  return formatPrice(referencePrice(config) * 0.99);
}

export function restingSellPrice(config: TestConfig): string {
  return formatPrice(referencePrice(config) * 1.01);
}

export function debugBuyPrice(config: TestConfig): string {
  return formatPrice(referencePrice(config) * 0.95);
}

export function debugSellPrice(config: TestConfig): string {
  return formatPrice(referencePrice(config) * 1.05);
}
