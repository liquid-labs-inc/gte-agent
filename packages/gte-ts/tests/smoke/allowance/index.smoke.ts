import { createGteOrderClient, fromPrivateKey } from "../../../src/index.js";
import { creditAccount, grantAllowance } from "../utils/devnet.js";
import { retryUntil, runSuite, sleep } from "../utils/runner.js";
import type { SuiteResult, TestConfig, TestDefinition } from "../utils/types.js";

const CREDIT_SETTLE_DELAY_MS = 3000;
const ORDER_SETTLE_DELAY_MS = 5000;
const EXPLICIT_ALLOWANCE_AMOUNT = "1000";
const EXPLICIT_ALLOWANCE_LEVERAGE = 50;
const RESTING_ORDER_PRICE = "100";
const FULL_RESERVE_QTY = "0.4995";
const REPLACED_RESERVE_QTY = "0.2997";
const RELEASED_RESERVE_QTY = "0.1998";
const SMALL_RESERVE_QTY = "0.0999";
const NEGATIVE_UPNL_OPEN_PRICE = "102000";
const NEGATIVE_UPNL_CLOSE_PRICE = "98000";
const NEGATIVE_UPNL_QTY = "0.1";
const NEGATIVE_UPNL_TRADER_CREDIT = "500";
const NEGATIVE_UPNL_MAKER_CREDIT = "1000";
const NEGATIVE_UPNL_LEVERAGE = 50;
const UI_CREDIT_AMOUNT = "123";
const RUN_SEED = BigInt(Date.now());
let ephemeralSignerCounter = 0n;

function nextEphemeralPrivateKey(): `0x${string}` {
  ephemeralSignerCounter += 1n;
  return `0x${(RUN_SEED + ephemeralSignerCounter).toString(16).padStart(64, "0")}` as `0x${string}`;
}

function createDedicatedClient(config: TestConfig) {
  const signer = fromPrivateKey(nextEphemeralPrivateKey());
  return {
    client: createGteOrderClient({
      env: "hyperliquid-prod",
      signer,
      httpBaseUrl: config.httpUrl,
      wsBaseUrl: config.wsUrl,
    }),
    userAddress: signer.address,
  };
}

function isAllowanceRejection(
  order?: { status?: string; error?: string; rejectReason?: string } | null,
): boolean {
  if (!order) return false;
  const status = order.status ?? "";
  const error = order.error ?? "";
  const rejectReason = order.rejectReason ?? "";
  return (
    status === "rejected" ||
    rejectReason === "insufficient_allowance" ||
    error.includes("InsufficientAllowance") ||
    error.toLowerCase().includes("insufficient allowance")
  );
}

function requireHttpUrl(httpUrl?: string): string {
  if (!httpUrl) {
    throw new Error("httpUrl is required for allowance smoke coverage");
  }
  return httpUrl;
}

function expectAllowanceValue(actual: string | undefined, expected: string, context: string): void {
  const actualValue = Number(actual ?? Number.NaN);
  const expectedValue = Number(expected);
  if (!Number.isFinite(actualValue) || Math.abs(actualValue - expectedValue) > 1e-9) {
    throw new Error(`Expected allowance ${expected}, got ${actual} (${context})`);
  }
}

function expectAvailableMarginValue(
  actual: string | undefined,
  expected: string,
  context: string,
): void {
  const actualValue = Number(actual ?? Number.NaN);
  const expectedValue = Number(expected);
  if (!Number.isFinite(actualValue) || Math.abs(actualValue - expectedValue) > 1e-9) {
    throw new Error(`Expected availableMargin ${expected}, got ${actual} (${context})`);
  }
}

async function waitForAllowanceAtLeast(
  user: ReturnType<typeof createDedicatedClient>,
  symbol: string,
  minimum: string,
  context: string,
  timeoutMs = 20_000,
  pollMs = 500,
): Promise<void> {
  const minimumValue = Number(minimum);
  const deadline = Date.now() + timeoutMs;
  let lastAllowance = "undefined";
  while (Date.now() <= deadline) {
    const allowance = await user.client.accounts.getAllowance({
      userAddress: user.userAddress,
      symbol,
    });
    lastAllowance = allowance.allowance ?? "undefined";
    const currentValue = Number(allowance.allowance ?? Number.NaN);
    if (Number.isFinite(currentValue) && currentValue >= minimumValue) {
      return;
    }
    await sleep(pollMs);
  }
  throw new Error(`Expected allowance >= ${minimum}, got ${lastAllowance} (${context})`);
}

