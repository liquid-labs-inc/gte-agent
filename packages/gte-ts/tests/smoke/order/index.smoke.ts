import { createGteOrderClient, fromPrivateKey } from "../../../src/index.js";
import type {
  GteOrderClient,
  LeverageChange,
  OrderResult,
  OrderUpdate,
  PerpOpenOrder,
  PerpPosition,
  Trade,
} from "../../../src/index.js";

type TradeWithRpnl = Trade & { makerRpnl?: string; takerRpnl?: string };
import { MAX_LEVERAGE, creditAccounts } from "../utils/devnet.js";
import { assertGeneratedSetLeverageBodyShape } from "../utils/generated.js";
import { assertPositionFinancials } from "../utils/invariants.js";
import { retryUntil, runSuite, sleep } from "../utils/runner.js";
import type { SuiteResult, TestConfig, TestDefinition } from "../utils/types.js";

// Upper-bound time we are willing to wait for a side-effect (order/position/
// trade/leverage) to become visible via HTTP. Tests poll every few hundred ms
// and return as soon as the expected state is observed, so the typical wait is
// well under this bound; it only represents the worst-case cap.
const ORDER_SETTLE_TIMEOUT_MS = 5000;
const LEVERAGE_SETTLE_TIMEOUT_MS = 3000;
const CREDIT_SETTLE_DELAY_MS = 3000;
const WS_COLLECT_TIMEOUT_MS = 8000;
const ORDER_SMOKE_CREDIT_AMOUNT = 1000;
const CAP_SAFE_ORDER_QUANTITY = "0.001";
const CAP_SAFE_ORDER_SIZE = Number.parseFloat(CAP_SAFE_ORDER_QUANTITY);
const POSITION_SIZE_TOLERANCE = Math.max(1e-8, CAP_SAFE_ORDER_SIZE * 0.001);

function waitForWsMessages(
  client: GteOrderClient,
  userAddress: string,
  count: number,
  timeout: number,
  filter: (order: PerpOpenOrder) => boolean = () => true,
): Promise<PerpOpenOrder[]> {
  const collected: PerpOpenOrder[] = [];
  const matched: PerpOpenOrder[] = [];
  let unsubscribe: (() => void) | null = null;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (unsubscribe) unsubscribe();
      if (matched.length < count) {
        const seen = collected
          .map(
            (order) =>
              `clientId=${order.clientId ?? "?"},status=${order.status ?? "?"},type=${order.orderType ?? "?"},trigger=${order.triggerPrice ?? "?"},tpsl=${order.tpsl ?? "?"}`,
          )
          .join("; ");
        reject(
          new Error(
            `Expected ${count} matching WS open-order message(s) within ${timeout}ms, got ${matched.length}. Saw: [${seen}]`,
          ),
        );
      } else {
        resolve(matched);
      }
    }, timeout);

    client.streams
      .openOrders({
        params: { userAddress },
        onData: (orders) => {
          for (const order of orders) {
            collected.push(order);
            if (filter(order)) matched.push(order);
          }
          if (matched.length >= count) {
            clearTimeout(timer);
            if (unsubscribe) unsubscribe();
            resolve(matched);
          }
        },
      })
      .then((unsub) => {
        unsubscribe = unsub;
      })
      .catch(reject);
  });
}

function getSignedPositionSize(position: Pick<PerpPosition, "side" | "size"> | undefined): number {
  if (!position?.size) return 0;
  const size = Number.parseFloat(position.size);
  if (Number.isNaN(size)) {
    throw new Error(`Expected numeric position size, got '${position.size}'`);
  }
  return position.side === "short" ? -size : size;
}

async function getPositionForSymbol(
  client: GteOrderClient,
  config: TestConfig,
): Promise<PerpPosition | undefined> {
  const positions = await client.accounts.getPositions({
    userAddress: config.userAddress,
  });
  return (positions.positions ?? []).find((position) => position.marketSymbol === config.symbol);
}

async function cancelOpenOrdersForSymbol(
  client: GteOrderClient,
  config: TestConfig,
): Promise<void> {
  const open = await client.accounts.getOpenOrders({
    userAddress: config.userAddress,
    symbol: config.symbol,
  });
  const orders = open.orders ?? [];
  if (orders.length === 0) return;

  await client.orders.cancel(
    orders
      .filter((order) => order.orderId)
      .map((order) => ({
        account: config.userAddress,
        symbol: config.symbol,
        side: order.side ?? "buy",
        origOrderId: order.orderId,
      })),
  );

  await retryUntil(async () => {
    const latest = await client.accounts.getOpenOrders({
      userAddress: config.userAddress,
      symbol: config.symbol,
    });
    const stillOpen = latest.orders ?? [];
    if (stillOpen.length > 0) {
      throw new Error(
        `Expected no open orders before TP/SL smoke, got ${JSON.stringify(stillOpen)}`,
      );
    }
  }, ORDER_SETTLE_TIMEOUT_MS);
}

async function flattenPositionForSymbol(
  client: GteOrderClient,
  counterparty: GteOrderClient,
  config: TestConfig,
): Promise<void> {
  if (!config.counterpartyAddress) throw new Error("counterpartyAddress required");

  const position = await getPositionForSymbol(client, config);
  const signedSize = getSignedPositionSize(position);
  if (Math.abs(signedSize) <= 0.0001) return;

  const quantity = Math.abs(signedSize).toFixed(8);
  const userSide = signedSize > 0 ? "sell" : "buy";
  const counterpartySide = signedSize > 0 ? "buy" : "sell";
  const price = signedSize > 0 ? "1000" : "1";
  const clientOrderIdBase = Date.now();

  await client.orders.create([
    {
      account: config.userAddress,
      symbol: config.symbol,
      side: userSide,
      orderType: "limit",
      price,
      quantity,
      timeInForce: "gtc",
      reduceOnly: true,
      clientOrderId: String(clientOrderIdBase),
    },
  ]);

  await counterparty.orders.create([
    {
      account: config.counterpartyAddress,
      symbol: config.symbol,
      side: counterpartySide,
      orderType: "limit",
      price,
      quantity,
      timeInForce: "gtc",
      clientOrderId: String(clientOrderIdBase + 1),
    },
  ]);

  await retryUntil(async () => {
    const latest = await getPositionForSymbol(client, config);
    const latestSignedSize = getSignedPositionSize(latest);
    if (Math.abs(latestSignedSize) > 0.0001) {
      throw new Error(
        `Expected flat precondition before TP/SL smoke, got ${JSON.stringify(latest)}`,
      );
    }
  }, WS_COLLECT_TIMEOUT_MS);
}

async function openLongPositionForSymbol(
  client: GteOrderClient,
  counterparty: GteOrderClient,
  config: TestConfig,
  quantity: string,
): Promise<void> {
  if (!config.counterpartyAddress) throw new Error("counterpartyAddress required");

  const price = "1";
  const clientOrderIdBase = Date.now();

  await client.orders.create([
    {
      account: config.userAddress,
      symbol: config.symbol,
      side: "buy",
      orderType: "limit",
      price,
      quantity,
      timeInForce: "gtc",
      clientOrderId: String(clientOrderIdBase),
    },
  ]);

  await counterparty.orders.create([
    {
      account: config.counterpartyAddress,
      symbol: config.symbol,
      side: "sell",
      orderType: "limit",
      price,
      quantity,
      timeInForce: "ioc",
      clientOrderId: String(clientOrderIdBase + 1),
    },
  ]);

  await retryUntil(async () => {
    const latest = await getPositionForSymbol(client, config);
    const signedSize = getSignedPositionSize(latest);
    if (signedSize < Number.parseFloat(quantity) - 0.0001) {
      throw new Error(`Expected fresh long position, got ${JSON.stringify(latest)}`);
    }
  }, WS_COLLECT_TIMEOUT_MS);
}

function isRejectedOrderUpdate(update: OrderUpdate): boolean {
  return update.order.status === "rejected" || update.status === "rejected";
}

function openOrderClientIds(
  page: Awaited<ReturnType<GteOrderClient["accounts"]["getOpenOrders"]>>,
): Set<string> {
  return new Set(
    (page.orders ?? []).map((order) => order.clientId).filter((id): id is string => Boolean(id)),
  );
}

function assertOpenOrdersIncludeClientIds(
  page: Awaited<ReturnType<GteOrderClient["accounts"]["getOpenOrders"]>>,
  expectedClientIds: string[],
  label: string,
) {
  const seenClientIds = openOrderClientIds(page);
  const missing = expectedClientIds.filter((clientId) => !seenClientIds.has(clientId));
  if (missing.length > 0) {
    throw new Error(`${label} missing client id(s): ${missing.join(", ")}`);
  }
}

function assertOpenOrdersPageLength(
  page: Awaited<ReturnType<GteOrderClient["accounts"]["getOpenOrders"]>>,
  expected: number,
  label: string,
) {
  const actual = page.orders?.length ?? 0;
  if (actual !== expected) {
    throw new Error(
      `Expected ${label} to contain ${expected} orders, got ${actual}: ${JSON.stringify(page)}`,
    );
  }
}

function requireOpenOrdersNextCursor(
  page: Awaited<ReturnType<GteOrderClient["accounts"]["getOpenOrders"]>>,
  label: string,
): string {
  if (!page.nextCursor) {
    throw new Error(`Expected nextCursor for ${label}: ${JSON.stringify(page)}`);
  }
  return page.nextCursor;
}

