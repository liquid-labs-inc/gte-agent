/**
 * Kill-switch coverage for the workflow routes (plan §6, checklist 13). With
 * `workflows: { enabled: false }` in the server's global config, every workflow
 * route answers with the typed WorkflowDisabledError instead of acting on the
 * run registry. The config file lives in its own test file so the disabling
 * config never bleeds into the enabled-path scenarios; each server build reads
 * it fresh.
 */
import "./setup"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe } from "bun:test"
import { check, exercise, http, record } from "./dsl"

const configFile = path.join(process.env.GTE_AGENT_HOME ?? "", "config", "gte-agent.json")

beforeAll(() => {
  mkdirSync(path.dirname(configFile), { recursive: true })
  writeFileSync(configFile, JSON.stringify({ workflows: { enabled: false } }))
})

afterAll(() => {
  rmSync(configFile, { force: true })
})

const disabled = (body: unknown) =>
  check(record(body)._tag === "WorkflowDisabledError", `expected WorkflowDisabledError, got ${JSON.stringify(body)}`)

describe("workflow routes disabled gate", () => {
  exercise([
    http
      .get("/api/session/:sessionID/workflow", "list answers with the typed disabled error")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({ path: `/api/session/${String(state.id)}/workflow` }))
      .json(404, disabled),
    http
      .get("/api/session/:sessionID/workflow/:runID", "get answers with the typed disabled error")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({ path: `/api/session/${String(state.id)}/workflow/wfr_anything` }))
      .json(404, disabled),
    http
      .post("/api/session/:sessionID/workflow/:runID/control", "control answers with the typed disabled error")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({
        path: `/api/session/${String(state.id)}/workflow/wfr_anything/control`,
        body: { action: "stop" },
      }))
      .json(404, disabled),
  ])
})