function positionSizeForSymbol(
  positions: Array<{ marketSymbol?: string; size?: string }> | undefined,
  symbol: string,
): number {
  const pos = (positions ?? []).find((p) => p.marketSymbol === symbol);
  return Number.parseFloat(pos?.size ?? "0");
}

function positionForSymbol<T extends { marketSymbol?: string }>(
  positions: T[] | undefined,
  symbol: string,
): T | undefined {
  return (positions ?? []).find((p) => p.marketSymbol === symbol);
}

async function waitForPositionSize(
  user: ReturnType<typeof createDedicatedClient>,
  symbol: string,
  expected: number,
  context: string,
  timeoutMs = 20_000,
  pollMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSize = Number.NaN;
  while (Date.now() <= deadline) {
    const positions = await user.client.accounts.getPositions({
      userAddress: user.userAddress,
      symbol,
    });
    lastSize = positionSizeForSymbol(positions.positions, symbol);
    if (Math.abs(lastSize - expected) <= 1e-9) {
      return;
    }
    await sleep(pollMs);
  }
  throw new Error(`Expected position size ${expected}, got ${lastSize} (${context})`);
}

async function waitForNegativeUnrealizedPnl(
  user: ReturnType<typeof createDedicatedClient>,
  symbol: string,
  context: string,
  timeoutMs = 20_000,
  pollMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastPnl = Number.NaN;
  let lastPosition = "undefined";
  while (Date.now() <= deadline) {
    const positions = await user.client.accounts.getPositions({
      userAddress: user.userAddress,
      symbol,
    });
    const position = positionForSymbol(positions.positions, symbol);
    lastPosition = JSON.stringify(position);
    lastPnl = Number.parseFloat(position?.unrealizedPnl ?? "NaN");
    if (Number.isFinite(lastPnl) && lastPnl < 0) {
      return;
    }
    await sleep(pollMs);
  }
  throw new Error(`Expected negative unrealized PnL, got ${lastPnl} (${context}): ${lastPosition}`);
}

async function waitForLeverage(
  user: ReturnType<typeof createDedicatedClient>,
  symbol: string,
  expected: number,
  context: string,
  timeoutMs = 20_000,
  pollMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastLeverage = Number.NaN;
  while (Date.now() <= deadline) {
    const leverage = await user.client.accounts.getLeverage({
      userAddress: user.userAddress,
      symbol,
    });
    lastLeverage = leverage.leverage ?? Number.NaN;
    if (lastLeverage === expected) {
      return;
    }
    await sleep(pollMs);
  }
  throw new Error(`Expected leverage ${expected}, got ${lastLeverage} (${context})`);
}

function expectOrderAccepted(
  result: { results?: Array<{ status?: string; error?: string }> },
  context: string,
): void {
  const order = result.results?.[0];
  if (!order) throw new Error(`No order result returned (${context})`);
  if (order.error) throw new Error(`Order rejected (${context}): ${order.error}`);
  if (order.status === "rejected") {
    throw new Error(`Order rejected without error text (${context})`);
  }
}

async function waitForOpenOrderClientIds(
  config: TestConfig,
  user: ReturnType<typeof createDedicatedClient>,
  clientOrderIds: string[],
  context: string,
  timeoutMs = 20_000,
  pollMs = 500,
): Promise<void> {
  const expectedIds = new Set(clientOrderIds);
  const deadline = Date.now() + timeoutMs;
  let lastIds: string[] = [];
  while (Date.now() <= deadline) {
    const openOrders = await user.client.accounts.getOpenOrders({
      userAddress: user.userAddress,
      symbol: config.symbol,
    });
    lastIds = (openOrders.orders ?? [])
      .map((order) => order.clientId)
      .filter((id): id is string => Boolean(id));
    if (clientOrderIds.every((id) => lastIds.includes(id))) {
      return;
    }
    await sleep(pollMs);
  }
  throw new Error(
    `Expected open order ids [${[...expectedIds].join(", ")}], got [${lastIds.join(", ")}] (${context})`,
  );
}

