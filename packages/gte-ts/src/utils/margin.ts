import type { TradeSide } from "../internal/types";

export function calculateInitialMargin(size: number, leverage: number): number {
  let _leverage = leverage;
  if (_leverage === 0) {
    _leverage = 1;
  }

  return size / _leverage;
}

export function calculateMaxSize(margin: number, leverage: number): number {
  return leverage * margin;
}

type CalculateLiquidationPriceParameters = {
  entryPrice: number;
  margin: number;
  side: TradeSide;
  baseSize: number;
  maintenanceMarginRatio: number;
};

export function calculateLiquidationPrice({
  entryPrice,
  margin,
  side,
  baseSize,
  maintenanceMarginRatio,
}: CalculateLiquidationPriceParameters): number {
  if (baseSize === 0) {
    return 0;
  }

  const marginPerSize = margin / baseSize;

  // Derived from margin engine is_liquidatable:
  //   equity = margin + unrealizedPnl
  //   liquidatable when equity < maintenanceMarginRatio * notional
  //
  // LONG:  liqPrice = (entryPrice - marginPerSize) / (1 - mmr)
  // SHORT: liqPrice = (entryPrice + marginPerSize) / (1 + mmr)
  if (side === "buy") {
    const liqPrice = (entryPrice - marginPerSize) / (1 - maintenanceMarginRatio);
    if (liqPrice >= entryPrice) return 0;
    return liqPrice;
  }
  const liqPrice = (entryPrice + marginPerSize) / (1 + maintenanceMarginRatio);
  if (liqPrice <= entryPrice) return 0;
  return liqPrice;
}
