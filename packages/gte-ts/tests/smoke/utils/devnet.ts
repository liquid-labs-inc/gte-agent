const DEFAULT_CREDIT_AMOUNT = 200;

const MOCK_SIGNATURE =
  "0xababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab";

let nextClientOrderId = 900_000;
let nextDevnetAccountId = BigInt(Date.now()) << 32n;

export const MATCHING_PRICE = 100;
export const MATCHING_QTY = 0.001;
export const RESTING_BUY_PRICE = 99;
export const RESTING_SELL_PRICE = 101;
export const RESTING_QTY = 0.001;
export const USER_RESTING_PRICE = 95;
export const USER_RESTING_QTY = 0.001;

export const INITIAL_MARK_PRICE = 100000;
export const MAKER_FEE = 0.0002;
export const TAKER_FEE = 0.0005;
export const MAX_LEVERAGE = 50;
export const DECIMALS = 8;

type BuildOrderOptions = {
  orderType?: string;
  timeInForce?: string;
  reduceOnly?: boolean;
  clientOrderId?: string;
};

type GrantAllowanceOptions = {
  subaccountId?: number;
  clusterId?: number;
  upnlEnabled?: boolean;
};

function requireHttpUrl(httpUrl?: string): string {
  if (!httpUrl) {
    throw new Error(
      "httpUrl is required. Pass GTE_HTTP_URL from .devnet.env or --httpUrl CLI arg.",
    );
  }
  return httpUrl;
}

function shouldRetryCredit(response: Response, attempt: number, maxAttempts: number): boolean {
  return response.status >= 500 && attempt < maxAttempts;
}

async function throwCreditFailure(response: Response): Promise<never> {
  const text = await response.text();
  throw new Error(`devnet credit failed: ${response.status} - ${text}`);
}

export async function creditAccount(
  account: string,
  httpUrl?: string,
  amount?: number | string,
): Promise<boolean> {
  const baseUrl = requireHttpUrl(httpUrl);
  const creditAmount = amount ?? DEFAULT_CREDIT_AMOUNT;
  const url = `${baseUrl}/devnet/faucet`;
  const requestBody = JSON.stringify({ account, amount: String(creditAmount) });

  const maxAttempts = 10;
  const initialDelayMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });

    if (response.ok) {
      const body = await response.json();
      if (body.success === true) {
        return true;
      }
      return false;
    }

    if (!shouldRetryCredit(response, attempt, maxAttempts)) {
      await throwCreditFailure(response);
    }

    const delay = initialDelayMs * 2 ** (attempt - 1);
    await new Promise((r) => setTimeout(r, delay));
  }

  return false;
}

export async function creditAccounts(
  accounts: string[],
  httpUrl?: string,
  amount?: number,
): Promise<void> {
  for (const account of accounts) {
    const success = await creditAccount(account, httpUrl, amount);
    if (!success) {
      throw new Error(`Failed to credit account ${account}`);
    }
  }
}

export function createDevnetAccount(): `0x${string}` {
  nextDevnetAccountId += 1n;
  return `0x${nextDevnetAccountId.toString(16).padStart(40, "0")}` as `0x${string}`;
}

export async function grantAllowance(
  account: string,
  symbol: string,
  amount: string,
  httpUrl?: string,
  options: GrantAllowanceOptions = {},
): Promise<void> {
  if (!httpUrl) {
    throw new Error("httpUrl is required for grantAllowance");
  }
  const url = `${httpUrl}/devnet/grant-allowance`;
  const requestBody = JSON.stringify({
    account,
    symbol,
    amount,
    subaccount_id: options.subaccountId ?? 0,
    cluster_id: options.clusterId ?? 0,
    upnl_enabled: options.upnlEnabled ?? true,
  });
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: requestBody,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`grant-allowance failed: ${response.status} - ${text}`);
  }
}

export async function creditAndGrantAllowance(
  account: string,
  symbol: string,
  httpUrl?: string,
  amount?: number,
  options: GrantAllowanceOptions = {},
): Promise<void> {
  // Deposit goes to free_collateral; devnet handler also emits an AllowanceGrant. Explicit grant just sets flags.
  const creditAmount = amount ?? DEFAULT_CREDIT_AMOUNT;
  await creditAccount(account, httpUrl, creditAmount);
  await grantAllowance(account, symbol, "0", httpUrl, options);
}

