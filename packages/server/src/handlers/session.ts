import { Session } from "@gte-agent/core/session"
import { SessionMessage } from "@gte-agent/core/session/message"
import { DateTime, Effect, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { GTEAgentApi } from "../api"
import { SessionsCursor } from "../groups/session"
import { Agent } from "@gte-agent/core/agent"
import { Model } from "@gte-agent/core/model"
import { Provider } from "@gte-agent/core/provider"
import { Event } from "@gte-agent/core/event"
import {
  ConflictError,
  ForbiddenError,
  InvalidCursorError,
  InvalidRequestError,
  SessionNotFoundError,
  UnknownError,
} from "../errors"

const DefaultSessionsLimit = 50

const notFound = (sessionID: Session.ID) =>
  new SessionNotFoundError({
    sessionID,
    message: `Session not found: ${sessionID}`,
  })

const forbidden = (message: string) => new ForbiddenError({ message })

function eventData(input: unknown, id?: string): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id,
    data: JSON.stringify(input),
  }
}

export const sessionHandlers = HttpApiBuilder.group(GTEAgentApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service

    return handlers
      .handle(
        "create",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .create({
                id: ctx.payload.id,
                runtimeScope: ctx.payload.runtimeScope,
                authorityID: ctx.payload.authorityID,
                agent: ctx.payload.agent ? Agent.ID.make(ctx.payload.agent) : undefined,
                model: ctx.payload.model
                  ? Model.Ref.make({
                      id: Model.ID.make(ctx.payload.model.id),
                      providerID: Provider.ID.make(ctx.payload.model.providerID),
                      variant: ctx.payload.model.variant ? Model.VariantID.make(ctx.payload.model.variant) : undefined,
                    })
                  : undefined,
              })
              .pipe(
                Effect.catchTag("GTEAuth.AuthorityRequiredError", (error) =>
                  Effect.fail(new InvalidRequestError({ message: error.message, field: "authorityID" })),
                ),
                Effect.catchTag("GTEAuth.MutationDeniedError", (error) =>
                  Effect.fail(forbidden(`Principal ${error.principalID} cannot act for authority ${error.authorityID}`)),
                ),
                Effect.catchTag("GTEAuth.AuthorityConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Session ${error.sessionID} is already bound to a different principal or authority`,
                      resource: error.sessionID,
                    }),
                  ),
                ),
              ),
          }
        }),
      )
      .handle(
        "sessions",
        Effect.fn(function* (ctx) {
          const query =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : ctx.query
          const sessions = yield* session.list({
            ...query,
            limit: ctx.query.limit ?? DefaultSessionsLimit,
          })
          const first = sessions[0]
          const last = sessions.at(-1)
          return {
            data: sessions,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: DateTime.toEpochMillis(first.time.created),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: DateTime.toEpochMillis(last.time.created),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handleRaw(
        "events",
        Effect.fn("session.events")(function* (ctx: {
          params: { sessionID: Session.ID }
          query: { after?: Event.Cursor }
        }) {
          const status = yield* session.get(ctx.params.sessionID).pipe(
            Effect.as(200),
            Effect.catchTag("Session.NotFoundError", () => Effect.succeed(404)),
            Effect.catchTag("GTEAuth.ReadDeniedError", () => Effect.succeed(403)),
          )
          if (status !== 200) return HttpServerResponse.empty({ status })

          return HttpServerResponse.stream(
            session.events({ sessionID: ctx.params.sessionID, after: ctx.query.after }).pipe(
              Stream.map((event) => eventData(event, String(event.cursor))),
              Stream.pipeThroughChannel(Sse.encode()),
              Stream.encodeText,
            ),
            {
              contentType: "text/event-stream",
              headers: {
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "X-Content-Type-Options": "nosniff",
              },
            },
          )
        }),
      )
      .handle(
        "prompt",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                prompt: ctx.payload.prompt,
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(notFound(error.sessionID)),
                ),
                Effect.catchTag("GTEAuth.ReadDeniedError", (error) =>
                  Effect.fail(forbidden(`Principal ${error.principalID} cannot read authority ${error.authorityID}`)),
                ),
                Effect.catchTag("GTEAuth.MutationDeniedError", (error) =>
                  Effect.fail(forbidden(`Principal ${error.principalID} cannot act for authority ${error.authorityID}`)),
                ),
                Effect.catchTag("Session.PromptConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                      resource: error.messageID,
                    }),
                  ),
                ),
              ),
          }
        }),
      )
      .handle(
        "context",
        Effect.fn(function* (ctx) {
          return {
            data: (yield* session.context(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(notFound(error.sessionID))),
              Effect.catchTag("GTEAuth.ReadDeniedError", (error) =>
                Effect.fail(forbidden(`Principal ${error.principalID} cannot read authority ${error.authorityID}`)),
              ),
              Effect.catchTag("Session.MessageDecodeError", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({
                        message: "Unexpected server error. Check server logs for details.",
                        ref,
                      }),
                    ),
                  ),
                )
              }),
            )).filter(SessionMessage.isPublicMessage),
          }
        }),
      )
  }),
)
