import type { GteDataClient } from "../../../src/index.js";
import {
  assertDefined,
  assertNonNegative,
  assertPositionFinancials,
  assertPositive,
  assertSortedDesc,
  assertValidNumber,
} from "../utils/invariants.js";
import { runSuite } from "../utils/runner.js";
import type { SuiteResult, TestConfig, TestDefinition } from "../utils/types.js";

export async function runAccountsTests(
  client: GteDataClient,
  config: TestConfig,
): Promise<SuiteResult> {
  const tests: TestDefinition[] = [
    {
      name: "getPositions",
      fn: async () => {
        const res = await client.accounts.getPositions({
          userAddress: config.userAddress,
        });
        const positions = res.positions ?? [];
        for (const pos of positions) {
          if (!pos.marketSymbol) throw new Error("Position missing marketSymbol");
          if (!pos.side) throw new Error("Position missing side");
          if (pos.size === undefined) throw new Error("Position missing size");
          assertPositionFinancials(pos);
        }
      },
    },
    {
      name: "getOpenOrders",
      fn: async () => {
        const res = await client.accounts.getOpenOrders({
          userAddress: config.userAddress,
        });
        const orders = res.orders ?? [];
        for (const order of orders) {
          if (!order.orderId) throw new Error("Order missing orderId");
          if (!order.marketSymbol) throw new Error("Order missing marketSymbol");
          if (order.limitPrice !== undefined) {
            assertPositive(order.limitPrice, "order.limitPrice");
          }
          if (order.originalSize !== undefined) {
            assertPositive(order.originalSize, "order.originalSize");
          }
        }
      },
    },
    {
      name: "getOrders",
      fn: async () => {
        const res = await client.accounts.getOrders({
          userAddress: config.userAddress,
          limit: 50,
        });
        const orders = res.orders ?? [];
        for (const order of orders) {
          assertValidOrderHistoryEntry(order);
        }
        assertOrderTimestampsSorted(orders);
      },
    },
    {
      name: "getFundingHistory",
      optional: true,
      fn: async () => {
        const res = await client.accounts.getFundingHistory({
          userAddress: config.userAddress,
          limit: 50,
        });
        const payments = res.payments ?? [];
        for (const p of payments) {
          if (!p.marketSymbol) throw new Error("FundingPayment missing marketSymbol");
          if (p.fundingRate === undefined) throw new Error("FundingPayment missing fundingRate");
          if (p.payment === undefined) throw new Error("FundingPayment missing payment");
        }
      },
    },
    {
      name: "getLeverage",
      fn: async () => {
        const res = await client.accounts.getLeverage({
          userAddress: config.userAddress,
          symbol: config.symbol,
        });
        if (res.leverage === undefined) throw new Error("getLeverage returned no value");
        assertPositive(res.leverage, "leverage");
      },
    },
    {
      name: "getTradeHistory",
      fn: async () => {
        const res = await client.accounts.getTradeHistory({
          userAddress: config.userAddress,
        });
        const trades = res.trades ?? [];
        for (const trade of trades) {
          assertValidTrade(trade);
          if (trade.startPosition === undefined) {
            throw new Error("UserTrade missing startPosition");
          }
          if (trade.leverage === undefined) {
            throw new Error("UserTrade missing leverage");
          }
        }
      },
    },
    {
      name: "getTradeHistoryWithSymbol",
      fn: async () => {
        const res = await client.accounts.getTradeHistory({
          userAddress: config.userAddress,
          marketSymbol: config.symbol,
        });
        const trades = res.trades ?? [];
        for (const trade of trades) {
          if (trade.marketSymbol !== config.symbol) {
            throw new Error(
              `Expected trade.marketSymbol=${config.symbol}, got ${trade.marketSymbol}`,
            );
          }
        }
      },
    },
    {
      name: "getTradeHistoryWithSymbolPagination",
      fn: async () => {
        const res = await client.accounts.getTradeHistory({
          userAddress: config.userAddress,
          marketSymbol: config.symbol,
          limit: 1,
        });
        const trades = res.trades ?? [];
        for (const trade of trades) {
          if (trade.marketSymbol !== config.symbol) {
            throw new Error(
              `Expected paginated trade.marketSymbol=${config.symbol}, got ${trade.marketSymbol}`,
            );
          }
        }
      },
    },
    {
      name: "getFees",
      fn: async () => {
        const res = await client.accounts.getFees({
          userAddress: config.userAddress,
        });
        assertPerpsFeesGte(res.perps);
      },
    },
    {
      name: "getAccountMetrics",
      fn: async () => {
        const res = await client.accounts.getAccountMetrics({
          userAddress: config.userAddress,
        });
        assertDefined(res.accountValue, "metrics.accountValue");
        assertValidNumber(res.accountValue, "metrics.accountValue");
        assertDefined(res.unrealizedPnl, "metrics.unrealizedPnl");
        assertValidNumber(res.unrealizedPnl, "metrics.unrealizedPnl");
        assertDefined(res.maintenanceMargin, "metrics.maintenanceMargin");
        assertNonNegative(res.maintenanceMargin ?? "0", "metrics.maintenanceMargin");
        assertDefined(res.crossMarginRatio, "metrics.crossMarginRatio");
        assertNonNegative(res.crossMarginRatio ?? 0, "metrics.crossMarginRatio");
        assertDefined(res.totalMarginUsed, "metrics.totalMarginUsed");
        assertNonNegative(res.totalMarginUsed ?? "0", "metrics.totalMarginUsed");
        assertDefined(res.totalNotional, "metrics.totalNotional");
        assertNonNegative(res.totalNotional ?? "0", "metrics.totalNotional");
        assertDefined(res.freeCollateral, "metrics.freeCollateral");
        assertNonNegative(res.freeCollateral ?? "0", "metrics.freeCollateral");
        assertDefined(res.tradingAllowance, "metrics.tradingAllowance");
        assertNonNegative(res.tradingAllowance ?? "0", "metrics.tradingAllowance");
        assertDefined(res.totalVolume, "metrics.totalVolume");
        assertDefined(res.totalTrades, "metrics.totalTrades");
        assertNonNegative(res.totalTrades ?? 0, "metrics.totalTrades");
      },
    },
  ];

  return runSuite("accounts", tests, config);
}

