/**
 * Message protocol between the TUI process and the worker that hosts the
 * canonical GTE Agent server.
 *
 * Requests are serialized into structured-cloneable messages. Responses are
 * streamed back chunk by chunk so streaming bodies (most importantly the
 * session SSE event stream) flow through the in-process channel without
 * buffering and without waiting for the response to complete.
 */

/** Virtual origin used for in-process requests. No TCP socket is involved. */
export const VIRTUAL_ORIGIN = "http://gte-agent.internal"

export type BridgeRequestMessage = {
  readonly type: "request"
  readonly id: number
  readonly url: string
  readonly method: string
  readonly headers: ReadonlyArray<readonly [string, string]>
  readonly body: Uint8Array | null
}

export type BridgeAbortMessage = {
  readonly type: "abort"
  readonly id: number
}

export type BridgeListenMessage = {
  readonly type: "listen"
  readonly id: number
  readonly hostname: string
  readonly port: number
}

export type BridgeShutdownMessage = {
  readonly type: "shutdown"
  readonly id: number
}

export type ToWorkerMessage = BridgeRequestMessage | BridgeAbortMessage | BridgeListenMessage | BridgeShutdownMessage

export type WorkerReadyMessage = {
  readonly type: "ready"
}

export type ResponseHeadMessage = {
  readonly type: "response-head"
  readonly id: number
  readonly status: number
  readonly statusText: string
  readonly headers: ReadonlyArray<readonly [string, string]>
}

export type ResponseChunkMessage = {
  readonly type: "response-chunk"
  readonly id: number
  readonly chunk: Uint8Array
}

export type ResponseEndMessage = {
  readonly type: "response-end"
  readonly id: number
}

export type ResponseErrorMessage = {
  readonly type: "response-error"
  readonly id: number
  readonly message: string
}

export type ListenResultMessage = {
  readonly type: "listen-result"
  readonly id: number
  readonly url?: string
  readonly error?: string
}

export type ShutdownResultMessage = {
  readonly type: "shutdown-result"
  readonly id: number
}

export type FromWorkerMessage =
  | WorkerReadyMessage
  | ResponseHeadMessage
  | ResponseChunkMessage
  | ResponseEndMessage
  | ResponseErrorMessage
  | ListenResultMessage
  | ShutdownResultMessage
