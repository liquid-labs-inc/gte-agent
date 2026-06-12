import { describe, expect, it, vi } from "vitest";

import type { WsTransport } from "../ws/transport";
import { Streams } from "./streams";

describe("Streams balances mapping", () => {
  it("maps WS balance events with full USDC token metadata", async () => {
    const wsEvent = {
      userAddress: "0xabc",
      perps: [
        {
          tokenSymbol: "USDC",
          tokenAddress: "",
          totalBalance: "12.5",
          balanceUsd: "12.5",
          freeCollateral: "10.0",
          tradingAllowance: "2.5",
        },
      ],
      spot: [],
      timestampUs: 1n,
    };

    const subscribe = vi.fn(async (_topic, _params, onData: (data: unknown) => void) => {
      onData(wsEvent);
      return vi.fn();
    });

    const streams = new Streams({ subscribe } as unknown as WsTransport, null, null);
    let received: unknown;

    await streams.balances({
      params: { userAddress: "0xabc" },
      onData: (data) => {
        received = data;
      },
    });

    expect(received).toEqual({
      perps: [
        {
          token: {
            symbol: "USDC",
            name: "USDC",
            address: undefined,
            decimals: 6,
            logoUrl: "",
            tokenType: "stablecoin",
          },
          totalBalance: 12.5,
          balanceUsd: 12.5,
          freeCollateral: 10,
          tradingAllowance: 2.5,
        },
      ],
      spot: [],
      version: 0,
    });
  });
});

