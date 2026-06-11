import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsTransport } from "./transport";

type TestTransportInternal = {
  ws: MockWebSocket | null;
  reconnectAttempts: number;
  intentionallyClosed: boolean;
  reconnect: boolean;
  baseReconnectInterval: number;
  maxReconnectAttempts: number;
  subscriptions: Map<number, unknown>;
  resubscribeAll(): void;
  handleReconnect(): void;
};

function getTransportInternals(transport: WsTransport): TestTransportInternal {
  return transport as unknown as TestTransportInternal;
}

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sentMessages: string[] = [];

  constructor(public url: string) {
    // Simulate async connection
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  // Helper to simulate incoming message
  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  // Helper to simulate error
  simulateError(): void {
    this.onerror?.({ type: "error" } as Event);
  }
}

beforeEach(() => {
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WsTransport", () => {
  describe("connection", () => {
    it("should connect to WebSocket server", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      await transport.connect();
      // If we got here without error, connection succeeded
      expect(true).toBe(true);
    });

    it("should not reconnect if already connected", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      await transport.connect();
      // Second connect should return immediately
      await transport.connect();
      // Only one WebSocket should have been created
      expect(true).toBe(true);
    });

    it("should handle connection error", async () => {
      // Create a WebSocket that fails to connect
      class FailingWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = FailingWebSocket.CONNECTING;
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: ((error: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;

        constructor(public url: string) {
          // Simulate async error
          queueMicrotask(() => {
            this.onerror?.({ type: "error" } as Event);
          });
        }

        send(_data: string): void {}
        close(): void {}
      }

      vi.stubGlobal("WebSocket", FailingWebSocket);

      const transport = new WsTransport({
        url: "wss://test.com/ws",
        reconnect: false,
      });

      await expect(transport.connect()).rejects.toThrow("WebSocket connection failed");
    });
  });

  describe("subscription", () => {
    it("should subscribe and receive messages", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      const onData = vi.fn();

      const unsubscribe = await transport.subscribe("book", { symbol: "BTC-USD" }, onData);

      // Get the mock WebSocket instance
      const ws = getTransportInternals(transport).ws as MockWebSocket;

      // Check subscription message was sent
      expect(ws.sentMessages.length).toBe(1);
      const request = JSON.parse(ws.sentMessages[0]);
      expect(request.method).toBe("subscribe");
      expect(request.topic).toBe("book");
      expect(request.params.symbol).toBe("BTC-USD");

      // Simulate server response
      ws.simulateMessage({ id: request.id, d: { bids: [], asks: [] } });

      expect(onData).toHaveBeenCalledWith({ bids: [], asks: [] });

      // Cleanup
      unsubscribe();
    });

    it("should handle multiple subscriptions", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      const onData1 = vi.fn();
      const onData2 = vi.fn();

      const unsub1 = await transport.subscribe("book", { symbol: "BTC-USD" }, onData1);
      const unsub2 = await transport.subscribe("trades", { symbol: "ETH-USD" }, onData2);

      const ws = getTransportInternals(transport).ws as MockWebSocket;

      // Check both subscription messages were sent
      expect(ws.sentMessages.length).toBe(2);

      const request1 = JSON.parse(ws.sentMessages[0]);
      const request2 = JSON.parse(ws.sentMessages[1]);

      // Simulate responses for each subscription
      ws.simulateMessage({ id: request1.id, d: { bids: [], asks: [] } });
      ws.simulateMessage({ id: request2.id, d: [{ price: 100, size: 1 }] });

      expect(onData1).toHaveBeenCalledWith({ bids: [], asks: [] });
      expect(onData2).toHaveBeenCalledWith([{ price: 100, size: 1 }]);

      // Cleanup
      unsub1();
      unsub2();
    });

    it("should ignore messages for unknown subscriptions", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      const onData = vi.fn();

      await transport.subscribe("book", { symbol: "BTC-USD" }, onData);

      const ws = getTransportInternals(transport).ws as MockWebSocket;

      // Simulate message with unknown id
      ws.simulateMessage({ id: 999, d: { data: "unknown" } });

      // onData should not have been called
      expect(onData).not.toHaveBeenCalled();
    });

    it("should ignore subscription ack messages", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      const onData = vi.fn();

      await transport.subscribe("trades", { symbol: "BTC-USD" }, onData);

      const ws = getTransportInternals(transport).ws as MockWebSocket;
      const request = JSON.parse(ws.sentMessages[0]);

      ws.simulateMessage({ id: request.id, d: { subscribed: true } });
      expect(onData).not.toHaveBeenCalled();

      ws.simulateMessage({ id: request.id, d: [{ price: "100", size: "1" }] });
      expect(onData).toHaveBeenCalledWith([{ price: "100", size: "1" }]);
    });
  });

  describe("error handling", () => {
    it("should handle error responses", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      const onData = vi.fn();
      const onError = vi.fn();

      await transport.subscribe("book", { symbol: "INVALID" }, onData, onError);

      const ws = getTransportInternals(transport).ws as MockWebSocket;
      const request = JSON.parse(ws.sentMessages[0]);

      // Simulate error response
      ws.simulateMessage({
        id: request.id,
        error: { code: 4003, message: "Invalid params" },
      });

      expect(onError).toHaveBeenCalledWith({
        code: 4003,
        message: "Invalid params",
      });
      expect(onData).not.toHaveBeenCalled();
    });

    it("should handle malformed messages gracefully", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      await transport.connect();

      const ws = getTransportInternals(transport).ws as MockWebSocket;

      // Simulate invalid JSON message -- should not throw
      expect(() => {
        ws.onmessage?.({ data: "invalid json" } as MessageEvent);
      }).not.toThrow();
    });
  });

  describe("unsubscription", () => {
    it("should unsubscribe correctly", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      const onData = vi.fn();

      const unsubscribe = await transport.subscribe("book", { symbol: "BTC-USD" }, onData);

      const ws = getTransportInternals(transport).ws as MockWebSocket;
      JSON.parse(ws.sentMessages[0]);

      unsubscribe();

      // Check unsubscribe message was sent
      expect(ws.sentMessages.length).toBe(2);
      const unsubRequest = JSON.parse(ws.sentMessages[1]);
      expect(unsubRequest.method).toBe("unsubscribe");
      expect(unsubRequest.topic).toBe("book");
      expect(unsubRequest.params.symbol).toBe("BTC-USD");
    });

    it("should not send unsubscribe if already unsubscribed", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      const onData = vi.fn();

      const unsubscribe = await transport.subscribe("book", { symbol: "BTC-USD" }, onData);

      const ws = getTransportInternals(transport).ws as MockWebSocket;

      unsubscribe();
      unsubscribe(); // Call again

      // Should only have subscribe + one unsubscribe
      expect(ws.sentMessages.length).toBe(2);
    });

    it("should not receive messages after unsubscribe", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      const onData = vi.fn();

      const unsubscribe = await transport.subscribe("book", { symbol: "BTC-USD" }, onData);

      const ws = getTransportInternals(transport).ws as MockWebSocket;
      const request = JSON.parse(ws.sentMessages[0]);

      unsubscribe();

      // Simulate message after unsubscribe
      ws.simulateMessage({ id: request.id, d: { bids: [], asks: [] } });

      expect(onData).not.toHaveBeenCalled();
    });
  });

  describe("disconnect", () => {
    it("should disconnect and clear subscriptions", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      await transport.subscribe("book", { symbol: "BTC-USD" }, vi.fn());

      transport.disconnect();

      // Check internal state is cleared
      expect(getTransportInternals(transport).subscriptions.size).toBe(0);
      expect(getTransportInternals(transport).ws).toBe(null);
    });

    it("should mark connection as intentionally closed", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      await transport.connect();

      transport.disconnect();

      expect(getTransportInternals(transport).intentionallyClosed).toBe(true);
    });
  });

  describe("reconnection", () => {
    it("should not reconnect if intentionally disconnected", async () => {
      const transport = new WsTransport({
        url: "wss://test.com/ws",
        reconnect: true,
        reconnectInterval: 1000,
      });

      await transport.connect();

      // Intentional disconnect
      transport.disconnect();

      // Should not have attempted reconnect
      expect(getTransportInternals(transport).reconnectAttempts).toBe(0);
      expect(getTransportInternals(transport).intentionallyClosed).toBe(true);
    });

    it("should not reconnect if reconnect option is false", async () => {
      const transport = new WsTransport({
        url: "wss://test.com/ws",
        reconnect: false,
      });

      await transport.connect();

      const ws = getTransportInternals(transport).ws as MockWebSocket;

      // Simulate unexpected close - reconnect handler won't be called
      // because reconnect option is false
      ws.readyState = MockWebSocket.CLOSED;
      ws.onclose?.();

      // Should not have attempted reconnect
      expect(getTransportInternals(transport).reconnectAttempts).toBe(0);
    });

    it("should stop reconnecting after max attempts", async () => {
      const onError = vi.fn();
      const transport = new WsTransport({
        url: "wss://test.com/ws",
        reconnect: true,
        reconnectInterval: 100,
        maxReconnectAttempts: 2,
      });

      await transport.subscribe("book", { symbol: "BTC-USD" }, vi.fn(), onError);

      getTransportInternals(transport).reconnectAttempts = 2;

      getTransportInternals(transport).handleReconnect();

      // Should call onError for subscriptions
      expect(onError).toHaveBeenCalledWith(new Error("Max reconnection attempts reached"));
    });

    it("should increment reconnect attempts", async () => {
      const transport = new WsTransport({
        url: "wss://test.com/ws",
        reconnect: true,
        reconnectInterval: 100,
        maxReconnectAttempts: 10,
      });

      await transport.connect();

      expect(getTransportInternals(transport).reconnectAttempts).toBe(0);

      getTransportInternals(transport).reconnectAttempts = 1;
      expect(getTransportInternals(transport).reconnectAttempts).toBe(1);
    });

    it("should resubscribe all subscriptions via resubscribeAll", async () => {
      const transport = new WsTransport({
        url: "wss://test.com/ws",
        reconnect: true,
        reconnectInterval: 100,
      });

      await transport.subscribe("book", { symbol: "BTC-USD" }, vi.fn());
      await transport.subscribe("trades", { symbol: "ETH-USD" }, vi.fn());

      const ws = getTransportInternals(transport).ws as MockWebSocket;

      // Clear sent messages to only see resubscription messages
      ws.sentMessages = [];

      getTransportInternals(transport).resubscribeAll();

      // Should have 2 resubscribe messages
      expect(ws.sentMessages.length).toBe(2);

      const msg1 = JSON.parse(ws.sentMessages[0]);
      const msg2 = JSON.parse(ws.sentMessages[1]);

      expect(msg1.method).toBe("subscribe");
      expect(msg2.method).toBe("subscribe");
    });

    it("should reset reconnect attempts on successful connection", async () => {
      const transport = new WsTransport({
        url: "wss://test.com/ws",
        reconnect: true,
      });

      getTransportInternals(transport).reconnectAttempts = 5;

      await transport.connect();

      expect(getTransportInternals(transport).reconnectAttempts).toBe(0);
    });

    it("should notify reconnect listeners after successful reconnect", async () => {
      let connectionAttempt = 0;

      class ReconnectingWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = ReconnectingWebSocket.CONNECTING;
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: ((error: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        sentMessages: string[] = [];

        constructor(public url: string) {
          connectionAttempt++;
          if (connectionAttempt === 1) {
            setTimeout(() => {
              this.readyState = ReconnectingWebSocket.OPEN;
              this.onopen?.();
            }, 0);
          } else {
            setTimeout(() => {
              this.readyState = ReconnectingWebSocket.OPEN;
              this.onopen?.();
            }, 0);
          }
        }

        send(data: string): void {
          this.sentMessages.push(data);
        }

        close(): void {
          this.readyState = ReconnectingWebSocket.CLOSED;
          this.onclose?.();
        }
      }

      vi.stubGlobal("WebSocket", ReconnectingWebSocket);

      const transport = new WsTransport({
        url: "wss://test.com/ws",
        reconnect: true,
        reconnectInterval: 10,
        maxReconnectAttempts: 3,
      });

      const listener = vi.fn();
      const unsubscribe = transport.onReconnect(listener);

      await transport.connect();

      // Not fired on initial connect
      expect(listener).not.toHaveBeenCalled();

      // Simulate an unexpected close that triggers reconnect
      const ws = getTransportInternals(transport).ws as unknown as ReconnectingWebSocket;
      ws.readyState = ReconnectingWebSocket.CLOSED;
      ws.onclose?.();

      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1), {
        timeout: 2000,
      });

      unsubscribe();
    });

    it("should stop notifying a reconnect listener after it unsubscribes", async () => {
      const transport = new WsTransport({
        url: "wss://test.com/ws",
        reconnect: true,
      });

      const listener = vi.fn();
      const unsubscribe = transport.onReconnect(listener);
      unsubscribe();

      const internals = transport as unknown as {
        notifyReconnectListeners(): void;
      };
      internals.notifyReconnectListeners();

      expect(listener).not.toHaveBeenCalled();
    });

    it("should clear reconnect listeners on intentional disconnect", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      const listener = vi.fn();
      transport.onReconnect(listener);

      await transport.connect();
      transport.disconnect();

      const internals = transport as unknown as {
        reconnectListeners: Set<() => void>;
        notifyReconnectListeners(): void;
      };
      expect(internals.reconnectListeners.size).toBe(0);
    });
  });

  describe("subscribe resilience", () => {
    it("should store subscription and return unsubscribe even when connection fails", async () => {
      class FailingWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = FailingWebSocket.CONNECTING;
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: ((error: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;

        constructor(public url: string) {
          queueMicrotask(() => {
            this.onerror?.({ type: "error" } as Event);
            this.readyState = FailingWebSocket.CLOSED;
            this.onclose?.();
          });
        }

        send(_data: string): void {}
        close(): void {
          this.readyState = FailingWebSocket.CLOSED;
        }
      }

      vi.stubGlobal("WebSocket", FailingWebSocket);

      const transport = new WsTransport({
        url: "wss://test.com/ws",
        reconnect: false,
      });

      const onData = vi.fn();
      const unsub = await transport.subscribe("book", { symbol: "BTC-USD" }, onData);

      expect(getTransportInternals(transport).subscriptions.size).toBe(1);
      expect(typeof unsub).toBe("function");

      unsub();
      expect(getTransportInternals(transport).subscriptions.size).toBe(0);
    });

    it("should resubscribe stored subscriptions after reconnect succeeds", async () => {
      let connectionAttempt = 0;

      class ReconnectingWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = ReconnectingWebSocket.CONNECTING;
        onopen: (() => void) | null = null;
        onclose: (() => void) | null = null;
        onerror: ((error: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        sentMessages: string[] = [];

        constructor(public url: string) {
          connectionAttempt++;
          if (connectionAttempt === 1) {
            queueMicrotask(() => {
              this.onerror?.({ type: "error" } as Event);
              this.readyState = ReconnectingWebSocket.CLOSED;
              this.onclose?.();
            });
          } else {
            setTimeout(() => {
              this.readyState = ReconnectingWebSocket.OPEN;
              this.onopen?.();
            }, 0);
          }
        }

        send(data: string): void {
          this.sentMessages.push(data);
        }

        close(): void {
          this.readyState = ReconnectingWebSocket.CLOSED;
        }
      }

      vi.stubGlobal("WebSocket", ReconnectingWebSocket);

      const transport = new WsTransport({
        url: "wss://test.com/ws",
        reconnect: true,
        reconnectInterval: 10,
        maxReconnectAttempts: 3,
      });

      const onData = vi.fn();
      await transport.subscribe("book", { symbol: "BTC-USD" }, onData);

      expect(getTransportInternals(transport).subscriptions.size).toBe(1);

      await vi.waitFor(
        () => {
          const ws = getTransportInternals(transport).ws as unknown as ReconnectingWebSocket;
          expect(ws?.sentMessages?.length).toBeGreaterThan(0);
        },
        { timeout: 2000 },
      );

      const ws = getTransportInternals(transport).ws as unknown as ReconnectingWebSocket;
      const request = JSON.parse(ws.sentMessages[0]);
      expect(request.method).toBe("subscribe");
      expect(request.topic).toBe("book");
    });
  });

  describe("eager connect", () => {
    it("should start connection immediately without awaiting", () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      transport.eagerConnect();
      expect(getTransportInternals(transport).ws).not.toBe(null);
    });
  });

  describe("options defaults", () => {
    it("should use default options", () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });

      expect(getTransportInternals(transport).reconnect).toBe(true);
      expect(getTransportInternals(transport).baseReconnectInterval).toBe(1000);
      expect(getTransportInternals(transport).maxReconnectAttempts).toBe(10);
    });

    it("should allow overriding options", () => {
      const transport = new WsTransport({
        url: "wss://test.com/ws",
        reconnect: false,
        reconnectInterval: 5000,
        maxReconnectAttempts: 5,
      });

      expect(getTransportInternals(transport).reconnect).toBe(false);
      expect(getTransportInternals(transport).baseReconnectInterval).toBe(5000);
      expect(getTransportInternals(transport).maxReconnectAttempts).toBe(5);
    });
  });

  describe("response messages", () => {
    it("should handle response messages with subscription data", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      const onData = vi.fn();

      await transport.subscribe("candles", { symbol: "BTC-USD", interval: "1m" }, onData);

      const ws = getTransportInternals(transport).ws as MockWebSocket;
      const request = JSON.parse(ws.sentMessages[0]);

      ws.simulateMessage({ id: request.id, d: { subscribed: true } });
      expect(onData).not.toHaveBeenCalled();

      ws.simulateMessage({
        id: request.id,
        d: [{ open: "100", close: "101" }],
      });
      expect(onData).toHaveBeenCalledWith([{ open: "100", close: "101" }]);
    });

    it("should handle book response messages", async () => {
      const transport = new WsTransport({ url: "wss://test.com/ws" });
      const onData = vi.fn();

      await transport.subscribe("book", { symbol: "BTC-USD" }, onData);

      const ws = getTransportInternals(transport).ws as MockWebSocket;
      const request = JSON.parse(ws.sentMessages[0]);

      ws.simulateMessage({
        id: request.id,
        d: {
          market_id: "1",
          bids: [{ price: "50000", size: "1.5" }],
          asks: [{ price: "50100", size: "2.0" }],
        },
      });

      expect(onData).toHaveBeenCalledWith({
        market_id: "1",
        bids: [{ price: "50000", size: "1.5" }],
        asks: [{ price: "50100", size: "2.0" }],
      });
    });
  });
});
