/**
 * Route coverage for POST /api/session/:sessionID/snapshot — compact durable
 * transcript snapshots of read-only GTE data.
 *
 * Ownership denial (read-only / no-read principals) is covered at the core
 * service level in packages/core/test/session-snapshot.test.ts, because the
 * server stub auth runs in dev (auth-disabled) mode.
 */
import "./setup"
import { describe } from "bun:test"
import { check, exercise, http, record } from "./dsl"

const SUMMARY = {
  title: "ETH-USD order book",
  fields: { mid: "2000.5", spread: "0.1" },
  rows: [
    { side: "bid", price: "2000.4", size: "3" },
    { side: "ask", price: "2000.6", size: "2" },
  ],
}

const PROVENANCE = {
  env: "hyperliquid-dev",
  source: "http",
  timestamp: "2026-06-11T00:00:00.000Z",
  symbol: "ETH-USD",
}

const body = (overrides: Record<string, unknown> = {}) => ({
  command: "/book",
  panel: "book",
  key: "ETH-USD",
  summary: SUMMARY,
  provenance: PROVENANCE,
  ...overrides,
})

describe("session.snapshot", () => {
  exercise([
    http
      .post("/api/session/:sessionID/snapshot", "records a compact snapshot and returns its durable sequence")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({ path: `/api/session/${String(state.id)}/snapshot`, body: body() }))
      .json(200, (responseBody, { state }) => {
        const data = record(record(responseBody, "snapshot response").data, "snapshot data")
        check(data.sessionID === state.id, "response should echo the session")
        check(data.command === "/book", "response should echo the command")
        check(data.panel === "book" && data.key === "ETH-USD", "response should echo panel and key")
        check(typeof data.seq === "number" && data.seq > 0, `snapshot should commit durably: ${JSON.stringify(data)}`)
      }),
    http
      .post("/api/session/:sessionID/snapshot", "persists the snapshot durably so SSE replay carries it with a cursor")
      .seeded(async (api) => {
        const session = await api.createSession()
        const result = await api.call({
          method: "POST",
          path: `/api/session/${String(session.id)}/snapshot`,
          body: body({ command: "/markets", panel: undefined, key: undefined }),
        })
        check(result.status === 200, `seed snapshot failed: ${result.status} ${result.text}`)
        return session
      })
      .at(({ state }) => ({ method: "GET", path: `/api/session/${String(state.id)}/event` }))
      .timeout(30_000)
      .sse(
        {
          until: (events) =>
            events.some((event) => record(record(event.data, "sse data").event, "event").type === "session.snapshot.recorded"),
          timeoutMs: 15_000,
        },
        (outcome) => {
          const frame = outcome.events.find(
            (event) => record(record(event.data, "sse data").event, "event").type === "session.snapshot.recorded",
          )!
          const envelope = record(frame.data, "sse data")
          check(typeof envelope.cursor === "number", "durable snapshot replay must carry a cursor")
          check(frame.id === String(envelope.cursor), "SSE id should mirror the durable cursor")
          const data = record(record(envelope.event, "event").data, "event data")
          check(data.command === "/markets", "replayed snapshot should keep its command")
          const summary = record(data.summary, "summary")
          check(Array.isArray(summary.rows) && summary.rows.length === 2, "replayed snapshot should keep compact rows")
          const provenance = record(data.provenance, "provenance")
          check(provenance.env === "hyperliquid-dev" && provenance.source === "http", "provenance must replay intact")
        },
      ),
    http
      .post("/api/session/:sessionID/snapshot", "rejects summaries with more than 10 rows (schema cap)")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({
        path: `/api/session/${String(state.id)}/snapshot`,
        body: body({
          summary: { rows: Array.from({ length: 11 }, (_, index) => ({ index })) },
        }),
      }))
      .status(400),
    http
      .post("/api/session/:sessionID/snapshot", "rejects oversized summaries (byte cap)")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({
        path: `/api/session/${String(state.id)}/snapshot`,
        body: body({ summary: { note: "x".repeat(9_000) } }),
      }))
      .json(400, (responseBody) => {
        const error = record(responseBody, "error body")
        check(error._tag === "InvalidRequestError", `expected InvalidRequestError: ${JSON.stringify(error)}`)
        check(error.kind === "snapshotTooLarge", `expected snapshotTooLarge kind: ${JSON.stringify(error)}`)
      }),
    http
      .post("/api/session/:sessionID/snapshot", "returns SessionNotFoundError for a missing session")
      .at(() => ({ path: "/api/session/ses_snapshot_missing/snapshot", body: body() }))
      .json(404, (responseBody) => {
        const error = record(responseBody, "error body")
        check(error._tag === "SessionNotFoundError", `expected SessionNotFoundError: ${JSON.stringify(error)}`)
      }),
  ])
})
