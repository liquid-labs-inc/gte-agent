import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_HTTP_BASE_URL,
  DEFAULT_WS_BASE_URL,
  DEV_HTTP_BASE_URL,
  DEV_WS_BASE_URL,
} from "./constants";
import {
  GteApiError,
  GteDataClient,
  GteOrderClient,
  VERSION,
  createGteDataClient,
  createGteOrderClient,
  fromPrivateKey,
  getHealth,
} from "./index";
import type {
  AccountsReadInterface,
  GteDataClientInterface,
  GteOrderClientInterface,
  GteSigner,
  Market,
  MarketsInterface,
  OrdersInterface,
  PortfolioInterface,
} from "./index";
import { _resetHyperliquidExchangeForTesting } from "./internal/hyperliquid/exchange";

const PROD_HTTP_BASE_URL = "https://34-36-202-112.sslip.io/v1";
const PROD_WS_BASE_URL = "wss://34-36-202-112.sslip.io/ws";
const PROD_ENV = "hyperliquid-prod";
const DEV_ENV = "hyperliquid-dev";
const TEST_SIGNATURE_R = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const TEST_SIGNATURE_S = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
const TEST_WALLET_SIGNATURE = `${TEST_SIGNATURE_R}${TEST_SIGNATURE_S.slice(2)}1b`;
// Exchange writes are signed client-side and POSTed to Hyperliquid with a
// split { r, s, v } signature (see internal/hyperliquid/exchange.ts).
const TEST_HL_SIGNATURE = { r: TEST_SIGNATURE_R, s: TEST_SIGNATURE_S, v: 27 };

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const HL_EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";

// Minimal Hyperliquid metadata: the SymbolConverter loads perp meta and spot
// meta once per module and resolves "BTC" -> asset 0 with 5 size decimals.
const HL_META = {
  universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50 }],
};
const HL_SPOT_META = {
  universe: [{ name: "PURR/USDC", tokens: [1, 0], index: 0, isCanonical: true }],
  tokens: [
    { name: "USDC", szDecimals: 8, weiDecimals: 8, index: 0, isCanonical: true },
    { name: "PURR", szDecimals: 0, weiDecimals: 5, index: 1, isCanonical: true },
  ],
};

function fetchedUrl(input: unknown): string {
  return String(input instanceof Request ? input.url : input);
}

/**
 * Routes Hyperliquid info requests to canned metadata and answers each
 * exchange POST from the given queue (defaulting to a bare ok).
 */
function mockHlFetch(...exchangeResponses: unknown[]) {
  const queue = [...exchangeResponses];
  mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    if (fetchedUrl(input) === HL_INFO_URL) {
      const { type } = JSON.parse(String(init?.body)) as { type: string };
      return mockResponse(type === "spotMeta" ? HL_SPOT_META : HL_META);
    }
    return mockResponse(queue.shift() ?? { status: "ok" });
  });
}

function hlExchangeCalls() {
  return mockFetch.mock.calls.filter((call) => fetchedUrl(call[0]) === HL_EXCHANGE_URL);
}

function hlExchangeBody(index = 0) {
  const init = hlExchangeCalls()[index]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as {
    action: Record<string, unknown>;
    nonce: number;
    signature: { r: string; s: string; v: number };
  };
}

type TestableDataClient = GteDataClient & {
  _gteWsTransport: {
    url: string;
  };
};

const mockFetch = vi.fn();

function mockResponse<T>(data: T, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    headers: new Headers({ "content-type": "application/json" }),
  } as Response);
}

function createRecordingSigner(signature = TEST_WALLET_SIGNATURE): GteSigner & {
  signedMessages: unknown[];
} {
  const signedMessages: unknown[] = [];
  return {
    address: "0x1234567890abcdef1234567890abcdef12345678",
    signedMessages,
    signTypedData: vi.fn(async (params) => {
      signedMessages.push(params);
      return signature as `0x${string}`;
    }),
    signMessage: vi.fn(async (args) => {
      signedMessages.push(args.message);
      return signature as `0x${string}`;
    }),
  };
}

