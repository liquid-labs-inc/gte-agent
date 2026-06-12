import type {
  AccountMetricsUpdate,
  Candle,
  GetBalancesResponse,
  GteDataClient,
  HttpBook,
  MarketDataPerps,
  PerpOpenOrder,
  PerpPosition,
  Trade,
} from "../../../src/index.js";
import {
  buildOrder,
  createDevnetAccount,
  creditAccount,
  creditAccounts,
  placeMatchingOrders,
  placeRestingOrdersAtPrices,
  postOrders,
} from "../utils/devnet.js";
import {
  assertCandleOHLC,
  assertNonNegative,
  assertOrderbookIntegrity,
  assertPositive,
  assertValidEnum,
} from "../utils/invariants.js";
import { matchingPrice, restingBuyPrice, restingSellPrice } from "../utils/pricing.js";
import { retryUntil, runSuite, sleep } from "../utils/runner.js";
import type { SuiteResult, TestConfig, TestDefinition } from "../utils/types.js";

const BALANCE_CHANGE_EPSILON = 1e-6;
const BALANCE_COMPARE_RELATIVE_TOLERANCE = 1e-6;
const BALANCE_COMPARE_ABSOLUTE_TOLERANCE = 1e-6;
const DATA_STREAM_CREDIT_AMOUNT = 200;
const DATA_STREAM_ORDER_QUANTITY = "0.001";

