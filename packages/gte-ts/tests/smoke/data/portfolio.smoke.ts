import type { GetPnlHistoryResponse, GteDataClient } from "../../../src/index.js";
import {
  buildOrder,
  createDevnetAccount,
  creditAccount,
  creditAccounts,
  postOrders,
} from "../utils/devnet.js";
import { assertNonNegative, assertSortedAsc } from "../utils/invariants.js";
import { retryUntil, runSuite, sleep } from "../utils/runner.js";
import type { SuiteResult, TestConfig, TestDefinition } from "../utils/types.js";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const PNL_PROPAGATION_DELAY_MS = 3000;
const PORTFOLIO_SMOKE_CREDIT_AMOUNT = 200;
const PORTFOLIO_SMOKE_ORDER_QUANTITY = "0.001";
const REALIZED_PNL_BALANCE_CREDIT = PORTFOLIO_SMOKE_CREDIT_AMOUNT;
const REALIZED_PNL_OPEN_LIQUIDITY_PRICE = 110000;
const REALIZED_PNL_CLOSE_LIQUIDITY_PRICE = 90000;
const REALIZED_PNL_QTY = Number.parseFloat(PORTFOLIO_SMOKE_ORDER_QUANTITY);

function assertTimestampsNonDecreasing(
  items: Array<{ timestamp?: string | number }>,
  label: string,
): void {
  if (items.length <= 1) return;
  const timestamps = items.map((item) => Number(item.timestamp ?? 0));
  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i] < timestamps[i - 1]) {
      throw new Error(`${label} timestamps must be non-decreasing at index ${i}`);
    }
  }
}

function validateBalance(bal: {
  token?: { symbol?: string };
  totalBalance?: number;
  balanceUsd?: number;
  freeCollateral?: number;
  tradingAllowance?: number;
}): void {
  if (bal.token?.symbol === undefined) throw new Error("Balance missing token.symbol");
  if (bal.totalBalance !== undefined) {
    assertNonNegative(bal.totalBalance, "balance.totalBalance");
  }
  if (bal.balanceUsd !== undefined) {
    assertNonNegative(bal.balanceUsd, "balance.balanceUsd");
  }
  if (bal.freeCollateral !== undefined) {
    assertNonNegative(bal.freeCollateral, "balance.freeCollateral");
  }
  if (bal.tradingAllowance !== undefined) {
    assertNonNegative(bal.tradingAllowance, "balance.tradingAllowance");
  }
}

