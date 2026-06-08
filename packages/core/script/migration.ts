#!/usr/bin/env bun

import path from "path"
import { parseArgs } from "util"

const root = path.resolve(import.meta.dirname, "../../..")
const baseline = "20260608010000_clean_gte_agent_baseline"
const registry = path.join(root, "packages/core/src/database/migration.gen.ts")
const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    check: { type: "boolean" },
    name: { type: "string" },
  },
})

if (args.values.check) {
  await check()
  process.exit(0)
}

throw new Error("GTE Agent uses a clean baseline migration. Edit the baseline explicitly instead of generating legacy migrations.")

async function check() {
  if (args.values.name) throw new Error("--name is only valid when generating migrations, which is disabled")
  const expected = `import type { DatabaseMigration } from "./migration"

export const migrations = (
  await Promise.all([
    import("./migration/${baseline}"),
  ])
).map((module) => module.default) satisfies DatabaseMigration.Migration[]
`
  if ((await Bun.file(registry).text()) !== expected) {
    throw new Error("Database migration registry must contain only the clean GTE Agent baseline.")
  }
  if (!(await Bun.file(path.join(root, "packages/core/src/database/migration", `${baseline}.ts`)).exists())) {
    throw new Error(`Clean GTE Agent baseline migration is missing: ${baseline}`)
  }
}