function waitForMessages<T>(
  subscribe: (onData: (data: T) => void) => Promise<() => void>,
  count: number,
  timeout: number,
): Promise<T[]> {
  const messages: T[] = [];
  let unsubscribe: (() => void) | null = null;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanupSubscription(unsubscribe);
      if (messages.length === 0) {
        reject(new Error(`No messages received within ${timeout}ms`));
      } else {
        resolve(messages);
      }
    }, timeout);

    subscribe((data) => {
      messages.push(data);
      if (messages.length >= count) {
        clearTimeout(timer);
        cleanupSubscription(unsubscribe);
        resolve(messages);
      }
    })
      .then((unsub) => {
        unsubscribe = unsub;
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function waitForMessageMatching<T>(
  subscribe: (onData: (data: T) => void) => Promise<() => void>,
  predicate: (data: T) => boolean,
  timeout: number,
): Promise<T> {
  let unsubscribe: (() => void) | null = null;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanupSubscription(unsubscribe);
      reject(new Error(`No matching message received within ${timeout}ms`));
    }, timeout);

    subscribe((data) => {
      if (predicate(data)) {
        clearTimeout(timer);
        cleanupSubscription(unsubscribe);
        resolve(data);
      }
    })
      .then((unsub) => {
        unsubscribe = unsub;
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function cleanupSubscription(unsubscribe: (() => void) | null): void {
  try {
    if (unsubscribe) unsubscribe();
  } catch {
    // Ignore cleanup errors
  }
}

function bookToInvariantFormat(book: HttpBook): {
  bids?: Array<{ price?: string; size?: string }>;
  asks?: Array<{ price?: string; size?: string }>;
} {
  return {
    bids: (book.bids ?? []).map((l) => ({
      price: l.price?.toString(),
      size: l.qty,
    })),
    asks: (book.asks ?? []).map((l) => ({
      price: l.price?.toString(),
      size: l.qty,
    })),
  };
}

function candleToInvariantFormat(candle: Candle): {
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  volume?: string;
} {
  return {
    open: candle.open?.toString(),
    high: candle.high?.toString(),
    low: candle.low?.toString(),
    close: candle.close?.toString(),
    volume: candle.volume?.toString(),
  };
}

function assertOpenOrder(order: PerpOpenOrder, expectedSymbol?: string): void {
  if (!order.orderId || order.orderId.length === 0) {
    throw new Error(`openOrder missing orderId, got: ${JSON.stringify(order)}`);
  }
  if (expectedSymbol && order.marketSymbol !== expectedSymbol) {
    throw new Error(
      `openOrder marketSymbol mismatch: expected ${expectedSymbol}, got ${order.marketSymbol}`,
    );
  }
  if (!order.side) {
    throw new Error(`openOrder missing side, got: ${JSON.stringify(order)}`);
  }
  assertValidEnum(order.side, ["buy", "sell", "buy"], "openOrder.side");
  if (!order.limitPrice) {
    throw new Error(`openOrder missing limitPrice, got: ${JSON.stringify(order)}`);
  }
  assertPositive(order.limitPrice, "openOrder.limitPrice");
  if (!order.currentSize) {
    throw new Error(`openOrder missing currentSize, got: ${JSON.stringify(order)}`);
  }
  assertPositive(order.currentSize, "openOrder.currentSize");
}

function assertOptionalNonNegative(value: number | undefined, label: string): void {
  if (value !== undefined) assertNonNegative(value, label);
}

function validateBalanceUpdate(update: GetBalancesResponse): void {
  for (const bal of [...(update.spot ?? []), ...(update.perps ?? [])]) {
    if (bal.token?.symbol === undefined) throw new Error("Missing token.symbol");
    assertOptionalNonNegative(bal.totalBalance, "totalBalance");
    assertOptionalNonNegative(bal.freeCollateral, "freeCollateral");
    assertOptionalNonNegative(bal.tradingAllowance, "tradingAllowance");
    assertOptionalNonNegative(bal.balanceUsd, "balanceUsd");
  }
}

type PerpBalance = NonNullable<GetBalancesResponse["perps"]>[number];

function findPerpCollateralBalance(update: GetBalancesResponse, label: string): PerpBalance {
  const balance = (update.perps ?? []).find((bal) => {
    const symbol = bal.token?.symbol?.toUpperCase();
    return symbol === "USDC" || symbol === "USD";
  });
  if (!balance) {
    throw new Error(`${label} missing USDC perps balance: ${JSON.stringify(update)}`);
  }
  return balance;
}

function requireBalanceNumber(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number, got ${String(value)}`);
  }
  return value;
}

function assertCloseToHttp(wsValue: number, httpValue: number, label: string): void {
  const tolerance = Math.max(
    BALANCE_COMPARE_ABSOLUTE_TOLERANCE,
    Math.abs(httpValue) * BALANCE_COMPARE_RELATIVE_TOLERANCE,
  );
  if (Math.abs(wsValue - httpValue) > tolerance) {
    throw new Error(
      `${label} WS/HTTP mismatch: ws=${wsValue} http=${httpValue} tolerance=${tolerance}`,
    );
  }
}

function assertCloseNumber(
  actual: number,
  expected: number,
  label: string,
  tolerance = 1e-8,
): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${label} mismatch: actual=${actual} expected=${expected} tolerance=${tolerance}`,
    );
  }
}

function balanceChanged(before: PerpBalance, update: GetBalancesResponse): boolean {
  try {
    const after = findPerpCollateralBalance(update, "stream update");
    const beforeTotal = requireBalanceNumber(before.totalBalance, "before.totalBalance");
    const beforeFreeCollateral = requireBalanceNumber(
      before.freeCollateral,
      "before.freeCollateral",
    );
    const afterTotal = requireBalanceNumber(after.totalBalance, "stream.totalBalance");
    const afterFreeCollateral = requireBalanceNumber(after.freeCollateral, "stream.freeCollateral");

    return (
      Math.abs(afterTotal - beforeTotal) > BALANCE_CHANGE_EPSILON ||
      Math.abs(afterFreeCollateral - beforeFreeCollateral) > BALANCE_CHANGE_EPSILON
    );
  } catch {
    return false;
  }
}

async function testBookStream(client: GteDataClient, config: TestConfig): Promise<void> {
  const bookPromise = waitForMessages<HttpBook>(
    (onData) =>
      client.streams.book({
        params: { symbol: config.symbol },
        onData,
      }),
    1,
    config.wsTimeout,
  );

  bookPromise.catch(() => {});

  await sleep(500);
  await placeRestingOrdersAtPrices(
    config.httpUrl,
    config.symbol,
    restingBuyPrice(config),
    restingSellPrice(config),
  );

  const messages = await bookPromise;
  for (const book of messages) {
    assertOrderbookIntegrity(bookToInvariantFormat(book));
  }
}

async function testTradesStream(client: GteDataClient, config: TestConfig): Promise<void> {
  const tradePromise = waitForMessages<Trade[]>(
    (onData) =>
      client.streams.trades({
        params: { symbol: config.symbol },
        onData,
      }),
    1,
    config.wsTimeout,
  );

  tradePromise.catch(() => {});

  await sleep(500);
  await placeMatchingOrders(config.httpUrl, config.symbol, matchingPrice(config));

  const messages = await tradePromise;
  if (messages.length === 0) throw new Error("Expected at least one trade message");
  for (const trades of messages) {
    for (const trade of trades) {
      if (trade.marketSymbol !== config.symbol) {
        throw new Error(
          `trade marketSymbol mismatch: expected ${config.symbol}, got ${trade.marketSymbol}`,
        );
      }
      assertPositive(trade.price ?? "", "trade.price");
      assertPositive(trade.size ?? "", "trade.size");
    }
  }
}

async function testBalancesStream(client: GteDataClient, config: TestConfig): Promise<void> {
  const userAddress = createDevnetAccount();

  if (!config.httpUrl) {
    throw new Error("httpUrl is required for GTE balance stream credit smoke");
  }

  const balancePromise = waitForMessageMatching<GetBalancesResponse>(
    (onData) =>
      client.streams.balances({
        params: { userAddress },
        onData,
      }),
    (update) => {
      try {
        const balance = findPerpCollateralBalance(update, "balance stream credit update");
        return (
          requireBalanceNumber(balance.totalBalance, "stream.totalBalance") > 0 &&
          requireBalanceNumber(balance.tradingAllowance, "stream.tradingAllowance") > 0
        );
      } catch {
        return false;
      }
    },
    config.wsTimeout,
  );

  balancePromise.catch(() => {});

  await creditAccount(userAddress, config.httpUrl);

  const wsUpdate = await balancePromise;
  validateBalanceUpdate(wsUpdate);
  const wsPerp = findPerpCollateralBalance(wsUpdate, "balance stream credit update");
  const wsTotal = requireBalanceNumber(wsPerp.totalBalance, "stream.totalBalance");
  const wsFreeCollateral = requireBalanceNumber(wsPerp.freeCollateral, "stream.freeCollateral");
  const wsTradingAllowance = requireBalanceNumber(
    wsPerp.tradingAllowance,
    "stream.tradingAllowance",
  );
  if (wsTotal <= 0 || wsTradingAllowance <= 0) {
    throw new Error(
      `Balance stream must receive credited total and final grant state, got total=${wsTotal} tradingAllowance=${wsTradingAllowance}`,
    );
  }

  await retryUntil(
    async () => {
      const httpUpdate = await client.portfolio.getBalances({ userAddress });
      const httpPerp = findPerpCollateralBalance(httpUpdate, "post-credit HTTP balances");
      assertCloseToHttp(
        wsTotal,
        requireBalanceNumber(httpPerp.totalBalance, "http.totalBalance"),
        "credit totalBalance",
      );
      assertCloseToHttp(
        wsFreeCollateral,
        requireBalanceNumber(httpPerp.freeCollateral, "http.freeCollateral"),
        "credit freeCollateral",
      );
      assertCloseToHttp(
        wsTradingAllowance,
        requireBalanceNumber(httpPerp.tradingAllowance, "http.tradingAllowance"),
        "credit tradingAllowance",
      );
    },
    Math.max(config.timeout, 5000),
  );
}

async function testBalancesStreamAfterFillMatchesHttp(
  client: GteDataClient,
  config: TestConfig,
): Promise<void> {
  if (!config.httpUrl) {
    throw new Error("httpUrl is required for GTE balance stream fill smoke");
  }

  const userAddress = createDevnetAccount();
  const counterpartyAddress = createDevnetAccount();

  await creditAccounts(
    [userAddress, counterpartyAddress],
    config.httpUrl,
    DATA_STREAM_CREDIT_AMOUNT,
  );
  await sleep(500);

  const before = await client.portfolio.getBalances({
    userAddress,
  });
  const beforePerp = findPerpCollateralBalance(before, "pre-trade HTTP balances");

  const balancePromise = waitForMessageMatching<GetBalancesResponse>(
    (onData) =>
      client.streams.balances({
        params: { userAddress },
        onData,
      }),
    (update) => balanceChanged(beforePerp, update),
    config.wsTimeout,
  );

  balancePromise.catch(() => {});

  const makerClientOrderId = String(Date.now());
  await postOrders(
    [
      buildOrder(
        counterpartyAddress,
        "sell",
        config.symbol,
        matchingPrice(config),
        DATA_STREAM_ORDER_QUANTITY,
        {
          clientOrderId: makerClientOrderId,
        },
      ),
    ],
    config.httpUrl,
  );

  await sleep(500);

  await postOrders(
    [
      buildOrder(userAddress, "buy", config.symbol, "0", DATA_STREAM_ORDER_QUANTITY, {
        orderType: "market",
        timeInForce: "ioc",
        clientOrderId: String(Number(makerClientOrderId) + 1),
      }),
    ],
    config.httpUrl,
  );

  const wsUpdate = await balancePromise;
  validateBalanceUpdate(wsUpdate);

  const wsPerp = findPerpCollateralBalance(wsUpdate, "balance stream update");
  const wsTotal = requireBalanceNumber(wsPerp.totalBalance, "stream.totalBalance");
  const wsFreeCollateral = requireBalanceNumber(wsPerp.freeCollateral, "stream.freeCollateral");
  const wsTradingAllowance = requireBalanceNumber(
    wsPerp.tradingAllowance,
    "stream.tradingAllowance",
  );

  await retryUntil(
    async () => {
      const httpUpdate = await client.portfolio.getBalances({
        userAddress,
      });
      const httpPerp = findPerpCollateralBalance(httpUpdate, "post-trade HTTP balances");
      const httpTotal = requireBalanceNumber(httpPerp.totalBalance, "http.totalBalance");
      const httpFreeCollateral = requireBalanceNumber(
        httpPerp.freeCollateral,
        "http.freeCollateral",
      );
      const httpTradingAllowance = requireBalanceNumber(
        httpPerp.tradingAllowance,
        "http.tradingAllowance",
      );

      assertCloseToHttp(wsTotal, httpTotal, "totalBalance");
      assertCloseToHttp(wsFreeCollateral, httpFreeCollateral, "freeCollateral");
      assertCloseToHttp(wsTradingAllowance, httpTradingAllowance, "tradingAllowance");
    },
    Math.max(config.timeout, 5000),
  );
}

function validatePositionMessages(messages: PerpPosition[][]): void {
  for (const positions of messages) {
    if (!Array.isArray(positions)) {
      throw new Error("Expected positions to be an array");
    }
    if (positions.length === 0) {
      throw new Error("Expected non-empty positions array after placing orders");
    }
    for (const pos of positions) {
      if (!pos.side) throw new Error("Position missing side");
      if (!pos.size) throw new Error("Position missing size");
      assertPositive(pos.size, "position.size");
    }
  }
}

function findPositionForSymbol(
  positions: PerpPosition[] | undefined,
  symbol: string,
): PerpPosition | undefined {
  return (positions ?? []).find((position) => position.marketSymbol === symbol);
}

function positionSize(position: PerpPosition | undefined): number {
  return Number.parseFloat(position?.size ?? "0");
}

function assertStreamPositionMatchesHttp(
  wsPosition: PerpPosition,
  httpPosition: PerpPosition,
): void {
  if (wsPosition.marketSymbol !== httpPosition.marketSymbol) {
    throw new Error(
      `position marketSymbol mismatch: ws=${wsPosition.marketSymbol} http=${httpPosition.marketSymbol}`,
    );
  }
  if (wsPosition.side !== httpPosition.side) {
    throw new Error(`position side mismatch: ws=${wsPosition.side} http=${httpPosition.side}`);
  }
  assertCloseNumber(
    Number.parseFloat(wsPosition.size ?? "0"),
    Number.parseFloat(httpPosition.size ?? "0"),
    "position.size",
  );
}

function assertStreamOpenOrderMatchesHttp(wsOrder: PerpOpenOrder, httpOrder: PerpOpenOrder): void {
  if (wsOrder.orderId !== httpOrder.orderId) {
    throw new Error(`openOrder orderId mismatch: ws=${wsOrder.orderId} http=${httpOrder.orderId}`);
  }
  if (wsOrder.marketSymbol !== httpOrder.marketSymbol) {
    throw new Error(
      `openOrder marketSymbol mismatch: ws=${wsOrder.marketSymbol} http=${httpOrder.marketSymbol}`,
    );
  }
  if (wsOrder.side !== httpOrder.side) {
    throw new Error(`openOrder side mismatch: ws=${wsOrder.side} http=${httpOrder.side}`);
  }
  if (wsOrder.clientId !== httpOrder.clientId) {
    throw new Error(
      `openOrder clientId mismatch: ws=${wsOrder.clientId} http=${httpOrder.clientId}`,
    );
  }
  assertCloseNumber(
    Number.parseFloat(wsOrder.limitPrice ?? "0"),
    Number.parseFloat(httpOrder.limitPrice ?? "0"),
    "openOrder.limitPrice",
  );
  assertCloseNumber(
    Number.parseFloat(wsOrder.currentSize ?? "0"),
    Number.parseFloat(httpOrder.currentSize ?? "0"),
    "openOrder.currentSize",
  );
}

async function testPositionsStream(client: GteDataClient, config: TestConfig): Promise<void> {
  if (!config.httpUrl) {
    throw new Error("httpUrl is required for GTE positions stream smoke");
  }

  const userAddress = createDevnetAccount();
  const counterpartyAddress = createDevnetAccount();
  await creditAccounts(
    [userAddress, counterpartyAddress],
    config.httpUrl,
    DATA_STREAM_CREDIT_AMOUNT,
  );
  await sleep(500);

  const before = await client.accounts.getPositions({
    userAddress,
    symbol: config.symbol,
  });
  const beforeSize = positionSize(findPositionForSymbol(before.positions, config.symbol));

  const positionPromise = waitForMessageMatching<PerpPosition[]>(
    (onData) =>
      client.streams.positions({
        params: { userAddress },
        onData,
      }),
    (positions) => {
      const position = findPositionForSymbol(positions, config.symbol);
      return position !== undefined && positionSize(position) > beforeSize;
    },
    config.wsTimeout,
  );

  positionPromise.catch(() => {});

  const clientOrderId = Date.now();
  await postOrders(
    [
      buildOrder(
        counterpartyAddress,
        "sell",
        config.symbol,
        matchingPrice(config),
        DATA_STREAM_ORDER_QUANTITY,
        {
          clientOrderId: String(clientOrderId),
        },
      ),
    ],
    config.httpUrl,
  );
  await sleep(500);
  await postOrders(
    [
      buildOrder(userAddress, "buy", config.symbol, "0", DATA_STREAM_ORDER_QUANTITY, {
        orderType: "market",
        timeInForce: "ioc",
        clientOrderId: String(clientOrderId + 1),
      }),
    ],
    config.httpUrl,
  );

  const positions = await positionPromise;
  validatePositionMessages([positions]);
  const wsPosition = findPositionForSymbol(positions, config.symbol);
  if (!wsPosition) throw new Error(`Position stream did not include ${config.symbol}`);

  await retryUntil(
    async () => {
      const httpPositions = await client.accounts.getPositions({
        userAddress,
        symbol: config.symbol,
      });
      const httpPosition = findPositionForSymbol(httpPositions.positions, config.symbol);
      if (!httpPosition || positionSize(httpPosition) <= beforeSize) {
        throw new Error(`HTTP position did not increase above beforeSize=${beforeSize}`);
      }
      assertStreamPositionMatchesHttp(wsPosition, httpPosition);
    },
    Math.max(config.timeout, 5000),
  );
}

async function testOpenOrdersStream(client: GteDataClient, config: TestConfig): Promise<void> {
  if (!config.httpUrl) {
    throw new Error("httpUrl is required for GTE openOrders stream smoke");
  }

  const userAddress = createDevnetAccount();
  await creditAccount(userAddress, config.httpUrl, DATA_STREAM_CREDIT_AMOUNT);
  await sleep(500);

  const clientOrderId = String(Date.now());
  const ordersPromise = waitForMessageMatching<PerpOpenOrder[]>(
    (onData) =>
      client.streams.openOrders({
        params: { userAddress, symbol: config.symbol },
        onData,
      }),
    (orders) => orders.some((order) => order.clientId === clientOrderId),
    config.wsTimeout,
  );

  ordersPromise.catch(() => {});

  await sleep(500);
  await postOrders(
    [
      buildOrder(
        userAddress,
        "buy",
        config.symbol,
        restingBuyPrice(config),
        DATA_STREAM_ORDER_QUANTITY,
        {
          clientOrderId,
        },
      ),
    ],
    config.httpUrl,
  );

  const streamOrders = await ordersPromise;
  const wsOrder = streamOrders.find((order) => order.clientId === clientOrderId);
  if (!wsOrder) throw new Error(`openOrders stream missing clientId=${clientOrderId}`);
  assertOpenOrder(wsOrder, config.symbol);

  await retryUntil(
    async () => {
      const httpOrders = await client.accounts.getOpenOrders({
        userAddress,
        symbol: config.symbol,
      });
      const httpOrder = (httpOrders.orders ?? []).find((order) => order.clientId === clientOrderId);
      if (!httpOrder) {
        throw new Error(`HTTP openOrders missing clientId=${clientOrderId}`);
      }
      assertStreamOpenOrderMatchesHttp(wsOrder, httpOrder);
    },
    Math.max(config.timeout, 5000),
  );
}

async function testMarketDataGte(client: GteDataClient, config: TestConfig): Promise<void> {
  // Trades were placed by earlier stream tests. Wait for a message where
  // volume24h > 0, proving the archive → WS pipeline works end-to-end.
  const data = await waitForMessageMatching<MarketDataPerps>(
    (onData) =>
      client.streams.marketData({
        params: { symbol: config.symbol },
        onData,
      }),
    (d) => d.volume24h !== undefined && d.volume24h > 0,
    config.wsTimeout,
  );
  assertPositive(data.markPrice ?? 0, "marketData.markPrice");
  assertPositive(data.indexPrice ?? 0, "marketData.indexPrice");
  assertPositive(data.volume24h ?? 0, "marketData.volume24h");
  assertPositive(data.prevDayPrice ?? 0, "marketData.prevDayPrice");
}

async function testAccountMetricsStreamAfterFillMatchesHttp(
  client: GteDataClient,
  config: TestConfig,
): Promise<void> {
  if (!config.httpUrl) {
    throw new Error("httpUrl is required for GTE account metrics stream smoke");
  }

  const userAddress = createDevnetAccount();
  const counterpartyAddress = createDevnetAccount();

  await creditAccounts(
    [userAddress, counterpartyAddress],
    config.httpUrl,
    DATA_STREAM_CREDIT_AMOUNT,
  );
  await sleep(500);

  const metricsPromise = waitForMessageMatching<AccountMetricsUpdate>(
    (onData) =>
      client.streams.accountMetrics({
        params: { userAddress },
        onData,
      }),
    (update) => {
      const notional = Number.parseFloat(update.totalNotional ?? "0");
      const tradingAllowance = Number.parseFloat(update.tradingAllowance ?? "0");
      return (
        Number.isFinite(notional) &&
        notional > 0 &&
        Number.isFinite(tradingAllowance) &&
        tradingAllowance > 0
      );
    },
    config.wsTimeout,
  );

  metricsPromise.catch(() => {});

  const makerClientOrderId = String(Date.now());
  await postOrders(
    [
      buildOrder(
        counterpartyAddress,
        "sell",
        config.symbol,
        matchingPrice(config),
        DATA_STREAM_ORDER_QUANTITY,
        {
          clientOrderId: makerClientOrderId,
        },
      ),
    ],
    config.httpUrl,
  );
  await sleep(500);

  await postOrders(
    [
      buildOrder(userAddress, "buy", config.symbol, "0", DATA_STREAM_ORDER_QUANTITY, {
        orderType: "market",
        timeInForce: "ioc",
        clientOrderId: String(Number(makerClientOrderId) + 1),
      }),
    ],
    config.httpUrl,
  );

  const wsUpdate = await metricsPromise;

  const wsAccountValue = requireBalanceNumber(
    Number.parseFloat(wsUpdate.accountValue ?? "0"),
    "stream.accountValue",
  );
  const wsTotalMarginUsed = requireBalanceNumber(
    Number.parseFloat(wsUpdate.totalMarginUsed ?? "0"),
    "stream.totalMarginUsed",
  );
  const wsTotalNotional = requireBalanceNumber(
    Number.parseFloat(wsUpdate.totalNotional ?? "0"),
    "stream.totalNotional",
  );
  const wsFreeCollateral = requireBalanceNumber(
    Number.parseFloat(wsUpdate.freeCollateral ?? "0"),
    "stream.freeCollateral",
  );
  const wsTradingAllowance = requireBalanceNumber(
    Number.parseFloat(wsUpdate.tradingAllowance ?? "0"),
    "stream.tradingAllowance",
  );

  if (wsTotalMarginUsed <= 0) {
    throw new Error(`totalMarginUsed must be positive after fill, got ${wsTotalMarginUsed}`);
  }
  if (wsTotalNotional <= 0) {
    throw new Error(`totalNotional must be positive after fill, got ${wsTotalNotional}`);
  }
  if (wsTradingAllowance <= 0) {
    throw new Error(`tradingAllowance must be positive after fill, got ${wsTradingAllowance}`);
  }

  // Parity: streamer reuses the same compute path as GET_ACCOUNT_METRICS.
  await retryUntil(
    async () => {
      const http = await client.accounts.getAccountMetrics({ userAddress });

      const httpAccountValue = requireBalanceNumber(
        Number.parseFloat(http.accountValue ?? "0"),
        "http.accountValue",
      );
      const httpTotalMarginUsed = requireBalanceNumber(
        Number.parseFloat(http.totalMarginUsed ?? "0"),
        "http.totalMarginUsed",
      );
      const httpTotalNotional = requireBalanceNumber(
        Number.parseFloat(http.totalNotional ?? "0"),
        "http.totalNotional",
      );
      const httpMaintenanceMargin = requireBalanceNumber(
        Number.parseFloat(http.maintenanceMargin ?? "0"),
        "http.maintenanceMargin",
      );
      const httpUnrealizedPnl = requireBalanceNumber(
        Number.parseFloat(http.unrealizedPnl ?? "0"),
        "http.unrealizedPnl",
      );
      const httpFreeCollateral = requireBalanceNumber(
        Number.parseFloat(http.freeCollateral ?? "0"),
        "http.freeCollateral",
      );
      const httpTradingAllowance = requireBalanceNumber(
        Number.parseFloat(http.tradingAllowance ?? "0"),
        "http.tradingAllowance",
      );

      // Parity covers margin-critical fields only. totalVolume/totalTrades
      // are archive-derived and HTTP-only (see ws.proto comment) to avoid
      // fill-vs-archive races overwriting fresh HTTP values.
      assertCloseToHttp(wsAccountValue, httpAccountValue, "accountValue");
      assertCloseToHttp(wsFreeCollateral, httpFreeCollateral, "freeCollateral");
      assertCloseToHttp(wsTradingAllowance, httpTradingAllowance, "tradingAllowance");
      assertCloseToHttp(wsTotalMarginUsed, httpTotalMarginUsed, "totalMarginUsed");
      assertCloseToHttp(wsTotalNotional, httpTotalNotional, "totalNotional");
      assertCloseToHttp(
        Number.parseFloat(wsUpdate.maintenanceMargin ?? "0"),
        httpMaintenanceMargin,
        "maintenanceMargin",
      );
      assertCloseToHttp(
        Number.parseFloat(wsUpdate.unrealizedPnl ?? "0"),
        httpUnrealizedPnl,
        "unrealizedPnl",
      );
    },
    Math.max(config.timeout, 5000),
  );
}

export async function runStreamsTests(
  client: GteDataClient,
  config: TestConfig,
): Promise<SuiteResult> {
  const tests: TestDefinition[] = [
    {
      id: "book",
      name: "book",
      fn: () => testBookStream(client, config),
    },
    {
      id: "candles",
      name: "candles",
      optional: false,
      fn: async () => {
        const messages = await waitForMessages<Candle>(
          (onData) =>
            client.streams.candles({
              params: { symbol: config.symbol, interval: "1m" },
              onData,
            }),
          1,
          config.wsTimeout,
        );
        for (const candle of messages) {
          assertCandleOHLC(candleToInvariantFormat(candle));
        }
      },
    },
    {
      id: "trades",
      name: "trades",
      fn: () => testTradesStream(client, config),
    },
    {
      id: "positions",
      name: "positions",
      skip: false,
      fn: () => testPositionsStream(client, config),
    },
    {
      id: "openOrders",
      name: "openOrders",
      skip: false,
      fn: () => testOpenOrdersStream(client, config),
    },
    {
      id: "marketData",
      name: "marketData",
      optional: false,
      fn: () => testMarketDataGte(client, config),
    },
    {
      id: "balances",
      name: "balances",
      optional: false,
      fn: () => testBalancesStream(client, config),
    },
    {
      id: "balancesAfterFill",
      name: "balances after fill matches HTTP",
      skip: false,
      fn: () => testBalancesStreamAfterFillMatchesHttp(client, config),
    },
    {
      id: "accountMetricsAfterFill",
      name: "accountMetrics after fill matches HTTP",
      skip: false,
      fn: () => testAccountMetricsStreamAfterFillMatchesHttp(client, config),
    },
  ];

  return runSuite("streams", selectStreamTests(tests, config), config);
}

function selectStreamTests(tests: TestDefinition[], config: TestConfig): TestDefinition[] {
  if (!config.streamTests) {
    return tests;
  }

  const known = new Set(
    tests.map((test) => test.id).filter((id): id is string => id !== undefined),
  );
  const unknown = [...config.streamTests].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unsupported stream test(s): ${unknown.join(", ")}`);
  }

  return tests.filter((test) => test.id !== undefined && config.streamTests?.has(test.id));
}
