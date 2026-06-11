import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { FORBIDDEN_NAMES, scanTree, type Finding } from "./audit-gte-imports"

const SCRIPT_PATH = path.resolve(import.meta.dir, "audit-gte-imports.ts")

const tempRoots: string[] = []

function makeTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gte-audit-"))
  tempRoots.push(root)
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(root, relPath)
    fs.mkdirSync(path.dirname(absPath), { recursive: true })
    fs.writeFileSync(absPath, content)
  }
  return root
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop()!, { recursive: true, force: true })
  }
})

function findingsFor(files: Record<string, string>): Finding[] {
  return scanTree(makeTree(files)).findings
}

describe("audit-gte-imports", () => {
  test("clean read-only fixture passes", () => {
    const findings = findingsFor({
      "packages/core/src/gte/data.ts": [
        `import { createGteDataClient, type GteEnvKey, type Market } from "gte-ts"`,
        `import type { GetMarketsParams, GetPositionsParams, GetLeverageParams } from "gte-ts"`,
        `export const client = createGteDataClient({ env: "hyperliquid-dev" as GteEnvKey })`,
        `export const leverage = (params: GetLeverageParams) => client.accounts.getLeverage(params)`,
      ].join("\n"),
      "packages/tui/src/panel.tsx": `import * as gte from "gte-ts"\nexport const make = () => gte.createGteDataClient({ env: "hyperliquid-dev" })\n`,
    })
    expect(findings).toEqual([])
  })

  test("named forbidden import fails", () => {
    const findings = findingsFor({
      "packages/core/src/bad.ts": `import { createGteOrderClient } from "gte-ts"\n`,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      file: "packages/core/src/bad.ts",
      line: 1,
      name: "createGteOrderClient",
      rule: "import-binding",
    })
  })

  test("aliased forbidden import fails", () => {
    const findings = findingsFor({
      "packages/server/src/bad.ts": `import { createGteOrderClient as makeClient } from "gte-ts"\n`,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ name: "createGteOrderClient", rule: "import-binding" })
  })

  test("type-only forbidden import fails", () => {
    const findings = findingsFor({
      "packages/core/src/bad.ts": `import type { OrdersInterface, SetLeverageParams } from "gte-ts"\n`,
    })
    expect(findings.map((finding) => finding.name).sort()).toEqual(["OrdersInterface", "SetLeverageParams"])
    expect(findings.every((finding) => finding.rule === "import-binding")).toBe(true)
  })

  test("forbidden binding on a multi-line import reports the binding line", () => {
    const findings = findingsFor({
      "packages/core/src/bad.ts": [
        `import {`,
        `  createGteDataClient,`,
        `  GteOrderClient,`,
        `} from "gte-ts"`,
        ``,
      ].join("\n"),
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ name: "GteOrderClient", rule: "import-binding", line: 3 })
  })

  test("namespace import plus member access to forbidden name fails", () => {
    const findings = findingsFor({
      "packages/cli/src/bad.ts": [
        `import * as gte from "gte-ts"`,
        `const client = gte.createGteOrderClient({ env: "hyperliquid-dev", signer })`,
        ``,
      ].join("\n"),
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ name: "createGteOrderClient", rule: "namespace-member", line: 2 })
  })

  test("deep import into gte-ts internals fails", () => {
    const findings = findingsFor({
      "packages/core/src/bad.ts": `import { fromPrivateKey } from "gte-ts/src/internal/signers"\n`,
    })
    const rules = findings.map((finding) => finding.rule)
    expect(rules).toContain("deep-import")
    const deep = findings.find((finding) => finding.rule === "deep-import")!
    expect(deep.name).toBe("gte-ts/src/internal/signers")
  })

  test("relative deep import into packages/gte-ts fails", () => {
    const findings = findingsFor({
      "packages/core/src/bad.ts": `import { GteOrderClient as C } from "../../gte-ts/src/client/order-client"\n`,
    })
    expect(findings.some((finding) => finding.rule === "deep-import")).toBe(true)
  })

  test("dynamic deep import and require fail", () => {
    const findings = findingsFor({
      "script/bad.ts": [
        `const signers = await import("gte-ts/src/internal/signers")`,
        `const orderClient = require("gte-ts/src/client/order-client")`,
        ``,
      ].join("\n"),
    })
    expect(findings.filter((finding) => finding.rule === "deep-import")).toHaveLength(2)
  })

  test("star re-export of the gte-ts entry fails", () => {
    const findings = findingsFor({
      "packages/core/src/bad.ts": `export * from "gte-ts"\n`,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ name: "*", rule: "star-reexport" })
  })

  test("bare-name fallback flags forbidden names outside imports", () => {
    const findings = findingsFor({
      "packages/core/src/bad.ts": `const help = "construct a GteSigner here"\n`,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ name: "GteSigner", rule: "bare-name" })
  })

  test("gte-audit-allow pragma suppresses a legitimate mention", () => {
    const findings = findingsFor({
      "packages/core/src/ok.ts": [
        `// gte-audit-allow: GteSigner doc string mentioning the forbidden surface`,
        `const help = "GteSigner is not available in Phase 1"`,
        `const inline = "fromPrivateKeyAccount is blocked" // gte-audit-allow: fromPrivateKeyAccount doc string`,
        ``,
      ].join("\n"),
    })
    expect(findings).toEqual([])
  })

  test("pragma without a reason is itself a violation and does not suppress", () => {
    const findings = findingsFor({
      "packages/core/src/bad.ts": `const help = "GteSigner" // gte-audit-allow: GteSigner\n`,
    })
    const rules = findings.map((finding) => finding.rule).sort()
    expect(rules).toEqual(["bare-name", "invalid-pragma"])
  })

  test("pragma does not suppress unrelated names", () => {
    const findings = findingsFor({
      "packages/core/src/bad.ts": `const help = "GteSigner" // gte-audit-allow: createGteOrderClient wrong name\n`,
    })
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ name: "GteSigner", rule: "bare-name" })
  })

  test("vendored gte-ts and docs are excluded from the scan", () => {
    const findings = findingsFor({
      "packages/gte-ts/src/index.ts": `export { GteOrderClient, createGteOrderClient } from "./client/order-client"\n`,
      "docs/example.ts": `import { fromPrivateKey } from "gte-ts"\n`,
      "packages/core/src/ok.ts": `import { createGteDataClient } from "gte-ts"\n`,
    })
    expect(findings).toEqual([])
  })

  test("every forbidden name is caught when imported", () => {
    for (const name of FORBIDDEN_NAMES) {
      const findings = findingsFor({
        "packages/core/src/bad.ts": `import { ${name} } from "gte-ts"\n`,
      })
      expect(findings.map((finding) => finding.name)).toContain(name)
    }
  })

  test("subprocess: exits 0 on clean tree, 1 on violation", () => {
    const cleanRoot = makeTree({
      "packages/core/src/ok.ts": `import { createGteDataClient } from "gte-ts"\nexport const c = createGteDataClient({ env: "hyperliquid-dev" })\n`,
    })
    const clean = Bun.spawnSync(["bun", SCRIPT_PATH, cleanRoot], { stdout: "pipe", stderr: "pipe" })
    expect(clean.exitCode).toBe(0)
    expect(clean.stdout.toString()).toContain("gte import audit passed")

    const dirtyRoot = makeTree({
      "packages/core/src/bad.ts": `import { createGteOrderClient as x } from "gte-ts"\n`,
    })
    const dirty = Bun.spawnSync(["bun", SCRIPT_PATH, dirtyRoot], { stdout: "pipe", stderr: "pipe" })
    expect(dirty.exitCode).toBe(1)
    const stderr = dirty.stderr.toString()
    expect(stderr).toContain("gte import audit FAILED")
    expect(stderr).toContain("packages/core/src/bad.ts:1")
    expect(stderr).toContain("createGteOrderClient")
    expect(stderr).toContain("import-binding")
  })
})
