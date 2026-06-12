export * as Session from "./session"
export * from "./session/schema"

import { Cause, DateTime, Effect, Layer, Schema, Context, Option, Stream } from "effect"
import { and, asc, desc, eq, gt, inArray, like, lt, or, type SQL } from "drizzle-orm"
import { Project } from "./project"
import { Model } from "./model"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { Event } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { Agent } from "./agent"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { RuntimeScope } from "./runtime-scope"
import { GTEAuth } from "./gte-auth"

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by location (home is special)

export const ListAnchor = Schema.Struct({
  id: SessionSchema.ID,
  time: Schema.Finite,
  direction: Schema.Literals(["previous", "next"]),
})
export type ListAnchor = typeof ListAnchor.Type

const ListInputBase = {
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: Project.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  /** Owning session for derived work (workflow agents); purely observational. */
  parentID?: SessionSchema.ID
  agent?: Agent.ID
  model?: Model.Ref
  runtimeScope: RuntimeScope.Ref
  authorityID?: GTEAuth.AuthorityID
}

/** Session-scoped UI intent patch: `undefined` leaves a field unchanged, `null` clears it. */
type UpdateIntentInput = {
  sessionID: SessionSchema.ID
  selectedMarket?: string | null
  trackedAddress?: SessionSchema.TrackedAddress | null
  pinnedPanels?: SessionSchema.PinnedPanels | null
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals(["move", "shell", "skill", "switchAgent", "switchModel"]),
  },
) {}

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}

