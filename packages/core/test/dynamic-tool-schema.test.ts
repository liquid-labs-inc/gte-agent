import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { DynamicToolSchema } from "@gte-agent/core/dynamic-tool/schema"
import { it } from "./lib/effect"

describe("DynamicToolSchema.validName", () => {
  it.effect("accepts lowercase snake_case names", () =>
    Effect.sync(() => {
      expect(DynamicToolSchema.validName("funding_spread")).toBe(true)
      expect(DynamicToolSchema.validName("a2")).toBe(true)
      expect(DynamicToolSchema.validName("x".repeat(64))).toBe(true)
    }),
  )

  it.effect("rejects names that cannot ride the provider wire next to shipped tools", () =>
    Effect.sync(() => {
      expect(DynamicToolSchema.validName("")).toBe(false)
      expect(DynamicToolSchema.validName("a")).toBe(false)
      expect(DynamicToolSchema.validName("Funding")).toBe(false)
      expect(DynamicToolSchema.validName("2fast")).toBe(false)
      expect(DynamicToolSchema.validName("kebab-case")).toBe(false)
      expect(DynamicToolSchema.validName("x".repeat(65))).toBe(false)
    }),
  )

  it.effect("reserves the gte_ prefix for shipped data tools", () =>
    Effect.sync(() => {
      expect(DynamicToolSchema.validName("gte_markets")).toBe(false)
      expect(DynamicToolSchema.validName("gte_anything")).toBe(false)
    }),
  )
})

describe("DynamicToolSchema.toJsonSchema", () => {
  it.effect("projects the parameter record onto a top-level object schema", () =>
    Effect.sync(() => {
      expect(
        DynamicToolSchema.toJsonSchema({
          market: { type: "string", description: "Market symbol", enum: ["BTC", "ETH"] },
          depth: { type: "number", required: false },
        }),
      ).toEqual({
        type: "object",
        properties: {
          market: { type: "string", description: "Market symbol", enum: ["BTC", "ETH"] },
          depth: { type: "number" },
        },
        // `required` defaults to true: only an explicit false opts a parameter out.
        required: ["market"],
        additionalProperties: false,
      })
    }),
  )

  it.effect("an empty record still declares type object (provider requirement)", () =>
    Effect.sync(() => {
      expect(DynamicToolSchema.toJsonSchema({})).toEqual({
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      })
    }),
  )
})

describe("DynamicToolSchema.validateCode", () => {
  it.effect("accepts plain async-body code", () =>
    Effect.sync(() => {
      expect(DynamicToolSchema.validateCode("return params.a + params.b")).toBeUndefined()
      expect(
        DynamicToolSchema.validateCode("const data = await gte('gte_markets', {})\nreturn data"),
      ).toBeUndefined()
    }),
  )

  it.effect("rejects the sandbox escape hatches with Tool code wording", () =>
    Effect.sync(() => {
      expect(DynamicToolSchema.validateCode("")?.reason).toBe("Tool code is empty")
      expect(DynamicToolSchema.validateCode("await import('fs')")?.reason).toContain("cannot use import")
      expect(DynamicToolSchema.validateCode("eval('1')")?.reason).toContain("cannot use eval")
      expect(DynamicToolSchema.validateCode("new Function('1')")?.reason).toContain("Function constructor")
      expect(DynamicToolSchema.validateCode("({}).constructor")?.reason).toContain(".constructor")
      expect(DynamicToolSchema.validateCode("globalThis.x")?.reason).toContain("globalThis")
      expect(DynamicToolSchema.validateCode("return (")?.reason).toContain("syntax error")
    }),
  )
})
