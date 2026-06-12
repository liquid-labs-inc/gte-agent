/**
 * Route-level coverage for the workflow observation/control routes
 * (list / get / control) with the kill switch ON. The demo runner never calls
 * the workflow tool, so these scenarios cover the routing contract — empty
 * list, not-found, and control validation — not a full run. The disabled-gate
 * scenarios live in ./workflow-disabled.test.ts, and the SSE snapshot bridge is
 * covered in ../live-session-events.test.ts.
 */
import "./setup"
import { describe } from "bun:test"
import { array, check, exercise, http, record } from "./dsl"

const MISSING_RUN = "wfr_httpapi_missing"

describe("session.workflow.list", () => {
  exercise([
    http
      .get("/api/session/:sessionID/workflow", "returns an empty list for a session with no runs")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({ path: `/api/session/${String(state.id)}/workflow` }))
      .json(200, (body) => {
        check(array(record(body, "list response").data, "runs").length === 0, "fresh session should have no runs")
      }),
    http
      .get("/api/session/:sessionID/workflow", "returns SessionNotFoundError for a missing session")
      .at(() => ({ path: "/api/session/ses_httpapi_missing/workflow" }))
      .json(404, (body) => {
        check(record(body)._tag === "SessionNotFoundError", `expected SessionNotFoundError, got ${JSON.stringify(body)}`)
      }),
  ])
})

describe("session.workflow.get", () => {
  exercise([
    http
      .get("/api/session/:sessionID/workflow/:runID", "returns WorkflowRunNotFoundError for an unknown run")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({ path: `/api/session/${String(state.id)}/workflow/${MISSING_RUN}` }))
      .json(404, (body) => {
        const error = record(body)
        check(error._tag === "WorkflowRunNotFoundError", `expected WorkflowRunNotFoundError, got ${JSON.stringify(body)}`)
        check(error.runID === MISSING_RUN, "error should echo the run id")
      }),
    http
      .get("/api/session/:sessionID/workflow/:runID", "rejects a run id without the wfr_ prefix")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({ path: `/api/session/${String(state.id)}/workflow/bogus_run` }))
      .json(400, (body) => {
        check(record(body)._tag === "InvalidRequestError", `expected InvalidRequestError, got ${JSON.stringify(body)}`)
      }),
  ])
})

describe("session.workflow.control", () => {
  exercise([
    http
      .post("/api/session/:sessionID/workflow/:runID/control", "returns WorkflowRunNotFoundError for an unknown run")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({
        path: `/api/session/${String(state.id)}/workflow/${MISSING_RUN}/control`,
        body: { action: "stop" },
      }))
      .json(404, (body) => {
        check(
          record(body)._tag === "WorkflowRunNotFoundError",
          `expected WorkflowRunNotFoundError, got ${JSON.stringify(body)}`,
        )
      }),
    http
      .post("/api/session/:sessionID/workflow/:runID/control", "rejects an unknown control action")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({
        path: `/api/session/${String(state.id)}/workflow/${MISSING_RUN}/control`,
        body: { action: "explode" },
      }))
      .json(400, (body) => {
        check(record(body)._tag === "InvalidRequestError", `expected InvalidRequestError, got ${JSON.stringify(body)}`)
      }),
    http
      .post("/api/session/:sessionID/workflow/:runID/control", "returns SessionNotFoundError for a missing session")
      .at(() => ({ path: `/api/session/ses_httpapi_missing/workflow/${MISSING_RUN}/control`, body: { action: "pause" } }))
      .json(404, (body) => {
        check(record(body)._tag === "SessionNotFoundError", `expected SessionNotFoundError, got ${JSON.stringify(body)}`)
      }),
  ])
})