describe("gte-ts", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    _resetHyperliquidExchangeForTesting();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("exports", () => {
    it("should export VERSION", () => {
      expect(VERSION).toBe("0.0.1");
    });

    it("should export GteApiError", () => {
      expect(GteApiError).toBeDefined();
      const error = new GteApiError(
        "test",
        { code: 400 },
        new Request("http://test"),
        new Response(),
      );
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("GteApiError");
      expect(error.message).toBe("test");
      expect(error.status).toBe(200);
    });

    it("should create data client with default options", () => {
      const client = createGteDataClient({
        env: PROD_ENV,
      });
      expect(client).toBeInstanceOf(GteDataClient);
    });

    it("should create order client with signer", () => {
      const client = createGteOrderClient({
        env: PROD_ENV,
        signer: fromPrivateKey(
          "0x0123456789012345678901234567890123456789012345678901234567890123",
        ),
      });
      expect(client).toBeInstanceOf(GteOrderClient);
    });

    it("should throw when creating order client without signer", () => {
      expect(() =>
        createGteOrderClient({ env: PROD_ENV } as Parameters<typeof createGteOrderClient>[0]),
      ).toThrow("signer");
    });

    it("should have namespaced methods on data client", () => {
      const client = createGteDataClient({
        env: PROD_ENV,
      });
      expect(client.markets).toBeDefined();
      expect(client.accounts).toBeDefined();
      expect(client.portfolio).toBeDefined();
      expect(client.getHealth).toBeDefined();
    });

    it("should have orders namespace on order client", () => {
      const client = createGteOrderClient({
        env: PROD_ENV,
        signer: fromPrivateKey(
          "0x0123456789012345678901234567890123456789012345678901234567890123",
        ),
      });
      expect(client.orders).toBeDefined();
    });
  });

  describe("client.getHealth", () => {
    it("should call health endpoint", async () => {
      const healthResponse = {
        status: "ok",
        timestamp: 1234567890,
        details: null,
      };
      mockFetch.mockReturnValueOnce(mockResponse(healthResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.getHealth();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/health");
      expect(data).toEqual(healthResponse);
    });
  });

  describe("configuration", () => {
    const signer = () =>
      fromPrivateKey("0x0123456789012345678901234567890123456789012345678901234567890123");

    it("requires an env for data clients", () => {
      expect(() => createGteDataClient({} as Parameters<typeof createGteDataClient>[0])).toThrow(
        "env",
      );
    });

    it("requires an env for order clients", () => {
      expect(() =>
        createGteOrderClient({ signer: signer() } as Parameters<typeof createGteOrderClient>[0]),
      ).toThrow("env");
    });

    it("uses the prod HTTP default for prod data clients", async () => {
      mockFetch.mockReturnValueOnce(mockResponse({ status: "ok", timestamp: 1234567890 }));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      await client.getHealth();

      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(DEFAULT_HTTP_BASE_URL).toBe(PROD_HTTP_BASE_URL);
      expect(request.url).toBe(`${PROD_HTTP_BASE_URL}/health`);
    });

    it("uses the dev HTTP default for dev data clients", async () => {
      mockFetch.mockReturnValueOnce(mockResponse({ status: "ok", timestamp: 1234567890 }));

      const client = createGteDataClient({
        env: DEV_ENV,
      });
      await client.getHealth();

      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toBe(`${DEV_HTTP_BASE_URL}/health`);
    });

    it("uses the prod HTTP default for prod order clients", async () => {
      mockFetch.mockReturnValueOnce(mockResponse({ status: "ok", timestamp: 1234567890 }));

      const client = createGteOrderClient({ env: PROD_ENV, signer: signer() });
      await client.getHealth();

      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(DEFAULT_HTTP_BASE_URL).toBe(PROD_HTTP_BASE_URL);
      expect(request.url).toBe(`${PROD_HTTP_BASE_URL}/health`);
    });

    it("uses the dev HTTP default for standalone HTTP helpers", async () => {
      mockFetch.mockReturnValueOnce(mockResponse({ status: "ok", timestamp: 1234567890 }));

      await getHealth({ env: DEV_ENV });

      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toBe(`${DEV_HTTP_BASE_URL}/health`);
    });

    it("falls back to the env HTTP default for blank overrides", async () => {
      mockFetch.mockReturnValueOnce(mockResponse({ status: "ok", timestamp: 1234567890 }));

      const client = createGteDataClient({
        env: DEV_ENV,
        httpBaseUrl: " \t\n ",
      });
      await client.getHealth();

      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toBe(`${DEV_HTTP_BASE_URL}/health`);
    });

    it("trims and removes trailing slashes from HTTP overrides", async () => {
      mockFetch.mockReturnValueOnce(mockResponse({ status: "ok", timestamp: 1234567890 }));

      const client = createGteDataClient({
        env: DEV_ENV,
        httpBaseUrl: " https://dev-api.gte.xyz/v1/// ",
      });
      await client.getHealth();

      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toBe("https://dev-api.gte.xyz/v1/health");
    });

    it("forwards custom headers", async () => {
      mockFetch.mockReturnValueOnce(mockResponse({ status: "ok", timestamp: 1234567890 }));

      const client = createGteDataClient({
        env: PROD_ENV,
        headers: {
          "x-gte-test": "config",
        },
      });
      await client.getHealth();

      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.headers.get("x-gte-test")).toBe("config");
    });

    it("falls back to the env WS default for blank overrides", () => {
      const client = createGteDataClient({
        env: DEV_ENV,
        wsBaseUrl: " \n\t ",
      }) as TestableDataClient;

      expect(DEFAULT_WS_BASE_URL).toBe(PROD_WS_BASE_URL);
      expect(DEV_WS_BASE_URL).toBe("wss://34-8-220-41.sslip.io/ws");
      expect(client._gteWsTransport.url).toBe(DEV_WS_BASE_URL);
    });

    it("passes through nonblank WS overrides without normalization", () => {
      const wsBaseUrl = " wss://example.test/ws/// ";

      const client = createGteDataClient({
        env: PROD_ENV,
        wsBaseUrl,
      }) as TestableDataClient;

      expect(client._gteWsTransport.url).toBe(wsBaseUrl);
    });
  });

  describe("client.markets", () => {
    it("should list markets", async () => {
      const marketsResponse = { markets: [], nextCursor: null };
      mockFetch.mockReturnValueOnce(mockResponse(marketsResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.markets.list({ limit: 10 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/markets");
      expect(data).toEqual(marketsResponse);
    });

    it("should search markets", async () => {
      const searchResponse = { markets: [], nextCursor: null };
      mockFetch.mockReturnValueOnce(mockResponse(searchResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.markets.search({ query: "BTC" });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/markets/search");
      expect(data).toEqual(searchResponse);
    });

    it("should get market by symbol", async () => {
      const market = createMockMarket();
      mockFetch.mockReturnValueOnce(mockResponse(market));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.markets.get({ symbol: "BTC-USD" });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/markets/BTC-USD");
      expect(data).toEqual(market);
    });

    it("should get order book", async () => {
      const book = {
        bids: [{ price: 490.0, qty: 15.0, numOrders: 3 }],
        asks: [{ price: 67.67, qty: 2000.0, numOrders: 5 }],
        timestamp: 1234567890,
      };
      mockFetch.mockReturnValueOnce(mockResponse(book));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.markets.getOrderBook({ symbol: "BTC-USD" });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/markets/BTC-USD/book");
      expect(data).toEqual(book);
    });

    it("should get candles", async () => {
      const apiCandles = [
        {
          open: "50000",
          high: "51000",
          low: "49000",
          close: "50500",
          volume: "1000",
          timestamp: "1234567890000",
        },
      ];
      const expectedCandles = apiCandles;
      mockFetch.mockReturnValueOnce(mockResponse(apiCandles));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.markets.getCandles({
        symbol: "BTC-USD",
        from: 1234567890,
        interval: "1h",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/markets/BTC-USD/candles");
      expect(new URL(request.url).searchParams.get("interval")).toBe("1h");
      expect(data).toEqual(expectedCandles);
    });

    it("should get trades", async () => {
      const tradesResponse = {
        trades: [
          {
            id: "1",
            marketSymbol: "BTC-USD",
            timestamp: "1234567890000",
          },
        ],
        nextCursor: null,
      };
      mockFetch.mockReturnValueOnce(mockResponse(tradesResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.markets.getTrades({ symbol: "BTC-USD" });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/markets/BTC-USD/trades");
      expect(data).toEqual(tradesResponse);
    });

    it("should send market trade user and offset filters as public gateway queries", async () => {
      const tradesResponse = { trades: [], nextCursor: null };
      mockFetch.mockReturnValueOnce(mockResponse(tradesResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      await client.markets.getTrades({
        symbol: "BTC-USD",
        user: "0x1234567890abcdef1234567890abcdef12345678",
        offset: 25,
        limit: 10,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("user=0x1234567890abcdef1234567890abcdef12345678");
      expect(request.url).toContain("offset=25");
      expect(request.url).toContain("limit=10");
      expect(request.url).not.toContain("clientId=");
      expect(request.url).not.toContain("startTime=");
      expect(request.url).not.toContain("endTime=");
    });

    it("should get market data", async () => {
      const marketDataResponse = {
        openInterest: 1000000,
        markPrice: 50000,
        midPrice: 50025,
        indexPrice: 49950,
        fundingRate: 0.0001,
      };
      mockFetch.mockReturnValueOnce(mockResponse(marketDataResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.markets.getData({ symbol: "BTC-USD" });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/markets/BTC-USD/data");
      expect(data).toEqual(marketDataResponse);
    });
  });

  describe("client.accounts", () => {
    it("should get positions", async () => {
      const positionsResponse = { positions: [], nextCursor: null };
      mockFetch.mockReturnValueOnce(mockResponse(positionsResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.accounts.getPositions({
        userAddress: "0x1234567890abcdef",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/accounts/0x1234567890abcdef/positions");
      expect(data).toEqual(positionsResponse);
    });

    it("should get open orders", async () => {
      const ordersResponse = { orders: [], nextCursor: null };
      mockFetch.mockReturnValueOnce(mockResponse(ordersResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.accounts.getOpenOrders({
        userAddress: "0x1234567890abcdef",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/accounts/0x1234567890abcdef/orders/open");
      expect(data).toEqual(ordersResponse);
    });

    it("should include open-order subaccount filter", async () => {
      const ordersResponse = { orders: [], nextCursor: null };
      mockFetch.mockReturnValueOnce(mockResponse(ordersResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      await client.accounts.getOpenOrders({
        userAddress: "0x1234567890abcdef",
        symbol: "BTC-USD",
        subaccountId: 7,
        limit: 25,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/accounts/0x1234567890abcdef/orders/open");
      expect(request.url).toContain("symbol=BTC-USD");
      expect(request.url).toContain("subaccountId=7");
      expect(request.url).toContain("limit=25");
    });

    it("should send open-order clientId filter as the public gateway query", async () => {
      const ordersResponse = { orders: [], nextCursor: null };
      mockFetch.mockReturnValueOnce(mockResponse(ordersResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      await client.accounts.getOpenOrders({
        userAddress: "0x1234567890abcdef",
        clientId: "client-123",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("clientId=client-123");
      expect(request.url).not.toContain("clientOrderId=client-123");
    });

    it("should get orders", async () => {
      const ordersResponse = { orders: [], nextCursor: null };
      mockFetch.mockReturnValueOnce(mockResponse(ordersResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.accounts.getOrders({
        userAddress: "0x1234567890abcdef",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/accounts/0x1234567890abcdef/orders");
      expect(data).toEqual(ordersResponse);
    });

    it("should get funding history", async () => {
      const fundingResponse = { payments: [], nextCursor: null };
      mockFetch.mockReturnValueOnce(mockResponse(fundingResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.accounts.getFundingHistory({
        userAddress: "0x1234567890abcdef",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/accounts/0x1234567890abcdef/funding");
      expect(data).toEqual(fundingResponse);
    });

    it("should get leverage", async () => {
      const leverageResponse = { leverage: 10 };
      mockFetch.mockReturnValueOnce(mockResponse(leverageResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.accounts.getLeverage({
        userAddress: "0x1234567890abcdef",
        symbol: "BTC-USD",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/accounts/0x1234567890abcdef/leverage");
      expect(data).toEqual(leverageResponse);
    });

    it("should set leverage with a signed Hyperliquid updateLeverage action", async () => {
      mockHlFetch({ status: "ok", response: { type: "default" } });

      const signer = createRecordingSigner();
      const client = createGteOrderClient({
        env: PROD_ENV,
        signer,
      });
      const data = await client.accounts.setLeverage({
        userAddress: "0x1234567890abcdef",
        symbol: "BTC-USD",
        leverage: 5,
        subaccountId: 0,
      });

      expect(hlExchangeCalls()).toHaveLength(1);
      const body = hlExchangeBody();
      expect(body.action).toEqual({
        type: "updateLeverage",
        asset: 0,
        isCross: true,
        leverage: 5,
      });
      expect(body.signature).toEqual(TEST_HL_SIGNATURE);
      expect(typeof body.nonce).toBe("number");
      expect(signer.signedMessages).toHaveLength(1);
      expect(signer.signedMessages[0]).toMatchObject({
        primaryType: "Agent",
        message: { source: "a" },
      });
      expect(data).toEqual({ success: true, leverage: 5 });
    });

    it("should get next subaccount", async () => {
      const subaccountResponse = { subaccountId: 1 };
      mockFetch.mockReturnValueOnce(mockResponse(subaccountResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.accounts.getNextSubaccount({
        userAddress: "0x1234567890abcdef",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/accounts/0x1234567890abcdef/next-subaccount");
      expect(data).toEqual(subaccountResponse);
    });

    it("should get allowance", async () => {
      const allowanceResponse = {
        account: "0x1234567890abcdef",
        symbol: "BTC-USD",
        allowance: "1.000000",
      };
      mockFetch.mockReturnValueOnce(mockResponse(allowanceResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.accounts.getAllowance({
        userAddress: "0x1234567890abcdef",
        symbol: "BTC-USD",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/accounts/0x1234567890abcdef/allowance");
      expect(data).toEqual(allowanceResponse);
    });
  });

  describe("client.portfolio", () => {
    it("should get balances", async () => {
      const balanceResponse = { perps: [], spot: [] };
      mockFetch.mockReturnValueOnce(mockResponse(balanceResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.portfolio.getBalances({
        userAddress: "0x1234567890abcdef",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/accounts/0x1234567890abcdef/balances");
      expect(data).toEqual(balanceResponse);
    });

    it("should return balance tokens from the wire schema", async () => {
      const balanceResponse = {
        perps: [
          {
            token: {
              symbol: "0x0000000000000000000000000000000000000000",
              name: "",
              logoUrl: "",
              decimals: 6,
              tokenType: "crypto",
            },
            totalBalance: 988.117295,
            balanceUsd: 988.117295,
            freeCollateral: 988.117295,
          },
        ],
        spot: [],
      };
      mockFetch.mockReturnValueOnce(mockResponse(balanceResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.portfolio.getBalances({
        userAddress: "0x1234567890abcdef",
      });

      expect(data).toEqual({
        perps: [
          {
            token: {
              symbol: "0x0000000000000000000000000000000000000000",
              name: "",
              logoUrl: "",
              decimals: 6,
              tokenType: "crypto",
            },
            totalBalance: 988.117295,
            balanceUsd: 988.117295,
            freeCollateral: 988.117295,
          },
        ],
        spot: [],
      });
    });

    it("should get balance history", async () => {
      const historyResponse = { perps: [], spot: [] };
      mockFetch.mockReturnValueOnce(mockResponse(historyResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.portfolio.getBalanceHistory({
        userAddress: "0x1234567890abcdef",
        from: 1234567890,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/accounts/0x1234567890abcdef/balances/history");
      expect(data).toEqual(historyResponse);
    });

    it("should get pnl history", async () => {
      const pnlResponse = { perps: [], spot: [] };
      mockFetch.mockReturnValueOnce(mockResponse(pnlResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const data = await client.portfolio.getPnl({
        userAddress: "0x1234567890abcdef",
        from: 1234567890,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("/accounts/0x1234567890abcdef/pnl/history");
      expect(data).toEqual(pnlResponse);
    });
  });

  describe("client.orders (OrderClient only)", () => {
    it("should create orders", async () => {
      mockHlFetch({
        status: "ok",
        response: { type: "order", data: { statuses: [{ resting: { oid: 12345 } }] } },
      });

      const signer = createRecordingSigner();
      const client = createGteOrderClient({
        env: PROD_ENV,
        signer,
      });
      const data = await client.orders.create([
        {
          account: "0x1234567890abcdef",
          clientOrderId: "1",
          symbol: "BTC-USD",
          price: "50000",
          quantity: "1",
          reduceOnly: false,
          side: "buy",
          subaccountId: 0,
          timeInForce: "gtc",
          orderType: "limit",
        },
      ]);

      expect(hlExchangeCalls()).toHaveLength(1);
      const body = hlExchangeBody();
      expect(body.action).toEqual({
        type: "order",
        orders: [{ a: 0, b: true, p: "50000", s: "1", r: false, t: { limit: { tif: "Gtc" } } }],
        grouping: "na",
      });
      expect(body.signature).toEqual(TEST_HL_SIGNATURE);
      expect(signer.signedMessages).toHaveLength(1);
      expect(signer.signedMessages[0]).toMatchObject({
        primaryType: "Agent",
        message: {
          source: "a",
        },
      });
      expect(data.results).toHaveLength(1);
      expect(data.results?.[0]).toMatchObject({
        orderId: "12345",
        clientOrderId: "1",
        status: "new",
      });
    });

    it("should pass TP/SL stop orders as Hyperliquid trigger orders", async () => {
      mockHlFetch({
        status: "ok",
        response: { type: "order", data: { statuses: [{ resting: { oid: 12345 } }] } },
      });

      const signer = createRecordingSigner();
      const client = createGteOrderClient({
        env: PROD_ENV,
        signer,
      });

      await client.orders.create([
        {
          account: "0x1234567890abcdef",
          clientOrderId: "1",
          symbol: "BTC-USD",
          price: "55000",
          quantity: "1",
          reduceOnly: true,
          side: "sell",
          subaccountId: 0,
          timeInForce: "gtc",
          orderType: "stop_limit",
          tpsl: "tp",
          tpslLimitPrice: "54900",
        },
      ]);

      expect(hlExchangeCalls()).toHaveLength(1);
      const body = hlExchangeBody();
      expect(body.action).toEqual({
        type: "order",
        orders: [
          {
            a: 0,
            b: false,
            p: "54900",
            s: "1",
            r: true,
            t: { trigger: { triggerPx: "55000", isMarket: false, tpsl: "tp" } },
          },
        ],
        grouping: "positionTpsl",
      });
      expect(body.signature).toEqual(TEST_HL_SIGNATURE);
      expect(signer.signedMessages).toHaveLength(1);
    });

    it("should cancel orders", async () => {
      mockHlFetch({
        status: "ok",
        response: { type: "cancel", data: { statuses: ["success"] } },
      });

      const signer = createRecordingSigner();
      const client = createGteOrderClient({
        env: PROD_ENV,
        signer,
      });
      const data = await client.orders.cancel([
        {
          account: "0x1234567890abcdef",
          clientOrderId: "2",
          symbol: "BTC-USD",
          origClientOrderId: "1",
          side: "buy",
          subaccountId: 0,
        },
      ]);

      expect(hlExchangeCalls()).toHaveLength(1);
      const body = hlExchangeBody();
      expect(body.action).toEqual({
        type: "cancel",
        cancels: [{ a: 0, o: 1 }],
      });
      expect(body.signature).toEqual(TEST_HL_SIGNATURE);
      expect(signer.signedMessages).toHaveLength(1);
      expect(data.results?.[0]).toMatchObject({
        orderId: "1",
        clientOrderId: "2",
        status: "cancelled",
      });
    });

    it("should cancel orders by exchange order id", async () => {
      mockHlFetch({
        status: "ok",
        response: { type: "cancel", data: { statuses: ["success"] } },
      });

      const client = createGteOrderClient({
        env: PROD_ENV,
        signer: createRecordingSigner(),
      });
      const data = await client.orders.cancel([
        {
          account: "0x1234567890abcdef",
          clientOrderId: "2",
          symbol: "BTC-USD",
          origOrderId: "12345",
          side: "buy",
          subaccountId: 0,
        },
      ]);

      const body = hlExchangeBody();
      expect(body.action).toEqual({
        type: "cancel",
        cancels: [{ a: 0, o: 12345 }],
      });
      expect(data.results?.[0]).toMatchObject({
        orderId: "12345",
        status: "cancelled",
      });
    });

    it("should replace orders", async () => {
      mockHlFetch({
        status: "ok",
        response: { type: "order", data: { statuses: [{ resting: { oid: 12346 } }] } },
      });

      const signer = createRecordingSigner();
      const client = createGteOrderClient({
        env: PROD_ENV,
        signer,
      });
      const data = await client.orders.replace([
        {
          account: "0x1234567890abcdef",
          clientOrderId: "3",
          symbol: "BTC-USD",
          originalClientOrderId: "1",
          price: "51000",
          quantity: "2",
          side: "buy",
          subaccountId: 0,
          orderType: "limit",
        },
      ]);

      expect(hlExchangeCalls()).toHaveLength(1);
      const body = hlExchangeBody();
      expect(body.action).toEqual({
        type: "modify",
        oid: 1,
        order: { a: 0, b: true, p: "51000", s: "2", r: false, t: { limit: { tif: "Gtc" } } },
      });
      expect(body.signature).toEqual(TEST_HL_SIGNATURE);
      expect(signer.signedMessages).toHaveLength(1);
      expect(data.results?.[0]).toMatchObject({
        orderId: "12346",
        clientOrderId: "3",
        status: "new",
      });
    });

    it("should replace orders by exchange order id", async () => {
      mockHlFetch({
        status: "ok",
        response: { type: "order", data: { statuses: [{ resting: { oid: 12346 } }] } },
      });

      const client = createGteOrderClient({
        env: PROD_ENV,
        signer: createRecordingSigner(),
      });
      await client.orders.replace([
        {
          account: "0x1234567890abcdef",
          clientOrderId: "3",
          symbol: "BTC-USD",
          originalOrderId: "12345",
          price: "51000",
          quantity: "2",
          side: "buy",
          subaccountId: 0,
          orderType: "limit",
        },
      ]);

      const body = hlExchangeBody();
      expect(body.action).toEqual({
        type: "modify",
        oid: 12345,
        order: { a: 0, b: true, p: "51000", s: "2", r: false, t: { limit: { tif: "Gtc" } } },
      });
    });

    it("should send TP/SL replace as a Hyperliquid modify with a trigger order", async () => {
      mockHlFetch({
        status: "ok",
        response: { type: "order", data: { statuses: [{ resting: { oid: 12346 } }] } },
      });

      const client = createGteOrderClient({
        env: PROD_ENV,
        signer: createRecordingSigner(),
      });
      const data = await client.orders.replace([
        {
          account: "0x1234567890abcdef",
          clientOrderId: "3",
          symbol: "BTC-USD",
          originalClientOrderId: "1",
          price: "51000",
          quantity: "2",
          side: "sell",
          subaccountId: 0,
          orderType: "stop_limit",
          reduceOnly: true,
          tpsl: "tp",
        },
      ]);

      expect(hlExchangeCalls()).toHaveLength(1);
      const body = hlExchangeBody();
      expect(body.action).toEqual({
        type: "modify",
        oid: 1,
        order: {
          a: 0,
          b: false,
          p: "51000",
          s: "2",
          r: true,
          t: { trigger: { triggerPx: "51000", isMarket: false, tpsl: "tp" } },
        },
      });
      expect(data.results?.[0]).toMatchObject({
        orderId: "12346",
        clientOrderId: "3",
        status: "new",
      });
    });

    it("should create and cancel TWAP orders with signed Hyperliquid actions", async () => {
      mockHlFetch(
        {
          status: "ok",
          response: { type: "twapOrder", data: { status: { running: { twapId: 11 } } } },
        },
        {
          status: "ok",
          response: { type: "twapCancel", data: { status: "success" } },
        },
      );

      const signer = createRecordingSigner();
      const client = createGteOrderClient({
        env: PROD_ENV,
        signer,
      });

      const created = await client.orders.createTwap({
        account: "0x1234567890abcdef",
        symbol: "BTC-USD",
        side: "buy",
        quantity: "1",
        reduceOnly: false,
        subaccountId: 0,
        twap: {
          duration: 10,
          randomize: false,
        },
      });
      const cancelled = await client.orders.cancelTwap({
        account: "0x1234567890abcdef",
        symbol: "BTC-USD",
        side: "buy",
        subaccountId: 0,
        twapId: "11",
      });

      expect(hlExchangeCalls()).toHaveLength(2);
      const createBody = hlExchangeBody(0);
      expect(createBody.action).toEqual({
        type: "twapOrder",
        twap: { a: 0, b: true, s: "1", r: false, m: 10, t: false },
      });
      expect(createBody.signature).toEqual(TEST_HL_SIGNATURE);
      const cancelBody = hlExchangeBody(1);
      expect(cancelBody.action).toEqual({
        type: "twapCancel",
        a: 0,
        t: 11,
      });
      expect(signer.signedMessages).toHaveLength(2);
      expect(created).toEqual({ twapId: "11" });
      expect(cancelled).toEqual({ status: "success" });
    });

    it("generates monotonic nonces when multiple requests share a millisecond", async () => {
      mockHlFetch({ status: "ok" }, { status: "ok" });
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(500);

      try {
        const client = createGteOrderClient({
          env: PROD_ENV,
          signer: createRecordingSigner(),
        });
        const order = {
          account: "0x1234567890abcdef",
          clientOrderId: "1",
          symbol: "BTC-USD",
          price: "50000",
          quantity: "1",
          reduceOnly: false,
          side: "buy" as const,
          subaccountId: 0,
          timeInForce: "gtc" as const,
          orderType: "limit" as const,
        };

        await client.orders.create([order]);
        await client.orders.create([{ ...order, clientOrderId: "2" }]);

        expect(hlExchangeBody(0).nonce).toBe(500);
        expect(hlExchangeBody(1).nonce).toBe(501);
      } finally {
        dateSpy.mockRestore();
      }
    });
  });

  describe("custom baseUrl", () => {
    it("should use custom baseUrl", async () => {
      const healthResponse = {
        status: "ok",
        timestamp: 1234567890,
        details: null,
      };
      mockFetch.mockReturnValueOnce(mockResponse(healthResponse));

      const client = createGteDataClient({
        env: PROD_ENV,
        httpBaseUrl: "https://dev-api.gte.xyz/v1",
      });
      await client.getHealth();

      const request = mockFetch.mock.calls[0]?.[0] as Request;
      expect(request.url).toContain("dev-api.gte.xyz");
    });
  });
});

function createMockMarket(): Market {
  return {
    symbol: "BTC-USD",
    baseToken: {
      name: "Bitcoin",
      symbol: "BTC",
      decimals: 8,
    },
    quoteToken: {
      name: "US Dollar",
      symbol: "USD",
      decimals: 6,
    },
    marketType: "perp",
    price: 50000,
    priceChange24hr: 2.5,
    volume24hrUsd: 100000000,
  };
}

describe("interface-based mocking", () => {
  describe("mocking namespace interfaces", () => {
    it("should allow mocking MarketsInterface", async () => {
      const mockMarkets: MarketsInterface = {
        list: vi.fn().mockResolvedValue({
          markets: [{ symbol: "BTC-USD" }],
          nextCursor: null,
        }),
        search: vi.fn(),
        get: vi.fn(),
        getData: vi.fn(),
        getOrderBook: vi.fn(),
        getCandles: vi.fn(),
        getTrades: vi.fn(),
      };

      const result = await mockMarkets.list({ limit: 10 });
      expect(result?.markets).toHaveLength(1);
      expect(mockMarkets.list).toHaveBeenCalledWith({ limit: 10 });
    });

    it("should allow mocking AccountsReadInterface", async () => {
      const mockAccounts: AccountsReadInterface = {
        getPositions: vi.fn().mockResolvedValue({ positions: [], nextCursor: null }),
        getOpenOrders: vi.fn(),
        getOrders: vi.fn(),
        getFundingHistory: vi.fn(),
        getLeverage: vi.fn(),
        getNextSubaccount: vi.fn(),
        getAllowance: vi.fn(),
        getFees: vi.fn(),
        getAccountMetrics: vi.fn(),
      };

      const result = await mockAccounts.getPositions({ userAddress: "0x123" });
      expect(result).toBeDefined();
    });

    it("should allow mocking OrdersInterface", async () => {
      const mockOrders: OrdersInterface = {
        create: vi.fn().mockResolvedValue({ results: [{ orderId: "1", status: "new" }] }),
        cancel: vi.fn(),
        replace: vi.fn(),
      };

      const result = await mockOrders.create([]);
      expect(result?.results).toHaveLength(1);
    });

    it("should allow mocking PortfolioInterface", async () => {
      const mockPortfolio: PortfolioInterface = {
        getBalances: vi.fn().mockResolvedValue({ perps: [], spot: [] }),
        getBalanceHistory: vi.fn(),
        getPnl: vi.fn(),
      };

      const result = await mockPortfolio.getBalances({ userAddress: "0x123" });
      expect(result).toBeDefined();
    });
  });

  describe("mocking full client interfaces", () => {
    it("should allow mocking GteDataClientInterface", async () => {
      const mockClient: GteDataClientInterface = {
        markets: {
          list: vi.fn().mockResolvedValue({ markets: [], nextCursor: null }),
          search: vi.fn(),
          get: vi.fn(),
          getData: vi.fn(),
          getOrderBook: vi.fn(),
          getCandles: vi.fn(),
          getTrades: vi.fn(),
        },
        accounts: {
          getPositions: vi.fn(),
          getOpenOrders: vi.fn(),
          getOrders: vi.fn(),
          getFundingHistory: vi.fn(),
          getLeverage: vi.fn(),
          getNextSubaccount: vi.fn(),
          getAllowance: vi.fn(),
          getFees: vi.fn(),
          getAccountMetrics: vi.fn(),
        },
        portfolio: {
          getBalances: vi.fn(),
          getBalanceHistory: vi.fn(),
          getPnl: vi.fn(),
        },
        streams: {
          book: vi.fn(),
          candles: vi.fn(),
          trades: vi.fn(),
          openOrders: vi.fn(),
          positions: vi.fn(),
          userFunding: vi.fn(),
          orders: vi.fn(),
          marketData: vi.fn(),
        },
        getHealth: vi.fn().mockResolvedValue({ status: "ok" }),
      };

      const result = await mockClient.markets.list();
      expect(result?.markets).toEqual([]);
    });
  });

  describe("type compatibility", () => {
    it("GteDataClient should be assignable to GteDataClientInterface", () => {
      const client = createGteDataClient({
        env: PROD_ENV,
      });
      const _interfaceClient: GteDataClientInterface = client;
      expect(_interfaceClient).toBeDefined();
    });

    it("GteOrderClient should be assignable to GteOrderClientInterface", () => {
      const client = createGteOrderClient({
        env: PROD_ENV,
        signer: fromPrivateKey(
          "0x0123456789012345678901234567890123456789012345678901234567890123",
        ),
      });
      const _interfaceClient: GteOrderClientInterface = client;
      expect(_interfaceClient).toBeDefined();
    });
  });
});
