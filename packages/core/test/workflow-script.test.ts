import { describe, expect, test } from "bun:test"
import { WorkflowScript } from "@gte-agent/core/workflow/script"

const reject = (script: string) => {
  const invalid = WorkflowScript.validate(script)
  expect(invalid).toBeInstanceOf(WorkflowScript.InvalidScriptError)
  return invalid?.reason ?? ""
}

const accept = (script: string) => {
  const invalid = WorkflowScript.validate(script)
  expect(invalid).toBeUndefined()
}

describe("WorkflowScript.validate", () => {
  test("rejects an empty script", () => {
    expect(reject("")).toContain("empty")
    expect(reject("   \n\t")).toContain("empty")
  })

  test("rejects import declarations", () => {
    expect(reject('import fs from "node:fs"\nreturn 1')).toContain("import")
  })

  test("rejects dynamic import()", () => {
    expect(reject('const fs = await import("node:fs")\nreturn 1')).toContain("import")
  })

  test("rejects import.meta", () => {
    expect(reject("return import.meta.url")).toContain("import")
  })

  test("rejects eval", () => {
    expect(reject('return eval("1 + 1")')).toContain("eval")
  })

  test("rejects the Function constructor", () => {
    expect(reject('return new Function("return 1")()')).toContain("Function")
    expect(reject('return Function("return 1")()')).toContain("Function")
  })

  test("rejects .constructor access", () => {
    expect(reject('return ({}).constructor.constructor("return 1")()')).toContain("constructor")
    expect(reject("return ({})['constructor']")).toContain("constructor")
  })

  test("rejects globalThis", () => {
    expect(reject("return globalThis")).toContain("globalThis")
  })

  test("rejects export declarations", () => {
    expect(reject("export const x = 1")).toContain("export")
  })

  test("rejects syntax errors with the engine message", () => {
    expect(reject("return {")).toContain("syntax error")
  })

  test("banned words inside strings and comments are fine", () => {
    accept(
      [
        "// import the data? no: agents do the importing",
        "/* eval Function constructor globalThis */",
        'const result = await agent({ prompt: "Explain why eval and import are banned. Mention globalThis." })',
        "return result.text",
      ].join("\n"),
    )
  })

  test("banned words inside template literal text are fine", () => {
    accept(["const topic = 'imports'", "return `eval and ${topic} are governed by globalThis-free agents`"].join("\n"))
  })

  test("template interpolations are validated as code", () => {
    expect(reject("return `value: ${globalThis}`")).toContain("globalThis")
    expect(reject('return `value: ${eval("1")}`')).toContain("eval")
  })

  test("accepts the documented orchestration shape", () => {
    accept(
      [
        'const angles = ["funding", "liquidity", "volume"]',
        'const research = await phase("research", () =>',
        "  map(angles, (angle) => agent({ prompt: `Research ${angle} for ${args.symbol}` }), { concurrency: 3 }),",
        ")",
        'log("research complete")',
        'const summary = await phase("synthesize", () =>',
        '  agent({ prompt: "Synthesize: " + research.map((item) => item.text).join("\\n") }),',
        ")",
        "return summary.text",
      ].join("\n"),
    )
  })
})