function assertClose(actual: number | undefined, expected: number, label: string): void {
  if (actual === undefined || !Number.isFinite(actual)) {
    throw new Error(`${label} missing or invalid, expected ${expected}, got ${actual}`);
  }
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${label} expected ${expected}, got ${actual}`);
  }
}

async function expectPerpsTotalBalance(
  client: GteDataClient,
  userAddress: `0x${string}`,
  expected: number,
  timeoutMs: number,
): Promise<void> {
  await retryUntil(async () => {
    const res = await client.portfolio.getBalances({ userAddress });
    const primaryPerp = res.perps?.[0];
    if (!primaryPerp) {
      throw new Error(`Expected a perps balance for ${userAddress}, got ${JSON.stringify(res)}`);
    }
    assertClose(primaryPerp.totalBalance, expected, "perps totalBalance");
    assertClose(primaryPerp.balanceUsd, expected, "perps balanceUsd");
    if (primaryPerp.freeCollateral === undefined || !Number.isFinite(primaryPerp.freeCollateral)) {
      throw new Error(`perps freeCollateral missing or invalid: ${JSON.stringify(primaryPerp)}`);
    }
  }, timeoutMs);
}

async function expectNoPositions(
  client: GteDataClient,
  userAddress: `0x${string}`,
  timeoutMs: number,
): Promise<void> {
  await retryUntil(async () => {
    const res = await client.accounts.getPositions({ userAddress });
    const positions = res.positions ?? [];
    if (positions.length !== 0) {
      throw new Error(
        `Expected no open positions for ${userAddress}, got ${JSON.stringify(positions)}`,
      );
    }
  }, timeoutMs);
}

async function expectPositionSize(
  client: GteDataClient,
  userAddress: `0x${string}`,
  expectedSize: number,
  timeoutMs: number,
): Promise<void> {
  await retryUntil(async () => {
    const res = await client.accounts.getPositions({ userAddress });
    const positions = res.positions ?? [];
    const size = positions.reduce(
      (sum, position) => sum + Number.parseFloat(position.size ?? "0"),
      0,
    );
    if (Math.abs(size - expectedSize) > 0.000001) {
      throw new Error(
        `Expected position size ${expectedSize}, got ${size}; positions=${JSON.stringify(positions)}`,
      );
    }
  }, timeoutMs);
}

async function expectRealizedPnlFromTradeHistory(
  client: GteDataClient,
  userAddress: `0x${string}`,
  marketSymbol: string,
  timeoutMs: number,
): Promise<number> {
  let realizedPnl = 0;
  await retryUntil(async () => {
    const res = await client.accounts.getTradeHistory({
      userAddress,
      marketSymbol,
      limit: 50,
    });
    const trades = res.trades ?? [];
    const closedPnls = trades
      .map((trade) => Number.parseFloat(trade.closedPnl ?? "0"))
      .filter((value) => Number.isFinite(value));
    const sum = closedPnls.reduce((total, value) => total + value, 0);
    if (closedPnls.length === 0 || Math.abs(sum) < 0.000001) {
      throw new Error(`Expected non-zero closedPnl in trade history, got ${JSON.stringify(res)}`);
    }
    realizedPnl = sum;
  }, timeoutMs);
  return realizedPnl;
}

async function testGetBalances(client: GteDataClient, config: TestConfig): Promise<void> {
  await ensureMarginUsingBalance(client, config);

  const res = await client.portfolio.getBalances({
    userAddress: config.userAddress,
  });
  const spotBalances = res.spot ?? [];
  const perpBalances = res.perps ?? [];
  if (perpBalances.length === 0) {
    throw new Error("GTE getBalances returned 0 perp balances (expected at least 1 after credit)");
  }
  for (const bal of [...spotBalances, ...perpBalances]) {
    validateBalance(bal);
  }
  const primaryPerp = perpBalances[0];
  if (
    primaryPerp?.totalBalance !== undefined &&
    primaryPerp.freeCollateral !== undefined &&
    primaryPerp.totalBalance > 0 &&
    primaryPerp.freeCollateral >= primaryPerp.totalBalance
  ) {
    throw new Error(
      `Expected freeCollateral < totalBalance for GTE perps balance, got freeCollateral=${primaryPerp.freeCollateral} total=${primaryPerp.totalBalance}`,
    );
  }
}

async function ensureMarginUsingBalance(client: GteDataClient, config: TestConfig): Promise<void> {
  if (false || !config.httpUrl) return;

  await retryUntil(async () => {
    const res = await client.portfolio.getBalances({
      userAddress: config.userAddress,
    });
    const primaryPerp = res.perps?.[0];
    const total = primaryPerp?.totalBalance;
    const freeCollateral = primaryPerp?.freeCollateral;
    if (
      total === undefined ||
      freeCollateral === undefined ||
      !Number.isFinite(total) ||
      !Number.isFinite(freeCollateral) ||
      total <= 0 ||
      freeCollateral >= total
    ) {
      throw new Error(
        `Expected GTE perps balance with margin usage, got freeCollateral=${freeCollateral} total=${total}`,
      );
    }
  }, config.timeout);
}

async function ensurePnlData(
  client: GteDataClient,
  config: TestConfig,
  counterpartyAddress?: `0x${string}`,
): Promise<void> {
  if (false || !config.httpUrl || !counterpartyAddress) return;
  await creditAccount(config.userAddress, config.httpUrl, PORTFOLIO_SMOKE_CREDIT_AMOUNT);
  await creditAccount(counterpartyAddress, config.httpUrl, PORTFOLIO_SMOKE_CREDIT_AMOUNT);
  await sleep(500);
  await placeMarginUsingOrderForUser(config, counterpartyAddress);
  await ensureMarginUsingBalance(client, config);
  await sleep(PNL_PROPAGATION_DELAY_MS);
}

async function placeMarginUsingOrderForUser(
  config: TestConfig,
  counterpartyAddress: `0x${string}`,
): Promise<void> {
  if (!config.httpUrl) return;

  const clientOrderId = Date.now();
  await postOrders(
    [
      buildOrder(
        counterpartyAddress,
        "sell",
        config.symbol,
        "100",
        PORTFOLIO_SMOKE_ORDER_QUANTITY,
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
      buildOrder(config.userAddress, "buy", config.symbol, "0", PORTFOLIO_SMOKE_ORDER_QUANTITY, {
        orderType: "market",
        timeInForce: "ioc",
        clientOrderId: String(clientOrderId + 1),
      }),
    ],
    config.httpUrl,
  );
}

async function testClosedPositionBalanceReflectsRealizedPnl(
  client: GteDataClient,
  config: TestConfig,
): Promise<void> {
  if (false || !config.httpUrl) return;

  const trader = createDevnetAccount();
  const counterparty = createDevnetAccount();
  const closeCounterparty = createDevnetAccount();
  await creditAccounts(
    [trader, counterparty, closeCounterparty],
    config.httpUrl,
    REALIZED_PNL_BALANCE_CREDIT,
  );
  await sleep(500);

  await expectPerpsTotalBalance(client, trader, REALIZED_PNL_BALANCE_CREDIT, config.timeout);

  await postOrders(
    [
      buildOrder(
        counterparty,
        "sell",
        config.symbol,
        String(REALIZED_PNL_OPEN_LIQUIDITY_PRICE),
        String(REALIZED_PNL_QTY),
      ),
    ],
    config.httpUrl,
  );
  await sleep(500);
  await postOrders(
    [
      buildOrder(trader, "buy", config.symbol, "0", String(REALIZED_PNL_QTY), {
        orderType: "market",
        timeInForce: "ioc",
      }),
    ],
    config.httpUrl,
  );

  await expectPositionSize(client, trader, REALIZED_PNL_QTY, config.timeout);

  await postOrders(
    [
      buildOrder(
        closeCounterparty,
        "buy",
        config.symbol,
        String(REALIZED_PNL_CLOSE_LIQUIDITY_PRICE),
        String(REALIZED_PNL_QTY),
      ),
    ],
    config.httpUrl,
  );
  await sleep(500);
  await postOrders(
    [
      buildOrder(trader, "sell", config.symbol, "0", String(REALIZED_PNL_QTY), {
        orderType: "market",
        timeInForce: "ioc",
        reduceOnly: true,
      }),
    ],
    config.httpUrl,
  );

  await expectNoPositions(client, trader, config.timeout);
  const realizedPnl = await expectRealizedPnlFromTradeHistory(
    client,
    trader,
    config.symbol,
    config.timeout,
  );
  await expectPerpsTotalBalance(
    client,
    trader,
    REALIZED_PNL_BALANCE_CREDIT + realizedPnl,
    config.timeout,
  );
}

function fetchPnl(client: GteDataClient, config: TestConfig): Promise<GetPnlHistoryResponse> {
  const now = Date.now();
  const window = ONE_HOUR_MS;
  const from = now - window;
  return client.portfolio.getPnl({
    userAddress: config.userAddress,
    from,
    to: now,
  });
}

type PortfolioTimeframeWindow = {
  label: string;
  from: number;
  to: number;
};

function portfolioTimeframeWindows(now: Date): PortfolioTimeframeWindow[] {
  const nowMs = now.getTime();
  return [
    { label: "1d", from: nowMs - ONE_DAY_MS, to: nowMs },
    { label: "1w", from: nowMs - 7 * ONE_DAY_MS, to: nowMs },
    { label: "1m", from: nowMs - 30 * ONE_DAY_MS, to: nowMs },
    { label: "3m", from: nowMs - 90 * ONE_DAY_MS, to: nowMs },
    {
      label: "ytd",
      from: new Date(now.getFullYear(), 0, 1).getTime(),
      to: nowMs,
    },
    { label: "1y", from: nowMs - 365 * ONE_DAY_MS, to: nowMs },
  ];
}

function assertPnlPerpsNonEmpty(res: GetPnlHistoryResponse): void {
  const perps = res.perps ?? [];
  if (perps.length === 0) {
    throw new Error("Expected at least one perps PnL snapshot");
  }
}

async function testGtePnlTimeframes(client: GteDataClient, config: TestConfig): Promise<void> {
  for (const { label, from, to } of portfolioTimeframeWindows(new Date())) {
    await retryUntil(async () => {
      const res = await client.portfolio.getPnl({
        userAddress: config.userAddress,
        from,
        to,
      });
      assertPnlPerpsNonEmpty(res);
      const perps = res.perps ?? [];
      assertTimestampsNonDecreasing(perps, `Perp PnL history ${label}`);
      for (const [index, snapshot] of perps.entries()) {
        const timestamp = Number(snapshot.timestamp ?? 0);
        if (timestamp < from || timestamp > to) {
          throw new Error(
            `Perp PnL history ${label} snapshot ${index} timestamp ${timestamp} outside requested [${from}, ${to}]`,
          );
        }
        if (
          snapshot.pnlUsd === undefined ||
          typeof snapshot.pnlUsd !== "number" ||
          Number.isNaN(snapshot.pnlUsd)
        ) {
          throw new Error(`Perp PnL history ${label} snapshot ${index} missing or invalid pnlUsd`);
        }
      }
    }, config.timeout);
  }
}

export async function runPortfolioTests(
  client: GteDataClient,
  config: TestConfig,
): Promise<SuiteResult> {
  const testConfig = { ...config, userAddress: createDevnetAccount() };
  const counterpartyAddress = createDevnetAccount();

  await ensurePnlData(client, testConfig, counterpartyAddress);

  // Fetch PnL once and share across tests to avoid flaky results from
  // consecutive API calls returning slightly different live snapshots.
  let pnlResponse: GetPnlHistoryResponse | null = null;
  async function getPnlResponse(): Promise<GetPnlHistoryResponse> {
    if (!pnlResponse) {
      pnlResponse = await fetchPnl(client, testConfig);
    }
    return pnlResponse;
  }

  const tests: TestDefinition[] = [
    {
      name: "getBalances",
      optional: false,
      fn: () => testGetBalances(client, testConfig),
    },
    {
      name: "getBalanceHistory",
      optional: false,
      fn: async () => {
        const now = Date.now();
        const window = ONE_HOUR_MS;
        const from = now - window;
        const res = await client.portfolio.getBalanceHistory({
          userAddress: testConfig.userAddress,
          from,
        });
        const spotTs = (res.spot ?? []).map((s) => Number(s.timestamp ?? 0));
        const perpTs = (res.perps ?? []).map((s) => Number(s.timestamp ?? 0));
        assertSortedAsc(spotTs, "Spot balance history timestamps");
        assertSortedAsc(perpTs, "Perp balance history timestamps");
      },
    },
    {
      name: "getPnl",
      fn: async () => {
        const res = await getPnlResponse();
        assertPnlPerpsNonEmpty(res);
        assertTimestampsNonDecreasing(res.perps ?? [], "Perp PnL history");
      },
    },
    {
      name: "getPnl has valid pnlUsd fields",
      fn: async () => {
        const res = await getPnlResponse();
        const perps = res.perps ?? [];
        assertPnlPerpsNonEmpty(res);
        for (let i = 0; i < perps.length; i++) {
          const s = perps[i];
          if (s.timestamp === undefined) {
            throw new Error(`Perps snapshot ${i} missing timestamp`);
          }
          if (s.pnlUsd === undefined || typeof s.pnlUsd !== "number" || Number.isNaN(s.pnlUsd)) {
            throw new Error(`Perps snapshot ${i} missing or invalid pnlUsd`);
          }
        }
      },
    },
    {
      name: "getPnl supports portfolio timeframes",
      optional: false,
      fn: () => testGtePnlTimeframes(client, testConfig),
    },
    {
      name: "closed position balance reflects realized PnL",
      optional: false,
      fn: () => testClosedPositionBalanceReflectsRealizedPnl(client, config),
    },
  ];

  return runSuite("portfolio", tests, config);
}
