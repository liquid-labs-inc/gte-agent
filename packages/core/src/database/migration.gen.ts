import type { DatabaseMigration } from "./migration"

export const migrations = (
  await Promise.all([
    import("./migration/20260608010000_clean_gte_agent_baseline"),
  ])
).map((module) => module.default) satisfies DatabaseMigration.Migration[]
