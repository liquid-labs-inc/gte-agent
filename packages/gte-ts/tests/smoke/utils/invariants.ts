export function assertDefined<T>(value: T | undefined | null, field: string): asserts value is T {
  if (value === undefined || value === null) {
    throw new Error(`${field} must be present, got ${String(value)}`);
  }
}

export function assertNonEmpty(value: string | undefined | null, field: string): void {
  assertDefined(value, field);
  if (value.length === 0) {
    throw new Error(`${field} must be non-empty string, got ""`);
  }
}

export function assertMinLength<T>(arr: T[], min: number, field: string): void {
  if (arr.length < min) {
    throw new Error(`${field} must have at least ${min} items, got ${arr.length}`);
  }
}

export function assertPositive(value: string | number, field: string): void {
  const num = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(num) || num <= 0) {
    throw new Error(`${field} must be positive, got ${value}`);
  }
}

export function assertNonNegative(value: string | number, field: string): void {
  const num = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(num) || num < 0) {
    throw new Error(`${field} must be non-negative, got ${value}`);
  }
}

export function assertApproxEqual(
  actual: string | number,
  expected: number,
  tolerance: number,
  field: string,
): void {
  const num = typeof actual === "string" ? Number(actual) : actual;
  if (Number.isNaN(num)) {
    throw new Error(`${field} must be a valid number, got ${actual}`);
  }
  if (Math.abs(num - expected) > tolerance) {
    throw new Error(`${field} expected ~${expected} (tolerance ${tolerance}), got ${num}`);
  }
}

export function assertValidNumber(value: string | number | undefined, field: string): number {
  assertDefined(value, field);
  const num = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(num)) {
    throw new Error(`${field} must be a valid number, got ${value}`);
  }
  return num;
}

export function assertSortedAsc(values: number[], field: string): void {
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1]) {
      throw new Error(
        `${field} must be sorted ascending at index ${i}: ${values[i - 1]} > ${values[i]}`,
      );
    }
  }
}

export function assertSortedDesc(values: number[], field: string): void {
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1]) {
      throw new Error(
        `${field} must be sorted descending at index ${i}: ${values[i - 1]} < ${values[i]}`,
      );
    }
  }
}

export function assertUnique<T>(values: T[], field: string): void {
  const seen = new Set<T>();
  for (const v of values) {
    if (seen.has(v)) {
      throw new Error(`${field} must be unique, found duplicate: ${v}`);
    }
    seen.add(v);
  }
}

