export const DEFAULT_HTTP_BASE_URL = "https://34-36-202-112.sslip.io/v1";
export const DEFAULT_WS_BASE_URL = "wss://34-36-202-112.sslip.io/ws";
export const DEV_HTTP_BASE_URL = "https://34-8-220-41.sslip.io/v1";
export const DEV_WS_BASE_URL = "wss://34-8-220-41.sslip.io/ws";
export const CROSS_MARGIN_SUBACCOUNT_ID = 0;

export type GteEnvKey = "hyperliquid-dev" | "hyperliquid-prod";

export const GTE_ENV_ENDPOINTS = {
  "hyperliquid-dev": {
    http: DEV_HTTP_BASE_URL,
    ws: DEV_WS_BASE_URL,
  },
  "hyperliquid-prod": {
    http: DEFAULT_HTTP_BASE_URL,
    ws: DEFAULT_WS_BASE_URL,
  },
} as const satisfies Record<GteEnvKey, { http: string; ws: string }>;
