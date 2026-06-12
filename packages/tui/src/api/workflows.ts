/**
 * Typed raw-fetch wrapper for the Milestone 8 workflow snapshot + control
 * routes. Like the GTE and models clients, this goes straight to the canonical
 * HTTP API through the same fetch function as everything else; the generated
 * SDK predates these routes.
 *
 * Routes (a parallel workstream owns the server side):
 * - GET  /api/session/:sessionID/workflow            list run snapshots
 * - GET  /api/session/:sessionID/workflow/:runID     one run snapshot
 * - POST /api/session/:sessionID/workflow/:runID/control { action, agentID? }
 *
 * Read-shaped except `control`, which pauses/resumes/stops a run (or an agent
 * within it). The kill switch answers these routes with a typed disabled error;
 * `isWorkflowsDisabled` recognizes it so callers can show "workflows are
 * disabled" instead of a generic failure.
 */
import type { RunSnapshot } from "../state/workflows"

export type WorkflowControlAction = "pause" | "resume" | "stop"

export class WorkflowsRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly tag?: string,
  ) {
    super(message)
    this.name = "WorkflowsRequestError"
  }
}

/**
 * True when the error is the kill-switch disabled response. The server tags it
 * (assumed `WorkflowsDisabledError`); a 403/404 carrying "disabled" in the tag
 * or message is also treated as disabled so a tag rename does not silently
 * regress the kill-switch surface.
 */
export function isWorkflowsDisabled(error: unknown): boolean {
  if (!(error instanceof WorkflowsRequestError)) return false
  const tag = error.tag ?? ""
  if (tag === "WorkflowsDisabledError") return true
  return tag.toLowerCase().includes("disabled") || error.message.toLowerCase().includes("workflows are disabled")
}

export interface WorkflowsApi {
  list(sessionID: string): Promise<readonly RunSnapshot[]>
  get(sessionID: string, runID: string): Promise<RunSnapshot>
  control(
    sessionID: string,
    runID: string,
    action: WorkflowControlAction,
    agentID?: string,
  ): Promise<RunSnapshot | undefined>
}

export function createWorkflowsApi(input: { baseUrl: string; fetch: typeof fetch }): WorkflowsApi {
  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await input.fetch(`${input.baseUrl}${path}`, init)
    const text = await response.text()
    let body: unknown
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      body = undefined
    }
    if (!response.ok) {
      const error = (body ?? {}) as { _tag?: string; message?: string }
      const message = typeof error.message === "string" ? error.message : `Request failed: HTTP ${response.status}`
      throw new WorkflowsRequestError(message, response.status, error._tag)
    }
    return body
  }

  const enc = encodeURIComponent

  return {
    async list(sessionID) {
      const result = (await request(`/api/session/${enc(sessionID)}/workflow`)) as { data: readonly RunSnapshot[] }
      return result.data
    },

    async get(sessionID, runID) {
      const result = (await request(`/api/session/${enc(sessionID)}/workflow/${enc(runID)}`)) as { data: RunSnapshot }
      return result.data
    },

    async control(sessionID, runID, action, agentID) {
      const result = (await request(`/api/session/${enc(sessionID)}/workflow/${enc(runID)}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...(agentID === undefined ? {} : { agentID }) }),
      })) as { data?: RunSnapshot } | undefined
      return result?.data
    },
  }
}
