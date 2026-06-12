export * as DynamicToolProtocol from "./protocol"

/**
 * Wire protocol between the dynamic-tool runtime (host) and the sandboxed Bun
 * worker executing one tool invocation. Messages must stay structured-clone
 * friendly plain objects: the worker has no Effect runtime and no schema
 * machinery, so this is the one intentionally untyped-at-runtime boundary,
 * typed here and validated by behavior on both sides (the workflow-protocol
 * precedent).
 */

export type HostToWorker =
  | { type: "start"; code: string; params: unknown }
  | { type: "gte-result"; id: number; ok: true; value: unknown }
  | { type: "gte-result"; id: number; ok: false; error: string }

export type WorkerToHost =
  | { type: "ready" }
  | { type: "gte"; id: number; name: string; params: unknown }
  | { type: "done"; result: unknown }
  | { type: "failed"; reason: string }