async function seedAllowanceAccount(config: TestConfig, httpUrl: string, upnlEnabled = true) {
  const dedicatedUser = createDedicatedClient(config);
  // Deposit exactly the desired allowance amount — auto-grant moves it all to trading.
  await creditAccount(dedicatedUser.userAddress, httpUrl, EXPLICIT_ALLOWANCE_AMOUNT);
  // Explicit grant sets upnl_enabled flag on the MC (no collateral moved since free=0).
  await grantAllowance(dedicatedUser.userAddress, config.symbol, "0", httpUrl, {
    clusterId: 0,
    upnlEnabled,
  });
  const leverage = await dedicatedUser.client.accounts.setLeverage({
    userAddress: dedicatedUser.userAddress,
    symbol: config.symbol,
    leverage: EXPLICIT_ALLOWANCE_LEVERAGE,
  });
  if (!leverage.success) {
    throw new Error(`Failed to set allowance smoke leverage to ${EXPLICIT_ALLOWANCE_LEVERAGE}x`);
  }
  await waitForLeverage(
    dedicatedUser,
    config.symbol,
    EXPLICIT_ALLOWANCE_LEVERAGE,
    "seedAllowanceAccount leverage",
  );
  await sleep(CREDIT_SETTLE_DELAY_MS);
  return dedicatedUser;
}

async function expectAllowance(
  config: TestConfig,
  user: ReturnType<typeof createDedicatedClient>,
): Promise<void> {
  const allowance = await user.client.accounts.getAllowance({
    userAddress: user.userAddress,
    symbol: config.symbol,
  });
  expectAllowanceValue(
    allowance.allowance,
    EXPLICIT_ALLOWANCE_AMOUNT,
    "expectAllowance(EXPLICIT_ALLOWANCE_AMOUNT)",
  );
}

async function expectAvailableMargin(
  config: TestConfig,
  user: ReturnType<typeof createDedicatedClient>,
  expected: string,
  context: string,
): Promise<void> {
  const availableMargin = await getAvailableMargin(config, user, context);
  expectAvailableMarginValue(availableMargin.toString(), expected, context);
}

async function getAvailableMargin(
  config: TestConfig,
  user: ReturnType<typeof createDedicatedClient>,
  context: string,
): Promise<number> {
  const allowance = await user.client.accounts.getAllowance({
    userAddress: user.userAddress,
    symbol: config.symbol,
  });
  if (allowance.marketId === undefined || allowance.marketId === "") {
    throw new Error(`Expected allowance response marketId (${context})`);
  }
  const availableMargin = Number(allowance.availableMargin ?? Number.NaN);
  if (!Number.isFinite(availableMargin)) {
    throw new Error(
      `Expected numeric availableMargin, got ${allowance.availableMargin} (${context})`,
    );
  }
  return availableMargin;
}

function expectAvailableMarginBelow(actual: number, maximum: number, context: string): void {
  if (actual >= maximum) {
    throw new Error(`Expected availableMargin below ${maximum}, got ${actual} (${context})`);
  }
}

function expectAvailableMarginAbove(actual: number, minimum: number, context: string): void {
  if (actual <= minimum) {
    throw new Error(`Expected availableMargin above ${minimum}, got ${actual} (${context})`);
  }
}

function expectNumberClose(
  actual: number | string | undefined,
  expected: string,
  context: string,
): void {
  const actualValue = Number(actual ?? Number.NaN);
  const expectedValue = Number(expected);
  if (!Number.isFinite(actualValue) || Math.abs(actualValue - expectedValue) > 1e-9) {
    throw new Error(`Expected ${context}=${expected}, got ${actual}`);
  }
}

async function runCreditVisibleOnUiSurfacesScenario(config: TestConfig): Promise<void> {
  const httpUrl = requireHttpUrl(config.httpUrl);
  const dedicatedUser = createDedicatedClient(config);

  await creditAccount(dedicatedUser.userAddress, httpUrl, UI_CREDIT_AMOUNT);

  await retryUntil(async () => {
    const [balances, allowance, metrics] = await Promise.all([
      dedicatedUser.client.portfolio.getBalances({
        userAddress: dedicatedUser.userAddress,
      }),
      dedicatedUser.client.accounts.getAllowance({
        userAddress: dedicatedUser.userAddress,
        symbol: config.symbol,
      }),
      dedicatedUser.client.accounts.getAccountMetrics({
        userAddress: dedicatedUser.userAddress,
      }),
    ]);
    const perps = balances.perps?.[0];
    if (!perps) {
      throw new Error(`Expected perps balance after credit, got ${JSON.stringify(balances)}`);
    }

    expectNumberClose(perps.totalBalance, UI_CREDIT_AMOUNT, "balances.totalBalance");
    expectNumberClose(perps.balanceUsd, UI_CREDIT_AMOUNT, "balances.balanceUsd");
    expectNumberClose(perps.freeCollateral, UI_CREDIT_AMOUNT, "balances.freeCollateral");
    expectNumberClose(perps.tradingAllowance, UI_CREDIT_AMOUNT, "balances.tradingAllowance");
    expectNumberClose(allowance.allowance, UI_CREDIT_AMOUNT, "allowance.allowance");
    expectNumberClose(allowance.availableMargin, UI_CREDIT_AMOUNT, "allowance.availableMargin");
    expectNumberClose(metrics.accountValue, UI_CREDIT_AMOUNT, "metrics.accountValue");
    expectNumberClose(metrics.freeCollateral, UI_CREDIT_AMOUNT, "metrics.freeCollateral");
    expectNumberClose(metrics.tradingAllowance, UI_CREDIT_AMOUNT, "metrics.tradingAllowance");
    expectNumberClose(metrics.totalMarginUsed, "0", "metrics.totalMarginUsed");
  }, config.timeout);
}

