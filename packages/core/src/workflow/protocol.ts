export * as WorkflowProtocol from "./protocol"

/**
 * Wire protocol between the workflow runtime (host) and the sandboxed Bun
 * worker executing the orchestration script. Messages must stay
 * structured-clone friendly plain objects: the worker has no Effect runtime
 * and no schema machinery, so this is the one intentionally untyped-at-runtime
 * boundary, typed here and validated by behavior on both sides.
 */

export type AgentRequest = {
  prompt: string
  /** Agent type passed through to the child session. */
  type?: string
  /** Model override as "providerID/modelID". */
  model?: string
  /** Reasoning-effort variant for this agent. */
  variant?: string
}

export type AgentResult = {
  text: string
  tokens: { input: number; output: number; reasoning: number }
}

export type HostToWorker =
  | { type: "start"; script: string; args: unknown }
  | { type: "agent-result"; id: number; ok: true; value: AgentResult }
  | { type: "agent-result"; id: number; ok: false; error: string }

export type WorkerToHost =
  | { type: "ready" }
  | { type: "phase-started"; name: string }
  | { type: "phase-ended"; name: string }
  | { type: "agent"; id: number; phase: string; request: AgentRequest }
  | { type: "log"; message: string }
  | { type: "done"; result: unknown }
  | { type: "failed"; reason: string }

/** Implicit phase for agents spawned outside any phase() block. */
export const DEFAULT_PHASE = "main"
