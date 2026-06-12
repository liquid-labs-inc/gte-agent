export * as WorkflowEvent from "./event"

import { Event } from "../event"
import { SessionSchema } from "../session/schema"
import { WorkflowSchema } from "./schema"

/**
 * Ephemeral (local, never persisted) full-run snapshot published by the
 * workflow runtime and consumed live by the TUI over the session SSE channel.
 * Snapshot rather than delta so consumers replace state wholesale;
 * high-frequency transitions coalesce on a short tick. The durable audit
 * trail is `SessionEvent.Workflow` (started/finished) plus the persisted
 * script on disk.
 *
 * The definition intentionally omits `sync`: run progress must never be
 * written to the durable event log or the transcript. It carries no cursor on
 * the wire and does not participate in `?after` replay.
 */
export const Updated = Event.define({
  type: "session.workflow.updated",
  schema: {
    sessionID: SessionSchema.ID,
    run: WorkflowSchema.RunInfo,
  },
})
export type Updated = typeof Updated.Type