describe("Streams symbol-scoped WS mapping", () => {
  it("normalizes trade marketSymbol to the requested symbol", async () => {
    const subscribe = vi.fn(async (_topic, _params, onData: (data: unknown) => void) => {
      onData([
        {
          tradeId: "1",
          marketId: "0x01",
          makerAccountId: "maker",
          takerAccountId: "taker",
          takerSide: "buy",
          price: "100",
          quantity: "2",
          blockHeight: 1,
          timestampUs: 1n,
        },
      ]);
      return { unsubscribe: vi.fn() };
    });

    const streams = new Streams({ subscribe } as unknown as WsTransport, null, null);
    let received: unknown;

    await streams.trades({
      params: { symbol: "BTC-USD" },
      onData: (data) => {
        received = data;
      },
    });

    expect(received).toEqual([
      expect.objectContaining({
        marketSymbol: "BTC-USD",
      }),
    ]);
  });

  it("normalizes order and open-order marketSymbol to the requested symbol", async () => {
    const event = {
      orderId: "o1",
      marketId: "0x01",
      side: "buy",
      status: "new",
      price: "100",
      leavesQty: "2",
      filledQty: "0",
      clientOrderId: "client-1",
      timestampUs: 1n,
    };

    const subscribe = vi
      .fn()
      .mockImplementationOnce(async (_topic, _params, onData: (data: unknown) => void) => {
        onData(event);
        return { unsubscribe: vi.fn() };
      })
      .mockImplementationOnce(async (_topic, _params, onData: (data: unknown) => void) => {
        onData(event);
        return { unsubscribe: vi.fn() };
      });

    const streams = new Streams({ subscribe } as unknown as WsTransport, null, null);
    let ordersReceived: unknown;
    let openOrdersReceived: unknown;

    await streams.orders({
      params: { userAddress: "0xabc", symbol: "ETH-USD" },
      onData: (data) => {
        ordersReceived = data;
      },
    });

    await streams.openOrders({
      params: { userAddress: "0xabc", symbol: "ETH-USD" },
      onData: (data) => {
        openOrdersReceived = data;
      },
    });

    expect(ordersReceived).toEqual([
      expect.objectContaining({
        order: expect.objectContaining({
          marketSymbol: "ETH-USD",
        }),
      }),
    ]);
    expect(openOrdersReceived).toEqual([
      expect.objectContaining({
        marketSymbol: "ETH-USD",
      }),
    ]);
  });

  it("passes batched order subscription users to GTE transport", async () => {
    const subscribe = vi.fn(async () => ({ unsubscribe: vi.fn() }));
    const streams = new Streams({ subscribe } as unknown as WsTransport, null, null);

    await streams.orders({
      params: {
        symbol: "BTC-USD-PERP",
        userAddresses: ["0xabc", "0xdef"],
      },
      onData: () => {},
    });

    expect(subscribe).toHaveBeenCalledWith(
      "orders",
      {
        symbol: "BTC-USD-PERP",
        userAddresses: ["0xabc", "0xdef"],
      },
      expect.any(Function),
      undefined,
    );
  });

  it("passes through market partials on the open-order stream", async () => {
    const event = {
      orderId: "market-1",
      marketId: "0x01",
      side: "buy",
      status: "partially_filled",
      price: "105",
      leavesQty: "2",
      filledQty: "1",
      clientOrderId: "client-market-1",
      timestampUs: 1n,
      orderType: "market",
    };

    const subscribe = vi.fn(async (_topic, _params, onData: (data: unknown) => void) => {
      onData(event);
      return { unsubscribe: vi.fn() };
    });

    const streams = new Streams({ subscribe } as unknown as WsTransport, null, null);
    const onData = vi.fn();

    await streams.openOrders({
      params: { userAddress: "0xabc", symbol: "ETH-USD" },
      onData,
    });

    expect(onData).toHaveBeenCalledWith([
      expect.objectContaining({
        orderId: "market-1",
        marketSymbol: "ETH-USD",
        side: "buy",
        limitPrice: "105",
        currentSize: "2",
        originalSize: "3",
        orderType: "market",
      }),
    ]);
  });

  it("preserves pbjson TP/SL metadata on order and open-order streams", async () => {
    const event = {
      orderId: "tp-1",
      marketId: "0x01",
      side: "sell",
      status: "pending_new",
      price: "55000",
      avgPrice: "0",
      leavesQty: "0.01",
      filledQty: "0",
      clientOrderId: "client-tp-1",
      timestampUs: 1n,
      orderType: "stop_limit",
      triggerPrice: "55000",
      tpsl: "tp",
      isReduceOnly: true,
    };

    const subscribe = vi
      .fn()
      .mockImplementationOnce(async (_topic, _params, onData: (data: unknown) => void) => {
        onData(event);
        return { unsubscribe: vi.fn() };
      })
      .mockImplementationOnce(async (_topic, _params, onData: (data: unknown) => void) => {
        onData(event);
        return { unsubscribe: vi.fn() };
      });

    const streams = new Streams({ subscribe } as unknown as WsTransport, null, null);
    let ordersReceived: unknown;
    let openOrdersReceived: unknown;

    await streams.orders({
      params: { userAddress: "0xabc", symbol: "BTC-USD-PERP" },
      onData: (data) => {
        ordersReceived = data;
      },
    });

    await streams.openOrders({
      params: { userAddress: "0xabc", symbol: "BTC-USD-PERP" },
      onData: (data) => {
        openOrdersReceived = data;
      },
    });

    expect(ordersReceived).toEqual([
      expect.objectContaining({
        order: expect.objectContaining({
          marketSymbol: "BTC-USD-PERP",
          orderType: "stop_limit",
          triggerPrice: "55000",
          tpsl: "tp",
          isReduceOnly: true,
        }),
      }),
    ]);
    expect(openOrdersReceived).toEqual([
      expect.objectContaining({
        marketSymbol: "BTC-USD-PERP",
        orderType: "stop_limit",
        triggerPrice: "55000",
        tpsl: "tp",
        isReduceOnly: true,
      }),
    ]);
  });

  it("preserves numeric TP/SL metadata on open-order streams", async () => {
    const event = {
      orderId: "sl-1",
      marketId: "0x01",
      side: 2,
      status: 8,
      price: "45000",
      avgPrice: "0",
      leavesQty: "0.01",
      filledQty: "0",
      clientOrderId: "client-sl-1",
      timestampUs: 1n,
      orderType: 4,
      triggerPrice: "45000",
      tpsl: 2,
      isReduceOnly: true,
    };

    const subscribe = vi.fn(async (_topic, _params, onData: (data: unknown) => void) => {
      onData(event);
      return { unsubscribe: vi.fn() };
    });

    const streams = new Streams({ subscribe } as unknown as WsTransport, null, null);
    let received: unknown;

    await streams.openOrders({
      params: { userAddress: "0xabc", symbol: "BTC-USD-PERP" },
      onData: (data) => {
        received = data;
      },
    });

    expect(received).toEqual([
      expect.objectContaining({
        side: "sell",
        orderType: "stop_market",
        triggerPrice: "45000",
        tpsl: "sl",
        isReduceOnly: true,
      }),
    ]);
  });

  it("maps leverage changes and filters them client-side", async () => {
    const subscribe = vi.fn(async (_topic, _params, onData: (data: unknown) => void) => {
      onData([
        {
          accountId: "0xdef",
          subaccountId: 7,
          symbol: "BTC-USD",
          leverage: 3n,
          timestampUs: 1_700_000_000_000_000n,
        },
        {
          accountId: "0xabc",
          subaccountId: 7,
          symbol: "BTC-USD",
          leverage: 5n,
          timestampUs: 1_700_000_000_000_000n,
        },
      ]);
      return { unsubscribe: vi.fn() };
    });

    const streams = new Streams({ subscribe } as unknown as WsTransport, null, null);
    let received: unknown;

    await streams.leverageChanges({
      params: { userAddress: "0xabc", symbol: "BTC-USD", subaccountId: 7 },
      onData: (data) => {
        received = data;
      },
    });

    expect(subscribe).toHaveBeenCalledWith("leverage_changes", {}, expect.any(Function), undefined);
    expect(received).toEqual({
      accountId: "0xabc",
      subaccountId: 7,
      marketSymbol: "BTC-USD",
      leverage: 5,
      timestamp: "1700000000000",
    });
  });
});

