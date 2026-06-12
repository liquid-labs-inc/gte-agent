/**
 * Live-phase composition for GET /api/session/:sessionID/event.
 *
 * The durable phase (replay + live durable events with cursors) comes from
 * `Session.events`, which only ever emits committed aggregate events. This
 * module merges in session-scoped EPHEMERAL events for the live phase only:
 * panel events (`session.panel.updated` / `session.panel.status`) and the
 * workflow run snapshot (`session.workflow.updated`):
 *
 * - Local events carry NO cursor, so clients cannot resume from them and the
 *   `?after` replay semantics of the durable aggregate are untouched.
 * - The merge is allowlisted to those ephemeral event definitions rather than
 *   every local event type, so existing durable-only consumers see no new types
 *   unless panels or workflows are actually active.
 *
 * It also binds panel-subscription lifecycle to SSE presence: the panel
 * manager attaches when the stream starts (first consumer activates the
 * session's pinned panels from durable intent) and detaches when the stream
 * ends (TUI exit / session close cleans up automatically).
 */
import { Event } from "@gte-agent/core/event"
import { GtePanelEvent } from "@gte-agent/core/gte-data/panel-event"
import type { GtePanelManager } from "@gte-agent/core/gte-data/panel-manager"
import type { Session } from "@gte-agent/core/session"
import type { SessionEvent } from "@gte-agent/core/session/event"
import { WorkflowEvent } from "@gte-agent/core/workflow/event"
import { WorkflowSchema } from "@gte-agent/core/workflow/schema"
import { Effect, Schema, Stream } from "effect"

export type Envelope = {
  /** Durable aggregate cursor; absent for ephemeral (local) events. */
  readonly cursor?: number
  readonly event: unknown
}

export type Deps = {
  readonly events: Pick<Event.Interface, "subscribe">
  readonly panels: Pick<GtePanelManager.Interface, "attach" | "detach">
}

export function liveSessionEvents<E, R>(
  deps: Deps,
  input: {
    readonly sessionID: Session.ID
    readonly durable: Stream.Stream<Event.CursorEvent<SessionEvent.DurableEvent>, E, R>
  },
): Stream.Stream<Envelope, E, R> {
  const durable = input.durable.pipe(
    Stream.map((item): Envelope => ({ cursor: item.cursor, event: item.event })),
  )
  // The subscription delivers a DECODED snapshot: RunInfo's time fields are
  // DateTime objects, which raw JSON.stringify would render as ISO strings and
  // the TUI's elapsed() reads as NaN. Encode the run back through RunInfo so the
  // wire carries epoch millis, matching the HTTP routes (which encode through
  // their success schema) and the TUI's millis contract. Panel events carry no
  // DateTime fields, so they pass through unencoded.
  const encodeRun = Schema.encodeSync(WorkflowSchema.RunInfo)
  const workflow = deps.events
    .subscribe(WorkflowEvent.Updated)
    .pipe(Stream.map((payload) => ({ ...payload, data: { ...payload.data, run: encodeRun(payload.data.run) } })))
  const local = Stream.merge(
    Stream.merge(deps.events.subscribe(GtePanelEvent.Updated), deps.events.subscribe(GtePanelEvent.Status)),
    workflow,
  ).pipe(
    Stream.filter((payload) => payload.data.sessionID === input.sessionID),
    Stream.map((payload): Envelope => ({ event: payload })),
  )
  const merged = Stream.merge(durable, local)
  // Presence refcount scoped to the stream: attach on start, detach on end.
  return Stream.unwrap(
    Effect.acquireRelease(deps.panels.attach(input.sessionID), () => deps.panels.detach(input.sessionID)).pipe(
      Effect.as(merged),
    ),
  )
}