async function reserveAllowance(
  config: TestConfig,
  user: ReturnType<typeof createDedicatedClient>,
  originalClientOrderId: string,
): Promise<void> {
  const reserveResult = await user.client.orders.create([
    {
      account: user.userAddress,
      symbol: config.symbol,
      side: "buy",
      orderType: "limit",
      price: RESTING_ORDER_PRICE,
      quantity: FULL_RESERVE_QTY,
      timeInForce: "gtc",
      clientOrderId: originalClientOrderId,
    },
  ]);
  const reserveOrder = reserveResult.results?.[0];
  if (!reserveOrder) throw new Error("No reserve order result returned");
  if (reserveOrder.error) throw new Error(`Reserve order rejected: ${reserveOrder.error}`);
  await waitForOpenOrderClientIds(config, user, [originalClientOrderId], "reserveAllowance");
}

async function expectAllowanceReject(
  config: TestConfig,
  user: ReturnType<typeof createDedicatedClient>,
  clientOrderId: string,
): Promise<void> {
  const openBefore = await user.client.accounts.getOpenOrders({
    userAddress: user.userAddress,
    symbol: config.symbol,
  });
  const openCountBefore = (openBefore.orders ?? []).length;

  const rejectResult = await user.client.orders.create([
    {
      account: user.userAddress,
      symbol: config.symbol,
      side: "buy",
      orderType: "limit",
      price: RESTING_ORDER_PRICE,
      quantity: SMALL_RESERVE_QTY,
      timeInForce: "gtc",
      clientOrderId,
    },
  ]);
  if (isAllowanceRejection(rejectResult.results?.[0] ?? null)) {
    return;
  }

  await sleep(ORDER_SETTLE_DELAY_MS);

  const openAfter = await user.client.accounts.getOpenOrders({
    userAddress: user.userAddress,
    symbol: config.symbol,
  });
  const openCountAfter = (openAfter.orders ?? []).length;
  const orderStillOpen = (openAfter.orders ?? []).some((o) => o.clientId === clientOrderId);
  if (orderStillOpen || openCountAfter > openCountBefore) {
    throw new Error(
      `Expected allowance rejection/no-resting-order, but order appears open (before=${openCountBefore}, after=${openCountAfter}, clientOrderId=${clientOrderId})`,
    );
  }

  const orderHistory = await user.client.accounts.getOrders({
    userAddress: user.userAddress,
    symbol: config.symbol,
    clientId: clientOrderId,
    limit: 20,
  });
  const latest = (orderHistory.orders ?? []).find((o) => o.clientId === clientOrderId);
  if (latest) {
    const status = latest.status ?? "";
    if (
      status === "new" ||
      status === "pending_new" ||
      status === "partially_filled" ||
      status === "filled"
    ) {
      throw new Error(
        `Expected allowance rejection/non-execution, got status=${status} for clientOrderId=${clientOrderId}`,
      );
    }
  }
}

async function replaceReservedOrder(
  config: TestConfig,
  user: ReturnType<typeof createDedicatedClient>,
  originalClientOrderId: string,
  clientOrderId: string,
): Promise<void> {
  const replaceResult = await user.client.orders.replace([
    {
      account: user.userAddress,
      symbol: config.symbol,
      side: "buy",
      price: RESTING_ORDER_PRICE,
      quantity: REPLACED_RESERVE_QTY,
      originalClientOrderId,
      clientOrderId,
    },
  ]);
  const replacedOrder = replaceResult.results?.[0];
  if (!replacedOrder) throw new Error("No replace order result returned");
  if (replacedOrder.error) throw new Error(`Replace order rejected: ${replacedOrder.error}`);
  await waitForOpenOrderClientIds(config, user, [clientOrderId], "replaceReservedOrder");
}

