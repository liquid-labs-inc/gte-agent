import { SessionSnapshot } from "@gte-agent/core/session/snapshot"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { GTEAgentApi } from "../api"
import { ForbiddenError, InvalidRequestError, SessionNotFoundError } from "../errors"

/**
 * Belt-and-braces size cap for one snapshot summary, on top of the
 * schema-level row cap. Keeps the durable transcript compact even when a
 * caller stuffs long strings into the bounded structure.
 */
export const MAX_SNAPSHOT_SUMMARY_BYTES = 8_192

export const sessionSnapshotHandlers = HttpApiBuilder.group(GTEAgentApi, "sessionSnapshot", (handlers) =>
  Effect.gen(function* () {
    const snapshots = yield* SessionSnapshot.Service

    return handlers.handle(
      "record",
      Effect.fn(function* (ctx) {
        const size = JSON.stringify(ctx.payload.summary).length
        if (size > MAX_SNAPSHOT_SUMMARY_BYTES) {
          return yield* Effect.fail(
            new InvalidRequestError({
              message: `Snapshot summary too large: ${size} bytes (max ${MAX_SNAPSHOT_SUMMARY_BYTES}). Trim rows/fields before recording.`,
              field: "summary",
              kind: "snapshotTooLarge",
            }),
          )
        }
        return {
          data: yield* snapshots
            .record({
              sessionID: ctx.params.sessionID,
              command: ctx.payload.command,
              panel: ctx.payload.panel,
              key: ctx.payload.key,
              summary: ctx.payload.summary,
              provenance: ctx.payload.provenance,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("GTEAuth.ReadDeniedError", (error) =>
                Effect.fail(
                  new ForbiddenError({
                    message: `Principal ${error.principalID} cannot read authority ${error.authorityID}`,
                  }),
                ),
              ),
              Effect.catchTag("GTEAuth.MutationDeniedError", (error) =>
                Effect.fail(
                  new ForbiddenError({
                    message: `Principal ${error.principalID} cannot act for authority ${error.authorityID}`,
                  }),
                ),
              ),
            ),
        }
      }),
    )
  }),
)
