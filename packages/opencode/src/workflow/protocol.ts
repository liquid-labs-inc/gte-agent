// Wire protocol between the workflow runtime (host) and the sandboxed Bun
// worker that executes the orchestration script. Messages are structured-clone
// friendly plain objects.

export type AgentRequestOptions = {
  prompt: string
  /** Agent type from the registry; defaults to "general". */
  type?: string
  /** Model override "provider/model" for this agent. */
  model?: string
  /** Reasoning-effort variant for this agent. */
  variant?: string
}

export type AgentResult = {
  text: string
  tokens: { input: number; output: number }
}

export type HostToWorker =
  | { type: "start"; script: string; args: unknown }
  | { type: "agent-result"; id: number; ok: true; value: AgentResult }
  | { type: "agent-result"; id: number; ok: false; error: string }

export type WorkerToHost =
  | { type: "ready" }
  | { type: "phase-start"; name: string }
  | { type: "phase-end"; name: string }
  | { type: "agent"; id: number; phase: string; options: AgentRequestOptions }
  | { type: "log"; message: string }
  | { type: "done"; result: unknown }
  | { type: "error"; message: string; stack?: string }

/** Implicit phase for agents spawned outside any phase() block. */
export const DEFAULT_PHASE = "main"

export * as WorkflowProtocol from "./protocol"