async function placeReleasedOrder(
  config: TestConfig,
  user: ReturnType<typeof createDedicatedClient>,
  clientOrderId: string,
): Promise<void> {
  const releasedResult = await user.client.orders.create([
    {
      account: user.userAddress,
      symbol: config.symbol,
      side: "buy",
      orderType: "limit",
      price: RESTING_ORDER_PRICE,
      quantity: RELEASED_RESERVE_QTY,
      timeInForce: "gtc",
      clientOrderId,
    },
  ]);
  const releasedOrder = releasedResult.results?.[0];
  if (!releasedOrder) throw new Error("No released-capacity order result returned");
  if (releasedOrder.error) {
    throw new Error(`Released-capacity order rejected: ${releasedOrder.error}`);
  }
  await waitForOpenOrderClientIds(config, user, [clientOrderId], "placeReleasedOrder");
}

async function expectOpenOrderQuantities(
  config: TestConfig,
  user: ReturnType<typeof createDedicatedClient>,
): Promise<void> {
  const openOrders = await user.client.accounts.getOpenOrders({
    userAddress: user.userAddress,
    symbol: config.symbol,
  });
  const restingQuantities = (openOrders.orders ?? [])
    .map((order) => order.originalSize)
    .filter((size): size is string => Boolean(size))
    .map((size) => Number.parseFloat(size))
    .sort((a, b) => a - b);

  if (
    restingQuantities.length !== 2 ||
    restingQuantities[0] !== Number(RELEASED_RESERVE_QTY) ||
    restingQuantities[1] !== Number(REPLACED_RESERVE_QTY)
  ) {
    throw new Error(
      `Expected two resting orders sized ${RELEASED_RESERVE_QTY} and ${REPLACED_RESERVE_QTY} after replace, found [${restingQuantities.join(", ")}]`,
    );
  }
}

async function runReplaceReleaseScenario(config: TestConfig): Promise<void> {
  const httpUrl = requireHttpUrl(config.httpUrl);
  const dedicatedUser = await seedAllowanceAccount(config, httpUrl);
  await expectAllowance(config, dedicatedUser);
  await expectAvailableMargin(
    config,
    dedicatedUser,
    EXPLICIT_ALLOWANCE_AMOUNT,
    "runReplaceReleaseScenario initial availableMargin",
  );

  const orderNonce = Date.now();
  const originalClientOrderId = String(orderNonce);
  await reserveAllowance(config, dedicatedUser, originalClientOrderId);
  const marginAfterFullReserve = await getAvailableMargin(
    config,
    dedicatedUser,
    "runReplaceReleaseScenario availableMargin after full reserve",
  );
  expectAvailableMarginBelow(
    marginAfterFullReserve,
    5,
    "runReplaceReleaseScenario availableMargin after full reserve",
  );
  await expectAllowanceReject(config, dedicatedUser, String(orderNonce + 1));
  await replaceReservedOrder(config, dedicatedUser, originalClientOrderId, String(orderNonce + 2));
  const marginAfterReplace = await getAvailableMargin(
    config,
    dedicatedUser,
    "runReplaceReleaseScenario availableMargin after replace release",
  );
  expectAvailableMarginAbove(
    marginAfterReplace,
    marginAfterFullReserve + 250,
    "runReplaceReleaseScenario availableMargin after replace release",
  );
  await placeReleasedOrder(config, dedicatedUser, String(orderNonce + 3));
  const marginAfterReleasedOrder = await getAvailableMargin(
    config,
    dedicatedUser,
    "runReplaceReleaseScenario availableMargin after released-capacity order",
  );
  expectAvailableMarginBelow(
    marginAfterReleasedOrder,
    marginAfterFullReserve + 5,
    "runReplaceReleaseScenario availableMargin after released-capacity order",
  );
  await expectOpenOrderQuantities(config, dedicatedUser);
  await expectAllowance(config, dedicatedUser);
}

