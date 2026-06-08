import { describe, expect, test } from "bun:test"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@gte-agent/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "@gte-agent/core/database/database"
import { DatabaseMigration } from "@gte-agent/core/database/migration"
import { migrations } from "@gte-agent/core/database/migration.gen"
import { tmpdir } from "./fixture/tmpdir"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const coreRoot = path.resolve(import.meta.dirname, "..")
const baseline = "20260608010000_clean_gte_agent_baseline"

const tableNames = sql`
  SELECT name
  FROM sqlite_master
  WHERE type = 'table'
  ORDER BY name
`

describe("DatabaseMigration", () => {
  test("serializes concurrent embedded initialization for one database path", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "embedded.sqlite")
    const layers = [Database.layerFromPath(filename), Database.layerFromPath(filename)]

    await Effect.runPromise(
      Effect.all(
        layers.map((layer) => Effect.scoped(Layer.build(layer))),
        { concurrency: "unbounded" },
      ),
    )
  })

  test("applies the clean GTE Agent baseline to an empty database", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        expect(migrations.map((migration) => migration.id)).toEqual([baseline])
        expect(yield* db.all<{ name: string }>(tableNames)).toEqual([
          { name: "data_migration" },
          { name: "event" },
          { name: "event_sequence" },
          { name: "migration" },
          { name: "permission" },
          { name: "project" },
          { name: "project_directory" },
          { name: "session" },
          { name: "session_context_epoch" },
          { name: "session_input" },
          { name: "session_message" },
          { name: "todo" },
        ])
        expect(yield* db.get(sql`SELECT count(*) as count FROM migration`)).toEqual({ count: 1 })
      }),
    )
  })

  test("baseline omits historical account, workspace, and V1 projection tables", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const names = new Set((yield* db.all<{ name: string }>(tableNames)).map((row) => row.name))

        expect(names.has("account")).toBe(false)
        expect(names.has("account_state")).toBe(false)
        expect(names.has("control_account")).toBe(false)
        expect(names.has("workspace")).toBe(false)
        expect(names.has("message")).toBe(false)
        expect(names.has("part")).toBe(false)
      }),
    )
  })

  test("session baseline includes immutable principal and authority fields without workspace", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        const columns = (yield* db.all<{ name: string }>(sql`PRAGMA table_info(session)`)).map((row) => row.name)

        expect(columns).toContain("principal_id")
        expect(columns).toContain("authority_id")
        expect(columns).not.toContain("workspace_id")
      }),
    )
  })

  test("only the clean baseline migration wrapper remains on disk", async () => {
    expect(
      await Array.fromAsync(
        new Bun.Glob("*.ts").scan({ cwd: path.join(coreRoot, "src/database/migration"), onlyFiles: true }),
      ),
    ).toEqual([`${baseline}.ts`])
    expect(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: path.join(coreRoot, "migration"), onlyFiles: true })))
      .toEqual([])
  })
})
