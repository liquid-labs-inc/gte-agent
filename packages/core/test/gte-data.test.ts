import { describe, expect, test } from "bun:test"
import { ConfigProvider, Context, Effect, Layer } from "effect"
import { GteAddress } from "@gte-agent/core/gte-data/address"
import { GteData } from "@gte-agent/core/gte-data/gte-data"
import { GteDataSchema } from "@gte-agent/core/gte-data/schema"
import { GteSymbol } from "@gte-agent/core/gte-data/symbol"
import { it } from "./lib/effect"
import { makeStubClient, market } from "./lib/gte-stub"

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const ADDRESS = "0x52908400098527886e0f7030069857d2e4169ee7"

const resolveConfig = (env?: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(GteData.ConfigService.defaultLayer)
      return Context.get(context, GteData.ConfigService)
    }),
  ).pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: env === undefined ? {} : { GTE_AGENT_GTE_ENV: env } }))),
  )

describe("GteData config", () => {
  test("defaults to hyperliquid-dev when GTE_AGENT_GTE_ENV is unset", async () => {
    const config = await Effect.runPromise(resolveConfig())
    expect(config.env).toBe("hyperliquid-dev")
  })

  test("resolves an explicit valid environment", async () => {
    const config = await Effect.runPromise(resolveConfig("hyperliquid-prod"))
    expect(config.env).toBe("hyperliquid-prod")
  })

  test("rejects an invalid environment with the valid keys listed", async () => {
    const error = await Effect.runPromise(resolveConfig("bogus-env").pipe(Effect.flip))
    expect(error).toBeInstanceOf(GteDataSchema.ConfigError)
    expect(error.message).toContain("bogus-env")
    expect(error.message).toContain("hyperliquid-dev")
    expect(error.message).toContain("hyperliquid-prod")
  })
})

describe("GteData provenance", () => {
  const gte = GteData.make("hyperliquid-dev", makeStubClient())

  it.effect("wraps market reads as { provenance, data } with env, symbol, source, and ISO timestamp", () =>
    Effect.gen(function* () {
      const snapshot = yield* gte.getMarket({ symbol: "BTC-USD" })
      expect(snapshot.data).toEqual(market("BTC-USD"))
      expect(snapshot.provenance.env).toBe("hyperliquid-dev")
      expect(snapshot.provenance.source).toBe("http")
      expect(snapshot.provenance.symbol).toBe("BTC-USD")
      expect(snapshot.provenance.timestamp).toMatch(ISO_TIMESTAMP)
      expect(snapshot.provenance.address).toBeUndefined()
      expect(snapshot.provenance.params).toBeUndefined()
    }),
  )

  it.effect("records material query params and prunes undefined values", () =>
    Effect.gen(function* () {
      const snapshot = yield* gte.getCandles({ symbol: "BTC-USD", interval: "1h", from: 1_000, to: undefined, limit: 5 })
      expect(snapshot.provenance.params).toEqual({ interval: "1h", from: 1_000, limit: 5 })
      expect(snapshot.provenance.symbol).toBe("BTC-USD")
    }),
  )

  it.effect("records the address on address-scoped reads", () =>
    Effect.gen(function* () {
      const snapshot = yield* gte.getBalances({ userAddress: ADDRESS })
      expect(snapshot.provenance.address).toBe(ADDRESS)
    }),
  )

  it.effect("maps thrown client errors to a typed RequestError carrying the op", () =>
    Effect.gen(function* () {
      const error = yield* gte.getMarket({ symbol: "NOPE-USD" }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(GteDataSchema.RequestError)
      expect(error.op).toBe("markets.get")
      expect(error.message).toContain("NOPE-USD")
    }),
  )
})

describe("GteAddress", () => {
  it.effect("normalizes mixed-case addresses to lowercase", () =>
    Effect.gen(function* () {
      const decoded = yield* GteAddress.decode("0x52908400098527886E0F7030069857D2E4169EE7")
      expect(String(decoded)).toBe(ADDRESS)
    }),
  )

  it.effect("rejects malformed addresses with a friendly message", () =>
    Effect.gen(function* () {
      const error = yield* GteAddress.decode("0x1234").pipe(Effect.flip)
      expect(error).toBeInstanceOf(GteAddress.InvalidAddressError)
      expect(error.message).toContain("Invalid EVM address")
      expect(error.message).toContain("40 hex")
    }),
  )
})

describe("GteSymbol resolver", () => {
  const markets = makeStubClient().markets

  it.effect("resolves an exact symbol pass-through", () =>
    Effect.gen(function* () {
      const result = yield* GteSymbol.resolve(markets, "BTC-USD")
      expect(result).toMatchObject({ outcome: "resolved", symbol: "BTC-USD" })
    }),
  )

  it.effect("resolves a lowercase symbol via deterministic uppercasing", () =>
    Effect.gen(function* () {
      const result = yield* GteSymbol.resolve(markets, "btc-usd")
      expect(result).toMatchObject({ outcome: "resolved", symbol: "BTC-USD" })
    }),
  )

  it.effect("resolves a unique search hit", () =>
    Effect.gen(function* () {
      const result = yield* GteSymbol.resolve(markets, "eth")
      expect(result).toMatchObject({ outcome: "resolved", symbol: "ETH-USD" })
    }),
  )

  it.effect("returns structured ambiguity instead of guessing", () =>
    Effect.gen(function* () {
      const result = yield* GteSymbol.resolve(markets, "dog")
      expect(result).toEqual({ outcome: "ambiguous", query: "dog", candidates: ["DOGE-USD", "DOGS-USD"] })
    }),
  )

  it.effect("prefers an exact case-insensitive match among multiple search hits", () =>
    Effect.gen(function* () {
      const two = makeStubClient().markets
      const exact = { ...two, search: () => Promise.resolve([market("BTC-USD"), market("BTC2-USD")]) }
      const result = yield* GteSymbol.resolve({ ...exact, get: () => Promise.reject(new Error("404")) }, "btc-usd")
      expect(result).toMatchObject({ outcome: "resolved", symbol: "BTC-USD" })
    }),
  )

  it.effect("returns notFound for unknown and empty queries", () =>
    Effect.gen(function* () {
      expect(yield* GteSymbol.resolve(markets, "zzz")).toEqual({ outcome: "notFound", query: "zzz" })
      expect(yield* GteSymbol.resolve(markets, "   ")).toEqual({ outcome: "notFound", query: "" })
    }),
  )

  it.effect("propagates search transport failures as RequestError", () =>
    Effect.gen(function* () {
      const broken = {
        get: () => Promise.reject(new Error("404")),
        search: () => Promise.reject(new Error("boom")),
      }
      const error = yield* GteSymbol.resolve(broken, "btc").pipe(Effect.flip)
      expect(error).toBeInstanceOf(GteDataSchema.RequestError)
      expect(error.op).toBe("markets.search")
    }),
  )
})