export type Error =
  | NotFoundError
  | MessageDecodeError
  | OperationUnavailableError
  | PromptConflictError
  | GTEAuth.AuthorityRequiredError
  | GTEAuth.AuthorizationError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (
    input: CreateInput,
  ) => Effect.Effect<
    SessionSchema.Info,
    GTEAuth.AuthorityRequiredError | GTEAuth.MutationDeniedError | GTEAuth.AuthorityConflictError
  >
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError | GTEAuth.ReadDeniedError>
  readonly updateIntent: (
    input: UpdateIntentInput,
  ) => Effect.Effect<SessionSchema.Info, NotFoundError | GTEAuth.ReadDeniedError | GTEAuth.MutationDeniedError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError | GTEAuth.ReadDeniedError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined, NotFoundError | GTEAuth.ReadDeniedError>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError | GTEAuth.ReadDeniedError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: Event.Cursor
  }) => Stream.Stream<Event.CursorEvent<SessionEvent.DurableEvent>, NotFoundError | GTEAuth.ReadDeniedError>
  readonly switchAgent: (input: {
    sessionID: SessionSchema.ID
    agent: string
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: Model.Ref
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: Prompt
    delivery?: SessionInput.Delivery
    resume?: boolean
  }) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError | GTEAuth.ReadDeniedError | GTEAuth.MutationDeniedError>
  readonly shell: (input: {
    id?: Event.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly skill: (input: {
    id?: Event.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly resume: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<void, NotFoundError | GTEAuth.ReadDeniedError | SessionRunner.RunError>
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/Session") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* Event.Service
    const projects = yield* Project.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const auth = Option.getOrElse(yield* Effect.serviceOption(GTEAuth.RequestContextService), () => GTEAuth.devContext)
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const scope = yield* Effect.scope

    const enqueueWake = (sessionID: SessionSchema.ID) =>
      execution.wake(sessionID).pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logError("Failed to wake Session").pipe(
                Effect.annotateLogs("sessionID", sessionID),
                Effect.annotateLogs("cause", cause),
              ),
        ),
        Effect.ignore,
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid,
      )

    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    const result = Service.of({
      create: Effect.fn("Session.create")(function* (input) {
        const sessionID = input.id ?? SessionSchema.ID.create()
        const authorityID = yield* GTEAuth.requireExplicitAuthority(auth, input.authorityID)
        if (!GTEAuth.canAct(auth, authorityID)) {
          return yield* new GTEAuth.MutationDeniedError({ sessionID, principalID: auth.principalID, authorityID })
        }
        const recorded = yield* store.get(sessionID)
        if (recorded) {
          if (recorded.principalID !== auth.principalID || recorded.authorityID !== authorityID) {
            return yield* new GTEAuth.AuthorityConflictError({
              sessionID,
              principalID: auth.principalID,
              authorityID,
            })
          }
          return recorded
        }
        const project = yield* projects.resolve(input.runtimeScope.directory)
        yield* db
          .insert(ProjectTable)
          .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        const now = Date.now()
        const info = SessionSchema.Info.make({
          id: sessionID,
          parentID: input.parentID,
          projectID: project.id,
          principalID: auth.principalID,
          authorityID,
          runtimeScope: input.runtimeScope,
          subpath: RelativePath.make(path.relative(project.directory, input.runtimeScope.directory).replaceAll("\\", "/")),
          title: `New session - ${new Date(now).toISOString()}`,
          agent: input.agent,
          model: input.model
            ? {
                id: Model.ID.make(input.model.id),
                providerID: input.model.providerID,
                variant: input.model.variant,
              }
            : undefined,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(now), updated: DateTime.makeUnsafe(now) },
        })
        const projected = yield* events
          .publish(SessionEvent.Created, { sessionID, timestamp: DateTime.makeUnsafe(now), info })
          .pipe(
            Effect.as({ type: "created" } as const),
            Effect.catchDefect((defect) => {
              if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                return Effect.die(defect)
              }
              // Concurrent creation lost the projection race. The existing Session identity wins.
              return store
                .get(sessionID)
                .pipe(
                  Effect.flatMap((session) =>
                    session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                  ),
                )
            }),
          )
        if (projected.type === "existing") return projected.session
        return yield* result.get(sessionID).pipe(Effect.orDie)
      }),
      get: Effect.fn("Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        if (!GTEAuth.canRead(auth, session.authorityID)) {
          return yield* new GTEAuth.ReadDeniedError({
            sessionID,
            principalID: auth.principalID,
            authorityID: session.authorityID,
          })
        }
        return session
      }),
      updateIntent: Effect.fn("Session.updateIntent")(function* (input) {
        const recorded = yield* result.get(input.sessionID)
        if (!GTEAuth.canAct(auth, recorded.authorityID)) {
          return yield* new GTEAuth.MutationDeniedError({
            sessionID: input.sessionID,
            principalID: auth.principalID,
            authorityID: recorded.authorityID,
          })
        }
        // The HTTP handler forwards omitted fields as undefined, so an empty patch
        // must not append a durable no-op event or bump time_updated.
        if (input.selectedMarket === undefined && input.trackedAddress === undefined && input.pinnedPanels === undefined) {
          return recorded
        }
        const resolve = <T>(next: T | null | undefined, current: T | undefined) =>
          next === null ? undefined : (next ?? current)
        yield* events.publish(SessionEvent.IntentUpdated, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          selectedMarket: resolve(input.selectedMarket, recorded.selectedMarket),
          trackedAddress: resolve(input.trackedAddress, recorded.trackedAddress),
          pinnedPanels: resolve(input.pinnedPanels, recorded.pinnedPanels),
        })
        return yield* result.get(input.sessionID)
      }),
      list: Effect.fn("Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        const readableAuthorityIDs = auth.authorities
          .filter((authority) => authority.read)
          .map((authority) => authority.authorityID)
        if (readableAuthorityIDs.length === 0) return []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        conditions.push(eq(SessionTable.principal_id, auth.principalID))
        conditions.push(inArray(SessionTable.authority_id, readableAuthorityIDs))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode)
      }),
      message: Effect.fn("Session.message")(function* (input) {
        yield* result.get(input.sessionID)
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.aggregateEvents({ aggregateID: input.sessionID, after: input.after }))),
        ).pipe(
          Stream.filter((event): event is Event.CursorEvent<SessionEvent.DurableEvent> =>
            isDurableSessionEvent(event.event),
          ),
        ),
      prompt: Effect.fn("Session.prompt")((input) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const recorded = yield* result.get(input.sessionID)
            if (!GTEAuth.canAct(auth, recorded.authorityID)) {
              return yield* new GTEAuth.MutationDeniedError({
                sessionID: input.sessionID,
                principalID: auth.principalID,
                authorityID: recorded.authorityID,
              })
            }
            const returnPrompt = Effect.fnUntraced(function* (admitted: SessionInput.Admitted) {
              if (input.resume !== false) yield* enqueueWake(input.sessionID)
              return admitted
            }, Effect.uninterruptible)
            const messageID = input.id ?? SessionMessage.ID.create()
            const delivery = input.delivery ?? "steer"
            const expected = { sessionID: input.sessionID, messageID, prompt: input.prompt, delivery }
            const admitted = yield* SessionInput.admit(db, events, {
              id: messageID,
              sessionID: input.sessionID,
              prompt: input.prompt,
              delivery,
            }).pipe(
              Effect.catchDefect((defect) =>
                defect instanceof SessionInput.LifecycleConflict
                  ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                  : Effect.die(defect),
              ),
            )
            if (!SessionInput.equivalent(admitted, expected))
              return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
            return yield* returnPrompt(admitted)
          }),
        ),
      ),
      shell: Effect.fn("Session.shell")(function* () {
        return yield* new OperationUnavailableError({ operation: "shell" })
      }),
      skill: Effect.fn("Session.skill")(function* () {
        return yield* new OperationUnavailableError({ operation: "skill" })
      }),
      switchAgent: Effect.fn("Session.switchAgent")(function* () {
        return yield* new OperationUnavailableError({ operation: "switchAgent" })
      }),
      switchModel: Effect.fn("Session.switchModel")(function* () {
        return yield* new OperationUnavailableError({ operation: "switchModel" })
      }),
      resume: Effect.fn("Session.resume")(function* (sessionID) {
        yield* result.get(sessionID)
        yield* execution.resume(sessionID)
      }),
    })

    return result
  }),
)

const DefaultDatabase = Database.defaultLayer
const DefaultEvents = Event.layer.pipe(Layer.provide(DefaultDatabase))
const DefaultProjector = SessionProjector.layer.pipe(Layer.provide(DefaultEvents), Layer.provide(DefaultDatabase))
const DefaultStore = SessionStore.layer.pipe(Layer.provide(DefaultDatabase))
export const defaultLayer = layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      DefaultDatabase,
      DefaultEvents,
      DefaultProjector,
      DefaultStore,
      SessionExecution.noopLayer,
      Project.defaultLayer,
      GTEAuth.defaultLayer,
    ),
  ),
  Layer.orDie,
)
