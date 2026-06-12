import { describe, expect, it } from "vitest";
import { resolveSmokeEndpointConfig } from "./config.js";

describe("resolveSmokeEndpointConfig", () => {
  it("returns explicit HTTP and WS URLs", () => {
    expect(
      resolveSmokeEndpointConfig({
        httpUrl: "http://127.0.0.1:8080/v1",
        wsUrl: "ws://127.0.0.1:8080/ws",
      }),
    ).toEqual({
      httpUrl: "http://127.0.0.1:8080/v1",
      wsUrl: "ws://127.0.0.1:8080/ws",
    });
  });

  it("rejects missing HTTP URL", () => {
    expect(() =>
      resolveSmokeEndpointConfig({
        httpUrl: undefined,
        wsUrl: "ws://127.0.0.1:8080/ws",
      }),
    ).toThrow("GTE_HTTP_URL");
  });

  it("rejects missing WS URL", () => {
    expect(() =>
      resolveSmokeEndpointConfig({
        httpUrl: "http://127.0.0.1:8080/v1",
        wsUrl: undefined,
      }),
    ).toThrow("GTE_WS_URL");
  });

  it("rejects blank URLs", () => {
    expect(() =>
      resolveSmokeEndpointConfig({
        httpUrl: " ",
        wsUrl: "\t",
      }),
    ).toThrow("GTE_HTTP_URL");
  });
});
