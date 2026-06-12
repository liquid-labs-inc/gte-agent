import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { GteData } from "@gte-agent/core/gte-data/gte-data"
import { Permission } from "@gte-agent/core/permission"
import { Session } from "@gte-agent/core/session"
import { SessionSchema } from "@gte-agent/core/session/schema"
import { SessionStore } from "@gte-agent/core/session/store"
import { ApplicationTools } from "@gte-agent/core/tool/application-tools"
import { GteTools } from "@gte-agent/core/tool/gte/tools"
import { ToolRegistry } from "@gte-agent/core/tool/registry"
import type { ToolCall, ToolResultValue } from "@gte-agent/llm"
import { testEffect } from "./lib/effect"
import { EXPECTED_GTE_TOOLS, makeStubClient, type StubCall } from "./lib/gte-stub"

const TRACKED = "0x52908400098527886e0f7030069857d2e4169ee7"
const EXPLICIT = "0x8617e340b3d01fa5f11f306f4090fd50e238070d"

const trackedSession = Session.ID.make("ses_gte_tools_tracked")
const bareSession = Session.ID.make("ses_gte_tools_bare")

const calls: StubCall[] = []

const permission = Layer.mock(Permission.Service, {
  assert: () => Effect.void,
})
const sessionStore = Layer.mock(SessionStore.Service, {
  get: (sessionID: SessionSchema.ID) =>
    Effect.succeed(
      sessionID === trackedSession
        ? ({ id: sessionID, trackedAddress: TRACKED } as unknown as SessionSchema.Info)
        : ({ id: sessionID } as unknown as SessionSchema.Info),
    ),
})

const registry = ToolRegistry.layer.pipe(Layer.provide(permission), Layer.provide(ApplicationTools.layer))
const gteData = GteData.layerFromClient("hyperliquid-dev", makeStubClient(calls))
const base = Layer.mergeAll(registry, gteData, sessionStore)
const it = testEffect(Layer.mergeAll(base, GteTools.layer.pipe(Layer.provide(base))))

const call = (name: string, input: unknown): ToolCall => ({
  type: "tool-call",
  id: `call-${name}`,
  name,
  input,
})

const EXPECTED_TOOLS = EXPECTED_GTE_TOOLS

const errorText = (result: ToolResultValue): string => {
  expect(result.type).toBe("error")
  return String((result as { value: unknown }).value)
}

