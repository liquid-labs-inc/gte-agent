import { SessionMessage } from "@gte-agent/core/session/message"
import { SessionInput } from "@gte-agent/core/session/input"
import { Prompt } from "@gte-agent/core/session/prompt"
import { Session } from "@gte-agent/core/session"
import { Project } from "@gte-agent/core/project"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { GTEAuth } from "@gte-agent/core/gte-auth"
import { Event } from "@gte-agent/core/event"
import { AbsolutePath, PositiveInt, RelativePath, withStatics } from "@gte-agent/core/schema"
import { Schema, Struct } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  ForbiddenError,
  InvalidCursorError,
  InvalidRequestError,
  SessionNotFoundError,
  UnknownError,
} from "../errors"
import { GTEAuthorization } from "../middleware/authorization"

const SessionsQueryFields = {
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional).annotate({
    description: "Maximum number of sessions to return. Defaults to the newest 50 sessions.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Session order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  search: Schema.optional(Schema.String),
}

const SessionsDirectoryQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath,
})

const SessionsProjectQuery = Schema.Struct({
  ...SessionsQueryFields,
  project: Project.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const SessionsAllQuery = Schema.Struct(SessionsQueryFields)

const withCursor = <Fields extends Schema.Struct.Fields>(schema: Schema.Struct<Fields>) =>
  schema.mapFields((fields) => ({
    ...Struct.omit(fields, ["limit"]),
    anchor: Session.ListAnchor,
  }))

const SessionsCursorInput = Schema.Union([
  withCursor(SessionsDirectoryQuery),
  withCursor(SessionsProjectQuery),
  withCursor(SessionsAllQuery),
])
const SessionsCursorJson = Schema.fromJsonString(SessionsCursorInput)
const encodeSessionsCursor = Schema.encodeSync(SessionsCursorJson)
const decodeSessionsCursor = Schema.decodeUnknownEffect(SessionsCursorJson)

export const SessionsCursor = Schema.String.pipe(
  Schema.brand("SessionsCursor"),
  withStatics((schema) => {
    const make = schema.make
    return {
      make: (input: typeof SessionsCursorInput.Type) =>
        make(Buffer.from(encodeSessionsCursor(input)).toString("base64url")),
      parse: (input: string) => decodeSessionsCursor(Buffer.from(input, "base64url").toString("utf8")),
    }
  }),
)
export type SessionsCursor = typeof SessionsCursor.Type

const SessionsCursorQuery = Schema.Struct({
  cursor: SessionsCursor.annotate({
    description: "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response.",
  }),
  limit: SessionsQueryFields.limit,
})

export const SessionsQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath.pipe(Schema.optional),
  project: Project.ID.pipe(Schema.optional),
  subpath: RelativePath.pipe(Schema.optional),
  cursor: SessionsCursorQuery.fields.cursor.pipe(Schema.optional),
}).annotate({ identifier: "SessionsQuery" })

export const SessionGroup = HttpApiGroup.make("session")
  .add(
    HttpApiEndpoint.post("create", "/api/session", {
      payload: Schema.Struct({
        id: Session.ID.pipe(Schema.optional),
        runtimeScope: RuntimeScope.Ref,
        authorityID: GTEAuth.AuthorityID.pipe(Schema.optional),
        agent: Schema.String.pipe(Schema.optional),
        model: Schema.Struct({
          id: Schema.String,
          providerID: Schema.String,
          variant: Schema.String.pipe(Schema.optional),
        }).pipe(Schema.optional),
      }).annotate({ identifier: "SessionCreateRequest" }),
      success: Schema.Struct({ data: Session.Info }).annotate({ identifier: "SessionCreateResponse" }),
      error: [ConflictError, ForbiddenError, InvalidRequestError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "session.create",
        summary: "Create session",
        description: "Create a canonical GTE Agent session bound to the authenticated principal and authority.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("sessions", "/api/session", {
      query: SessionsQuery,
      success: Schema.Struct({
        data: Schema.Array(Session.Info),
        cursor: Schema.Struct({
          previous: SessionsCursor.pipe(Schema.optional),
          next: SessionsCursor.pipe(Schema.optional),
        }),
      }).annotate({ identifier: "SessionsResponse" }),
      error: [ForbiddenError, InvalidCursorError, InvalidRequestError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "session.list",
        summary: "List sessions",
        description:
          "Retrieve sessions in the requested order. Items keep that order across pages; use cursor.next or cursor.previous to move through the ordered list.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("updateIntent", "/api/session/:sessionID/intent", {
      params: { sessionID: Session.ID },
      payload: Schema.Struct({
        selectedMarket: Schema.NullOr(Schema.String).pipe(Schema.optional).annotate({
          description: "Canonical market symbol the session is focused on. Omit to keep, null to clear.",
        }),
        trackedAddress: Schema.NullOr(Session.TrackedAddress).pipe(Schema.optional).annotate({
          description: "EVM address (0x + 40 hex chars) tracked by the session. Omit to keep, null to clear.",
        }),
        pinnedPanels: Schema.NullOr(Session.PinnedPanels).pipe(Schema.optional).annotate({
          description: `Pinned data panels (at most ${Session.MAX_PINNED_PANELS}). Omit to keep, null to clear.`,
        }),
      }).annotate({ identifier: "SessionIntentUpdateRequest" }),
      success: Schema.Struct({ data: Session.Info }).annotate({ identifier: "SessionIntentUpdateResponse" }),
      error: [ForbiddenError, SessionNotFoundError, InvalidRequestError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "session.intent.update",
        summary: "Update session intent",
        description:
          "Update session-scoped UI intent (selected market, tracked address, pinned panels). Omitted fields stay unchanged; explicit null clears a field.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("events", "/api/session/:sessionID/event", {
      params: { sessionID: Session.ID },
      query: Schema.Struct({
        after: Schema.NumberFromString.pipe(Schema.decodeTo(Event.Cursor), Schema.optional),
      }).annotate({ identifier: "SessionEventsQuery" }),
      success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/event-stream" })),
      error: [ForbiddenError, SessionNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "session.events",
        summary: "Stream session events",
        description: "Replay durable session events after the optional cursor, then stream new session events.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("prompt", "/api/session/:sessionID/prompt", {
      params: { sessionID: Session.ID },
      payload: Schema.Struct({
        id: SessionMessage.ID.pipe(Schema.optional),
        prompt: Prompt,
        delivery: SessionInput.Delivery.pipe(Schema.optional),
        resume: Schema.Boolean.pipe(Schema.optional),
      }),
      success: Schema.Struct({ data: SessionInput.Admitted }),
      error: [ConflictError, ForbiddenError, SessionNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "session.prompt",
        summary: "Send session prompt",
        description: "Durably admit one session input and schedule agent-loop execution unless resume is false.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("context", "/api/session/:sessionID/context", {
      params: { sessionID: Session.ID },
      success: Schema.Struct({ data: Schema.Array(SessionMessage.PublicMessage) }),
      error: [ForbiddenError, SessionNotFoundError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "session.context",
        summary: "Get session context",
        description: "Retrieve the active context messages for a session (all messages after the last compaction).",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "sessions",
      description: "Canonical session routes.",
    }),
  )
  .middleware(GTEAuthorization)
