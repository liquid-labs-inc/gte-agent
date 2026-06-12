import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Parameters } from "@/tool/workflow"
import { Workflow } from "@/workflow"

const decode = Schema.decodeUnknownSync(Parameters)

describe("workflow tool parameters", () => {
  test("accepts minimal valid params", () => {
    const params = decode({ name: "audit-sql", script: "return 1" })
    expect(params.name).toBe("audit-sql")
    expect(params.script).toBe("return 1")
    expect(params.args).toBeUndefined()
    expect(params.background).toBeUndefined()
  })

  test("accepts structured args and background flag", () => {
    const params = decode({
      name: "triage",
      script: "return args.items.length",
      args: { items: [1, 2, 3] },
      background: false,
    })
    expect(params.args).toEqual({ items: [1, 2, 3] })
    expect(params.background).toBe(false)
  })

  test("rejects missing required fields", () => {
    expect(() => decode({ script: "return 1" })).toThrow()
    expect(() => decode({ name: "x" })).toThrow()
    expect(() => decode({})).toThrow()
  })

  test("rejects wrong types", () => {
    expect(() => decode({ name: 42, script: "return 1" })).toThrow()
    expect(() => decode({ name: "x", script: ["not", "a", "string"] })).toThrow()
    expect(() => decode({ name: "x", script: "return 1", background: "yes" })).toThrow()
  })
})

describe("workflow feature gating", () => {
  test("enabled by default", () => {
    expect(Workflow.enabled({}, {})).toBe(true)
    expect(Workflow.enabled({ disableWorkflows: false }, {})).toBe(true)
  })

  test("disableWorkflows config turns the feature off", () => {
    expect(Workflow.enabled({ disableWorkflows: true }, {})).toBe(false)
  })

  test("GTE_AGENT_DISABLE_WORKFLOWS env kill switch wins over config", () => {
    expect(Workflow.enabled({}, { GTE_AGENT_DISABLE_WORKFLOWS: "1" })).toBe(false)
    expect(Workflow.enabled({}, { GTE_AGENT_DISABLE_WORKFLOWS: "true" })).toBe(false)
    expect(Workflow.enabled({ disableWorkflows: false }, { GTE_AGENT_DISABLE_WORKFLOWS: "1" })).toBe(false)
    expect(Workflow.enabled({}, { GTE_AGENT_DISABLE_WORKFLOWS: "0" })).toBe(true)
  })

  test("ultrathink keyword detection", () => {
    expect(Workflow.hasKeyword([{ type: "text", text: "please ultrathink this refactor" }])).toBe(true)
    expect(Workflow.hasKeyword([{ type: "text", text: "ULTRATHINK: audit everything" }])).toBe(true)
    expect(Workflow.hasKeyword([{ type: "text", text: "ultra think about it" }])).toBe(false)
    expect(Workflow.hasKeyword([{ type: "file" }])).toBe(false)
  })

  test("bestVariant resolves the highest reasoning effort", () => {
    expect(Workflow.bestVariant(["low", "high", "xhigh"])).toBe("xhigh")
    expect(Workflow.bestVariant(["low", "max"])).toBe("max")
    expect(Workflow.bestVariant(["low", "high"])).toBe("high")
    expect(Workflow.bestVariant(["mini", "thinking"])).toBe("thinking")
    expect(Workflow.bestVariant([])).toBeUndefined()
  })
})