describe("GteTools", () => {
  it.effect("registers the full read-only catalog with read-only descriptions", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const definitions = yield* registry.definitions()
      const names = definitions.map((definition) => definition.name).sort()
      expect(names).toEqual([...EXPECTED_TOOLS].sort())
      for (const definition of definitions) {
        expect(definition.description).toContain("Read-only")
        expect(definition.description).toContain("provenance")
      }
    }),
  )

  it.effect("executes a market tool end-to-end with symbol resolution and provenance", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const settled = yield* registry.settle({
        sessionID: bareSession,
        call: call("gte_market", { symbol: "btc-usd" }),
      })
      expect(settled.result.type).toBe("text")
      const structured = settled.output?.structured as { provenance: Record<string, unknown>; data: { symbol: string } }
      expect(structured.data.symbol).toBe("BTC-USD")
      expect(structured.provenance).toMatchObject({
        env: "hyperliquid-dev",
        source: "http",
        symbol: "BTC-USD",
      })
    }),
  )

  it.effect("fails with candidates when the symbol is ambiguous, so the model can search and retry", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* registry.execute({
        sessionID: bareSession,
        call: call("gte_market", { symbol: "dog" }),
      })
      const message = errorText(result)
      expect(message).toContain("ambiguous")
      expect(message).toContain("DOGE-USD")
      expect(message).toContain("DOGS-USD")
      expect(message).toContain("gte_markets")
    }),
  )

  it.effect("fails with a search hint when no market matches", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* registry.execute({
        sessionID: bareSession,
        call: call("gte_market", { symbol: "zzz" }),
      })
      expect(errorText(result)).toContain('No GTE market found matching "zzz"')
    }),
  )

  it.effect("prefers an explicit address over the session tracked address and normalizes case", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      calls.length = 0
      const settled = yield* registry.settle({
        sessionID: trackedSession,
        call: call("gte_balances", { address: EXPLICIT.toUpperCase().replace("0X", "0x") }),
      })
      expect(settled.result.type).toBe("text")
      const structured = settled.output?.structured as { provenance: { address: string } }
      expect(structured.provenance.address).toBe(EXPLICIT)
      expect(calls).toEqual([{ op: "portfolio.getBalances", params: { userAddress: EXPLICIT } }])
    }),
  )

  it.effect("falls back to the session tracked address when no address argument is given", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      calls.length = 0
      const settled = yield* registry.settle({
        sessionID: trackedSession,
        call: call("gte_balances", {}),
      })
      expect(settled.result.type).toBe("text")
      const structured = settled.output?.structured as { provenance: { address: string } }
      expect(structured.provenance.address).toBe(TRACKED)
      expect(calls).toEqual([{ op: "portfolio.getBalances", params: { userAddress: TRACKED } }])
    }),
  )

  it.effect("asks for an address when neither an argument nor a tracked address exists", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* registry.execute({
        sessionID: bareSession,
        call: call("gte_balances", {}),
      })
      const message = errorText(result)
      expect(message).toContain("no tracked address")
      expect(message).toContain("address")
    }),
  )

  it.effect("rejects an invalid explicit address before any request is made", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      calls.length = 0
      const result = yield* registry.execute({
        sessionID: trackedSession,
        call: call("gte_balances", { address: "0xnope" }),
      })
      expect(errorText(result)).toContain("Invalid EVM address")
      expect(calls).toEqual([])
    }),
  )

  it.effect("quote output is estimate-only: no order-payload, balance, or margin fields", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const settled = yield* registry.settle({
        sessionID: bareSession,
        call: call("gte_quote", { symbol: "BTC-USD", side: "buy", baseSize: 2 }),
      })
      expect(settled.result.type).toBe("text")
      const structured = settled.output?.structured as { provenance: unknown; data: Record<string, unknown> }
      expect(Object.keys(structured.data).sort()).toEqual(["estimate", "note", "requested", "side", "symbol"])
      expect(structured.data.estimate).toEqual({ size: 2, notional: 200, averagePrice: 100 })
      expect(String(structured.data.note)).toContain("estimate only")
      // Scan everything except the human-readable disclaimer note (which
      // legitimately mentions what the output does NOT contain).
      const { note: _note, ...rest } = structured.data
      const serialized = JSON.stringify({ ...rest, provenance: structured.provenance }).toLowerCase()
      for (const forbidden of ["order_id", "orderid", "clientorderid", "margin", "balance", "payload", "nonce", "signature"]) {
        expect(serialized).not.toContain(forbidden)
      }
    }),
  )

  it.effect("quote requires exactly one of baseSize or quoteSize", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const neither = yield* registry.execute({
        sessionID: bareSession,
        call: call("gte_quote", { symbol: "BTC-USD", side: "buy" }),
      })
      expect(errorText(neither)).toContain("exactly one")
      const both = yield* registry.execute({
        sessionID: bareSession,
        call: call("gte_quote", { symbol: "BTC-USD", side: "sell", baseSize: 1, quoteSize: 100 }),
      })
      expect(errorText(both)).toContain("exactly one")
    }),
  )

  it.effect("candles default the interval and from window and record them in provenance", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      calls.length = 0
      const settled = yield* registry.settle({
        sessionID: bareSession,
        call: call("gte_candles", { symbol: "BTC-USD" }),
      })
      expect(settled.result.type).toBe("text")
      const structured = settled.output?.structured as { provenance: { params: Record<string, unknown> } }
      expect(structured.provenance.params.interval).toBe("1h")
      expect(typeof structured.provenance.params.from).toBe("number")
    }),
  )

  it.effect("health tool returns a provenance-wrapped snapshot without address or symbol", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const settled = yield* registry.settle({
        sessionID: bareSession,
        call: call("gte_health", {}),
      })
      expect(settled.result.type).toBe("text")
      const structured = settled.output?.structured as { provenance: Record<string, unknown>; data: unknown }
      expect(structured.provenance).toMatchObject({ env: "hyperliquid-dev", source: "http" })
      expect(structured.data).toEqual({ status: "ok" })
    }),
  )
})
