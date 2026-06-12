import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { GteData } from "@gte-agent/core/gte-data/gte-data"

/**
 * Live smoke test against the hyperliquid-dev GTE data API.
 *
 * Skipped by default; opt in with:
 *
 *   GTE_AGENT_GTE_LIVE_TEST=1 bun test test/gte-data-live.test.ts
 */
const live = process.env.GTE_AGENT_GTE_LIVE_TEST === "1"

describe("GteData live smoke (hyperliquid-dev)", () => {
  test.skipIf(!live)(
    "lists markets, resolves a symbol, and reads health with provenance",
    async () => {
      const { createGteDataClient } = await import("gte-ts")
      const gte = GteData.make("hyperliquid-dev", createGteDataClient({ env: "hyperliquid-dev" }))

      const markets = await Effect.runPromise(gte.listMarkets({ limit: 5 }))
      expect(markets.provenance).toMatchObject({ env: "hyperliquid-dev", source: "http" })
      expect(Array.isArray(markets.data.markets)).toBe(true)
      expect(markets.data.markets.length).toBeGreaterThan(0)

      const first = markets.data.markets[0]!
      const resolution = await Effect.runPromise(gte.resolveSymbol(first.symbol.toLowerCase()))
      expect(resolution).toMatchObject({ outcome: "resolved", symbol: first.symbol })

      const health = await Effect.runPromise(gte.getHealth())
      expect(health.provenance.source).toBe("http")
      expect(health.data).toBeDefined()
    },
    30_000,
  )
})
