export * as GtePanelEvent from "./panel-event"

import { Schema } from "effect"
import { Event } from "../event"
import { SessionSchema } from "../session/schema"
import { Env } from "./schema"

/**
 * Ephemeral (local, never persisted) panel events published by the panel
 * manager and consumed live by the TUI over the session SSE channel.
 *
 * Both definitions intentionally omit `sync`: raw stream data must never be
 * written to the durable event log or the transcript. They carry no cursor on
 * the wire and do not participate in `?after` replay.
 */

/** Provenance for a live stream update (`source: "ws"`). */
export const StreamProvenance = Schema.Struct({
  env: Env,
  source: Schema.Literal("ws"),
  timestamp: Schema.String,
  symbol: Schema.String.pipe(Schema.optional),
  address: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "GtePanel.StreamProvenance" })
export type StreamProvenance = typeof StreamProvenance.Type

export const Updated = Event.define({
  type: "session.panel.updated",
  schema: {
    sessionID: SessionSchema.ID,
    panel: SessionSchema.PanelType,
    key: Schema.String,
    /** Latest (throttled) stream payload for the panel. */
    data: Schema.Unknown,
    provenance: StreamProvenance,
  },
})
export type Updated = typeof Updated.Type

export const PANEL_STATUSES = ["live", "degraded", "closed"] as const
export const PanelStatus = Schema.Literals(PANEL_STATUSES)
export type PanelStatus = typeof PanelStatus.Type

export const Status = Event.define({
  type: "session.panel.status",
  schema: {
    sessionID: SessionSchema.ID,
    panel: SessionSchema.PanelType,
    key: Schema.String,
    /**
     * live      stream subscription established
     * degraded  stream failed/unavailable; the TUI falls back to HTTP snapshot polling
     * closed    panel unpinned; subscription cleaned up
     */
    status: PanelStatus,
    reason: Schema.String.pipe(Schema.optional),
  },
})
export type Status = typeof Status.Type