async function runGrantAllowanceWithUpnlFlagScenario(config: TestConfig): Promise<void> {
  const httpUrl = requireHttpUrl(config.httpUrl);
  const dedicatedUser = await seedAllowanceAccount(config, httpUrl, false);
  await expectAllowance(config, dedicatedUser);
  await expectAvailableMargin(
    config,
    dedicatedUser,
    EXPLICIT_ALLOWANCE_AMOUNT,
    "runGrantAllowanceWithUpnlFlagScenario initial availableMargin",
  );
}

async function runGrantPropagationScenario(config: TestConfig): Promise<void> {
  const httpUrl = requireHttpUrl(config.httpUrl);
  const dedicatedUser = createDedicatedClient(config);
  const SMALL_ALLOWANCE = "200";
  const ADDITIONAL_ALLOWANCE = "500";

  await creditAccount(dedicatedUser.userAddress, httpUrl, SMALL_ALLOWANCE);
  const leverage = await dedicatedUser.client.accounts.setLeverage({
    userAddress: dedicatedUser.userAddress,
    symbol: config.symbol,
    leverage: EXPLICIT_ALLOWANCE_LEVERAGE,
  });
  if (!leverage.success) {
    throw new Error(`Failed to set grant propagation leverage to ${EXPLICIT_ALLOWANCE_LEVERAGE}x`);
  }
  await waitForLeverage(
    dedicatedUser,
    config.symbol,
    EXPLICIT_ALLOWANCE_LEVERAGE,
    "runGrantPropagationScenario leverage",
  );
  await sleep(CREDIT_SETTLE_DELAY_MS);

  const smallAllowance = await dedicatedUser.client.accounts.getAllowance({
    userAddress: dedicatedUser.userAddress,
    symbol: config.symbol,
  });
  expectAllowanceValue(
    smallAllowance.allowance,
    SMALL_ALLOWANCE,
    "runGrantPropagationScenario initial allowance",
  );

  const orderNonce = Date.now();
  const reserveResult = await dedicatedUser.client.orders.create([
    {
      account: dedicatedUser.userAddress,
      symbol: config.symbol,
      side: "buy",
      orderType: "limit",
      price: RESTING_ORDER_PRICE,
      quantity: SMALL_RESERVE_QTY,
      timeInForce: "gtc",
      clientOrderId: String(orderNonce),
    },
  ]);
  const reserveOrder = reserveResult.results?.[0];
  if (!reserveOrder || reserveOrder.error) {
    throw new Error(`Initial order should succeed: ${reserveOrder?.error}`);
  }
  await waitForOpenOrderClientIds(
    config,
    dedicatedUser,
    [String(orderNonce)],
    "runGrantPropagationScenario initial reserve",
  );
  const marginAfterInitialReserve = await getAvailableMargin(
    config,
    dedicatedUser,
    "runGrantPropagationScenario availableMargin after resting order reserve",
  );
  expectAvailableMarginBelow(
    marginAfterInitialReserve,
    2,
    "runGrantPropagationScenario availableMargin after resting order reserve",
  );

  await expectAllowanceReject(config, dedicatedUser, String(orderNonce + 1));

  // Mirror the Rust allowance propagation smoke: emit another live allowance grant via credit.
  await creditAccount(dedicatedUser.userAddress, httpUrl, ADDITIONAL_ALLOWANCE);
  await sleep(CREDIT_SETTLE_DELAY_MS);

  await waitForAllowanceAtLeast(
    dedicatedUser,
    config.symbol,
    "300",
    "runGrantPropagationScenario updated allowance after second credit",
  );

  const successResult = await dedicatedUser.client.orders.create([
    {
      account: dedicatedUser.userAddress,
      symbol: config.symbol,
      side: "buy",
      orderType: "limit",
      price: RESTING_ORDER_PRICE,
      quantity: SMALL_RESERVE_QTY,
      timeInForce: "gtc",
      clientOrderId: String(orderNonce + 2),
    },
  ]);
  const successOrder = successResult.results?.[0];
  if (!successOrder) throw new Error("No order result after grant increase");
  if (successOrder.error) {
    throw new Error(`Order should succeed after grant increase: ${successOrder.error}`);
  }
  await waitForOpenOrderClientIds(
    config,
    dedicatedUser,
    [String(orderNonce), String(orderNonce + 2)],
    "runGrantPropagationScenario second reserve",
  );
  const marginAfterSecondReserve = await getAvailableMargin(
    config,
    dedicatedUser,
    "runGrantPropagationScenario availableMargin after second reserve",
  );
  expectAvailableMarginAbove(
    marginAfterSecondReserve,
    250,
    "runGrantPropagationScenario availableMargin after second reserve",
  );
}