function openOrderRowKey(order: PerpOpenOrder): string | undefined {
  return order.orderId ?? order.clientId;
}

function assertOpenOrdersPagesAdvance(
  firstPage: Awaited<ReturnType<GteOrderClient["accounts"]["getOpenOrders"]>>,
  secondPage: Awaited<ReturnType<GteOrderClient["accounts"]["getOpenOrders"]>>,
) {
  if ((secondPage.orders ?? []).length === 0) {
    throw new Error(
      `Expected second open-orders page to contain more orders: ${JSON.stringify(secondPage)}`,
    );
  }

  const firstPageKeys = new Set((firstPage.orders ?? []).map(openOrderRowKey));
  const duplicate = (secondPage.orders ?? []).find((order) =>
    firstPageKeys.has(openOrderRowKey(order)),
  );
  if (duplicate) {
    throw new Error(
      `Expected open-orders cursor to advance without duplicates: ${JSON.stringify({ firstPage, secondPage })}`,
    );
  }
}

function assertSingleClientIdFilteredOrder(
  page: Awaited<ReturnType<GteOrderClient["accounts"]["getOpenOrders"]>>,
  clientId: string,
) {
  const filteredOrders = page.orders ?? [];
  if (filteredOrders.length !== 1 || filteredOrders[0]?.clientId !== clientId) {
    throw new Error(
      `Expected clientId-filtered open orders to return one order: ${JSON.stringify(page)}`,
    );
  }
}

function waitForUserTradeMatching(
  client: GteOrderClient,
  userAddress: string,
  timeout: number,
  predicate: (trade: TradeWithRpnl) => boolean,
): Promise<TradeWithRpnl> {
  return new Promise((resolve, reject) => {
    const collected: TradeWithRpnl[] = [];
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (unsubscribe) unsubscribe();
      const summary = collected
        .map((t) => `id=${t.id} mRpnl=${t.makerRpnl ?? ""} tRpnl=${t.takerRpnl ?? ""}`)
        .join(" | ");
      reject(
        new Error(`No matching user-trade WS event within ${timeout}ms. Collected: [${summary}]`),
      );
    }, timeout);

    client.streams
      .trades({
        params: { userAddress },
        onData: (trades) => {
          for (const trade of trades as TradeWithRpnl[]) {
            collected.push(trade);
            if (predicate(trade)) {
              clearTimeout(timer);
              if (unsubscribe) unsubscribe();
              resolve(trade);
              return;
            }
          }
        },
      })
      .then((unsub) => {
        unsubscribe = unsub;
      })
      .catch(reject);
  });
}

function waitForOrderUpdates(
  client: GteOrderClient,
  userAddress: string,
  count: number,
  timeout: number,
  filter: (update: OrderUpdate) => boolean = () => true,
): Promise<OrderUpdate[]> {
  const collected: OrderUpdate[] = [];
  const matched: OrderUpdate[] = [];
  let unsubscribe: (() => void) | null = null;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (unsubscribe) unsubscribe();
      if (matched.length === 0) {
        const seen = collected.map((e) => e.order.status ?? "?").join(", ");
        reject(
          new Error(
            `No matching WS order update within ${timeout}ms. Saw ${collected.length} event(s): [${seen}]`,
          ),
        );
      } else {
        resolve(matched);
      }
    }, timeout);

    client.streams
      .orders({
        params: { userAddress },
        onData: (updates) => {
          for (const update of updates) {
            collected.push(update);
            if (filter(update)) matched.push(update);
          }
          if (matched.length >= count) {
            clearTimeout(timer);
            if (unsubscribe) unsubscribe();
            resolve(matched);
          }
        },
      })
      .then((unsub) => {
        unsubscribe = unsub;
      })
      .catch(reject);
  });
}

function waitForLeverageChange(
  client: GteOrderClient,
  userAddress: string,
  symbol: string,
  subaccountId: number,
  leverage: number,
  timeout: number,
): Promise<LeverageChange> {
  const collected: LeverageChange[] = [];
  let unsubscribe: (() => void) | null = null;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (unsubscribe) unsubscribe();
      const seen = collected
        .map(
          (change) =>
            `account=${change.accountId},symbol=${change.marketSymbol},subaccount=${change.subaccountId},leverage=${change.leverage}`,
        )
        .join("; ");
      reject(
        new Error(`No matching leverage_changes WS event within ${timeout}ms. Saw: [${seen}]`),
      );
    }, timeout);

    client.streams
      .leverageChanges({
        params: { userAddress, symbol, subaccountId },
        onData: (change) => {
          collected.push(change);
          if (
            change.accountId.toLowerCase() === userAddress.toLowerCase() &&
            change.marketSymbol === symbol &&
            change.subaccountId === subaccountId &&
            change.leverage === leverage
          ) {
            clearTimeout(timer);
            if (unsubscribe) unsubscribe();
            resolve(change);
          }
        },
      })
      .then((unsub) => {
        unsubscribe = unsub;
      })
      .catch(reject);
  });
}

function waitForOrderHistoryUpdates(
  client: GteOrderClient,
  userAddress: string,
  count: number,
  timeout: number,
): Promise<OrderUpdate[]> {
  const collected: OrderUpdate[] = [];
  let unsubscribe: (() => void) | null = null;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (unsubscribe) unsubscribe();
      if (collected.length === 0) {
        reject(new Error(`No WS order history messages received within ${timeout}ms`));
      } else {
        resolve(collected);
      }
    }, timeout);

    client.streams
      .orderHistory({
        params: { userAddress },
        onData: (updates) => {
          for (const update of updates) {
            collected.push(update);
          }
          if (collected.length >= count) {
            clearTimeout(timer);
            if (unsubscribe) unsubscribe();
            resolve(collected);
          }
        },
      })
      .then((unsub) => {
        unsubscribe = unsub;
      })
      .catch(reject);
  });
}

function createCounterpartyClient(config: TestConfig): GteOrderClient {
  if (!config.counterpartyPk) throw new Error("counterpartyPk required for order tests");
  return createGteOrderClient({
    env: "hyperliquid-prod",
    signer: fromPrivateKey(config.counterpartyPk),
    httpBaseUrl: config.httpUrl,
    wsBaseUrl: config.wsUrl,
  });
}

function integerPrice(value: string | undefined): string {
  return String(Math.trunc(Number.parseFloat(value ?? "")));
}

function requireOpenOrderByClientId(
  orders: PerpOpenOrder[],
  clientOrderId: string,
  label: "TP" | "SL",
): PerpOpenOrder {
  const order = orders.find((entry) => entry.clientId === clientOrderId);
  if (order) return order;

  const ids = orders
    .map((entry) => `(clientId=${entry.clientId},orderId=${entry.orderId})`)
    .join(", ");
  throw new Error(
    `${label} stop not found in /orders/open. Expected clientId=${clientOrderId}. Saw: [${ids}]`,
  );
}

function assertRestingLimitOpenOrder(
  page: Awaited<ReturnType<GteOrderClient["accounts"]["getOpenOrders"]>>,
  clientOrderId: string,
  expectedSide: string,
  expectedLimitPrice: string,
  expectedOriginalSize: string,
): void {
  const orders = page.orders ?? [];
  if (orders.length === 0) throw new Error("Expected at least one open order");

  const order = orders.find((entry) => entry.clientId === clientOrderId);
  if (!order) {
    const summaries = orders.map((entry) => `${entry.clientId}:${entry.side}@${entry.limitPrice}`);
    throw new Error(
      `Expected clientId=${clientOrderId} in open orders, found: [${summaries.join(", ")}]`,
    );
  }

  if (order.side !== expectedSide) {
    throw new Error(`Expected ${expectedSide}, got ${String(order.side)}`);
  }

  if (
    !order.limitPrice ||
    Number.parseFloat(order.limitPrice) !== Number.parseFloat(expectedLimitPrice)
  ) {
    throw new Error(`Expected limitPrice=${expectedLimitPrice}, got ${order.limitPrice}`);
  }

  if (!order.originalSize) throw new Error("order missing originalSize");
  if (Number.parseFloat(order.originalSize) !== Number.parseFloat(expectedOriginalSize)) {
    throw new Error(`expected originalSize=${expectedOriginalSize}, got ${order.originalSize}`);
  }
}

function assertStopLimitTpslOpenOrder(
  order: PerpOpenOrder,
  label: "TP" | "SL",
  expectedTpsl: "tp" | "sl",
): void {
  if (order.tpsl !== expectedTpsl) {
    throw new Error(`Expected ${label} tpsl=${expectedTpsl}, got ${String(order.tpsl)}`);
  }
  if (!order.triggerPrice) throw new Error(`${label} triggerPrice missing`);
  if (order.orderType !== "stop_limit") {
    throw new Error(`Expected ${label} orderType=stop_limit, got ${String(order.orderType)}`);
  }
}

