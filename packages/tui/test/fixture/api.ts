/**
 * Mock fetch + SSE fixture for TUI component tests.
 *
 * Rewritten for the canonical GTE Agent routes (the quarantined opencode
 * fixture targeted legacy opencode routes). Implements just enough of
 * /api/health, /api/session, /api/session/:id/message,
 * /api/session/:id/prompt and the /api/session/:id/event SSE stream for the
 * app to boot, list sessions, open one, and receive streamed events.
 */
import type { SessionInfo, SessionPublicMessage } from "../../src/api/client"
import type { SessionEventEnvelope } from "../../src/api/events"

export function makeSession(input: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    projectID: "prj_test",
    principalID: "dev_principal",
    authorityID: "dev_authority",
    title: input.title ?? input.id,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
    runtimeScope: { directory: "/tmp/gta-test" },
    ...input,
  }
}

function json(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers)
  headers.set("content-type", "application/json")
  return new Response(JSON.stringify(data), { ...init, headers })
}

type SseHandle = {
  push: (envelope: SessionEventEnvelope) => void
  close: () => void
}

type IntentState = {
  selectedMarket?: string
  trackedAddress?: string
  pinnedPanels: { panel: string; key: string }[]
}

export function createMockApi(input?: {
  sessions?: SessionInfo[]
  messages?: Record<string, SessionPublicMessage[]>
  /** Known market symbols for /api/gte/resolve-symbol (exact or uppercase match resolves). */
  markets?: string[]
}) {
  const sessions = input?.sessions ?? []
  const messages = input?.messages ?? {}
  const markets = input?.markets ?? ["ETH-USD", "BTC-USD"]
  const prompts: { sessionID: string; text: string }[] = []
  const intents = new Map<string, IntentState>()
  const intentPatches: { sessionID: string; patch: Record<string, unknown> }[] = []
  const snapshots: { sessionID: string; body: Record<string, unknown> }[] = []
  const gteRequests: string[] = []
  const streams = new Map<string, SseHandle[]>()
  let counter = 0
  let eventCursor = 100

  const provenance = (extra?: Record<string, unknown>) => ({
    env: "hyperliquid-dev",
    source: "http",
    timestamp: "2026-06-11T00:00:00.000Z",
    ...extra,
  })

  function emitTo(sessionID: string, envelope: SessionEventEnvelope) {
    for (const handle of streams.get(sessionID) ?? []) handle.push(envelope)
  }

  const fetch = (async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = new Request(request instanceof Request ? request : String(request), init)
    const url = new URL(target.url)
    const parts = url.pathname.split("/").filter(Boolean)

    if (url.pathname === "/api/health") return json({ healthy: true })

    // --- Read-only GTE data routes (M5) ---
    if (parts[0] === "api" && parts[1] === "gte") {
      gteRequests.push(url.pathname + url.search)
      if (url.pathname === "/api/gte/env") {
        return json({
          env: "hyperliquid-dev",
          source: "http",
          timestamp: "2026-06-11T00:00:00.000Z",
          validEnvs: ["hyperliquid-dev", "hyperliquid-prod"],
        })
      }
      if (url.pathname === "/api/gte/health") {
        return json({ provenance: provenance(), data: { status: "ok" } })
      }
      if (url.pathname === "/api/gte/markets") {
        return json({ provenance: provenance(), data: markets.map((symbol) => ({ symbol, status: "active" })) })
      }
      if (url.pathname === "/api/gte/resolve-symbol") {
        const q = url.searchParams.get("q") ?? ""
        const exact = markets.find((symbol) => symbol === q || symbol === q.toUpperCase())
        if (exact) return json({ provenance: provenance(), data: { outcome: "resolved", symbol: exact, market: { symbol: exact } } })
        const hits = markets.filter((symbol) => symbol.toUpperCase().includes(q.toUpperCase()))
        if (hits.length === 1) {
          return json({ provenance: provenance(), data: { outcome: "resolved", symbol: hits[0], market: { symbol: hits[0] } } })
        }
        if (hits.length > 1) return json({ provenance: provenance(), data: { outcome: "ambiguous", query: q, candidates: hits } })
        return json({ provenance: provenance(), data: { outcome: "notFound", query: q } })
      }
      if (parts[2] === "market" && parts.length >= 4) {
        const symbol = decodeURIComponent(parts[3])
        const leaf = parts[4] ?? "definition"
        return json({
          provenance: provenance({ symbol }),
          data:
            leaf === "book"
              ? { bids: [{ price: "2000.4", size: "3" }], asks: [{ price: "2000.6", size: "2" }], mid: "2000.5" }
              : { symbol, leaf, value: 1 },
        })
      }
      if (parts[2] === "address" && parts.length >= 5) {
        const address = decodeURIComponent(parts[3])
        const leaf = parts[4]
        return json({ provenance: provenance({ address }), data: [{ leaf, address, amount: "1" }] })
      }
      return json({ _tag: "InvalidRequestError", message: `no mock for ${url.pathname}` }, { status: 400 })
    }

    if (url.pathname === "/api/session" && target.method === "GET") {
      return json({ data: sessions, cursor: {} })
    }

    if (url.pathname === "/api/session" && target.method === "POST") {
      const body = (await target.json()) as { runtimeScope: { directory: string } }
      const session = makeSession({
        id: `ses_created_${++counter}`,
        title: "new session",
        runtimeScope: body.runtimeScope,
      })
      sessions.unshift(session)
      return json({ data: session })
    }

    // /api/session/:sessionID/...
    if (parts[0] === "api" && parts[1] === "session" && parts.length === 4) {
      const sessionID = parts[2]
      const leaf = parts[3]

      if (leaf === "message") {
        return json({ data: messages[sessionID] ?? [], cursor: {} })
      }

      if (leaf === "intent" && target.method === "PATCH") {
        const patch = (await target.json()) as Record<string, unknown>
        intentPatches.push({ sessionID, patch })
        const current = intents.get(sessionID) ?? { pinnedPanels: [] }
        const resolve = <T,>(next: unknown, existing: T | undefined): T | undefined =>
          next === null ? undefined : ((next ?? existing) as T | undefined)
        const next: IntentState = {
          selectedMarket: resolve(patch.selectedMarket, current.selectedMarket),
          trackedAddress: resolve(patch.trackedAddress, current.trackedAddress),
          pinnedPanels: resolve(patch.pinnedPanels, current.pinnedPanels) ?? [],
        }
        intents.set(sessionID, next)
        // Mirror the server: the durable intent event flows over the SSE stream.
        emitTo(sessionID, {
          cursor: ++eventCursor,
          event: {
            id: `evt_intent_${eventCursor}`,
            type: "session.intent.updated",
            data: { sessionID, ...next },
          },
        })
        return json({ data: { ...(sessions.find((session) => String(session.id) === sessionID) ?? {}), ...next } })
      }

      if (leaf === "snapshot" && target.method === "POST") {
        const body = (await target.json()) as Record<string, unknown>
        snapshots.push({ sessionID, body })
        const seq = ++eventCursor
        emitTo(sessionID, {
          cursor: seq,
          event: {
            id: `evt_snapshot_${seq}`,
            type: "session.snapshot.recorded",
            data: { sessionID, ...body },
          },
        })
        return json({ data: { sessionID, command: body.command, panel: body.panel, key: body.key, seq } })
      }

      if (leaf === "prompt") {
        const body = (await target.json()) as { prompt: { text: string } }
        prompts.push({ sessionID, text: body.prompt.text })
        return json({
          data: {
            admittedSeq: prompts.length,
            id: `msg_prompt_${prompts.length}`,
            sessionID,
            prompt: body.prompt,
            delivery: "steer",
            timeCreated: Date.now(),
          },
        })
      }

      if (leaf === "event") {
        let handle: SseHandle
        const encoder = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            handle = {
              push(envelope) {
                const id = envelope.cursor === undefined ? "" : `id: ${envelope.cursor}\n`
                controller.enqueue(
                  encoder.encode(`event: message\n${id}data: ${JSON.stringify(envelope)}\n\n`),
                )
              },
              close() {
                try {
                  controller.close()
                } catch {
                  // already closed
                }
              },
            }
            const handles = streams.get(sessionID) ?? []
            handles.push(handle)
            streams.set(sessionID, handles)
          },
          cancel() {
            const handles = streams.get(sessionID) ?? []
            streams.set(
              sessionID,
              handles.filter((item) => item !== handle),
            )
          },
        })
        target.signal?.addEventListener("abort", () => {
          handle.close()
        })
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      }
    }

    throw new Error(`unexpected request: ${target.method} ${url.pathname}`)
  }) as typeof globalThis.fetch

  return {
    fetch,
    sessions,
    prompts,
    intents,
    intentPatches,
    snapshots,
    gteRequests,
    emit(sessionID: string, envelope: SessionEventEnvelope) {
      const handles = streams.get(sessionID) ?? []
      if (handles.length === 0) throw new Error(`no event stream subscribed for ${sessionID}`)
      for (const handle of handles) handle.push(envelope)
    },
    hasStream(sessionID: string) {
      return (streams.get(sessionID) ?? []).length > 0
    },
  }
}
