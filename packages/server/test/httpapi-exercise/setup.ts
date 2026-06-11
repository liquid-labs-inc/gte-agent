/**
 * Hermetic environment bootstrap for the httpapi-exercise suite.
 *
 * IMPORTANT: this module must be the FIRST import of every file in this
 * directory. `@gte-agent/core` captures `GTE_AGENT_*` environment variables at
 * module load time (see `core/src/flag/flag.ts` and `core/src/global.ts`), so
 * these overrides must run before any core or server module is evaluated.
 *
 * Every test server instance gets its own in-memory SQLite database
 * (`GTE_AGENT_DB=":memory:"` resolves to a fresh connection per server layer
 * build), so scenarios are fully isolated from each other and from any
 * developer state on the machine.
 */
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(tmpdir(), "gte-agent-httpapi-"))
const home = path.join(root, "home")
mkdirSync(home, { recursive: true })

process.env.GTE_AGENT_HOME = home
process.env.GTE_AGENT_TEST_HOME = home
process.env.GTE_AGENT_DB = ":memory:"

// Never let ambient developer configuration leak into the suite.
for (const key of [
  "GTE_AGENT_DATA_DIR",
  "GTE_AGENT_CACHE_DIR",
  "GTE_AGENT_CONFIG_DIR",
  "GTE_AGENT_STATE_DIR",
  "GTE_AGENT_TMP_DIR",
  "GTE_AGENT_SERVER_PASSWORD",
  "GTE_AGENT_SERVER_USERNAME",
  "GTE_AGENT_AUTH_MODE",
  "GTE_AGENT_AUTH_TOKEN",
  "GTE_AGENT_PRINCIPAL_ID",
  "GTE_AGENT_AUTHORITY_IDS",
]) {
  delete process.env[key]
}

let counter = 0

/** Unique absolute directory usable as a session runtime scope. */
export function scratchDirectory(label = "scope") {
  counter += 1
  const directory = path.join(root, "scratch", `${label}-${counter}`)
  mkdirSync(directory, { recursive: true })
  return directory
}

// Route core logs (e.g. schema-rejection warnings for the invalid-payload
// scenarios) to a file inside the scratch home instead of stderr. The dynamic
// import keeps the env assignments above ordered before any core module load.
const log = await import("@gte-agent/core/util/log")
await log.init({ print: false })