function assertPerpsFeesGte(perps: { makerFee?: number; takerFee?: number } | undefined): void {
  if (!perps) throw new Error("getFees missing perps");
  if (perps.makerFee === undefined) throw new Error("getFees missing perps.makerFee");
  assertNonNegative(perps.makerFee, "perps.makerFee");
  if (perps.takerFee === undefined) throw new Error("getFees missing perps.takerFee");
  assertNonNegative(perps.takerFee, "perps.takerFee");
}

const VALID_DIRECTIONS: ReadonlySet<string> = new Set([
  "open_long",
  "open_short",
  "long_to_short",
  "short_to_long",
  "close_long",
  "close_short",
]);

function assertOrderTimestampsSorted(orders: Array<{ timestamp?: string }>): void {
  if (orders.length <= 1) return;
  const timestamps = orders.map((order) => new Date(order.timestamp ?? 0).getTime());
  assertSortedDesc(timestamps, "order timestamps");
}

function assertValidOrderHistoryEntry(order: {
  status?: string;
  price?: string;
  orderValue?: string;
  leverage?: string | number;
}): void {
  if (order.status === "filled") {
    assertPositive(order.price, "filled order price");
    if (!order.orderValue) throw new Error("filled order missing orderValue");
    assertPositive(order.orderValue, "filled order orderValue");
  }
  assertDefined(order.leverage, "PerpOrder.leverage");
  assertPositive(order.leverage, "order.leverage");
}

function assertValidTrade(trade: {
  id?: string;
  marketSymbol?: string;
  price?: string;
  size?: string;
  side?: string;
  direction?: string;
  timestamp?: string;
  leverage?: string;
}): void {
  assertTradeRequiredFields(trade);
  assertTradeTimestamp(trade.timestamp);
  assertTradeDirection(trade.direction);
  assertGteTradeFields(trade);
}

function assertTradeRequiredFields(trade: {
  id?: string;
  marketSymbol?: string;
  price?: string;
  size?: string;
  side?: string;
  timestamp?: string;
}): void {
  if (!trade.id) throw new Error("UserTrade missing id");
  if (!trade.marketSymbol) throw new Error("UserTrade missing marketSymbol");
  if (!trade.price) throw new Error("UserTrade missing price");
  assertPositive(trade.price, "trade.price");
  if (!trade.size) throw new Error("UserTrade missing size");
  assertPositive(trade.size, "trade.size");
  if (!trade.side) throw new Error("UserTrade missing side");
  if (!trade.timestamp) throw new Error("UserTrade missing timestamp");
}

function assertTradeTimestamp(timestamp: string | undefined): void {
  const tsMs = Number(timestamp);
  if (tsMs < 1_000_000_000_000) {
    throw new Error(
      `UserTrade timestamp looks wrong (expected milliseconds >= 1e12, got ${timestamp})`,
    );
  }
}

function assertTradeDirection(direction: string | undefined): void {
  if (direction !== undefined && !VALID_DIRECTIONS.has(direction)) {
    throw new Error(`UserTrade has invalid direction: ${direction}`);
  }
}

function assertGteTradeFields(trade: {
  direction?: string;
  leverage?: string;
}): void {
  if (trade.direction === undefined) {
    throw new Error(`UserTrade missing direction (got ${trade.direction ?? "undefined"})`);
  }
  assertDefined(trade.leverage, "UserTrade.leverage");
  assertPositive(trade.leverage, "trade.leverage");
}
