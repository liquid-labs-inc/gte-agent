import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer, Stream } from "effect"
import { Agent } from "@gte-agent/core/agent"
import { asc, eq } from "drizzle-orm"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { EventTable } from "@gte-agent/core/event/sql"
import { GTEAuth } from "@gte-agent/core/gte-auth"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { Model } from "@gte-agent/core/model"
import { Project } from "@gte-agent/core/project"
import { ProjectTable } from "@gte-agent/core/project/sql"
import { Provider } from "@gte-agent/core/provider"
import { AbsolutePath } from "@gte-agent/core/schema"
import { Session } from "@gte-agent/core/session"
import { Prompt } from "@gte-agent/core/session/prompt"
import { SessionProjector } from "@gte-agent/core/session/projector"
import { SessionExecution } from "@gte-agent/core/session/execution"
import { SessionInput } from "@gte-agent/core/session/input"
import { SessionEvent } from "@gte-agent/core/session/event"
import { SessionTable } from "@gte-agent/core/session/sql"
import { SessionStore } from "@gte-agent/core/session/store"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const database = Database.layerFromPath(":memory:")
const events = Event.layer.pipe(Layer.provide(database))
const projects = Layer.succeed(
  Project.Service,
  Project.Service.of({
    resolve: (directory) => Effect.succeed({ id: Project.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const projector = SessionProjector.layer.pipe(Layer.provide(events), Layer.provide(database))
const store = SessionStore.layer.pipe(Layer.provide(database))
const sessions = Session.layer.pipe(
  Layer.provide(events),
  Layer.provide(database),
  Layer.provide(store),
  Layer.provide(projects),
  Layer.provide(SessionExecution.noopLayer),
)
const sessionsWithAuth = (auth: GTEAuth.RequestContext) =>
  Session.layer.pipe(
    Layer.provide(events),
    Layer.provide(database),
    Layer.provide(store),
    Layer.provide(projects),
    Layer.provide(SessionExecution.noopLayer),
    Layer.provide(GTEAuth.RequestContextService.layer(auth)),
  )
const it = testEffect(
  Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessions),
)
const principalID = GTEAuth.PrincipalID.make("user_test")
const otherPrincipalID = GTEAuth.PrincipalID.make("user_other")
const authorityID = GTEAuth.AuthorityID.make("ta_test")
const otherAuthorityID = GTEAuth.AuthorityID.make("ta_other")
const authEnabled = {
  principalID,
  authorities: [{ authorityID, read: true, act: true }],
  authDisabled: false,
}
const authReadOnly = {
  principalID,
  authorities: [{ authorityID, read: true, act: false }],
  authDisabled: false,
}
const authDenied = {
  principalID,
  authorities: [{ authorityID, read: false, act: false }],
  authDisabled: false,
}
const itAuth = testEffect(
  Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessionsWithAuth(authEnabled)),
)
const itReadOnly = testEffect(
  Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessionsWithAuth(authReadOnly)),
)
const itDenied = testEffect(
  Layer.mergeAll(database, events, projects, projector, store, SessionExecution.noopLayer, sessionsWithAuth(authDenied)),
)
const runtimeScope = RuntimeScope.Ref.make({ directory: AbsolutePath.make("/project") })
const id = Session.ID.create()
const insertSession = (input: {
  sessionID: Session.ID
  principalID: GTEAuth.PrincipalID
  authorityID: GTEAuth.AuthorityID
}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: runtimeScope.directory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: input.sessionID,
        project_id: Project.ID.global,
        principal_id: input.principalID,
        authority_id: input.authorityID,
        slug: "test",
        directory: runtimeScope.directory,
        title: "test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
  })

describe("Session.create", () => {
  it.effect("derives stable namespaced external IDs", () =>
    Effect.sync(() => {
      const input = { namespace: "opencord.agent-thread", key: "thread-1" }

      expect(Session.ID.fromExternal(input)).toBe(Session.ID.fromExternal(input))
      expect(Session.ID.fromExternal(input)).toMatch(/^ses_[a-f0-9]{64}$/)
      expect(Session.ID.fromExternal({ ...input, namespace: "another-app" })).not.toBe(
        Session.ID.fromExternal(input),
      )
      expect(Session.ID.fromExternal({ namespace: "a:b", key: "c" })).not.toBe(
        Session.ID.fromExternal({ namespace: "a", key: "b:c" }),
      )
    }),
  )

  it.effect("creates a fresh projected session when the ID is omitted", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service

      const first = yield* session.create({ runtimeScope })
      const second = yield* session.create({ runtimeScope })

      expect(second.id).not.toBe(first.id)
      expect(yield* session.list()).toHaveLength(2)
    }),
  )

  it.effect("returns the original session when the ID is retried", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const input = { id, runtimeScope }

      const first = yield* session.create(input)
      const retried = yield* session.create(input)

      expect(retried).toEqual(first)
      expect(yield* session.list()).toEqual([first])
    }),
  )

  itAuth.effect("requires explicit authority in auth-enabled mode", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const error = yield* session.create({ runtimeScope }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(GTEAuth.AuthorityRequiredError)
    }),
  )

  itAuth.effect("stores authenticated principal and explicit authority", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ runtimeScope, authorityID })

      expect(created.principalID).toBe(principalID)
      expect(created.authorityID).toBe(authorityID)
    }),
  )

  itReadOnly.effect("denies session creation when the principal cannot act for the authority", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const error = yield* session.create({ runtimeScope, authorityID }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(GTEAuth.MutationDeniedError)
    }),
  )

  itAuth.effect("rejects reused session IDs bound to a different principal or authority", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      yield* insertSession({ sessionID: id, principalID: otherPrincipalID, authorityID: otherAuthorityID })
      const error = yield* session.create({ id, runtimeScope, authorityID }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(GTEAuth.AuthorityConflictError)
    }),
  )

  itDenied.effect("denies session reads when the principal lacks read access", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      yield* insertSession({ sessionID: id, principalID, authorityID })
      const error = yield* session.get(id).pipe(Effect.flip)

      expect(error).toBeInstanceOf(GTEAuth.ReadDeniedError)
    }),
  )

  itDenied.effect("filters unreadable sessions out of local history", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      yield* insertSession({ sessionID: id, principalID, authorityID })

      expect(yield* session.list()).toEqual([])
    }),
  )

  itReadOnly.effect("denies prompt admission when the principal cannot act for the authority", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      yield* insertSession({ sessionID: id, principalID, authorityID })
      const error = yield* session
        .prompt({ sessionID: id, prompt: new Prompt({ text: "Trade" }), resume: false })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(GTEAuth.MutationDeniedError)
    }),
  )

  it.effect("stores supplied immutable create attributes", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const model = Model.Ref.make({
        id: Model.ID.make("sonnet"),
        providerID: Provider.ID.anthropic,
        variant: Model.VariantID.make("fast"),
      })

      expect(
        yield* session.create({
          runtimeScope: RuntimeScope.Ref.make({ directory: runtimeScope.directory }),
          agent: Agent.ID.make("build"),
          model,
        }),
      ).toMatchObject({ runtimeScope: { directory: runtimeScope.directory }, agent: "build", model })
    }),
  )

  it.effect("returns the existing Session when one ID is reused with matching authority", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ id, runtimeScope })
      const changed = [
        { id, runtimeScope: RuntimeScope.Ref.make({ directory: AbsolutePath.make("/other") }) },
        { id, runtimeScope, agent: Agent.ID.make("build") },
        {
          id,
          runtimeScope,
          model: Model.Ref.make({ id: Model.ID.make("sonnet"), providerID: Provider.ID.anthropic }),
        },
      ]

      for (const input of changed) {
        expect(yield* session.create(input)).toEqual(created)
      }
      expect(yield* session.list()).toHaveLength(1)
    }),
  )

  it.effect("returns one recorded session to concurrent exact retries", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const input = { id, runtimeScope }

      const created = yield* Effect.all([session.create(input), session.create(input)], { concurrency: "unbounded" })

      expect(created[1]).toEqual(created[0])
      expect(yield* session.list()).toEqual([created[0]])
    }),
  )

  it.effect("returns the current Session projection after updates", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const input = { id, runtimeScope }
      const created = yield* session.create(input)

      yield* db.update(SessionTable).set({ agent: "build" }).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)

      expect(yield* session.create(input)).toMatchObject({ id: created.id, agent: "build" })
    }),
  )

  it.effect("persists creation through the canonical created event", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ runtimeScope })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toMatchObject([{ type: Event.versionedType(SessionEvent.Created.type, 2) }])
    }),
  )

  it.effect("persists caller-ID creation through the canonical created event", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ id, runtimeScope })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).get().pipe(Effect.orDie),
      ).toMatchObject({
        data: { sessionID: id },
      })
    }),
  )

  it.effect("includes canonical creation rows in the Session event stream", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const events = yield* Event.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ runtimeScope })
      yield* session.prompt({ sessionID: created.id, prompt: new Prompt({ text: "Hello" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, created.id, Number.MAX_SAFE_INTEGER)

      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(3), Stream.runCollect)),
      ).toMatchObject([
        { cursor: 0, event: { type: "session.created", data: { sessionID: created.id } } },
        { cursor: 1, event: { type: "session.next.prompt.admitted", data: { prompt: { text: "Hello" } } } },
        { cursor: 2, event: { type: "session.next.prompt.promoted" } },
      ])
    }),
  )

  it.effect("replays one prompt lifecycle into a fresh target database", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const sourceEvents = yield* Event.Service
      const sourceDb = (yield* Database.Service).db
      const created = yield* session.create({ id: Session.ID.make("ses_fresh_target_replay"), runtimeScope })
      const admitted = yield* session.prompt({
        sessionID: created.id,
        prompt: new Prompt({ text: "Replay lifecycle" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers(sourceDb, sourceEvents, created.id, Number.MAX_SAFE_INTEGER)
      const serialized = (yield* sourceDb
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))

      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const targetDatabase = Database.layerFromPath(path.join(tmp.path, "target.sqlite"))
      const targetEvents = Event.layer.pipe(Layer.provide(targetDatabase))
      const targetProjector = SessionProjector.layer.pipe(Layer.provide(targetEvents), Layer.provide(targetDatabase))
      const targetStore = SessionStore.layer.pipe(Layer.provide(targetDatabase))

      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* Event.Service
        const store = yield* SessionStore.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: runtimeScope.directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)

        expect(yield* store.get(created.id)).toBeUndefined()
        expect(yield* events.replayAll(serialized.slice(0, 2))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 1,
        })
        expect(yield* store.context(created.id)).toEqual([])

        expect(yield* events.replayAll(serialized.slice(2))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 1,
          promotedSeq: 2,
        })
        expect(yield* store.context(created.id)).toMatchObject([
          { id: admitted.id, type: "user", text: "Replay lifecycle" },
        ])
        expect(
          (yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, created.id))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie)).map((event) => [event.seq, event.type]),
        ).toEqual([
          [0, Event.versionedType(SessionEvent.Created.type, 2)],
          [1, Event.versionedType(SessionEvent.PromptLifecycle.Admitted.type, 1)],
          [2, Event.versionedType(SessionEvent.PromptLifecycle.Promoted.type, 1)],
        ])
      }).pipe(Effect.provide(Layer.fresh(Layer.mergeAll(targetDatabase, targetEvents, targetProjector, targetStore))))
    }),
  )

  it.effect("does not mask unrelated created projector defects", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const event = yield* Event.Service
      const defect = new Error("unrelated projector defect")
      yield* event.project(SessionEvent.Created, () => Effect.die(defect))

      expect(yield* session.create({ id, runtimeScope }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("reports unfinished Session operations as unavailable", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ runtimeScope })
      const unavailable = (
        effect: Effect.Effect<void, Session.NotFoundError | Session.OperationUnavailableError>,
      ) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => (error instanceof Session.OperationUnavailableError ? error.operation : "not-found")),
        )

      expect(yield* unavailable(session.shell({ sessionID: created.id, command: "pwd" }))).toBe("shell")
      expect(yield* unavailable(session.skill({ sessionID: created.id, skill: "review" }))).toBe("skill")
      expect(yield* unavailable(session.switchAgent({ sessionID: created.id, agent: "build" }))).toBe("switchAgent")
      expect(
        yield* unavailable(
          session.switchModel({
            sessionID: created.id,
            model: Model.Ref.make({ id: Model.ID.make("sonnet"), providerID: Provider.ID.anthropic }),
          }),
        ),
      ).toBe("switchModel")
    }),
  )
})
