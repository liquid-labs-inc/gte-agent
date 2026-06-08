export * as SessionProjector from "./projector"

import { and, desc, eq } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { Event } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionMessageUpdater } from "./message-updater"
import { SessionInput } from "./input"
import { SessionContextEpoch } from "./context-epoch"
import { SessionMessageTable, SessionTable } from "./sql"
import { SessionSchema } from "./schema"

type DatabaseService = Database.Interface["db"]

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

export class SessionAlreadyProjected extends Error {}

function sessionRow(info: SessionSchema.Info): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    project_id: info.projectID,
    principal_id: info.principalID,
    authority_id: info.authorityID,
    parent_id: info.parentID,
    slug: info.id,
    directory: info.runtimeScope.directory,
    path: info.subpath,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: "gte-agent",
    cost: info.cost,
    tokens_input: info.tokens.input,
    tokens_output: info.tokens.output,
    tokens_reasoning: info.tokens.reasoning,
    tokens_cache_read: info.tokens.cache.read,
    tokens_cache_write: info.tokens.cache.write,
    time_created: DateTime.toEpochMillis(info.time.created),
    time_updated: DateTime.toEpochMillis(info.time.updated),
    time_archived: info.time.archived ? DateTime.toEpochMillis(info.time.archived) : undefined,
  }
}

function run(db: DatabaseService, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })
    const updateMessage = (message: SessionMessage.Message) => {
      if (event.seq === undefined) return Effect.die("Synchronized Session event is missing aggregate sequence")
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      return db
        .update(SessionMessageTable)
        .set({ type, time_created: DateTime.toEpochMillis(message.time.created), data })
        .where(
          and(
            eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
            eq(SessionMessageTable.session_id, event.data.sessionID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    const appendMessage = (message: SessionMessage.Message) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" ? message : undefined
        })
      },
      getCurrentCompaction() {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "compaction")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "compaction" ? message : undefined
        })
      },
      getCurrentShell(callID) {
        return Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "shell")))
            .orderBy(desc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          return rows
            .map(decodeRow)
            .find((message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
        })
      },
      updateAssistant: updateMessage,
      updateCompaction: updateMessage,
      updateShell: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

function insertMessage(db: DatabaseService, event: SessionEvent.Event, message: SessionMessage.Message) {
  if (event.seq === undefined) return Effect.die("Synchronized Session event is missing aggregate sequence")
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: event.data.sessionID,
      type,
      seq: event.seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* Event.Service
    const { db } = yield* Database.Service
    yield* events.beforeCommit((event) => SessionInput.guardReservedID(db, event))
    yield* events.project(SessionEvent.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
      }),
    )
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.runtimeScope.directory,
            path: event.data.subdirectory,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* SessionContextEpoch.reset(db, event.data.sessionID)
      }),
    )
    yield* events.project(SessionEvent.AgentSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ agent: event.data.agent, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.ModelSwitched, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* run(db, event)
        if (event.seq === undefined)
          return yield* Effect.die("Synchronized Session event is missing aggregate sequence")
        yield* SessionContextEpoch.requestReplacement(db, event.data.sessionID, event.seq)
      }),
    )
    yield* events.project(SessionEvent.PromptLifecycle.Admitted, (event) =>
      Effect.gen(function* () {
        if (event.seq === undefined)
          return yield* Effect.die("Synchronized Session event is missing aggregate sequence")
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        })
      }),
    )
    yield* events.project(SessionEvent.PromptLifecycle.Promoted, (event) =>
      Effect.gen(function* () {
        if (event.seq === undefined)
          return yield* Effect.die("Synchronized Session event is missing aggregate sequence")
        yield* insertMessage(
          db,
          event,
          yield* SessionInput.projectPromoted(db, {
            id: event.data.messageID,
            sessionID: event.data.sessionID,
            prompt: event.data.prompt,
            timeCreated: event.data.timeCreated,
            promotedSeq: event.seq,
          }),
        )
      }),
    )
    yield* events.project(SessionEvent.ContextUpdated, (event) => {
      if (!event.replay || event.seq === undefined) return run(db, event)
      return run(db, event).pipe(
        Effect.andThen(SessionContextEpoch.requestReplacement(db, event.data.sessionID, event.seq)),
      )
    })
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    // yield* events.project(SessionEvent.Retried, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Delta, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Ended, (event) => {
      if (event.seq === undefined) return Effect.die("Synchronized Session event is missing aggregate sequence")
      return run(db, event).pipe(
        Effect.andThen(SessionContextEpoch.requestReplacement(db, event.data.sessionID, event.seq)),
      )
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Event.defaultLayer), Layer.provide(Database.defaultLayer))
