import type { StreamError, StreamRequest, StreamResponse, StreamTopic } from "../types/ws";

export type WsTransportOptions = {
  url: string;
  reconnect?: boolean;
  /** Base reconnect interval in ms (used with exponential backoff). Default: 1000 */
  reconnectInterval?: number;
  /** Maximum reconnect interval in ms. Default: 30000 */
  maxReconnectInterval?: number;
  /** Maximum number of reconnection attempts before giving up. Default: 10 */
  maxReconnectAttempts?: number;
  /** Connection timeout in ms. Default: 10000 */
  connectionTimeout?: number;
  /** If no message received within this many ms, trigger reconnect. Default: 60000 */
  livenessTimeout?: number;
};

type Subscription = {
  id: number;
  topic: StreamTopic;
  params: Record<string, unknown>;
  onData: (data: unknown) => void;
  onError?: (error: StreamError | Error) => void;
};

export type ReconnectListener = () => void;

export class WsTransport {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnect: boolean;
  private baseReconnectInterval: number;
  private maxReconnectInterval: number;
  private maxReconnectAttempts: number;
  private connectionTimeout: number;
  private livenessTimeout: number;
  private reconnectAttempts = 0;
  private subscriptions = new Map<number, Subscription>();
  private nextId = 1;
  private connecting: Promise<void> | null = null;
  private intentionallyClosed = false;
  private lastMessageAt = 0;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectListeners = new Set<ReconnectListener>();

  constructor(options: WsTransportOptions) {
    this.url = options.url;
    this.reconnect = options.reconnect ?? true;
    this.baseReconnectInterval = options.reconnectInterval ?? 1000;
    this.maxReconnectInterval = options.maxReconnectInterval ?? 30_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.connectionTimeout = options.connectionTimeout ?? 10_000;
    this.livenessTimeout = options.livenessTimeout ?? 60_000;
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<void>((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.lastMessageAt = Date.now();
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled && this.ws?.readyState !== WebSocket.OPEN) {
          this.ws?.close();
          settled = true;
          this.connecting = null;
          reject(new Error(`WebSocket connection timed out after ${this.connectionTimeout}ms`));
        }
      }, this.connectionTimeout);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        if (settled) return;
        settled = true;
        this.reconnectAttempts = 0;
        this.connecting = null;
        this.startLivenessMonitor();
        resolve();
      };

      this.ws.onerror = () => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          this.connecting = null;
          reject(new Error("WebSocket connection failed"));
        }
      };

      this.ws.onclose = () => {
        clearTimeout(timeout);
        this.connecting = null;
        this.stopLivenessMonitor();
        if (!this.intentionallyClosed && this.reconnect) {
          this.handleReconnect();
        }
      };

      this.ws.onmessage = (event) => {
        this.lastMessageAt = Date.now();
        this.handleMessage(event);
      };
    });

    return this.connecting;
  }

  eagerConnect(): void {
    this.connect().catch(() => {
      // Handled by reconnect logic
    });
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    this.stopLivenessMonitor();
    this.ws?.close();
    this.ws = null;
    this.subscriptions.clear();
    this.reconnectListeners.clear();
  }

  onReconnect(listener: ReconnectListener): () => void {
    this.reconnectListeners.add(listener);
    return () => {
      this.reconnectListeners.delete(listener);
    };
  }

  async subscribe<T>(
    topic: StreamTopic,
    params: Record<string, unknown>,
    onData: (data: T) => void,
    onError?: (error: StreamError | Error) => void,
  ): Promise<() => void> {
    const id = this.nextId++;
    const subscription: Subscription = {
      id,
      topic,
      params,
      onData: onData as (data: unknown) => void,
      onError,
    };

    this.subscriptions.set(id, subscription);

    try {
      await this.connect();
      this.sendSubscribeRequest(id, topic, params);
    } catch {
      // Connection failed; subscription is stored and will be
      // sent when the built-in reconnect logic establishes a connection.
    }

    return () => {
      this.unsubscribe(id);
    };
  }

  private sendSubscribeRequest(
    id: number,
    topic: StreamTopic,
    params: Record<string, unknown>,
  ): void {
    const request: StreamRequest = {
      id,
      method: "subscribe",
      topic,
      params,
    };
    this.ws?.send(JSON.stringify(request));
  }

  private unsubscribe(id: number): void {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;

    if (this.ws?.readyState === WebSocket.OPEN) {
      const request: StreamRequest = {
        id,
        method: "unsubscribe",
        topic: subscription.topic,
        params: subscription.params,
      };
      this.ws.send(JSON.stringify(request));
    }

    this.subscriptions.delete(id);
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message = JSON.parse(event.data as string) as Record<string, unknown>;

      if (this.isResponseMessage(message)) {
        this.handleResponseMessage(message as StreamResponse<unknown>);
      }
    } catch {
      // Malformed messages are silently dropped
    }
  }

  private isResponseMessage(message: Record<string, unknown>): boolean {
    return "id" in message && typeof (message as { id: unknown }).id === "number";
  }

  private handleResponseMessage(response: StreamResponse<unknown>): void {
    const subscription = this.subscriptions.get(response.id);
    if (!subscription) return;

    if ("error" in response) {
      subscription.onError?.(response.error);
    } else if ("d" in response) {
      if (this.isAckMessage(response.d)) return;
      subscription.onData(response.d);
    }
  }

  private isAckMessage(data: unknown): boolean {
    return (
      typeof data === "object" &&
      data !== null &&
      "subscribed" in data &&
      typeof (data as { subscribed: unknown }).subscribed === "boolean"
    );
  }

  private computeReconnectDelay(): number {
    const exponential = this.baseReconnectInterval * 2 ** this.reconnectAttempts;
    const jitter = Math.random() * this.baseReconnectInterval;
    return Math.min(exponential + jitter, this.maxReconnectInterval);
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      for (const sub of this.subscriptions.values()) {
        sub.onError?.(new Error("Max reconnection attempts reached"));
      }
      return;
    }

    const delay = this.computeReconnectDelay();
    this.reconnectAttempts++;

    setTimeout(async () => {
      try {
        await this.connect();
        this.resubscribeAll();
        this.notifyReconnectListeners();
      } catch {
        // Will retry via onclose handler
      }
    }, delay);
  }

  private notifyReconnectListeners(): void {
    for (const listener of this.reconnectListeners) {
      try {
        listener();
      } catch (error) {
        console.error("WsTransport reconnect listener threw", error);
      }
    }
  }

  private resubscribeAll(): void {
    for (const sub of this.subscriptions.values()) {
      const request: StreamRequest = {
        id: sub.id,
        method: "subscribe",
        topic: sub.topic,
        params: sub.params,
      };
      this.ws?.send(JSON.stringify(request));
    }
  }

  private startLivenessMonitor(): void {
    this.stopLivenessMonitor();
    this.livenessTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > this.livenessTimeout) {
        this.ws?.close();
      }
    }, this.livenessTimeout / 2);
  }

  private stopLivenessMonitor(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }
}