export async function placeMatchingOrders(
  httpUrl?: string,
  symbol = "0",
  price = String(MATCHING_PRICE),
  quantity = String(MATCHING_QTY),
): Promise<void> {
  const buyAccount = createDevnetAccount();
  const sellAccount = createDevnetAccount();
  await creditAccounts([buyAccount, sellAccount], httpUrl);

  const buyOrder = buildOrder(buyAccount, "buy", symbol, price, quantity);
  const sellOrder = buildOrder(sellAccount, "sell", symbol, price, quantity);

  await postOrders([buyOrder], httpUrl);
  await postOrders([sellOrder], httpUrl);
}

export async function placeRestingOrders(httpUrl?: string, symbol = "0"): Promise<void> {
  return placeRestingOrdersAtPrices(
    httpUrl,
    symbol,
    String(RESTING_BUY_PRICE),
    String(RESTING_SELL_PRICE),
  );
}

export async function placeRestingOrdersAtPrices(
  httpUrl?: string,
  symbol = "0",
  buyPrice = String(RESTING_BUY_PRICE),
  sellPrice = String(RESTING_SELL_PRICE),
): Promise<void> {
  const buyAccount = createDevnetAccount();
  const sellAccount = createDevnetAccount();
  await creditAccounts([buyAccount, sellAccount], httpUrl);

  const buyOrder = buildOrder(buyAccount, "buy", symbol, buyPrice, String(RESTING_QTY));
  const sellOrder = buildOrder(sellAccount, "sell", symbol, sellPrice, String(RESTING_QTY));

  await postOrders([buyOrder], httpUrl);
  await postOrders([sellOrder], httpUrl);
}

export function buildOrder(
  account: string,
  side: string,
  symbol: string,
  price: string,
  quantity: string,
  options: BuildOrderOptions = {},
): Record<string, unknown> {
  const id = nextClientOrderId++;
  return {
    orderType: options.orderType ?? "limit",
    symbol,
    account,
    side,
    price,
    quantity,
    timeInForce: options.timeInForce ?? "gtc",
    reduceOnly: options.reduceOnly ?? false,
    signature: MOCK_SIGNATURE,
    subaccountId: 0,
    clientOrderId: options.clientOrderId ?? id.toString(),
  };
}

const COUNTERPARTY = "0x0000000000000000000000000000000000000007";

export async function placeMatchingOrdersForUser(
  userAddress: string,
  httpUrl?: string,
  symbol = "0",
  price = String(MATCHING_PRICE),
  quantity = String(MATCHING_QTY),
): Promise<void> {
  const buyOrder = buildOrder(userAddress, "buy", symbol, price, quantity);
  const sellOrder = buildOrder(COUNTERPARTY, "sell", symbol, price, quantity);

  await postOrders([buyOrder], httpUrl);
  await postOrders([sellOrder], httpUrl);
}

export async function placeRestingOrderForUser(
  userAddress: string,
  httpUrl?: string,
  symbol = "0",
  price = String(USER_RESTING_PRICE),
): Promise<void> {
  const order = buildOrder(userAddress, "buy", symbol, price, String(USER_RESTING_QTY));
  await postOrders([order], httpUrl);
}

export async function postOrders(
  orders: Record<string, unknown>[],
  httpUrl?: string,
): Promise<void> {
  if (!httpUrl) {
    throw new Error(
      "httpUrl is required. Pass GTE_HTTP_URL from .devnet.env or --httpUrl CLI arg.",
    );
  }
  const url = httpUrl;
  const response = await fetch(`${url}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orders }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Order placement failed: ${response.status} - ${body}`);
  }

  const body = await response.json();
  assertOrderResultsAccepted(body);
}

function assertOrderResultsAccepted(body: unknown): void {
  if (!body || typeof body !== "object") {
    throw new Error(`Order placement returned invalid response: ${JSON.stringify(body)}`);
  }

  const results = (body as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(`Order placement returned no results: ${JSON.stringify(body)}`);
  }

  for (const result of results) {
    assertOrderResultAccepted(result);
  }
}

function assertOrderResultAccepted(result: unknown): void {
  if (!result || typeof result !== "object") {
    throw new Error(`Order placement returned invalid result: ${JSON.stringify(result)}`);
  }

  const orderResult = result as {
    clientOrderId?: unknown;
    error?: unknown;
    rejectReason?: unknown;
    status?: unknown;
  };
  const clientOrderId = String(orderResult.clientOrderId ?? "unknown");
  const status = String(orderResult.status ?? "");
  const error = String(orderResult.error ?? "");
  const rejectReason = String(orderResult.rejectReason ?? "");
  const hasError = error.length > 0;
  const hasRejectReason = rejectReason.length > 0 && rejectReason !== "";
  const rejected = status === "rejected";

  if (hasError || hasRejectReason || rejected) {
    throw new Error(
      `Order ${clientOrderId} rejected: status=${status} rejectReason=${rejectReason} error=${error}`,
    );
  }
}
