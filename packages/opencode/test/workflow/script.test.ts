import { describe, expect, test } from "bun:test"
import { WorkflowScript } from "@/workflow/script"
import DEEP_RESEARCH from "@/workflow/deep-research.txt"

describe("workflow script validation", () => {
  test("accepts a plain orchestration script", () => {
    expect(
      WorkflowScript.validate(`
        const out = await phase("p", () => agent({ prompt: "x" }))
        return out.text
      `),
    ).toEqual({ ok: true })
  })

  test("rejects empty scripts", () => {
    expect(WorkflowScript.validate("").ok).toBe(false)
    expect(WorkflowScript.validate("   \n  ").ok).toBe(false)
  })

  test("rejects syntax errors", () => {
    const result = WorkflowScript.validate(`const = broken(`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("syntax error")
  })

  test("rejects dynamic import and import.meta", () => {
    expect(WorkflowScript.validate(`const fs = await import("fs"); return fs`).ok).toBe(false)
    expect(WorkflowScript.validate(`return import.meta.url`).ok).toBe(false)
  })

  test("rejects import/export declarations", () => {
    expect(WorkflowScript.validate(`import fs from "fs"`).ok).toBe(false)
    expect(WorkflowScript.validate(`export const x = 1`).ok).toBe(false)
  })

  test("does not trip on 'import' inside strings or comments", () => {
    expect(
      WorkflowScript.validate(`
        // this prompt mentions import() on purpose
        const r = await agent({ prompt: "explain what import.meta does" })
        return r.text
      `).ok,
    ).toBe(true)
  })

  test("allows top-level await and return", () => {
    expect(WorkflowScript.validate(`await log("hi"); return 1`).ok).toBe(true)
  })
})

describe("workflow script sandbox hardening", () => {
  test("rejects indirect code evaluation that could smuggle a dynamic import", () => {
    expect(WorkflowScript.validate(`return new Function('return import("node:fs")')()`).ok).toBe(false)
    expect(WorkflowScript.validate(`return Function("return process")()`).ok).toBe(false)
    expect(WorkflowScript.validate(`return eval("1+1")`).ok).toBe(false)
  })

  test("rejects constructor traversal and globalThis access", () => {
    expect(WorkflowScript.validate(`return log.constructor("return process")()`).ok).toBe(false)
    expect(WorkflowScript.validate(`return ({}).constructor`).ok).toBe(false)
    expect(WorkflowScript.validate(`return globalThis`).ok).toBe(false)
  })

  test("does not trip on banned tokens inside strings", () => {
    expect(
      WorkflowScript.validate(`
        const r = await agent({ prompt: "explain what a constructor and globalThis are; eval(x) too" })
        return r.text
      `).ok,
    ).toBe(true)
  })

  test("the bundled deep-research workflow passes validation", () => {
    expect(WorkflowScript.validate(DEEP_RESEARCH)).toEqual({ ok: true })
  })
})

describe("workflow frontmatter", () => {
  const script = [
    "// ---",
    "// name: triage-issues",
    "// description: Triage GitHub issues with cross-review",
    "// ---",
    "const out = await phase('p', () => agent({ prompt: 'x' }))",
    "return out.text",
  ].join("\n")

  test("parses name and description", () => {
    const meta = WorkflowScript.frontmatter(script)
    expect(meta.name).toBe("triage-issues")
    expect(meta.description).toBe("Triage GitHub issues with cross-review")
    expect(meta.body).not.toContain("// ---")
    expect(meta.body).toContain("return out.text")
  })

  test("scripts without frontmatter pass through unchanged", () => {
    const body = "return 42"
    expect(WorkflowScript.frontmatter(body)).toEqual({ body })
  })

  test("unterminated frontmatter is treated as plain body", () => {
    const broken = "// ---\n// name: x\nreturn 1"
    expect(WorkflowScript.frontmatter(broken).name).toBeUndefined()
    expect(WorkflowScript.frontmatter(broken).body).toBe(broken)
  })

  test("withFrontmatter renders a block that frontmatter() round-trips", () => {
    const rendered = WorkflowScript.withFrontmatter({
      name: "my-flow",
      description: "does things",
      body: "return 'hi'",
    })
    const meta = WorkflowScript.frontmatter(rendered)
    expect(meta.name).toBe("my-flow")
    expect(meta.description).toBe("does things")
    expect(meta.body.trim()).toBe("return 'hi'")
  })

  test("withFrontmatter replaces an existing block instead of stacking", () => {
    const rendered = WorkflowScript.withFrontmatter({ name: "renamed", body: script })
    const meta = WorkflowScript.frontmatter(rendered)
    expect(meta.name).toBe("renamed")
    expect(rendered.match(/\/\/ ---/g)).toHaveLength(2)
  })
})

describe("workflow names", () => {
  test("validName accepts slash-command-safe names", () => {
    expect(WorkflowScript.validName("deep-research")).toBe(true)
    expect(WorkflowScript.validName("triage_2")).toBe(true)
    expect(WorkflowScript.validName("-bad")).toBe(false)
    expect(WorkflowScript.validName("has space")).toBe(false)
    expect(WorkflowScript.validName("")).toBe(false)
  })
})
