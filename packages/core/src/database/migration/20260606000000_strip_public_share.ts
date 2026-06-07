import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260606000000_strip_public_share",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("DROP TABLE IF EXISTS `session_share`;")
      if ((yield* tx.all<{ name: string }>("PRAGMA table_info(`session`)")).some((column) => column.name === "share_url"))
        yield* tx.run("ALTER TABLE `session` DROP COLUMN `share_url`;")
    })
  },
} satisfies DatabaseMigration.Migration
