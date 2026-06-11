import { Session } from "@gte-agent/core/session"
import { SessionEvent } from "@gte-agent/core/session/event"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ForbiddenError, InvalidRequestError, SessionNotFoundError } from "../errors"
import { GTEAuthorization } from "../middleware/authorization"

/**
 * Transcript snapshot route. Slash commands (and other one-shot read
 * surfaces) record a COMPACT durable `session.snapshot.recorded` event here
 * after fetching data from /api/gte/*. Continuous panel updates never call
 * this route. The summary is schema-bounded (at most
 * `SessionEvent.MAX_SNAPSHOT_ROWS` rows) and additionally size-capped by the
 * handler.
 */
export const SessionSnapshotGroup = HttpApiGroup.make("sessionSnapshot")
  .add(
    HttpApiEndpoint.post("record", "/api/session/:sessionID/snapshot", {
      params: { sessionID: Session.ID },
      payload: Schema.Struct({
        command: Schema.String.annotate({
          description: 'Command or surface that produced the snapshot, e.g. "/book".',
        }),
        panel: Session.PanelType.pipe(Schema.optional),
        key: Schema.String.pipe(Schema.optional),
        summary: SessionEvent.SnapshotSummary,
        provenance: SessionEvent.SnapshotProvenance,
      }).annotate({ identifier: "SessionSnapshotRecordRequest" }),
      success: Schema.Struct({
        data: Schema.Struct({
          sessionID: Session.ID,
          command: Schema.String,
          panel: Session.PanelType.pipe(Schema.optional),
          key: Schema.String.pipe(Schema.optional),
          seq: Schema.Number.pipe(Schema.optional),
        }),
      }).annotate({ identifier: "SessionSnapshotRecordResponse" }),
      error: [ForbiddenError, SessionNotFoundError, InvalidRequestError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "session.snapshot.record",
        summary: "Record a transcript data snapshot",
        description:
          "Durably record a compact one-shot read-only data snapshot (with provenance) into the session transcript. Ownership-checked like the intent route.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "session-snapshots",
      description: "Compact transcript snapshots of read-only GTE data.",
    }),
  )
  .middleware(GTEAuthorization)
