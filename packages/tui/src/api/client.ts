/**
 * Thin typed wrapper over the canonical SDK client used by the TUI.
 *
 * All requests go through the provided fetch function, which is either the
 * in-process worker bridge fetch (default) or global fetch against a real
 * listener URL (gta --listen).
 */
import { createGTEAgentClient } from "@gte-agent/sdk/client"
import type { SessionInfo, SessionInputAdmitted, SessionPublicMessage } from "@gte-agent/sdk/client"

export type { SessionInfo, SessionInputAdmitted, SessionPublicMessage }

export interface Api {
  health(): Promise<boolean>
  listSessions(): Promise<SessionInfo[]>
  createSession(input: { directory: string }): Promise<SessionInfo>
  messages(sessionID: string): Promise<SessionPublicMessage[]>
  prompt(sessionID: string, text: string): Promise<SessionInputAdmitted>
}

function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null) {
    const data = error as { message?: unknown; _tag?: unknown }
    if (typeof data.message === "string") {
      return typeof data._tag === "string" ? `${data._tag}: ${data.message}` : data.message
    }
  }
  if (typeof error === "string" && error.length > 0) return error
  return fallback
}

export function createApi(input: { baseUrl: string; fetch: typeof fetch }): Api {
  const client = createGTEAgentClient({ baseUrl: input.baseUrl, fetch: input.fetch })

  return {
    async health() {
      const result = await client.health.get()
      if (result.error !== undefined) throw new Error(describeError(result.error, "Health check failed"))
      return result.data?.healthy ?? false
    },

    async listSessions() {
      const result = await client.session.list({ order: "desc" })
      if (result.error !== undefined) throw new Error(describeError(result.error, "Failed to list sessions"))
      return [...(result.data?.data ?? [])]
    },

    async createSession({ directory }) {
      // No model pinned at create time: sessions inherit the global default
      // from ~/.gte-agent/config.json; without one the runner errors visibly
      // and points at /models (strict, no silent fallback).
      const result = await client.session.create({
        sessionCreateRequest: {
          runtimeScope: { directory },
        },
      })
      if (result.error !== undefined) throw new Error(describeError(result.error, "Failed to create session"))
      if (!result.data?.data) throw new Error("Session create returned no data")
      return result.data.data
    },

    async messages(sessionID) {
      const result = await client.session.messages({ sessionID, order: "asc", limit: "200" })
      if (result.error !== undefined) throw new Error(describeError(result.error, "Failed to load messages"))
      return [...(result.data?.data ?? [])]
    },

    async prompt(sessionID, text) {
      const result = await client.session.prompt({ sessionID, prompt: { text } })
      if (result.error !== undefined) throw new Error(describeError(result.error, "Failed to send prompt"))
      if (!result.data?.data) throw new Error("Prompt returned no data")
      return result.data.data
    },
  }
}