async function runMarketOrderMarkPriceAllowanceScenario(config: TestConfig): Promise<void> {
  const httpUrl = requireHttpUrl(config.httpUrl);
  const maker = createDedicatedClient(config);
  const dedicatedUser = createDedicatedClient(config);

  await creditAccount(maker.userAddress, httpUrl, "1000");
  await creditAccount(dedicatedUser.userAddress, httpUrl, "100");
  await sleep(CREDIT_SETTLE_DELAY_MS);

  const allowance = await dedicatedUser.client.accounts.getAllowance({
    userAddress: dedicatedUser.userAddress,
    symbol: config.symbol,
  });
  expectAllowanceValue(
    allowance.allowance,
    "100",
    "runMarketOrderMarkPriceAllowanceScenario allowance",
  );

  // Ensure there is executable ask-side liquidity; if allowance checks are bypassed,
  // this market buy can fill and open position.
  await maker.client.orders.create([
    {
      account: maker.userAddress,
      symbol: config.symbol,
      side: "sell",
      orderType: "limit",
      price: "100",
      quantity: "1",
      timeInForce: "gtc",
      clientOrderId: String(Date.now()),
    },
  ]);

  const positionsBefore = await dedicatedUser.client.accounts.getPositions({
    userAddress: dedicatedUser.userAddress,
    symbol: config.symbol,
  });
  const sizeBefore = positionSizeForSymbol(positionsBefore.positions, config.symbol);

  const marketClientOrderId = String(Date.now() + 1);
  await dedicatedUser.client.orders.create([
    {
      account: dedicatedUser.userAddress,
      symbol: config.symbol,
      side: "buy",
      orderType: "market",
      price: "0",
      quantity: "1",
      timeInForce: "ioc",
      clientOrderId: marketClientOrderId,
    },
  ]);

  await sleep(ORDER_SETTLE_DELAY_MS);

  const openOrders = await dedicatedUser.client.accounts.getOpenOrders({
    userAddress: dedicatedUser.userAddress,
    symbol: config.symbol,
  });
  const stillOpen = (openOrders.orders ?? []).some((o) => o.clientId === marketClientOrderId);
  if (stillOpen) {
    throw new Error(
      `Market IOC order should not rest on book (clientOrderId=${marketClientOrderId})`,
    );
  }

  const positionsAfter = await dedicatedUser.client.accounts.getPositions({
    userAddress: dedicatedUser.userAddress,
    symbol: config.symbol,
  });
  const sizeAfter = positionSizeForSymbol(positionsAfter.positions, config.symbol);
  if (Math.abs(sizeAfter - sizeBefore) > 1e-9) {
    throw new Error(
      `Expected no position change on insufficient allowance market order, before=${sizeBefore}, after=${sizeAfter}`,
    );
  }

  const history = await dedicatedUser.client.accounts.getOrders({
    userAddress: dedicatedUser.userAddress,
    symbol: config.symbol,
    clientId: marketClientOrderId,
    limit: 20,
  });
  const latest = (history.orders ?? []).find((o) => o.clientId === marketClientOrderId);
  if (latest && (latest.status === "filled" || latest.status === "partially_filled")) {
    throw new Error(
      `Expected market order to remain unfilled on allowance check, got status=${latest.status}`,
    );
  }
}

