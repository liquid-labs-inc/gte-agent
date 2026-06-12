#!/usr/bin/env bun

/**
 * Audit active source for imports of the gte-ts mutation/signing surface.
 *
 * Phase 1 is read-only: active code may import `createGteDataClient` and read
 * types from "gte-ts", but must never import the order client, signer
 * adapters, or order/account write resources, and must never deep-import into
 * the vendored package's internals.
 *
 * Rules:
 *   import-binding    a static import/re-export from "gte-ts" binds a forbidden name
 *                     (handles aliases and `import type`)
 *   star-reexport     `export * [as ns] from "gte-ts"` re-exports the whole surface
 *   deep-import       any import/require/dynamic-import that reaches into the
 *                     vendored package ("gte-ts/...", ".../packages/gte-ts/...")
 *   namespace-member  `import * as g from "gte-ts"` followed by `g.<forbidden>`
 *   bare-name         belt-and-braces: a forbidden name appears anywhere in source
 *   invalid-pragma    a gte-audit-allow pragma without a reason
 *
 * Allowlist pragma (suppresses findings for <name> on the pragma's line and the
 * next line; <name> may be "*"):
 *   // gte-audit-allow: <name> <reason>
 *
 * Scope: the whole repo except packages/gte-ts (the vendored package itself),
 * docs/, and this script + its test (their rule lists and fixtures
 * legitimately contain forbidden names).
 *
 * Usage: bun run script/audit-gte-imports.ts [rootDir]
 * Exits 1 with a file:line report on violation, 0 when clean.
 */

import fs from "node:fs"
import path from "node:path"

export type Rule = "import-binding" | "star-reexport" | "deep-import" | "namespace-member" | "bare-name" | "invalid-pragma"

export interface Finding {
  file: string
  line: number
  name: string
  rule: Rule
  text: string
}

/** Mutation/signing exports of the vendored gte-ts entry (packages/gte-ts/src/index.ts). */
export const FORBIDDEN_NAMES: readonly string[] = [
  "createGteOrderClient",
  "GteOrderClient",
  "GteOrderClientOptions",
  "GteOrderClientInterface",
  "fromPrivateKey",
  "fromPrivateKeyAccount",
  "GteSigner",
  "OrdersInterface",
  "AccountsWriteInterface",
  "SetLeverageParams",
  "setLeverage",
  "CreateOrdersParams",
  "CancelOrdersParams",
  "ReplaceOrderParams",
  "ReplaceOrdersParams",
  "CreateTwapOrderParams",
  "CancelTwapOrderParams",
]

const FORBIDDEN_SET = new Set(FORBIDDEN_NAMES)
const FORBIDDEN_ALT = FORBIDDEN_NAMES.join("|")

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"])
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", "build", "coverage", ".git", ".turbo", ".artifacts"])
const EXCLUDED_ROOT_PATHS = new Set(["packages/gte-ts", "docs"])
// This script and its test define the rule list / fixtures and are not active code paths.
const SELF_BASENAMES = new Set(["audit-gte-imports.ts", "audit-gte-imports.test.ts"])

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

type SpecifierKind = "entry" | "deep" | "other"

function classifySpecifier(specifier: string, fileDir: string, repoRoot: string): SpecifierKind {
  if (specifier === "gte-ts") return "entry"
  if (specifier.startsWith("gte-ts/")) return "deep"
  if (specifier.includes("packages/gte-ts/")) return "deep"
  if (specifier.startsWith(".")) {
    const resolved = path.resolve(fileDir, specifier)
    const vendored = path.join(repoRoot, "packages", "gte-ts")
    if (resolved === vendored || resolved.startsWith(vendored + path.sep)) return "deep"
  }
  return "other"
}