async function assertSpecificTradeHistory(
  client: GteOrderClient,
  config: TestConfig,
  expectedPrices: string[],
): Promise<void> {
  const tradeHistory = await client.accounts.getTradeHistory({
    userAddress: config.userAddress,
    marketSymbol: config.symbol,
    limit: 50,
  });
  const matchingTrades = (tradeHistory.trades ?? []).filter((trade) =>
    expectedPrices.includes(integerPrice(trade.price)),
  );
  const seenPrices = new Set(matchingTrades.map((trade) => integerPrice(trade.price)));
  const missingPrices = expectedPrices.filter((price) => !seenPrices.has(price));
  if (missingPrices.length > 0) {
    throw new Error(
      `Trade history missing prices ${missingPrices.join(", ")}: ${JSON.stringify(tradeHistory)}`,
    );
  }
  for (const trade of matchingTrades) {
    if (Number.parseFloat(trade.size ?? "0") !== 0.001) {
      throw new Error(`Expected retained trade size 0.001, got ${JSON.stringify(trade)}`);
    }
  }
}

async function assertSpecificOrderHistory(
  client: GteOrderClient,
  config: TestConfig,
  expectedClientIds: string[],
): Promise<void> {
  const orderHistory = await client.accounts.getOrders({
    userAddress: config.userAddress,
    symbol: config.symbol,
    limit: 50,
  });
  const orders = orderHistory.orders ?? [];
  for (const clientId of expectedClientIds) {
    const order = orders.find((entry) => entry.clientId === clientId);
    if (!order) {
      throw new Error(
        `Order history missing clientId=${clientId}: ${JSON.stringify(orderHistory)}`,
      );
    }
    if (order.status !== "filled") {
      throw new Error(`Expected clientId=${clientId} FILLED, got ${JSON.stringify(order)}`);
    }
  }
}

