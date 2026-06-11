/**
 * SSE coverage for GET /api/session/:sessionID/event — replay + live durable
 * session events with the deterministic demo runner.
 */
import "./setup"
import { describe } from "bun:test"
import { check, exercise, http, record, sseCursor, sseEventTypes } from "./dsl"
import type { SseEvent } from "./harness"

const STEP_ENDED = "session.next.step.ended"
const DEMO_LIFECYCLE = [
  "session.created",
  "session.next.prompt.admitted",
  "session.next.prompt.promoted",
  "session.next.step.started",
  "session.next.text.started",
  "session.next.text.ended",
  STEP_ENDED,
]

const untilStepEnded = (events: SseEvent[]) =>
  events.some((event) => {
    const data = event.data
    if (typeof data !== "object" || data === null || Array.isArray(data)) return false
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- guarded above; parsed JSON objects are string-keyed records
    const payload = (data as Record<string, unknown>).event
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- guarded above; parsed JSON objects are string-keyed records
    return (payload as Record<string, unknown>).type === STEP_ENDED
  })

describe("session.events", () => {
  exercise([
    http
      .get("/api/session/:sessionID/event", "replays session.created as an SSE stream")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({ path: `/api/session/${String(state.id)}/event` }))
      .timeout(30_000)
      .sse({ until: (events) => events.length >= 1, timeoutMs: 15_000 }, (outcome, { state }) => {
        const first = record(outcome.events[0].data, "first event")
        check(Number(first.cursor) === 0, `replay should start at cursor 0: ${JSON.stringify(first)}`)
        const event = record(first.event, "event payload")
        check(event.type === "session.created", `first event should be session.created: ${String(event.type)}`)
        check(record(event.data, "event data").sessionID === state.id, "event should belong to the session")
        check(outcome.events[0].id === "0", "SSE id should mirror the durable cursor")
      }),
    http
      .get("/api/session/:sessionID/event", "streams the full deterministic demo prompt lifecycle")
      .seeded(async (api) => {
        const session = await api.createSession()
        await api.prompt(String(session.id))
        return session
      })
      .at(({ state }) => ({ path: `/api/session/${String(state.id)}/event` }))
      .timeout(45_000)
      .sse({ until: untilStepEnded, timeoutMs: 30_000 }, (outcome) => {
        const types = sseEventTypes(outcome.events)
        for (const expected of DEMO_LIFECYCLE) {
          check(types.includes(expected), `stream should contain ${expected}; saw ${JSON.stringify(types)}`)
        }
        const cursors = outcome.events.map(sseCursor)
        check(
          cursors.every((cursor, index) => index === 0 || cursor > cursors[index - 1]),
          `cursors should be strictly increasing: ${JSON.stringify(cursors)}`,
        )
        check(cursors[0] === 0, "replay should start from the beginning without an after cursor")
      }),
    http
      .get("/api/session/:sessionID/event", "replays only events after the ?after cursor")
      .seeded((api) => api.roundTrip())
      .at(({ state }) => ({ path: `/api/session/${String(state.session.id)}/event?after=0` }))
      .timeout(45_000)
      .sse({ until: untilStepEnded, timeoutMs: 30_000 }, (outcome) => {
        const types = sseEventTypes(outcome.events)
        check(!types.includes("session.created"), `after=0 should skip the cursor-0 event: ${JSON.stringify(types)}`)
        check(types.includes(STEP_ENDED), "replay should still include later durable events")
        const cursors = outcome.events.map(sseCursor)
        check(cursors.every((cursor) => cursor > 0), `all cursors should be greater than 0: ${JSON.stringify(cursors)}`)
      }),
    http
      .get("/api/session/:sessionID/event", "returns 404 for a missing session")
      .at(() => ({ path: "/api/session/ses_httpapi_missing/event" }))
      .status(404),
    http
      .get("/api/session/:sessionID/event", "rejects a negative after cursor")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({ path: `/api/session/${String(state.id)}/event?after=-1` }))
      .json(400, (body) => {
        check(record(body)._tag === "InvalidRequestError", `expected InvalidRequestError, got ${JSON.stringify(body)}`)
      }),
  ])
})