export function scanFile(file: string, content: string, repoRoot: string): Finding[] {
  const findings: Finding[] = []
  const lines = content.split("\n")
  const fileDir = path.dirname(path.resolve(repoRoot, file))

  // Pragma pass: gte-audit-allow on line N suppresses <name> on lines N and N+1.
  const allowed = new Map<number, Set<string>>()
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/gte-audit-allow:(.*)$/)
    if (!match) continue
    const rest = match[1].trim()
    const [name, ...reason] = rest.split(/\s+/)
    const lineNo = i + 1
    if (!name || reason.length === 0) {
      findings.push({
        file,
        line: lineNo,
        name: name || "(missing)",
        rule: "invalid-pragma",
        text: lines[i],
      })
      continue
    }
    for (const target of [lineNo, lineNo + 1]) {
      const set = allowed.get(target) ?? new Set<string>()
      set.add(name)
      allowed.set(target, set)
    }
  }

  const isAllowed = (line: number, name: string): boolean => {
    const set = allowed.get(line)
    return set !== undefined && (set.has(name) || set.has("*"))
  }

  const lineOf = (index: number): number => {
    let line = 1
    for (let i = 0; i < index && i < content.length; i++) if (content[i] === "\n") line++
    return line
  }

  const seen = new Set<string>()
  const report = (line: number, name: string, rule: Rule): void => {
    if (isAllowed(line, name)) return
    const key = `${line}:${name}`
    if (seen.has(key)) return
    seen.add(key)
    findings.push({ file, line, name, rule, text: lines[line - 1] ?? "" })
  }

  const namespaces = new Set<string>()

  // Static imports and re-exports with a `from` clause.
  const fromRe = /\b(import|export)\s+(type\s+)?([^"']*?)\sfrom\s*["']([^"']+)["']/g
  for (const match of content.matchAll(fromRe)) {
    const [matched, keyword, , clause, specifier] = match
    const kind = classifySpecifier(specifier, fileDir, repoRoot)
    if (kind === "other") continue
    const statementLine = lineOf(match.index)
    if (kind === "deep") {
      report(statementLine, specifier, "deep-import")
      continue
    }
    // Entry import/export from "gte-ts".
    if (keyword === "export" && clause.includes("*")) {
      report(statementLine, "*", "star-reexport")
      continue
    }
    const namespaceMatch = clause.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/)
    if (namespaceMatch) namespaces.add(namespaceMatch[1])
    const braceStart = matched.indexOf("{")
    if (braceStart === -1) continue
    const braceEnd = matched.indexOf("}", braceStart)
    if (braceEnd === -1) continue
    const inner = matched.slice(braceStart + 1, braceEnd)
    const bindingRe = /(?:^|,)\s*(?:type\s+)?([A-Za-z_$][\w$]*)/g
    for (const binding of inner.matchAll(bindingRe)) {
      const original = binding[1]
      if (!FORBIDDEN_SET.has(original)) continue
      const identifierOffset = binding.index + binding[0].lastIndexOf(original)
      report(lineOf(match.index + braceStart + 1 + identifierOffset), original, "import-binding")
    }
  }

  // Side-effect imports, dynamic imports, and requires: specifier check only
  // (forbidden bindings pulled out of these are caught by the bare-name pass).
  const bareSpecifierRe = /\b(?:import|require)\s*\(?\s*["']([^"']+)["']/g
  for (const match of content.matchAll(bareSpecifierRe)) {
    const specifier = match[1]
    if (classifySpecifier(specifier, fileDir, repoRoot) !== "deep") continue
    report(lineOf(match.index), specifier, "deep-import")
  }

  // Member access through a namespace imported from "gte-ts".
  for (const namespace of namespaces) {
    const memberRe = new RegExp(`\\b${escapeRegExp(namespace)}\\s*\\.\\s*(${FORBIDDEN_ALT})\\b`, "g")
    for (const match of content.matchAll(memberRe)) {
      report(lineOf(match.index), match[1], "namespace-member")
    }
  }

  // Belt-and-braces: any occurrence of a forbidden name in active source.
  const bareNameRe = new RegExp(`\\b(${FORBIDDEN_ALT})\\b`, "g")
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(bareNameRe)) {
      report(i + 1, match[1], "bare-name")
    }
  }

  return findings
}

export interface ScanResult {
  findings: Finding[]
  fileCount: number
}

export function scanTree(rootDir: string): ScanResult {
  const findings: Finding[] = []
  let fileCount = 0

  const walk = (dir: string, relative: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const relPath = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue
        if (EXCLUDED_ROOT_PATHS.has(relPath)) continue
        walk(path.join(dir, entry.name), relPath)
        continue
      }
      if (!entry.isFile()) continue
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue
      if (SELF_BASENAMES.has(entry.name)) continue
      fileCount++
      const content = fs.readFileSync(path.join(dir, entry.name), "utf8")
      findings.push(...scanFile(relPath, content, rootDir))
    }
  }

  walk(rootDir, "")
  return { findings, fileCount }
}

if (import.meta.main) {
  const rootArg = process.argv[2]
  const root = rootArg ? path.resolve(rootArg) : path.resolve(import.meta.dir, "..")
  const { findings, fileCount } = scanTree(root)
  if (findings.length > 0) {
    console.error(`gte import audit FAILED: ${findings.length} violation(s) (${fileCount} files scanned)\n`)
    for (const finding of findings) {
      console.error(`${finding.file}:${finding.line}  ${finding.name}  [${finding.rule}]`)
      console.error(`    ${finding.text.trim()}`)
    }
    console.error(
      "\nActive code paths must not import the gte-ts mutation/signing surface (Phase 1 is read-only)." +
        "\nUse createGteDataClient and read types only. See docs/m_5-read-only-gte-data-tools-plan.md." +
        "\nFor a legitimate non-import mention, annotate the line: // gte-audit-allow: <name> <reason>",
    )
    process.exit(1)
  }
  console.log(`gte import audit passed (${fileCount} files scanned)`)
}