async function runReduceOnlyCloseNegativeUpnlScenario(config: TestConfig): Promise<void> {
  const httpUrl = requireHttpUrl(config.httpUrl);
  const maker = createDedicatedClient(config);
  const trader = createDedicatedClient(config);
  const orderNonce = Date.now();

  await creditAccount(maker.userAddress, httpUrl, NEGATIVE_UPNL_MAKER_CREDIT);
  await creditAccount(trader.userAddress, httpUrl, NEGATIVE_UPNL_TRADER_CREDIT);
  const traderLeverage = await trader.client.accounts.setLeverage({
    userAddress: trader.userAddress,
    symbol: config.symbol,
    leverage: NEGATIVE_UPNL_LEVERAGE,
    subaccountId: 0,
  });
  if (!traderLeverage.success) {
    throw new Error(`Failed to set trader leverage to ${NEGATIVE_UPNL_LEVERAGE}x`);
  }
  const makerLeverage = await maker.client.accounts.setLeverage({
    userAddress: maker.userAddress,
    symbol: config.symbol,
    leverage: NEGATIVE_UPNL_LEVERAGE,
    subaccountId: 0,
  });
  if (!makerLeverage.success) {
    throw new Error(`Failed to set maker leverage to ${NEGATIVE_UPNL_LEVERAGE}x`);
  }
  await waitForLeverage(
    trader,
    config.symbol,
    NEGATIVE_UPNL_LEVERAGE,
    "negative-uPnL trader leverage",
  );
  await waitForLeverage(
    maker,
    config.symbol,
    NEGATIVE_UPNL_LEVERAGE,
    "negative-uPnL maker leverage",
  );
  await grantAllowance(trader.userAddress, config.symbol, "0", httpUrl, {
    clusterId: 0,
    upnlEnabled: true,
  });
  await sleep(CREDIT_SETTLE_DELAY_MS);

  await waitForAllowanceAtLeast(
    trader,
    config.symbol,
    NEGATIVE_UPNL_TRADER_CREDIT,
    "negative-uPnL trader initial allowance",
  );

  expectOrderAccepted(
    await maker.client.orders.create([
      {
        account: maker.userAddress,
        symbol: config.symbol,
        side: "sell",
        orderType: "limit",
        price: NEGATIVE_UPNL_OPEN_PRICE,
        quantity: NEGATIVE_UPNL_QTY,
        timeInForce: "gtc",
        clientOrderId: String(orderNonce),
      },
    ]),
    "seed opening ask",
  );
  await waitForOpenOrderClientIds(
    config,
    maker,
    [String(orderNonce)],
    "negative-uPnL opening ask rested",
  );
  expectOrderAccepted(
    await trader.client.orders.create([
      {
        account: trader.userAddress,
        symbol: config.symbol,
        side: "buy",
        orderType: "limit",
        price: NEGATIVE_UPNL_OPEN_PRICE,
        quantity: NEGATIVE_UPNL_QTY,
        timeInForce: "ioc",
        clientOrderId: String(orderNonce + 1),
      },
    ]),
    "open underwater long",
  );

  await waitForPositionSize(
    trader,
    config.symbol,
    Number(NEGATIVE_UPNL_QTY),
    "negative-uPnL long opened",
  );
  await waitForNegativeUnrealizedPnl(
    trader,
    config.symbol,
    "negative-uPnL long should be underwater before close",
  );

  expectOrderAccepted(
    await maker.client.orders.create([
      {
        account: maker.userAddress,
        symbol: config.symbol,
        side: "buy",
        orderType: "limit",
        price: NEGATIVE_UPNL_CLOSE_PRICE,
        quantity: NEGATIVE_UPNL_QTY,
        timeInForce: "gtc",
        clientOrderId: String(orderNonce + 2),
      },
    ]),
    "seed close bid",
  );
  await waitForOpenOrderClientIds(
    config,
    maker,
    [String(orderNonce + 2)],
    "negative-uPnL close bid rested",
  );
  expectOrderAccepted(
    await trader.client.orders.create([
      {
        account: trader.userAddress,
        symbol: config.symbol,
        side: "sell",
        orderType: "market",
        price: "0",
        quantity: NEGATIVE_UPNL_QTY,
        timeInForce: "ioc",
        reduceOnly: true,
        clientOrderId: String(orderNonce + 3),
      },
    ]),
    "reduce-only close under negative uPnL",
  );

  await waitForPositionSize(trader, config.symbol, 0, "reduce-only close flattened position");
}

export async function runAllowanceTests(config: TestConfig): Promise<SuiteResult> {
  const tests: TestDefinition[] = [
    {
      name: "devnet credit is visible on UI account surfaces",
      fn: async () => runCreditVisibleOnUiSurfacesScenario(config),
    },
    {
      name: "replace releases reserved capacity",
      fn: async () => runReplaceReleaseScenario(config),
    },
    {
      name: "grant allowance accepts upnl flag",
      fn: async () => runGrantAllowanceWithUpnlFlagScenario(config),
    },
    {
      name: "sequential grant propagation updates MC allowance",
      fn: async () => runGrantPropagationScenario(config),
    },
    {
      name: "market order allowance uses mark price",
      fn: async () => runMarketOrderMarkPriceAllowanceScenario(config),
    },
    {
      name: "reduce-only close works when negative uPnL exhausts allowance",
      fn: async () => runReduceOnlyCloseNegativeUpnlScenario(config),
    },
  ];

  return runSuite("allowance", tests, config);
}
