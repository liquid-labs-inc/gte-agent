/**
 * Live-phase composition for GET /api/session/:sessionID/event.
 *
 * The durable phase (replay + live durable events with cursors) comes from
 * `Session.events`, which only ever emits committed aggregate events. This
 * module merges in session-scoped EPHEMERAL panel events
 * (`session.panel.updated` / `session.panel.status`) for the live phase only:
 *
 * - Local events carry NO cursor, so clients cannot resume from them and the
 *   `?after` replay semantics of the durable aggregate are untouched.
 * - The merge is allowlisted to the panel event definitions rather than every
 *   local event type, so existing durable-only consumers see no new types
 *   unless panels are actually active.
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
import { Effect, Stream } from "effect"

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
  const local = Stream.merge(
    deps.events.subscribe(GtePanelEvent.Updated),
    deps.events.subscribe(GtePanelEvent.Status),
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
