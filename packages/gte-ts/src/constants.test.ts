import { describe, expect, it } from "vitest";

import {
  DEFAULT_HTTP_BASE_URL,
  DEFAULT_WS_BASE_URL,
  DEV_HTTP_BASE_URL,
  DEV_WS_BASE_URL,
  GTE_ENV_ENDPOINTS,
} from "./constants";

describe("endpoint constants", () => {
  it("maps prod env to production endpoints", () => {
    expect(GTE_ENV_ENDPOINTS["hyperliquid-prod"]).toEqual({
      http: DEFAULT_HTTP_BASE_URL,
      ws: DEFAULT_WS_BASE_URL,
    });
  });

  it("maps dev env to dev endpoints", () => {
    expect(GTE_ENV_ENDPOINTS["hyperliquid-dev"]).toEqual({
      http: DEV_HTTP_BASE_URL,
      ws: DEV_WS_BASE_URL,
    });
  });
});