describe("Streams trade direction handling", () => {
  it("passes through pbjson string enum direction fields unchanged", async () => {
    // pbjson serializes proto enums as their full string name, not as integers.
    // This test uses the actual wire format to catch regressions where numeric
    // DIRECTION_MAP lookups would silently drop the direction.
    const subscribe = vi.fn(async (_topic, _params, onData: (data: unknown) => void) => {
      onData([
        {
          tradeId: "t1",
          marketId: "1",
          makerAccountId: "0xmaker",
          takerAccountId: "0xtaker",
          takerSide: "buy",
          price: "100",
          quantity: "1",
          blockHeight: 1n,
          timestampUs: 1_700_000_000_000_000n,
          isLiquidation: false,
          makerDirection: "POSITION_DIRECTION_OPEN_SHORT",
          takerDirection: "POSITION_DIRECTION_OPEN_LONG",
        },
      ]);
      return vi.fn();
    });

    const streams = new Streams({ subscribe } as unknown as WsTransport, null, null);
    let received: unknown;

    await streams.trades({
      params: { symbol: "BTC-USD" },
      onData: (data) => {
        received = data;
      },
    });

    expect(received).toEqual([
      expect.objectContaining({
        makerDirection: "open_short",
        takerDirection: "open_long",
      }),
    ]);
  });

  it("propagates maker_rpnl and taker_rpnl from the wire event onto the mapped Trade", async () => {
    const subscribe = vi.fn(async (_topic, _params, onData: (data: unknown) => void) => {
      onData([
        {
          tradeId: "t3",
          marketId: "1",
          makerAccountId: "0xmaker",
          takerAccountId: "0xtaker",
          takerSide: "buy",
          price: "100",
          quantity: "1",
          blockHeight: 3n,
          timestampUs: 1_700_000_000_000_000n,
          isLiquidation: false,
          makerRpnl: "12.34",
          takerRpnl: "-5.67",
        },
      ]);
      return vi.fn();
    });

    const streams = new Streams({ subscribe } as unknown as WsTransport, null, null);
    let received: unknown;

    await streams.trades({
      params: { userAddress: "0xabc" },
      onData: (data) => {
        received = data;
      },
    });

    expect(received).toEqual([
      expect.objectContaining({
        makerRpnl: "12.34",
        takerRpnl: "-5.67",
      }),
    ]);
  });

  it("drops empty rpnl strings so consumers see undefined", async () => {
    const subscribe = vi.fn(async (_topic, _params, onData: (data: unknown) => void) => {
      onData([
        {
          tradeId: "t4",
          marketId: "1",
          makerAccountId: "0xmaker",
          takerAccountId: "0xtaker",
          takerSide: "buy",
          price: "100",
          quantity: "1",
          blockHeight: 4n,
          timestampUs: 1_700_000_000_000_000n,
          isLiquidation: false,
          makerRpnl: "",
          takerRpnl: "",
        },
      ]);
      return vi.fn();
    });

    const streams = new Streams({ subscribe } as unknown as WsTransport, null, null);
    let received: unknown;

    await streams.trades({
      params: { userAddress: "0xabc" },
      onData: (data) => {
        received = data;
      },
    });

    const trades = received as Array<Record<string, unknown>>;
    expect(trades[0]?.makerRpnl).toBeUndefined();
    expect(trades[0]?.takerRpnl).toBeUndefined();
  });

  it("passes through numeric direction fields for non-pbjson sources", async () => {
    const subscribe = vi.fn(async (_topic, _params, onData: (data: unknown) => void) => {
      onData([
        {
          tradeId: "t2",
          marketId: "1",
          makerAccountId: "0xmaker",
          takerAccountId: "0xtaker",
          takerSide: "1",
          price: "50",
          quantity: "2",
          blockHeight: 2n,
          timestampUs: 1_700_000_000_000_000n,
          isLiquidation: false,
          makerDirection: 2,
          takerDirection: 1,
        },
      ]);
      return vi.fn();
    });

    const streams = new Streams({ subscribe } as unknown as WsTransport, null, null);
    let received: unknown;

    await streams.trades({
      params: { symbol: "BTC-USD" },
      onData: (data) => {
        received = data;
      },
    });

    expect(received).toEqual([
      expect.objectContaining({
        makerDirection: "open_short",
        takerDirection: "open_long",
      }),
    ]);
  });
});
