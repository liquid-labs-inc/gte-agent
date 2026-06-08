import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { MoveSession } from "@gte-agent/core/control-plane/move-session"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { FSUtil } from "@gte-agent/core/fs-util"
import { Git } from "@gte-agent/core/git"
import { Project } from "@gte-agent/core/project"
import { ProjectTable } from "@gte-agent/core/project/sql"
import { AbsolutePath } from "@gte-agent/core/schema"
import { Session } from "@gte-agent/core/session"
import { SessionExecution } from "@gte-agent/core/session/execution"
import { SessionTable } from "@gte-agent/core/session/sql"
import { SessionStore } from "@gte-agent/core/session/store"
import { testEffect } from "./lib/effect"

const database = Database.layerFromPath(":memory:")
const events = Event.layer.pipe(Layer.provide(database))
const project = Project.layer.pipe(
  Layer.provide(database),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
)
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = Session.layer.pipe(
  Layer.provide(database),
  Layer.provide(events),
  Layer.provide(project),
  Layer.provide(store),
  Layer.provide(SessionExecution.noopLayer),
)
const layer = MoveSession.layer.pipe(Layer.provide(sessions))
const it = testEffect(Layer.mergeAll(layer, database, events, project, store, SessionExecution.noopLayer, sessions))

describe("MoveSession", () => {
  it.effect("keeps session moves unavailable while control-plane relocation is deferred", () =>
    Effect.gen(function* () {
      const projectID = Project.ID.make("project_move_unavailable")
      const sessionID = Session.ID.make("session_move_unavailable")
      const directory = AbsolutePath.make("/tmp/gte-agent-move-source")
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: projectID, worktree: directory, sandboxes: [], time_created: 1, time_updated: 1 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: projectID,
          slug: "move-unavailable",
          directory,
          title: "move unavailable",
          version: "test",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)

      const result = yield* MoveSession.Service.use((service) =>
        service.moveSession({
          sessionID,
          destination: { directory: AbsolutePath.make("/tmp/gte-agent-move-destination") },
          moveChanges: true,
        }),
      ).pipe(Effect.flip)

      expect(result).toBeInstanceOf(MoveSession.OperationUnavailableError)
      if (!(result instanceof MoveSession.OperationUnavailableError)) return
      expect(result.operation).toBe("moveSession")
      expect(
        yield* db
          .select({ directory: SessionTable.directory })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get(),
      ).toEqual({ directory })
    }),
  )
})
