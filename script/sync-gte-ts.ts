#!/usr/bin/env bun

/**
 * Sync the vendored gte-ts package from the upstream monorepo checkout.
 *
 * Shows a diff between the upstream package and packages/gte-ts (excluding
 * node_modules/dist and VENDORED.md). With --apply, refreshes the vendored
 * copy from upstream git HEAD and updates the commit SHAs in VENDORED.md.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const usage = "Usage: bun run script/sync-gte-ts.ts [--apply] [upstream-checkout-path]"

const args = process.argv.slice(2)
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage)
  process.exit(0)
}

const apply = args.includes("--apply")
const positional = args.filter((arg) => !arg.startsWith("-"))
const unknown = args.find((arg) => arg.startsWith("-") && arg !== "--apply")
if (unknown || positional.length > 1) {
  if (unknown) console.error(`Unknown option: ${unknown}`)
  console.error(usage)
  process.exit(1)
}

const root = path.resolve(import.meta.dir, "..")
const upstreamRepo = path.resolve(positional[0] ?? "/Users/moses/repos/monorepo")
const upstreamPath = "packages/typescript/gte-ts"
const upstreamDir = path.join(upstreamRepo, upstreamPath)
const vendoredDir = path.join(root, "packages", "gte-ts")
const vendoredMd = path.join(vendoredDir, "VENDORED.md")

if (!fs.existsSync(path.join(upstreamRepo, ".git"))) {
  console.error(`Upstream checkout not found (no .git): ${upstreamRepo}`)
  process.exit(1)
}
if (!fs.existsSync(upstreamDir)) {
  console.error(`Upstream package not found: ${upstreamDir}`)
  process.exit(1)
}

function run(cmd: string, cmdArgs: string[], opts: { allowFailure?: boolean } = {}): string {
  const res = spawnSync(cmd, cmdArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  if (res.error) throw res.error
  if (res.status !== 0 && !opts.allowFailure) {
    console.error(res.stderr || `Command failed: ${cmd} ${cmdArgs.join(" ")}`)
    process.exit(1)
  }
  return res.stdout
}

function git(...gitArgs: string[]): string {
  return run("git", ["-C", upstreamRepo, ...gitArgs]).trim()
}

// Diff upstream worktree vs vendored copy (informational; exits 1 on diff failure other than differences)
const diffRes = spawnSync(
  "diff",
  ["-rq", "--exclude=node_modules", "--exclude=dist", "--exclude=VENDORED.md", upstreamDir, vendoredDir],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
if (diffRes.status === 0) {
  console.log("Vendored copy matches upstream. Nothing to sync.")
  if (!apply) process.exit(0)
} else if (diffRes.status === 1) {
  console.log("Differences between upstream and vendored copy:\n")
  console.log(diffRes.stdout.trim())
  if (!apply) {
    console.log("\nRun with --apply to refresh the vendored copy.")
    process.exit(1)
  }
} else {
  console.error(diffRes.stderr || "diff failed")
  process.exit(1)
}

// --apply: refresh from upstream git HEAD (tracked files only) and update VENDORED.md SHAs
const dirty = git("status", "--porcelain", "--", upstreamPath)
if (dirty) {
  console.error(`Upstream package has uncommitted changes; commit them first:\n${dirty}`)
  process.exit(1)
}

const headSha = git("rev-parse", "HEAD")
const lastTouchSha = git("log", "-1", "--format=%H", "--", upstreamPath)
const lastTouchDate = git("log", "-1", "--format=%ad", "--date=short", "--", upstreamPath)
const lastTouchSubject = git("log", "-1", "--format=%s", "--", upstreamPath)
const now = new Date()
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`

// Replace vendored contents (keep VENDORED.md)
const vendoredNotes = fs.readFileSync(vendoredMd, "utf8")
fs.rmSync(vendoredDir, { recursive: true, force: true })
fs.mkdirSync(vendoredDir, { recursive: true })
run("bash", [
  "-c",
  `git -C ${JSON.stringify(upstreamRepo)} archive HEAD:${upstreamPath} | tar -x -C ${JSON.stringify(vendoredDir)}`,
])

const updatedNotes = vendoredNotes
  .replace(/Monorepo commit SHA at copy time: `[0-9a-f]+`/, `Monorepo commit SHA at copy time: \`${headSha}\``)
  .replace(
    /Last commit touching the package: `[0-9a-f]+`.*$/m,
    `Last commit touching the package: \`${lastTouchSha}\` (${lastTouchDate}, "${lastTouchSubject}")`,
  )
  .replace(/Copy date: \d{4}-\d{2}-\d{2}/, `Copy date: ${today}`)
fs.writeFileSync(vendoredMd, updatedNotes)

console.log(`\nRefreshed packages/gte-ts from ${upstreamRepo} @ ${headSha}`)
console.log(`Last commit touching the package: ${lastTouchSha} (${lastTouchDate})`)
console.log("Updated VENDORED.md. Run `bun install` if dependencies changed.")