export async function runOrderTests(
  client: GteOrderClient,
  config: TestConfig,
): Promise<SuiteResult> {
  if (!config.counterpartyAddress || !config.counterpartyPk) {
    throw new Error("counterpartyAddress and counterpartyPk are required for order tests");
  }

  const counterparty = createCounterpartyClient(config);
  let positionSizeBefore = 0;
  let restingLimitClientOrderId = "";
  const restingLimitSide = "sell";
  const restingLimitPrice = "100";
  let expectedLeverage = 5;

  const assertFilledPosition = async (context: "initial" | "persisted"): Promise<void> => {
    const res = await client.accounts.getPositions({
      userAddress: config.userAddress,
    });
    const positions = res.positions ?? [];
    if (context === "initial" && positions.length === 0) {
      throw new Error("Expected at least one position after fill");
    }
    const position = positions.find((p) => p.marketSymbol === config.symbol);
    if (!position) throw new Error(`No position found for ${config.symbol}`);
    if (!position.side) throw new Error("Position missing side");
    if (!position.size) throw new Error("Position missing size");
    const posSize = Number.parseFloat(position.size);
    const expectedMin = positionSizeBefore + CAP_SAFE_ORDER_SIZE;
    if (Math.abs(posSize - expectedMin) > POSITION_SIZE_TOLERANCE) {
      throw new Error(
        `expected position size=${expectedMin.toFixed(8)} (before=${positionSizeBefore} + ${CAP_SAFE_ORDER_QUANTITY} fill), got ${position.size}; tolerance=${POSITION_SIZE_TOLERANCE}`,
      );
    }
    assertPositionFinancials(position);
  };

  const assertTpslRoundTrip = async (
    tpClientOrderId: string,
    slClientOrderId: string,
  ): Promise<void> => {
    const open = await client.accounts.getOpenOrders({
      userAddress: config.userAddress,
    });
    const orders = open.orders ?? [];
    assertStopLimitTpslOpenOrder(
      requireOpenOrderByClientId(orders, tpClientOrderId, "TP"),
      "TP",
      "tp",
    );
    assertStopLimitTpslOpenOrder(
      requireOpenOrderByClientId(orders, slClientOrderId, "SL"),
      "SL",
      "sl",
    );
  };

  const assertWsTpslOrder = (
    order: PerpOpenOrder | undefined,
    clientOrderId: string,
    tpsl: "tp" | "sl",
    triggerPrice: string,
  ): void => {
    if (!order) throw new Error(`WS open-order missing clientId=${clientOrderId}`);
    if (order.orderType !== "stop_limit") {
      throw new Error(
        `Expected WS clientId=${clientOrderId} orderType=stop_limit, got ${String(order.orderType)}`,
      );
    }
    if (Number(order.triggerPrice) !== Number(triggerPrice)) {
      throw new Error(
        `Expected WS clientId=${clientOrderId} triggerPrice=${triggerPrice}, got ${String(order.triggerPrice)}`,
      );
    }
    if (order.tpsl !== tpsl) {
      throw new Error(
        `Expected WS clientId=${clientOrderId} tpsl=${tpsl}, got ${String(order.tpsl)}`,
      );
    }
    if (order.isReduceOnly !== false) {
      throw new Error(
        `Expected WS clientId=${clientOrderId} isReduceOnly=false (placed with reduceOnly:false), got ${String(order.isReduceOnly)}`,
      );
    }
  };

  const assertAcceptedBatchResult = (
    result: OrderResult | undefined,
    label: string,
    expectedClientOrderId: string,
  ): OrderResult => {
    if (!result) throw new Error(`${label} missing result`);
    if (String(result.clientOrderId ?? "") !== expectedClientOrderId) {
      throw new Error(
        `${label} expected clientOrderId=${expectedClientOrderId}, got ${JSON.stringify(result)}`,
      );
    }
    if (result.error) throw new Error(`${label} rejected: ${result.error}`);
    if (!result.orderId) throw new Error(`${label} missing orderId: ${JSON.stringify(result)}`);
    return result;
  };

  const assertRejectedBatchResult = (
    result: OrderResult | undefined,
    label: string,
    expectedClientOrderId: string,
  ): OrderResult => {
    if (!result) throw new Error(`${label} missing result`);
    if (String(result.clientOrderId ?? "") !== expectedClientOrderId) {
      throw new Error(
        `${label} expected clientOrderId=${expectedClientOrderId}, got ${JSON.stringify(result)}`,
      );
    }
    if (!result.error) throw new Error(`${label} expected rejection: ${JSON.stringify(result)}`);
    if (result.status !== "rejected") {
      throw new Error(`${label} expected rejected, got ${String(result.status)}`);
    }
    return result;
  };

  const tests: TestDefinition[] = [
    {
      name: "credit accounts",
      fn: async () => {
        if (!config.counterpartyAddress) {
          throw new Error("counterpartyAddress is required");
        }
        await creditAccounts(
          [config.userAddress, config.counterpartyAddress],
          config.httpUrl,
          ORDER_SMOKE_CREDIT_AMOUNT,
        );
        await sleep(CREDIT_SETTLE_DELAY_MS);
      },
    },
    {
      name: "create and cancel order at default leverage",
      fn: async () => {
        const clientOrderId = String(Date.now());
        const result = await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "90",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId,
          },
        ]);
        assertAcceptedBatchResult(result.results?.[0], "default leverage order", clientOrderId);
        await client.orders.cancel([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            origClientOrderId: clientOrderId,
          },
        ]);
        await retryUntil(async () => {
          const open = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
          });
          const lingering = (open.orders ?? []).find((order) => order.clientId === clientOrderId);
          if (lingering) {
            throw new Error(`Default leverage order still open: ${JSON.stringify(lingering)}`);
          }
        }, ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    {
      name: "set max leverage for high-notional order coverage",
      fn: async () => {
        await client.accounts.setLeverage({
          userAddress: config.userAddress,
          symbol: config.symbol,
          leverage: MAX_LEVERAGE,
          subaccountId: 0,
        });
        await counterparty.accounts.setLeverage({
          userAddress: config.counterpartyAddress,
          symbol: config.symbol,
          leverage: MAX_LEVERAGE,
          subaccountId: 0,
        });
        await sleep(CREDIT_SETTLE_DELAY_MS);
      },
    },
    {
      name: "create limit order",
      fn: async () => {
        restingLimitClientOrderId = String(Date.now());
        const result = await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: restingLimitSide,
            orderType: "limit",
            price: restingLimitPrice,
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId: restingLimitClientOrderId,
          },
        ]);

        const order = result.results?.[0];
        if (!order) throw new Error("No order result returned");
        if (!order.orderId) throw new Error("Order missing orderId");
        if (order.error) throw new Error(`Order rejected: ${order.error}`);
      },
    },
    {
      name: "verify order in open orders",
      fn: async () => {
        await retryUntil(async () => {
          const res = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
          });

          assertRestingLimitOpenOrder(
            res,
            restingLimitClientOrderId,
            restingLimitSide,
            restingLimitPrice,
            CAP_SAFE_ORDER_QUANTITY,
          );
        }, ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    {
      name: "verify resting order in order history",
      fn: async () => {
        const res = await client.accounts.getOrders({
          userAddress: config.userAddress,
          symbol: config.symbol,
        });

        const orders = res.orders ?? [];
        if (orders.length === 0) throw new Error("Expected at least one order in history");

        const buyOrder = orders.find((o) => o.clientId === restingLimitClientOrderId);
        if (!buyOrder) {
          const summaries = orders
            .map((o) => `${o.clientId}:${o.side}@${o.price}:${o.status}`)
            .join(", ");
          throw new Error(
            `Expected clientId=${restingLimitClientOrderId} in history, found: [${summaries}]`,
          );
        }
        if (buyOrder.side !== restingLimitSide)
          throw new Error(`Expected ${restingLimitSide}, got ${buyOrder.side}`);
        if (
          !buyOrder.price ||
          Number.parseFloat(buyOrder.price) !== Number.parseFloat(restingLimitPrice)
        ) {
          throw new Error(`Expected price=${restingLimitPrice}, got ${buyOrder.price}`);
        }
        if (buyOrder.status !== "new") {
          throw new Error(`Expected new, got ${buyOrder.status}`);
        }
      },
    },
    {
      name: "cancel order",
      fn: async () => {
        const openOrders = await client.accounts.getOpenOrders({
          userAddress: config.userAddress,
          symbol: config.symbol,
        });

        const orderToCancel = (openOrders.orders ?? []).find(
          (o) => o.clientId === restingLimitClientOrderId,
        );
        if (!orderToCancel) {
          throw new Error(`No open clientId=${restingLimitClientOrderId} order to cancel`);
        }

        const result = await client.orders.cancel([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: orderToCancel.side ?? "buy",
            origOrderId: orderToCancel.orderId,
          },
        ]);

        const cancelResult = result.results?.[0];
        if (!cancelResult) throw new Error("No cancel result returned");
        if (cancelResult.error) throw new Error(`Cancel rejected: ${cancelResult.error}`);
      },
    },
    {
      name: "verify order removed from open orders",
      fn: async () => {
        await retryUntil(async () => {
          const res = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
          });

          const orders = res.orders ?? [];
          const stillPresent = orders.find((o) => o.clientId === restingLimitClientOrderId);
          if (stillPresent) {
            throw new Error(`clientId=${restingLimitClientOrderId} still present after cancel`);
          }
        }, ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    {
      name: "batch create preserves earlier success on later reject",
      fn: async () => {
        const acceptedClientOrderId = String(Date.now());
        const rejectedClientOrderId = String(Date.now() + 1);

        const result = await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "73",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId: acceptedClientOrderId,
          },
          {
            account: "not_an_address",
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "74",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId: rejectedClientOrderId,
          },
        ]);

        assertAcceptedBatchResult(
          result.results?.[0],
          "batch create accepted item",
          acceptedClientOrderId,
        );
        assertRejectedBatchResult(
          result.results?.[1],
          "batch create rejected item",
          rejectedClientOrderId,
        );

        await retryUntil(async () => {
          const openOrders = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
          });
          const order = (openOrders.orders ?? []).find(
            (entry) => entry.clientId === acceptedClientOrderId,
          );
          if (!order) {
            throw new Error(
              `Expected batch-created order clientId=${acceptedClientOrderId} to stay open: ${JSON.stringify(openOrders)}`,
            );
          }
        }, ORDER_SETTLE_TIMEOUT_MS);

        const cleanup = await client.orders.cancel([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            origClientOrderId: acceptedClientOrderId,
          },
        ]);
        const cleanupResult = cleanup.results?.[0];
        if (!cleanupResult) throw new Error("Missing cleanup result for batch create smoke");
        if (cleanupResult.error) {
          throw new Error(`Batch create cleanup failed: ${cleanupResult.error}`);
        }

        await retryUntil(async () => {
          const openOrders = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
          });
          const order = (openOrders.orders ?? []).find(
            (entry) => entry.clientId === acceptedClientOrderId,
          );
          if (order) {
            throw new Error(
              `Batch create cleanup left clientId=${acceptedClientOrderId} open: ${JSON.stringify(openOrders)}`,
            );
          }
        }, ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    {
      name: "batch replace preserves earlier success on later reject",
      fn: async () => {
        const originalClientOrderId = String(Date.now());
        const replacedClientOrderId = String(Date.now() + 1);
        const rejectedClientOrderId = String(Date.now() + 2);

        const seed = await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "75",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId: originalClientOrderId,
          },
        ]);
        assertAcceptedBatchResult(
          seed.results?.[0],
          "batch replace seed item",
          originalClientOrderId,
        );

        await retryUntil(async () => {
          const openOrders = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
          });
          const order = (openOrders.orders ?? []).find(
            (entry) => entry.clientId === originalClientOrderId,
          );
          if (!order) {
            throw new Error(
              `Expected batch-replace seed order clientId=${originalClientOrderId} to stay open: ${JSON.stringify(openOrders)}`,
            );
          }
        }, ORDER_SETTLE_TIMEOUT_MS);

        const replaced = await client.orders.replace([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "76",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            clientOrderId: replacedClientOrderId,
            originalClientOrderId,
          },
          {
            account: "not_an_address",
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "77",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            clientOrderId: rejectedClientOrderId,
            originalClientOrderId,
          },
        ]);

        assertAcceptedBatchResult(
          replaced.results?.[0],
          "batch replace accepted item",
          replacedClientOrderId,
        );
        assertRejectedBatchResult(
          replaced.results?.[1],
          "batch replace rejected item",
          rejectedClientOrderId,
        );

        await retryUntil(async () => {
          const openOrders = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
          });
          const replacement = (openOrders.orders ?? []).find(
            (entry) => entry.clientId === replacedClientOrderId,
          );
          if (!replacement) {
            throw new Error(
              `Expected batch-replaced order clientId=${replacedClientOrderId} to stay open: ${JSON.stringify(openOrders)}`,
            );
          }
          const original = (openOrders.orders ?? []).find(
            (entry) => entry.clientId === originalClientOrderId,
          );
          if (original) {
            throw new Error(
              `Expected original clientId=${originalClientOrderId} to be gone after replace: ${JSON.stringify(openOrders)}`,
            );
          }
        }, ORDER_SETTLE_TIMEOUT_MS);

        const cleanup = await client.orders.cancel([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            origClientOrderId: replacedClientOrderId,
          },
        ]);
        const cleanupResult = cleanup.results?.[0];
        if (!cleanupResult) throw new Error("Missing cleanup result for batch replace smoke");
        if (cleanupResult.error) {
          throw new Error(`Batch replace cleanup failed: ${cleanupResult.error}`);
        }

        await retryUntil(async () => {
          const openOrders = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
          });
          const order = (openOrders.orders ?? []).find(
            (entry) => entry.clientId === replacedClientOrderId,
          );
          if (order) {
            throw new Error(
              `Batch replace cleanup left clientId=${replacedClientOrderId} open: ${JSON.stringify(openOrders)}`,
            );
          }
        }, ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    {
      name: "verify open orders cursor and client id filters",
      fn: async () => {
        const clientOrderIdBase = Date.now();
        const expectedClientIds = [
          String(clientOrderIdBase + 1),
          String(clientOrderIdBase + 2),
          String(clientOrderIdBase + 3),
        ];

        const result = await client.orders.create(
          expectedClientIds.map((clientOrderId, index) => ({
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy" as const,
            orderType: "limit" as const,
            price: String(63 + index),
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc" as const,
            clientOrderId,
          })),
        );

        const rejected = result.results?.find((order) => order.error);
        if (rejected?.error)
          throw new Error(`Open-order pagination seed rejected: ${rejected.error}`);

        await retryUntil(async () => {
          const page = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
            limit: 10,
          });
          assertOpenOrdersIncludeClientIds(page, expectedClientIds, "Open orders");
        }, ORDER_SETTLE_TIMEOUT_MS);

        const firstPage = await client.accounts.getOpenOrders({
          userAddress: config.userAddress,
          symbol: config.symbol,
          limit: 2,
        });
        assertOpenOrdersPageLength(firstPage, 2, "first open-orders page");
        const nextCursor = requireOpenOrdersNextCursor(firstPage, "full open-orders page");

        const secondPage = await client.accounts.getOpenOrders({
          userAddress: config.userAddress,
          symbol: config.symbol,
          limit: 2,
          cursor: nextCursor,
        });
        assertOpenOrdersPagesAdvance(firstPage, secondPage);
        assertOpenOrdersIncludeClientIds(
          {
            orders: [...(firstPage.orders ?? []), ...(secondPage.orders ?? [])],
          },
          expectedClientIds,
          "Paged open orders",
        );

        const filtered = await client.accounts.getOpenOrders({
          userAddress: config.userAddress,
          symbol: config.symbol,
          limit: 10,
          clientId: expectedClientIds[1],
        });
        assertSingleClientIdFilteredOrder(filtered, expectedClientIds[1]);

        await client.orders.cancel(
          expectedClientIds.map((origClientOrderId) => ({
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy" as const,
            origClientOrderId,
          })),
        );

        await retryUntil(async () => {
          const page = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
            limit: 10,
          });
          const stillOpen = (page.orders ?? []).filter((order) =>
            expectedClientIds.includes(order.clientId ?? ""),
          );
          if (stillOpen.length > 0) {
            throw new Error(
              `Pagination seed orders still open after cleanup: ${JSON.stringify(stillOpen)}`,
            );
          }
        }, ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    {
      name: "verify order history cursor advances",
      fn: async () => {
        const clientOrderIdBase = Date.now();
        const expectedClientIds = [String(clientOrderIdBase + 1), String(clientOrderIdBase + 2)];

        const result = await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "61",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId: expectedClientIds[0],
          },
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "62",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId: expectedClientIds[1],
          },
        ]);

        const rejected = result.results?.find((order) => order.error);
        if (rejected?.error) throw new Error(`Cursor seed order rejected: ${rejected.error}`);

        await retryUntil(async () => {
          const page = await client.accounts.getOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
            limit: 20,
          });
          const seenClientIds = new Set((page.orders ?? []).map((order) => order.clientId));
          const missing = expectedClientIds.filter((clientId) => !seenClientIds.has(clientId));
          if (missing.length > 0) {
            throw new Error(`Order history missing cursor seed order(s): ${missing.join(", ")}`);
          }
        }, ORDER_SETTLE_TIMEOUT_MS);

        const firstPage = await client.accounts.getOrders({
          userAddress: config.userAddress,
          symbol: config.symbol,
          limit: 1,
        });
        const firstOrder = firstPage.orders?.[0];
        if (!firstOrder) throw new Error("Expected first order history page to contain an order");
        if (!firstPage.nextCursor) {
          throw new Error(
            `Expected nextCursor for full order history page: ${JSON.stringify(firstPage)}`,
          );
        }

        const secondPage = await client.accounts.getOrders({
          userAddress: config.userAddress,
          symbol: config.symbol,
          limit: 1,
          cursor: firstPage.nextCursor,
        });
        const secondOrder = secondPage.orders?.[0];
        if (!secondOrder) throw new Error("Expected second order history page to contain an order");

        if (
          firstOrder.orderId === secondOrder.orderId &&
          firstOrder.status === secondOrder.status
        ) {
          throw new Error(
            `Expected cursor to advance, got duplicate first rows: ${JSON.stringify({ firstOrder, secondOrder })}`,
          );
        }
      },
    },
    {
      name: "fill order via matching",
      fn: async () => {
        // Snapshot position size before the fill so we can verify the delta
        const preRes = await client.accounts.getPositions({
          userAddress: config.userAddress,
        });
        const prePos = (preRes.positions ?? []).find((p) => p.marketSymbol === config.symbol);
        positionSizeBefore = prePos?.size ? Number.parseFloat(prePos.size) : 0;

        await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "100",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId: String(Date.now()),
          },
        ]);

        await counterparty.orders.create([
          {
            account: config.counterpartyAddress,
            symbol: config.symbol,
            side: "sell",
            orderType: "limit",
            price: "100",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId: String(Date.now() + 1),
          },
        ]);
      },
    },
    {
      name: "verify trade exists",
      fn: async () => {
        await retryUntil(async () => {
          const res = await client.markets.getTrades({
            symbol: config.symbol,
            limit: 50,
          });

          const trades = res.trades ?? [];
          if (trades.length === 0) throw new Error("Expected at least one trade after fill");
          const matchingTrade = trades.find(
            (t) =>
              t.price &&
              Number.parseFloat(t.price) === 100 &&
              t.size &&
              Number.parseFloat(t.size) === CAP_SAFE_ORDER_SIZE,
          );
          if (!matchingTrade) {
            const recent = trades
              .slice(0, 5)
              .map((t) => `${t.price}@${t.size}`)
              .join(", ");
            throw new Error(
              `Expected trade at price=100, size=${CAP_SAFE_ORDER_QUANTITY}. Recent trades: [${recent}]`,
            );
          }
        }, ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    {
      name: "verify position created",
      fn: async () => {
        await retryUntil(() => assertFilledPosition("initial"), ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    {
      name: "verify position persists on a later HTTP read",
      fn: async () => {
        await sleep(500);
        await retryUntil(() => assertFilledPosition("persisted"), ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    {
      name: "generated set leverage request omits internal trace fields",
      fn: async () => {
        await assertGeneratedSetLeverageBodyShape({
          userAddress: config.userAddress,
          symbol: config.symbol,
          leverage: 7,
          subaccountId: 0,
        });
      },
    },
    {
      name: "set leverage and receive leverage_changes accept",
      fn: async () => {
        const current = await client.accounts.getLeverage({
          userAddress: config.userAddress,
          symbol: config.symbol,
          subaccountId: 0,
        });
        const currentLeverage = current.leverage ?? 1;
        expectedLeverage =
          currentLeverage >= MAX_LEVERAGE ? currentLeverage - 1 : currentLeverage + 1;

        const leverageChange = waitForLeverageChange(
          client,
          config.userAddress,
          config.symbol,
          0,
          expectedLeverage,
          config.wsTimeout,
        );
        leverageChange.catch(() => {});

        const result = await client.accounts.setLeverage({
          userAddress: config.userAddress,
          symbol: config.symbol,
          leverage: expectedLeverage,
          subaccountId: 0,
        });

        if (!result.success) throw new Error("setLeverage did not return success");
        await leverageChange;
      },
    },
    {
      name: "verify leverage updated",
      fn: async () => {
        await retryUntil(async () => {
          const res = await client.accounts.getLeverage({
            userAddress: config.userAddress,
            symbol: config.symbol,
          });

          if (res.leverage === undefined) throw new Error("getLeverage returned no value");
          if (res.leverage !== expectedLeverage) {
            throw new Error(`Expected leverage ${expectedLeverage}, got ${res.leverage}`);
          }
        }, LEVERAGE_SETTLE_TIMEOUT_MS);
      },
    },
    // -----------------------------------------------------------------------
    // Stop-limit trigger: place stop-limit sell, push price down to trigger,
    // verify the triggered order fills and position closes.
    // -----------------------------------------------------------------------
    {
      name: "stop-limit: place trigger order",
      skip: false,
      fn: async () => {
        // We already have a long position from the earlier fill test.
        // Place a stop-limit sell at trigger=95, limit=94 (stop-loss).
        const clientOrderId = String(Date.now());
        const wsPromise = waitForOrderUpdates(
          client,
          config.userAddress,
          1,
          WS_COLLECT_TIMEOUT_MS,
          (u) => u.order.clientId === clientOrderId,
        );
        await sleep(500);

        const result = await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "sell",
            orderType: "stop_limit",
            triggerPrice: "95",
            price: "94",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            reduceOnly: true,
            clientOrderId,
          },
        ]);

        const order = result.results?.[0];
        if (!order) throw new Error("No order result returned for stop-limit");
        if (order.error) throw new Error(`Stop-limit order rejected: ${order.error}`);

        const events = await wsPromise;
        const placed = events.find((e) => e.order.clientId === clientOrderId);
        if (!placed) {
          throw new Error(`No WS update for reduce-only stop-limit clientId=${clientOrderId}`);
        }
        if (placed.order.isReduceOnly !== true) {
          throw new Error(
            `Expected WS order.isReduceOnly=true for reduce-only stop-limit, got ${String(placed.order.isReduceOnly)}`,
          );
        }
      },
    },
    {
      name: "stop-limit: place resting buy to absorb triggered sell",
      skip: false,
      fn: async () => {
        // Counterparty places a resting buy at 94 so the triggered sell has
        // liquidity to fill against.
        if (!config.counterpartyAddress) throw new Error("counterpartyAddress required");
        await counterparty.orders.create([
          {
            account: config.counterpartyAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "94",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId: String(Date.now()),
          },
        ]);
      },
    },
    {
      name: "stop-limit: trigger by pushing price to 95",
      skip: false,
      fn: async () => {
        // Push the last-trade price to 95 to fire the stop.
        // User buys (resting) so their position is NOT reduced before the
        // triggered reduce-only sell fires.  Counterparty sells IOC to match.
        if (!config.counterpartyAddress) throw new Error("counterpartyAddress required");
        await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "95",
            quantity: "0.001",
            timeInForce: "gtc",
            clientOrderId: String(Date.now()),
          },
        ]);
        await counterparty.orders.create([
          {
            account: config.counterpartyAddress,
            symbol: config.symbol,
            side: "sell",
            orderType: "limit",
            price: "95",
            quantity: "0.001",
            timeInForce: "ioc",
            clientOrderId: String(Date.now() + 1),
          },
        ]);
      },
    },
    {
      name: "stop-limit: verify triggered fill via trades",
      skip: false,
      fn: async () => {
        await retryUntil(async () => {
          const res = await client.markets.getTrades({
            symbol: config.symbol,
            limit: 50,
          });
          const trades = res.trades ?? [];
          const triggerFill = trades.find((t) => t.price && Number.parseFloat(t.price) === 94);
          if (!triggerFill) {
            const recent = trades
              .slice(0, 10)
              .map((t) => `${t.price}@${t.size}`)
              .join(", ");
            throw new Error(
              `Expected trade at price=94 from triggered stop-limit. Recent: [${recent}]`,
            );
          }
        }, ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    // -----------------------------------------------------------------------
    // Rebuild a long position for remaining tests (stop-limit consumed it).
    // -----------------------------------------------------------------------
    {
      name: "rebuild position after stop-limit test",
      skip: false,
      fn: async () => {
        if (!config.counterpartyAddress) throw new Error("counterpartyAddress required");
        await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "100",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId: String(Date.now()),
          },
        ]);
        await counterparty.orders.create([
          {
            account: config.counterpartyAddress,
            symbol: config.symbol,
            side: "sell",
            orderType: "limit",
            price: "100",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId: String(Date.now() + 1),
          },
        ]);
        // Wait until the rebuilt position is visible so the next test's
        // reduce-only stop-market is not rejected for missing position.
        await retryUntil(async () => {
          const res = await client.accounts.getPositions({
            userAddress: config.userAddress,
          });
          const position = (res.positions ?? []).find((p) => p.marketSymbol === config.symbol);
          if (!position?.size || Number.parseFloat(position.size) <= 0) {
            throw new Error("Position not rebuilt yet");
          }
        }, ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    // -----------------------------------------------------------------------
    // Stop-market trigger: place stop-market sell, trigger it, verify fill.
    // -----------------------------------------------------------------------
    {
      name: "stop-market: place trigger order",
      skip: false,
      fn: async () => {
        const clientOrderId = String(Date.now());
        const wsPromise = waitForOrderUpdates(
          client,
          config.userAddress,
          1,
          WS_COLLECT_TIMEOUT_MS,
          (u) => u.order.clientId === clientOrderId,
        );
        await sleep(500);

        const result = await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "sell",
            orderType: "stop_market",
            triggerPrice: "90",
            price: "85",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "ioc",
            reduceOnly: true,
            clientOrderId,
          },
        ]);

        const order = result.results?.[0];
        if (!order) throw new Error("No order result returned for stop-market");
        if (order.error) throw new Error(`Stop-market order rejected: ${order.error}`);

        const events = await wsPromise;
        const placed = events.find((e) => e.order.clientId === clientOrderId);
        if (!placed) {
          throw new Error(`No WS update for reduce-only stop-market clientId=${clientOrderId}`);
        }
        if (placed.order.isReduceOnly !== true) {
          throw new Error(
            `Expected WS order.isReduceOnly=true for reduce-only stop-market, got ${String(placed.order.isReduceOnly)}`,
          );
        }
      },
    },
    {
      name: "stop-market: place resting buy to absorb triggered sell",
      skip: false,
      fn: async () => {
        if (!config.counterpartyAddress) throw new Error("counterpartyAddress required");
        await counterparty.orders.create([
          {
            account: config.counterpartyAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "85",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId: String(Date.now()),
          },
        ]);
      },
    },
    {
      name: "stop-market: trigger by pushing price to 90",
      skip: false,
      fn: async () => {
        if (!config.counterpartyAddress) throw new Error("counterpartyAddress required");
        // User buys (resting) so position is NOT reduced before triggered
        // reduce-only sell fires.  Counterparty sells IOC to match.
        await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "90",
            quantity: "0.001",
            timeInForce: "gtc",
            clientOrderId: String(Date.now()),
          },
        ]);
        await counterparty.orders.create([
          {
            account: config.counterpartyAddress,
            symbol: config.symbol,
            side: "sell",
            orderType: "limit",
            price: "90",
            quantity: "0.001",
            timeInForce: "ioc",
            clientOrderId: String(Date.now() + 1),
          },
        ]);
      },
    },
    {
      name: "stop-market: verify triggered fill via trades",
      skip: false,
      fn: async () => {
        await retryUntil(async () => {
          const res = await client.markets.getTrades({
            symbol: config.symbol,
            limit: 50,
          });
          const trades = res.trades ?? [];
          const triggerFill = trades.find((t) => t.price && Number.parseFloat(t.price) === 85);
          if (!triggerFill) {
            const recent = trades
              .slice(0, 10)
              .map((t) => `${t.price}@${t.size}`)
              .join(", ");
            throw new Error(
              `Expected trade at price=85 from triggered stop-market. Recent: [${recent}]`,
            );
          }
        }, ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    {
      name: "verify market trade cursor advances",
      skip: false,
      fn: async () => {
        const firstPage = await client.markets.getTrades({
          symbol: config.symbol,
          limit: 1,
        });
        const firstTrade = firstPage.trades?.[0];
        if (!firstTrade) throw new Error("Expected first market trade page to contain a trade");
        if (!firstPage.nextCursor) {
          throw new Error(
            `Expected nextCursor for full market trade page: ${JSON.stringify(firstPage)}`,
          );
        }

        const secondPage = await client.markets.getTrades({
          symbol: config.symbol,
          limit: 1,
          cursor: firstPage.nextCursor,
        });
        const secondTrade = secondPage.trades?.[0];
        if (!secondTrade) throw new Error("Expected second market trade page to contain a trade");
        if (firstTrade.id === secondTrade.id) {
          throw new Error(
            `Expected market trade cursor to advance, got duplicate first rows: ${JSON.stringify({
              firstTrade,
              secondTrade,
            })}`,
          );
        }
      },
    },
    {
      name: "verify user trade history cursor advances",
      skip: false,
      fn: async () => {
        const firstPage = await client.accounts.getTradeHistory({
          userAddress: config.userAddress,
          marketSymbol: config.symbol,
          limit: 1,
        });
        const firstTrade = firstPage.trades[0];
        if (!firstTrade) throw new Error("Expected first user trade page to contain a trade");
        if (!firstPage.nextCursor) {
          throw new Error(
            `Expected nextCursor for full user trade page: ${JSON.stringify(firstPage)}`,
          );
        }

        const secondPage = await client.accounts.getTradeHistory({
          userAddress: config.userAddress,
          marketSymbol: config.symbol,
          limit: 1,
          cursor: firstPage.nextCursor,
        });
        const secondTrade = secondPage.trades[0];
        if (!secondTrade) throw new Error("Expected second user trade page to contain a trade");
        if (firstTrade.id === secondTrade.id) {
          throw new Error(
            `Expected user trade cursor to advance, got duplicate first rows: ${JSON.stringify({
              firstTrade,
              secondTrade,
            })}`,
          );
        }
      },
    },
    {
      name: "verify SDK history returns specific retained fills and orders",
      skip: false,
      fn: async () => {
        const clientOrderIdBase = Date.now();
        const expectedClientIds = [1, 2, 3, 4].map((n) => String(clientOrderIdBase + n));
        const expectedPrices = ["111", "112", "113", "114"];

        for (let i = 0; i < expectedPrices.length; i += 1) {
          await client.orders.create([
            {
              account: config.userAddress,
              symbol: config.symbol,
              side: "buy",
              orderType: "limit",
              price: expectedPrices[i],
              quantity: "0.001",
              timeInForce: "gtc",
              clientOrderId: expectedClientIds[i],
            },
          ]);
          await counterparty.orders.create([
            {
              account: config.counterpartyAddress,
              symbol: config.symbol,
              side: "sell",
              orderType: "limit",
              price: expectedPrices[i],
              quantity: "0.001",
              timeInForce: "ioc",
              clientOrderId: String(clientOrderIdBase + 10_000 + i),
            },
          ]);
        }

        await retryUntil(async () => {
          await assertSpecificTradeHistory(client, config, expectedPrices);
          await assertSpecificOrderHistory(client, config, expectedClientIds);
        }, ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    // -----------------------------------------------------------------------
    // GTD order: place a limit order with goodTilTime in the past, verify
    // it is rejected or expires immediately rather than resting on the book.
    // -----------------------------------------------------------------------
    {
      name: "GTD: reject already-expired order",
      skip: false,
      fn: async () => {
        const expiredClientOrderId = String(Date.now());
        const pastTime = String(Date.now() - 1_000);
        await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "80",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtd",
            goodTilTime: pastTime,
            clientOrderId: expiredClientOrderId,
          },
        ]);

        // The order should either be rejected outright or accepted and expired
        // immediately; either way it must not remain on the open-order book.
        await sleep(ORDER_SETTLE_TIMEOUT_MS);
        const openRes = await client.accounts.getOpenOrders({
          userAddress: config.userAddress,
          symbol: config.symbol,
        });
        const expired = (openRes.orders ?? []).find((o) => o.clientId === expiredClientOrderId);
        if (expired) throw new Error("GTD order with past expiry should not rest on book");
      },
    },
    {
      name: "GTD: place valid GTD order and verify it rests",
      skip: false,
      fn: async () => {
        const futureTime = String(Date.now() + 60_000);
        const result = await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "70",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtd",
            goodTilTime: futureTime,
            clientOrderId: String(Date.now()),
          },
        ]);

        const order = result.results?.[0];
        if (!order) throw new Error("No order result returned for GTD order");
        if (order.error) throw new Error(`GTD order rejected: ${order.error}`);

        await retryUntil(async () => {
          const openRes = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
          });
          const gtdOrder = (openRes.orders ?? []).find(
            (o) => o.side === "buy" && o.limitPrice && Number.parseFloat(o.limitPrice) === 70,
          );
          if (!gtdOrder) {
            const prices = (openRes.orders ?? [])
              .map((o) => `${o.side}@${o.limitPrice}`)
              .join(", ");
            throw new Error(`Expected GTD BUY@70 in open orders, found: [${prices}]`);
          }
        }, ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    {
      name: "GTD: cancel the resting GTD order by order id",
      skip: false,
      fn: async () => {
        const openRes = await client.accounts.getOpenOrders({
          userAddress: config.userAddress,
          symbol: config.symbol,
        });
        const gtdOrder = (openRes.orders ?? []).find(
          (o) => o.side === "buy" && o.limitPrice && Number.parseFloat(o.limitPrice) === 70,
        );
        if (!gtdOrder?.orderId) {
          throw new Error("Expected GTD BUY@70 to expose an orderId for cancel-by-order-id");
        }

        const cancelResult = await client.orders.cancel([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            origOrderId: gtdOrder.orderId,
          },
        ]);
        const cancelled = cancelResult.results?.[0];
        if (!cancelled) throw new Error("No cancel result returned for GTD order");
        if (cancelled.error) throw new Error(`GTD order cancel rejected: ${cancelled.error}`);

        await retryUntil(async () => {
          const afterCancel = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
          });
          const stillOpen = (afterCancel.orders ?? []).find((o) => o.orderId === gtdOrder.orderId);
          if (stillOpen) {
            throw new Error(`GTD order ${gtdOrder.orderId} still open after cancel-by-order-id`);
          }
        }, ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    {
      name: "cancel non-existent order completes without crash",
      fn: async () => {
        // Cancel an order that was never placed — the HTTP path may return
        // CANCELLED or REJECTED depending on the gateway. The important thing
        // is the reject/cancel path doesn't crash and returns a result.
        const result = await client.orders.cancel([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            origClientOrderId: "999999999",
          },
        ]);

        const cancelResult = result.results?.[0];
        if (!cancelResult) throw new Error("No cancel result returned");

        const status = cancelResult.status ?? "";
        const validStatus = status === "rejected" || status === "cancelled" || !!cancelResult.error;
        if (!validStatus) {
          throw new Error(`Unexpected status for non-existent order cancel: ${status}`);
        }
      },
    },
    {
      name: "WS: place order produces NEW event",
      skip: false,
      fn: async () => {
        const wsPromise = waitForWsMessages(client, config.userAddress, 1, WS_COLLECT_TIMEOUT_MS);
        // Small delay to let subscription establish
        await sleep(500);

        await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "90",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId: String(Date.now()),
          },
        ]);

        const events = await wsPromise;
        const newEvent = events.find((e) => e.status === "new");
        if (!newEvent) {
          const statuses = events.map((e) => e.status ?? "?").join(", ");
          throw new Error(`Expected new event, got: [${statuses}]`);
        }
      },
    },
    {
      name: "WS: order history stream emits archived CANCELLED update",
      skip: false,
      fn: async () => {
        const clOrdId = String(Date.now());
        const createResult = await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "90",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId: clOrdId,
          },
        ]);
        const placedOrder = createResult.results?.[0];
        if (!placedOrder?.clientOrderId) throw new Error("No clientOrderId from placed order");

        await retryUntil(async () => {
          const openRes = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
          });
          const placed = (openRes.orders ?? []).find(
            (o) => o.clientId === placedOrder.clientOrderId,
          );
          if (!placed) throw new Error("Placed order not yet visible on open orders");
        }, ORDER_SETTLE_TIMEOUT_MS);

        const wsPromise = waitForOrderHistoryUpdates(
          client,
          config.userAddress,
          1,
          WS_COLLECT_TIMEOUT_MS,
        );
        await sleep(500);

        await client.orders.cancel([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            origClientOrderId: placedOrder.clientOrderId,
          },
        ]);

        const events = await wsPromise;
        const cancelledEvent = events.find(
          (e) => e.status === "canceled" || e.order.status === "cancelled",
        );
        if (!cancelledEvent) {
          const statuses = events.map((e) => `${e.status}/${e.order.status ?? "?"}`).join(", ");
          throw new Error(`Expected CANCELLED order history update, got: [${statuses}]`);
        }
      },
    },
    {
      name: "WS: cancel non-existent order produces REJECTED event with OrderNotFound",
      skip: false,
      fn: async () => {
        const wsPromise = waitForOrderUpdates(
          client,
          config.userAddress,
          1,
          WS_COLLECT_TIMEOUT_MS,
          isRejectedOrderUpdate,
        );
        await sleep(500);

        await client.orders.cancel([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            origClientOrderId: "888888888",
          },
        ]);

        const events = await wsPromise;
        const rejectEvent = events.find((e) => e.order.status === "rejected");
        if (!rejectEvent) {
          const statuses = events.map((e) => `${e.order.status ?? "?"}`).join(", ");
          throw new Error(`Expected REJECTED event on 'orders' topic, got: [${statuses}]`);
        }
        if (!rejectEvent.error) {
          throw new Error("REJECTED OrderUpdate missing error field");
        }
        if (!rejectEvent.error.includes("OrderNotFound")) {
          throw new Error(`Expected error to contain 'OrderNotFound', got: '${rejectEvent.error}'`);
        }
      },
    },
    {
      name: "WS: cancel already-cancelled order produces REJECTED event",
      skip: false,
      fn: async () => {
        // Place an order, cancel it, then cancel again — the second cancel
        // should produce an OrderNotFound reject via WS `orders` topic.
        const clOrdId = String(Date.now());
        const createResult = await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "90",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            clientOrderId: clOrdId,
          },
        ]);
        const placedOrder = createResult.results?.[0];
        if (!placedOrder?.clientOrderId) throw new Error("No clientOrderId from placed order");

        await retryUntil(async () => {
          const openRes = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
          });
          const placed = (openRes.orders ?? []).find(
            (o) => o.clientId === placedOrder.clientOrderId,
          );
          if (!placed) throw new Error("Placed order not yet visible on open orders");
        }, ORDER_SETTLE_TIMEOUT_MS);

        await client.orders.cancel([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            origClientOrderId: placedOrder.clientOrderId,
          },
        ]);

        await retryUntil(async () => {
          const openRes = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
          });
          const stillOpen = (openRes.orders ?? []).find(
            (o) => o.clientId === placedOrder.clientOrderId,
          );
          if (stillOpen) throw new Error("First cancel has not yet removed order");
        }, ORDER_SETTLE_TIMEOUT_MS);

        // Subscribe to WS `orders` topic, then cancel the same order again.
        // Filter for REJECTED events only — the gateway may replay a small
        // look-back window to new subscribers which can surface the earlier
        // CANCELLED update, but the test only cares about the REJECTED reply
        // from the second cancel.
        const wsPromise = waitForOrderUpdates(
          client,
          config.userAddress,
          1,
          WS_COLLECT_TIMEOUT_MS,
          isRejectedOrderUpdate,
        );
        await sleep(500);

        await client.orders.cancel([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            origClientOrderId: placedOrder.clientOrderId,
          },
        ]);

        const events = await wsPromise;
        const rejectEvent = events.find((e) => e.order.status === "rejected");
        if (!rejectEvent) {
          const statuses = events.map((e) => `${e.order.status ?? "?"}`).join(", ");
          throw new Error(`Expected REJECTED event for double-cancel, got: [${statuses}]`);
        }
        if (!rejectEvent.error) {
          throw new Error("REJECTED OrderUpdate from double-cancel missing error field");
        }
      },
    },
    // -----------------------------------------------------------------------
    // tpsl round-trip: resting stop-limits tagged with tpsl must surface the
    // same tag and trigger price through /accounts/.../orders/open and the
    // open-orders WS stream without firing the stops.
    // -----------------------------------------------------------------------
    {
      name: "tpsl: round-trip TP + SL tags on resting stops",
      skip: false,
      fn: async () => {
        // Place a SELL TP and BUY SL far above the current price. Both should
        // rest in the trigger book and round-trip through /orders/open and WS.
        const tpClientOrderId = String(Date.now());
        const slClientOrderId = String(Date.now() + 1);
        const wsPromise = waitForWsMessages(
          client,
          config.userAddress,
          2,
          WS_COLLECT_TIMEOUT_MS,
          (order) => order.clientId === tpClientOrderId || order.clientId === slClientOrderId,
        );
        await sleep(500);

        const result = await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "sell",
            orderType: "stop_limit",
            triggerPrice: "1000",
            price: "1000",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            reduceOnly: false,
            clientOrderId: tpClientOrderId,
            tpsl: "tp",
          },
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "stop_limit",
            triggerPrice: "1000",
            price: "1000",
            quantity: CAP_SAFE_ORDER_QUANTITY,
            timeInForce: "gtc",
            reduceOnly: false,
            clientOrderId: slClientOrderId,
            tpsl: "sl",
          },
        ]);
        const tpPlaced = result.results?.[0];
        const slPlaced = result.results?.[1];
        if (!tpPlaced) throw new Error("No TP result returned");
        if (tpPlaced.status === "rejected" || tpPlaced.error) {
          throw new Error(
            `TP stop rejected: status=${tpPlaced.status} error=${tpPlaced.error ?? "none"} rejectReason=${tpPlaced.rejectReason ?? "none"}`,
          );
        }
        if (!slPlaced) throw new Error("No SL result returned");
        if (slPlaced.status === "rejected" || slPlaced.error) {
          throw new Error(
            `SL stop rejected: status=${slPlaced.status} error=${slPlaced.error ?? "none"} rejectReason=${slPlaced.rejectReason ?? "none"}`,
          );
        }

        await retryUntil(
          () => assertTpslRoundTrip(tpClientOrderId, slClientOrderId),
          ORDER_SETTLE_TIMEOUT_MS,
        );

        const wsOrders = await wsPromise;
        const wsTp = wsOrders.find((order) => order.clientId === tpClientOrderId);
        const wsSl = wsOrders.find((order) => order.clientId === slClientOrderId);
        assertWsTpslOrder(wsTp, tpClientOrderId, "tp", "1000");
        assertWsTpslOrder(wsSl, slClientOrderId, "sl", "1000");

        // Clean up. Poll until both tpsl orders have left the open-order set so
        // the resulting CANCELLED WS events do not leak into the next test's
        // fresh subscription window and get mistaken for its expected event.
        await client.orders.cancel([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "sell",
            origClientOrderId: tpClientOrderId,
          },
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            origClientOrderId: slClientOrderId,
          },
        ]);
        await retryUntil(async () => {
          const open = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
          });
          const stillOpen = (open.orders ?? []).filter(
            (o) => o.clientId === tpClientOrderId || o.clientId === slClientOrderId,
          );
          if (stillOpen.length > 0) throw new Error("tpsl cleanup still in flight");
        }, ORDER_SETTLE_TIMEOUT_MS);
      },
    },
    {
      name: "tpsl: filling TP auto-cancels remaining SL",
      skip: false,
      fn: async () => {
        if (!config.counterpartyAddress) throw new Error("counterpartyAddress required");

        await cancelOpenOrdersForSymbol(client, config);
        await flattenPositionForSymbol(client, counterparty, config);

        const testQuantity = CAP_SAFE_ORDER_QUANTITY;
        const testQuantityValue = Number.parseFloat(testQuantity);
        const entryMakerId = String(Date.now());
        const entryTakerId = String(Date.now() + 1);
        const tpClientOrderId = String(Date.now() + 2);
        const slClientOrderId = String(Date.now() + 3);
        const tpFillClientOrderId = String(Date.now() + 4);

        const baselinePosition = await getPositionForSymbol(client, config);
        const baselineSignedSize = getSignedPositionSize(baselinePosition);
        if (Math.abs(baselineSignedSize) > POSITION_SIZE_TOLERANCE) {
          throw new Error(
            `Expected flat baseline before TP/SL smoke, got ${JSON.stringify(baselinePosition)}`,
          );
        }

        await counterparty.orders.create([
          {
            account: config.counterpartyAddress,
            symbol: config.symbol,
            side: "sell",
            orderType: "limit",
            price: "100",
            quantity: testQuantity,
            timeInForce: "gtc",
            clientOrderId: entryMakerId,
          },
        ]);

        await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "100",
            quantity: testQuantity,
            timeInForce: "gtc",
            clientOrderId: entryTakerId,
          },
        ]);

        await retryUntil(async () => {
          const positions = await client.accounts.getPositions({
            userAddress: config.userAddress,
          });
          const btcPosition = (positions.positions ?? []).find(
            (position) => position.marketSymbol === config.symbol,
          );
          const signedSize = getSignedPositionSize(btcPosition);
          const expectedSignedSize = baselineSignedSize + testQuantityValue;
          if (!btcPosition || signedSize <= 0) {
            throw new Error(
              `Expected long ${config.symbol} position, got ${JSON.stringify(positions)}`,
            );
          }
          if (Math.abs(signedSize - expectedSignedSize) > POSITION_SIZE_TOLERANCE) {
            throw new Error(
              `Expected signed size=${expectedSignedSize.toFixed(8)}, got ${signedSize.toFixed(8)} from ${JSON.stringify(btcPosition)}`,
            );
          }
        }, ORDER_SETTLE_TIMEOUT_MS);

        const isTpFill = (update: OrderUpdate): boolean =>
          update.order.clientId === tpClientOrderId && update.status === "filled";
        const isSlCancel = (update: OrderUpdate): boolean =>
          update.order.clientId === slClientOrderId &&
          (update.status === "canceled" || update.order.status === "cancelled");

        const wsPromise = waitForOrderUpdates(
          client,
          config.userAddress,
          2,
          WS_COLLECT_TIMEOUT_MS,
          (update) => isTpFill(update) || isSlCancel(update),
        );
        await sleep(500);

        await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "sell",
            orderType: "limit",
            price: "115",
            quantity: testQuantity,
            timeInForce: "gtc",
            reduceOnly: true,
            clientOrderId: tpClientOrderId,
          },
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "sell",
            orderType: "stop_limit",
            triggerPrice: "90",
            price: "89",
            quantity: testQuantity,
            timeInForce: "gtc",
            reduceOnly: true,
            clientOrderId: slClientOrderId,
            tpsl: "sl",
          },
        ]);

        await retryUntil(async () => {
          const open = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
          });
          const tp = (open.orders ?? []).find((order) => order.clientId === tpClientOrderId);
          const sl = (open.orders ?? []).find((order) => order.clientId === slClientOrderId);
          if (!tp || !sl) {
            throw new Error(`Expected TP+SL in open orders, got ${JSON.stringify(open)}`);
          }
        }, ORDER_SETTLE_TIMEOUT_MS);

        await counterparty.orders.create([
          {
            account: config.counterpartyAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: "115",
            quantity: testQuantity,
            timeInForce: "gtc",
            clientOrderId: tpFillClientOrderId,
          },
        ]);

        const updates = await wsPromise;
        const tpFilled = updates.find(isTpFill);
        if (!tpFilled) {
          throw new Error(`Expected TP filled update, got ${JSON.stringify(updates)}`);
        }
        const slCanceled = updates.find(isSlCancel);
        if (!slCanceled) {
          throw new Error(
            `Expected sibling SL CANCELLED WS update after TP fill, got ${JSON.stringify(updates)}`,
          );
        }

        await retryUntil(async () => {
          const positions = await client.accounts.getPositions({
            userAddress: config.userAddress,
          });
          const btcPosition = (positions.positions ?? []).find(
            (position) => position.marketSymbol === config.symbol,
          );
          const signedSize = getSignedPositionSize(btcPosition);
          if (Math.abs(signedSize - baselineSignedSize) > POSITION_SIZE_TOLERANCE) {
            throw new Error(
              `Expected signed size to return to ${baselineSignedSize.toFixed(8)}, got ${signedSize.toFixed(8)} from ${JSON.stringify(positions)}`,
            );
          }

          const open = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
          });
          const lingering = (open.orders ?? []).filter(
            (order) => order.clientId === tpClientOrderId || order.clientId === slClientOrderId,
          );
          if (lingering.length > 0) {
            throw new Error(
              `Expected TP/SL open orders gone after close, got ${JSON.stringify(lingering)}`,
            );
          }
        }, WS_COLLECT_TIMEOUT_MS);
      },
    },
    {
      name: "WS: rejected OrderUpdate carries mapped status and error reason string",
      skip: false,
      fn: async () => {
        const wsPromise = waitForOrderUpdates(
          client,
          config.userAddress,
          1,
          WS_COLLECT_TIMEOUT_MS,
          isRejectedOrderUpdate,
        );
        await sleep(500);

        await client.orders.cancel([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "buy",
            origClientOrderId: "777777777",
          },
        ]);

        const events = await wsPromise;
        const rejectEvent = events.find((e) => e.status === "rejected");
        if (!rejectEvent) {
          const mapped = events.map((e) => `status=${e.status}`).join(", ");
          throw new Error(`Expected OrderUpdate with status='rejected', got: [${mapped}]`);
        }
        if (!rejectEvent.error || !rejectEvent.error.includes("OrderNotFound")) {
          throw new Error(
            `Expected OrderUpdate.error to contain 'OrderNotFound', got: '${rejectEvent.error ?? "(undefined)"}'`,
          );
        }
      },
    },
    // -----------------------------------------------------------------------
    // Realized PnL on live user-trade WS events: closing a long via a fresh
    // reduce-only fill must surface makerRpnl / takerRpnl on the user's side
    // of the streamed trade, so the frontend trade-history table can render
    // closedPnl without having to re-fetch REST history.
    // -----------------------------------------------------------------------
    {
      name: "WS: user-trade stream carries realized PnL on closing fill",
      skip: false,
      fn: async () => {
        if (!config.counterpartyAddress) throw new Error("counterpartyAddress required");

        await cancelOpenOrdersForSymbol(client, config);
        await flattenPositionForSymbol(client, counterparty, config);
        await openLongPositionForSymbol(client, counterparty, config, "0.001");

        const closeClientOrderId = String(Date.now());
        const closePrice = "1000";
        await client.orders.create([
          {
            account: config.userAddress,
            symbol: config.symbol,
            side: "sell",
            orderType: "limit",
            price: closePrice,
            quantity: "0.001",
            timeInForce: "gtc",
            reduceOnly: true,
            clientOrderId: closeClientOrderId,
          },
        ]);

        await retryUntil(async () => {
          const res = await client.accounts.getOpenOrders({
            userAddress: config.userAddress,
            symbol: config.symbol,
          });
          const resting = (res.orders ?? []).find((o) => o.clientId === closeClientOrderId);
          if (!resting) throw new Error("Reduce-only SELL not yet resting");
        }, ORDER_SETTLE_TIMEOUT_MS);

        const tradePromise = waitForUserTradeMatching(
          client,
          config.userAddress,
          WS_COLLECT_TIMEOUT_MS,
          (trade) => {
            const isMaker = trade.maker?.toLowerCase() === config.userAddress.toLowerCase();
            const rpnl = isMaker ? trade.makerRpnl : trade.takerRpnl;
            return rpnl !== undefined && rpnl !== "";
          },
        );
        await sleep(500);

        await counterparty.orders.create([
          {
            account: config.counterpartyAddress,
            symbol: config.symbol,
            side: "buy",
            orderType: "limit",
            price: closePrice,
            quantity: "0.001",
            timeInForce: "ioc",
            clientOrderId: String(Date.now() + 1),
          },
        ]);

        const trade = await tradePromise;
        const isMaker = trade.maker?.toLowerCase() === config.userAddress.toLowerCase();
        const userRpnl = isMaker ? trade.makerRpnl : trade.takerRpnl;
        if (userRpnl === undefined || userRpnl === "") {
          throw new Error(
            `Expected realized PnL on user's side (isMaker=${isMaker}) of closing trade, got maker=${trade.makerRpnl ?? ""} taker=${trade.takerRpnl ?? ""}`,
          );
        }
        if (Number.isNaN(Number(userRpnl))) {
          throw new Error(`Expected numeric realized PnL string, got '${userRpnl}'`);
        }
      },
    },
  ];

  return runSuite("order", tests, config);
}
