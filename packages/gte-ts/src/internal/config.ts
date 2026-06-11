import { GTE_ENV_ENDPOINTS, type GteEnvKey } from "../constants";
import type { Client } from "./generated/client";
import { createClient, createConfig } from "./generated/client";
import { WsTransport } from "./ws";

export type GteHttpClientOptions = {
  env: GteEnvKey;
  httpBaseUrl?: string;
  headers?: HeadersInit;
  client?: Client;
};

export type GteWsTransportConfigOptions = {
  env: GteEnvKey;
  wsBaseUrl?: string;
  wsReconnect?: boolean;
  wsReconnectInterval?: number;
  wsMaxReconnectInterval?: number;
  wsMaxReconnectAttempts?: number;
  wsConnectionTimeout?: number;
  wsLivenessTimeout?: number;
};

export function requireGteEnv(env: GteEnvKey | undefined): GteEnvKey {
  if (env !== "hyperliquid-dev" && env !== "hyperliquid-prod") {
    throw new Error("GTE env is required and must be one of: hyperliquid-dev, hyperliquid-prod");
  }

  return env;
}

export function resolveHttpBaseUrl(env: GteEnvKey, httpBaseUrl?: string): string {
  const trimmed = httpBaseUrl?.trim();
  if (!trimmed) {
    return GTE_ENV_ENDPOINTS[env].http;
  }

  return trimmed.replace(/\/+$/, "") || GTE_ENV_ENDPOINTS[env].http;
}

export function resolveWsBaseUrl(env: GteEnvKey, wsBaseUrl?: string): string {
  if (wsBaseUrl === undefined || wsBaseUrl.trim() === "") {
    return GTE_ENV_ENDPOINTS[env].ws;
  }

  return wsBaseUrl;
}

export function createGteHttpClient(options: GteHttpClientOptions): Client {
  const env = requireGteEnv(options?.env);

  return createClient(
    createConfig({
      baseUrl: resolveHttpBaseUrl(env, options?.httpBaseUrl),
      headers: options?.headers,
    }),
  );
}

export function resolveGteHttpClient(options?: GteHttpClientOptions): Client {
  if (options?.client) {
    return options.client;
  }

  if (!options) {
    throw new Error("GTE env is required and must be one of: hyperliquid-dev, hyperliquid-prod");
  }

  return createGteHttpClient(options);
}

export function createGteWsTransport(options: GteWsTransportConfigOptions): WsTransport {
  const env = requireGteEnv(options?.env);

  return new WsTransport({
    url: resolveWsBaseUrl(env, options?.wsBaseUrl),
    reconnect: options?.wsReconnect,
    reconnectInterval: options?.wsReconnectInterval,
    maxReconnectInterval: options?.wsMaxReconnectInterval,
    maxReconnectAttempts: options?.wsMaxReconnectAttempts,
    connectionTimeout: options?.wsConnectionTimeout,
    livenessTimeout: options?.wsLivenessTimeout,
  });
}