export function assertValidEnum<T>(value: T, allowed: readonly T[], field: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of [${allowed.join(", ")}], got ${value}`);
  }
}

export function assertPositionFinancials(pos: {
  entryPrice?: string;
  markPrice?: string;
  liquidationPrice?: string;
  margin?: string;
  positionValue?: string;
  unrealizedPnl?: string;
  leverage?: number;
  size?: string;
}): void {
  if (!pos.entryPrice) throw new Error("position.entryPrice must be present and non-empty");
  if (!pos.markPrice) throw new Error("position.markPrice must be present and non-empty");
  if (!pos.positionValue) throw new Error("position.positionValue must be present and non-empty");
  if (!pos.margin) throw new Error("position.margin must be present and non-empty");

  assertPositive(pos.entryPrice, "position.entryPrice");
  assertPositive(pos.markPrice, "position.markPrice");
  assertPositive(pos.positionValue, "position.positionValue");
  assertNonNegative(pos.margin, "position.margin");
  if (pos.leverage !== undefined) assertPositive(pos.leverage, "position.leverage");
  if (pos.liquidationPrice !== undefined) {
    assertNonNegative(pos.liquidationPrice, "position.liquidationPrice");
  }

  if (pos.unrealizedPnl !== undefined) {
    const upnl = Number(pos.unrealizedPnl);
    if (Number.isNaN(upnl)) {
      throw new Error(`position.unrealizedPnl must be a valid number, got ${pos.unrealizedPnl}`);
    }
  }
}

export function assertCandleOHLC(candle: {
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  volume?: string;
}): void {
  const open = Number(candle.open);
  const high = Number(candle.high);
  const low = Number(candle.low);
  const close = Number(candle.close);
  const volume = Number(candle.volume);

  if (Number.isNaN(open) || Number.isNaN(high) || Number.isNaN(low) || Number.isNaN(close)) {
    throw new Error("Candle OHLC values must be valid numbers");
  }

  if (high < low) {
    throw new Error(`Candle high (${high}) must be >= low (${low})`);
  }
  if (high < open || high < close) {
    throw new Error(`Candle high (${high}) must be >= max(open=${open}, close=${close})`);
  }
  if (low > open || low > close) {
    throw new Error(`Candle low (${low}) must be <= min(open=${open}, close=${close})`);
  }
  if (candle.volume !== undefined && (Number.isNaN(volume) || volume < 0)) {
    throw new Error(`Candle volume must be non-negative, got ${candle.volume}`);
  }
}

function extractAndValidatePrices(
  levels: Array<{ price?: string; size?: string }>,
  label: string,
): number[] {
  const prices: number[] = [];
  for (const level of levels) {
    assertPositive(level.price ?? "", `${label}.price`);
    assertPositive(level.size ?? "", `${label}.size`);
    prices.push(Number(level.price));
  }
  return prices;
}

function assertBidAskSpread(bidPrices: number[], askPrices: number[]): void {
  if (bidPrices.length > 0 && askPrices.length > 0) {
    const bestBid = bidPrices[0];
    const bestAsk = askPrices[0];
    if (bestBid >= bestAsk) {
      throw new Error(`Best bid (${bestBid}) must be < best ask (${bestAsk})`);
    }
  }
}

export function assertOrderbookIntegrity(
  book: {
    bids?: Array<{ price?: string; size?: string }>;
    asks?: Array<{ price?: string; size?: string }>;
  },
  options?: { minBids?: number; minAsks?: number },
): void {
  const bids = book.bids ?? [];
  const asks = book.asks ?? [];

  assertMinLength(bids, options?.minBids ?? 0, "bids");
  assertMinLength(asks, options?.minAsks ?? 0, "asks");

  const bidPrices = extractAndValidatePrices(bids, "bid");
  const askPrices = extractAndValidatePrices(asks, "ask");

  assertUnique(bidPrices, "bid prices");
  assertUnique(askPrices, "ask prices");
  assertSortedDesc(bidPrices, "bid prices");
  assertSortedAsc(askPrices, "ask prices");
  assertBidAskSpread(bidPrices, askPrices);
}

export function assertTradeComplete(trade: {
  id?: string;
  marketSymbol?: string;
  price?: string;
  size?: string;
  side?: string;
  timestamp?: string;
  blockNumber?: string;
}): void {
  assertNonEmpty(trade.id, "trade.id");
  assertNonEmpty(trade.marketSymbol, "trade.marketSymbol");
  assertDefined(trade.price, "trade.price");
  assertPositive(trade.price, "trade.price");
  assertDefined(trade.size, "trade.size");
  assertPositive(trade.size, "trade.size");
  assertDefined(trade.side, "trade.side");
  assertValidEnum(trade.side, ["buy", "sell", "buy"] as const, "trade.side");
  assertNonEmpty(trade.timestamp, "trade.timestamp");
  assertNonEmpty(trade.blockNumber, "trade.blockNumber");
}

export function assertPositionComplete(pos: {
  marketSymbol?: string;
  side?: string;
  size?: string;
  entryPrice?: string;
  markPrice?: string;
  liquidationPrice?: string;
  margin?: string;
  positionValue?: string;
  unrealizedPnl?: string;
  leverage?: number;
  timestamp?: string;
}): void {
  assertNonEmpty(pos.marketSymbol, "position.marketSymbol");
  assertDefined(pos.side, "position.side");
  assertValidEnum(pos.side, ["long", "long", "short"] as const, "position.side");
  assertDefined(pos.size, "position.size");
  assertPositive(pos.size, "position.size");
  assertPositionFinancials(pos);
  assertNonEmpty(pos.timestamp, "position.timestamp");
}

export function assertMarketDataComplete(data: {
  markPrice?: number;
  indexPrice?: number;
  fundingRate?: number;
  openInterest?: number;
  midPrice?: number;
}): void {
  assertDefined(data.markPrice, "marketData.markPrice");
  assertPositive(data.markPrice, "marketData.markPrice");
  assertDefined(data.indexPrice, "marketData.indexPrice");
  assertPositive(data.indexPrice, "marketData.indexPrice");
  assertDefined(data.fundingRate, "marketData.fundingRate");
  assertValidNumber(data.fundingRate, "marketData.fundingRate");
  assertDefined(data.openInterest, "marketData.openInterest");
  assertNonNegative(data.openInterest, "marketData.openInterest");
}

export function assertBalanceComplete(bal: {
  token?: { symbol?: string };
  totalBalance?: number;
  balanceUsd?: number;
  freeCollateral?: number;
  tradingAllowance?: number;
}): void {
  assertDefined(bal.token, "balance.token");
  assertNonEmpty(bal.token.symbol, "balance.token.symbol");
  assertDefined(bal.totalBalance, "balance.totalBalance");
  assertNonNegative(bal.totalBalance, "balance.totalBalance");
  assertDefined(bal.balanceUsd, "balance.balanceUsd");
  assertNonNegative(bal.balanceUsd, "balance.balanceUsd");
  if (bal.freeCollateral !== undefined) {
    assertNonNegative(bal.freeCollateral, "balance.freeCollateral");
  }
  if (bal.tradingAllowance !== undefined) {
    assertNonNegative(bal.tradingAllowance, "balance.tradingAllowance");
  }
}

export function assertCandleComplete(candle: {
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  timestamp?: string;
}): void {
  assertDefined(candle.timestamp, "candle.timestamp");
  assertCandleOHLC({
    open: candle.open?.toString(),
    high: candle.high?.toString(),
    low: candle.low?.toString(),
    close: candle.close?.toString(),
    volume: candle.volume?.toString(),
  });
  assertDefined(candle.volume, "candle.volume");
  assertNonNegative(candle.volume, "candle.volume");
}

export function assertOpenOrderComplete(order: {
  orderId?: string;
  marketSymbol?: string;
  side?: string;
  limitPrice?: string;
  currentSize?: string;
  originalSize?: string;
  timestamp?: string;
  status?: string;
}): void {
  assertNonEmpty(order.orderId, "openOrder.orderId");
  assertNonEmpty(order.marketSymbol, "openOrder.marketSymbol");
  assertDefined(order.side, "openOrder.side");
  assertValidEnum(order.side, ["buy", "sell", "buy"] as const, "openOrder.side");
  assertDefined(order.limitPrice, "openOrder.limitPrice");
  assertPositive(order.limitPrice, "openOrder.limitPrice");
  assertDefined(order.currentSize, "openOrder.currentSize");
  assertPositive(order.currentSize, "openOrder.currentSize");
  assertDefined(order.originalSize, "openOrder.originalSize");
  assertPositive(order.originalSize, "openOrder.originalSize");
  assertNonEmpty(order.timestamp, "openOrder.timestamp");
}
