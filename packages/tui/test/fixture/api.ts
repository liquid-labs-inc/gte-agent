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
import type { WorkflowControlAction } from "../../src/api/workflows"
import type { RunSnapshot } from "../../src/state/workflows"

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

const noTokens = { input: 0, output: 0, reasoning: 0 }

/** Build a workflow run snapshot for the mock registry and SSE envelopes. */
export function makeRun(input: Partial<RunSnapshot> & { id: string }): RunSnapshot {
  return {
    sessionID: "ses_alpha",
    name: input.name ?? input.id,
    status: "running",
    scriptPath: `/tmp/workflow-runs/${input.id}.mjs`,
    tokens: noTokens,
    time: { started: 1_000 },
    phases: [],
    agents: [],
    logs: [],
    ...input,
  }
}

/** Wrap a run snapshot as a `session.workflow.updated` SSE envelope (ephemeral, no cursor). */
export function workflowEnvelope(sessionID: string, run: RunSnapshot): SessionEventEnvelope {
  return { event: { id: `evt_wf_${run.id}`, type: "session.workflow.updated", data: { sessionID, run } } }
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

export type MockProvider = {
  id: string
  name: string
  authed: boolean
  method?: "api_key" | "oauth"
  source?: "config" | "store" | "env"
  models: { id: string; name: string; variants?: string[] }[]
}

const defaultProviders = (): MockProvider[] => [
  {
    id: "anthropic",
    name: "Anthropic",
    authed: true,
    method: "api_key",
    source: "env",
    models: [
      { id: "claude-fable-5", name: "Claude Fable 5", variants: ["low", "medium", "high", "xhigh", "max"] },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", variants: ["high", "max"] },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    authed: false,
    models: [
      { id: "gpt-5.5", name: "GPT-5.5" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
    ],
  },
]

export function createMockApi(input?: {
  sessions?: SessionInfo[]
  messages?: Record<string, SessionPublicMessage[]>
  /** Known market symbols for /api/gte/resolve-symbol (exact or uppercase match resolves). */
  markets?: string[]
  /** Curated catalog served by /api/models (mutable: auth routes flip authed). */
  providers?: MockProvider[]
  /** Persisted global default model returned by /api/models. */
  defaultModel?: { id: string; providerID: string }
  /** Localhost callback listener state reported by oauth/start (default: listening on 1455). */
  oauthListening?: boolean
  /** Seed workflow run snapshots served by /api/session/:id/workflow, keyed by session id. */
  workflows?: Record<string, RunSnapshot[]>
  /** Kill switch: workflow routes answer with the typed disabled error. */
  workflowsDisabled?: boolean
}) {
  const sessions = input?.sessions ?? []
  const messages = input?.messages ?? {}
  const markets = input?.markets ?? ["ETH-USD", "BTC-USD"]
  const providers = input?.providers ?? defaultProviders()
  let defaultModel = input?.defaultModel
  const sessionModels = new Map<string, { id: string; providerID: string; variant?: string }>()
  const selections: { providerID: string; modelID: string; variant?: string; sessionID?: string }[] = []
  const apiKeys: { provider: string; key: string; type?: string }[] = []
  const oauthStarts: { provider: string; flow: string }[] = []
  const oauthCompletions: { provider: string; flow: string; redirect?: string }[] = []
  // Completes without a redirect block (mirroring the server's callback wait)
  // until the test resolves them via completeOauth/failOauth.
  const pendingOauth = new Map<string, (outcome: "callback" | "timeout") => void>()
  let flowCounter = 0
  let modelsRequests = 0
  const prompts: { sessionID: string; text: string }[] = []
  const intents = new Map<string, IntentState>()
  const intentPatches: { sessionID: string; patch: Record<string, unknown> }[] = []
  const snapshots: { sessionID: string; body: Record<string, unknown> }[] = []
  const gteRequests: string[] = []
  const streams = new Map<string, SseHandle[]>()
  // Run registry keyed by session id; control mutates these and re-emits a snapshot.
  const workflows = new Map(Object.entries(input?.workflows ?? {}).map(([id, runs]) => [id, [...runs]]))
  const controls: { sessionID: string; runID: string; action: WorkflowControlAction; agentID?: string }[] = []
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

    // --- Model catalog + provider auth routes (M7) ---
    const modelsAuth = (provider: MockProvider) =>
      provider.authed
        ? { authenticated: true, method: provider.method ?? "api_key", source: provider.source ?? "store" }
        : { authenticated: false }
    const providerAuthState = (provider: MockProvider) => ({
      provider: provider.id,
      method: provider.authed ? (provider.method ?? "api_key") : ("none" as const),
      authed: provider.authed,
      accountId: false,
    })

    if (url.pathname === "/api/models" && target.method === "GET") {
      modelsRequests++
      const sessionID = url.searchParams.get("sessionID")
      return json({
        data: {
          providers: providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            auth: modelsAuth(provider),
            models: provider.models.map((model) => ({
              id: model.id,
              name: model.name,
              status: "active",
              released: 1735689600000,
              capabilities: { tools: true },
              limit: { context: 200000, output: 64000 },
              isDefault:
                defaultModel !== undefined && defaultModel.providerID === provider.id && defaultModel.id === model.id,
              ...(model.variants === undefined ? {} : { variants: model.variants }),
            })),
          })),
          default: defaultModel,
          session: sessionID === null ? undefined : { id: sessionID, model: sessionModels.get(sessionID) },
        },
      })
    }

    if (url.pathname === "/api/models/select" && target.method === "POST") {
      const body = (await target.json()) as {
        providerID: string
        modelID: string
        variant?: string
        sessionID?: string
      }
      const provider = providers.find((candidate) => candidate.id === body.providerID)
      if (provider === undefined) {
        return json(
          { _tag: "ProviderNotFoundError", message: `Unknown LLM provider: ${body.providerID}` },
          { status: 404 },
        )
      }
      const model = provider.models.find((candidate) => candidate.id === body.modelID)
      if (model === undefined) {
        return json(
          { _tag: "ModelNotFoundError", message: `Unknown model: ${body.providerID}/${body.modelID}` },
          { status: 404 },
        )
      }
      selections.push(body)
      defaultModel = { id: model.id, providerID: provider.id }
      const selected = { ...defaultModel, ...(body.variant === undefined ? {} : { variant: body.variant }) }
      if (body.sessionID !== undefined) {
        sessionModels.set(body.sessionID, selected)
        // Mirror the server: the durable switch event flows over the SSE stream.
        const seq = ++eventCursor
        emitTo(body.sessionID, {
          cursor: seq,
          event: {
            id: `evt_model_${seq}`,
            type: "session.next.model.switched",
            data: { sessionID: body.sessionID, messageID: `msg_model_${seq}`, model: selected },
          },
        })
      }
      return json({ data: { model: selected, name: model.name, auth: modelsAuth(provider) } })
    }

    if (parts[0] === "api" && parts[1] === "auth") {
      if (url.pathname === "/api/auth/status") return json({ data: providers.map(providerAuthState) })
      const provider = providers.find((candidate) => candidate.id === parts[2])
      if (provider === undefined) {
        return json({ _tag: "ProviderNotFoundError", message: `Unknown LLM provider: ${parts[2]}` }, { status: 404 })
      }
      if (parts[3] === "api-key" && target.method === "POST") {
        const body = (await target.json()) as { key: string; type?: string }
        apiKeys.push({ provider: provider.id, key: body.key, type: body.type })
        provider.authed = true
        provider.method = body.type === "setup_token" || body.key.startsWith("sk-ant-oat") ? "oauth" : "api_key"
        provider.source = "store"
        return json({ data: providerAuthState(provider) })
      }
      if (parts[3] === "oauth" && parts[4] === "start" && target.method === "POST") {
        const flow = `flow_${++flowCounter}`
        oauthStarts.push({ provider: provider.id, flow })
        const listening = input?.oauthListening ?? true
        return json({
          data: {
            flow,
            url: `https://auth.openai.com/oauth/authorize?client=mock&state=${flow}`,
            callback: { listening, ...(listening ? { port: 1455 } : {}) },
          },
        })
      }
      if (parts[3] === "oauth" && parts[4] === "complete" && target.method === "POST") {
        const body = (await target.json()) as { flow: string; redirect?: string }
        oauthCompletions.push({ provider: provider.id, flow: body.flow, redirect: body.redirect })
        const succeed = () => {
          provider.authed = true
          provider.method = "oauth"
          provider.source = "store"
          return json({ data: providerAuthState(provider) })
        }
        if (body.redirect !== undefined) return succeed()
        return new Promise<Response>((resolve) => {
          pendingOauth.set(body.flow, (outcome) => {
            pendingOauth.delete(body.flow)
            if (outcome === "callback") return resolve(succeed())
            resolve(
              json(
                { _tag: "ServiceUnavailableError", message: "Timed out waiting for the browser callback" },
                { status: 503 },
              ),
            )
          })
        })
      }
      return json({ _tag: "InvalidRequestError", message: `no mock for ${url.pathname}` }, { status: 400 })
    }

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
        if (exact)
          return json({
            provenance: provenance(),
            data: { outcome: "resolved", symbol: exact, market: { symbol: exact } },
          })
        const hits = markets.filter((symbol) => symbol.toUpperCase().includes(q.toUpperCase()))
        if (hits.length === 1) {
          return json({
            provenance: provenance(),
            data: { outcome: "resolved", symbol: hits[0], market: { symbol: hits[0] } },
          })
        }
        if (hits.length > 1)
          return json({ provenance: provenance(), data: { outcome: "ambiguous", query: q, candidates: hits } })
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

    // --- Workflow snapshot + control routes (M8) ---
    if (parts[0] === "api" && parts[1] === "session" && parts[3] === "workflow") {
      if (input?.workflowsDisabled === true) {
        // Mirror the real server: WorkflowDisabledError (singular) at 404.
        return json(
          { _tag: "WorkflowDisabledError", message: "Workflows are disabled in this environment" },
          { status: 404 },
        )
      }
      const sessionID = parts[2]
      const runs = workflows.get(sessionID) ?? []
      if (parts.length === 4 && target.method === "GET") return json({ data: runs })
      const runID = parts[4]
      const run = runs.find((candidate) => candidate.id === runID)
      if (parts.length === 5 && target.method === "GET") {
        if (run === undefined)
          return json({ _tag: "WorkflowRunNotFoundError", message: `Unknown run: ${runID}` }, { status: 404 })
        return json({ data: run })
      }
      if (parts.length === 6 && parts[5] === "control" && target.method === "POST") {
        const body = (await target.json()) as { action: WorkflowControlAction; agentID?: string }
        controls.push({ sessionID, runID, action: body.action, agentID: body.agentID })
        if (run === undefined)
          return json({ _tag: "WorkflowRunNotFoundError", message: `Unknown run: ${runID}` }, { status: 404 })
        const status = body.action === "pause" ? "paused" : body.action === "resume" ? "running" : "stopped"
        const next: RunSnapshot = { ...run, status }
        workflows.set(
          sessionID,
          runs.map((candidate) => (candidate.id === runID ? next : candidate)),
        )
        // Mirror the runtime: control transitions surface as an ephemeral
        // snapshot over SSE; the HTTP response itself is the applied outcome.
        emitTo(sessionID, {
          event: { id: `evt_wf_${++eventCursor}`, type: "session.workflow.updated", data: { sessionID, run: next } },
        })
        return json({ data: { applied: true } })
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
        const resolve = <T>(next: unknown, existing: T | undefined): T | undefined =>
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
                controller.enqueue(encoder.encode(`event: message\n${id}data: ${JSON.stringify(envelope)}\n\n`))
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
    providers,
    selections,
    apiKeys,
    oauthStarts,
    oauthCompletions,
    sessionModels,
    get defaultModel() {
      return defaultModel
    },
    get modelsRequests() {
      return modelsRequests
    },
    /** Resolve a blocked oauth/complete wait as if the browser callback landed. */
    completeOauth(flow: string) {
      const resolve = pendingOauth.get(flow)
      if (resolve === undefined) throw new Error(`no pending oauth completion for ${flow}`)
      resolve("callback")
    },
    /** Resolve a blocked oauth/complete wait as a timeout (paste fallback path). */
    failOauth(flow: string) {
      const resolve = pendingOauth.get(flow)
      if (resolve === undefined) throw new Error(`no pending oauth completion for ${flow}`)
      resolve("timeout")
    },
    hasPendingOauth(flow: string) {
      return pendingOauth.has(flow)
    },
    emit(sessionID: string, envelope: SessionEventEnvelope) {
      const handles = streams.get(sessionID) ?? []
      if (handles.length === 0) throw new Error(`no event stream subscribed for ${sessionID}`)
      for (const handle of handles) handle.push(envelope)
    },
    hasStream(sessionID: string) {
      return (streams.get(sessionID) ?? []).length > 0
    },
    controls,
    /** Push a live `session.workflow.updated` snapshot (also updates the served registry). */
    emitWorkflow(sessionID: string, run: RunSnapshot) {
      const runs = workflows.get(sessionID) ?? []
      workflows.set(sessionID, [run, ...runs.filter((candidate) => candidate.id !== run.id)])
      this.emit(sessionID, {
        event: { id: `evt_wf_${++eventCursor}`, type: "session.workflow.updated", data: { sessionID, run } },
      })
    },
  }
}
