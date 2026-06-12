import { afterEach, describe, expect, test } from "bun:test"
import {
  isUltrathink,
  mentionsUltrathink,
  resolveUltrathinkVariant,
  ultrathinkDisabledByEnv,
  ultrathinkOptions,
  ULTRATHINK_VARIANT,
} from "@/workflow/ultrathink"
import { cycleVariant, effortOptions } from "@/cli/cmd/run/variant.shared"
import { Workflow } from "@/workflow"

afterEach(() => {
  delete process.env["GTE_AGENT_DISABLE_WORKFLOWS"]
})

describe("workflow.ultrathink", () => {
  test("resolves the highest available reasoning variant (xhigh > max > high)", () => {
    expect(resolveUltrathinkVariant(["low", "high", "max", "xhigh"])).toBe("xhigh")
    expect(resolveUltrathinkVariant(["low", "high", "max"])).toBe("max")
    expect(resolveUltrathinkVariant(["low", "high"])).toBe("high")
    expect(resolveUltrathinkVariant(["low", "medium"])).toBeUndefined()
    expect(resolveUltrathinkVariant([])).toBeUndefined()
  })

  test("bestVariant falls back to the model's last variant when no high-effort variant exists", () => {
    expect(Workflow.bestVariant(["low", "high", "max"])).toBe("max")
    expect(Workflow.bestVariant(["low", "medium"])).toBe("medium")
    expect(Workflow.bestVariant([])).toBeUndefined()
  })

  test("ultrathinkOptions appends the pseudo-variant only when backed by a real variant", () => {
    expect(ultrathinkOptions(["low", "high"], true)).toEqual(["low", "high", ULTRATHINK_VARIANT])
    expect(ultrathinkOptions(["low"], true)).toEqual(["low"])
    expect(ultrathinkOptions([], true)).toEqual([])
    expect(ultrathinkOptions(["low", "high"], false)).toEqual(["low", "high"])
  })

  test("keyword detection matches whole words only", () => {
    expect(mentionsUltrathink("please ULTRATHINK this")).toBe(true)
    expect(mentionsUltrathink("ultrathink: refactor the auth flow")).toBe(true)
    expect(mentionsUltrathink("the ultrathinking machine")).toBe(false)
    expect(mentionsUltrathink("no keyword here")).toBe(false)
  })

  test("hasKeyword ignores synthetic parts", () => {
    expect(Workflow.hasKeyword([{ type: "text", text: "ultrathink this" }])).toBe(true)
    expect(Workflow.hasKeyword([{ type: "text", text: "ultrathink this", synthetic: true }])).toBe(false)
    expect(Workflow.hasKeyword([{ type: "file" }, { type: "text", text: "plain" }])).toBe(false)
  })

  test("isUltrathink", () => {
    expect(isUltrathink("ultrathink")).toBe(true)
    expect(isUltrathink("high")).toBe(false)
    expect(isUltrathink(undefined)).toBe(false)
  })

  test("kill switch: env var disables workflows and the effort option", () => {
    expect(Workflow.enabled({})).toBe(true)
    expect(Workflow.enabled({ disableWorkflows: true })).toBe(false)
    expect(ultrathinkDisabledByEnv()).toBe(false)
    process.env["GTE_AGENT_DISABLE_WORKFLOWS"] = "1"
    expect(ultrathinkDisabledByEnv()).toBe(true)
    expect(Workflow.enabled({})).toBe(false)
    expect(effortOptions(["low", "high"])).toEqual(["low", "high"])
  })

  test("effort cycling reaches ultrathink after the real variants", () => {
    const options = effortOptions(["low", "high"])
    expect(options).toEqual(["low", "high", ULTRATHINK_VARIANT])
    expect(cycleVariant(undefined, options)).toBe("low")
    expect(cycleVariant("low", options)).toBe("high")
    expect(cycleVariant("high", options)).toBe(ULTRATHINK_VARIANT)
    expect(cycleVariant(ULTRATHINK_VARIANT, options)).toBeUndefined() // wraps to default
  })
})
