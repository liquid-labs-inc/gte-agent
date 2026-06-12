/**
 * Scenario DSL for route-level coverage of the canonical GTE Agent server.
 *
 * Rewritten from the quarantined opencode `httpapi-exercise` pattern: one
 * small scenario per route behavior, with a builder that pairs a request spec
 * with typed seeded state and response assertions. Unlike opencode's harness,
 * every scenario gets a fresh server (and therefore a fresh in-memory
 * database), so there are no `mutating`/reset flags and no cross-scenario
 * ordering hazards.
 *
 * Shape:
 *
 *   http.post("/api/session/:sessionID/prompt", "admits a prompt")
 *     .seeded((api) => api.createSession())
 *     .at(({ state }) => ({ path: `/api/session/${state.id}/prompt`, body: { prompt: { text: "hi" } } }))
 *     .json(200, (body, ctx) => { ... assertions ... })
 *
 * Terminal methods (`status` / `json` / `sse`) produce a `Scenario`; register
 * scenarios with `exercise([...])`.
 */
import "./setup"
import { test } from "bun:test"
import {
  makeServer,
  type CallResult,
  type Method,
  type RequestSpec,
  type Server,
  type ServerOptions,
  type SseEvent,
  type StreamOptions,
  type StreamResult,
} from "./harness"
import { scratchDirectory } from "./setup"

/** Deterministic demo provider/model wired into the canonical server handlers. */
export const DEMO_MODEL = { id: "gte-agent-demo", providerID: "gte-agent-demo" }
/** Exact text emitted by the deterministic demo runner. */
export const DEMO_TEXT = "GTE Agent demo response."

export type Scenario = {
  readonly name: string
  readonly timeout: number
  readonly run: () => Promise<void>
}

export type Ctx<S> = {
  readonly api: Api
  readonly state: S
}

/** Per-scenario API surface: raw calls plus common seeding helpers (all via HTTP). */
export type Api = {
  readonly call: (spec: RequestSpec) => Promise<CallResult>
  readonly stream: (spec: RequestSpec, options?: StreamOptions) => Promise<StreamResult>
  /** POST /api/session with a unique runtime scope and the demo model. Returns the encoded Session.Info. */
  readonly createSession: (input?: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** POST /api/session/:id/prompt. Returns the encoded admitted input. */
  readonly prompt: (sessionID: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** Poll messages until the demo assistant reply is projected and completed. Returns all messages (asc). */
  readonly awaitAssistant: (sessionID: string, options?: { timeoutMs?: number }) => Promise<unknown[]>
  /** createSession + prompt + awaitAssistant: a full deterministic demo round-trip. */
  readonly roundTrip: () => Promise<{ session: Record<string, unknown>; messages: unknown[] }>
}

/** Narrow `value` to a record or fail with a readable message. */
export function record(value: unknown, label = "value"): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object, got: ${JSON.stringify(value)}`)
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- guarded above; parsed JSON objects are string-keyed records
  return value as Record<string, unknown>
}

/** Narrow `value` to an array or fail with a readable message. */
export function array(value: unknown, label = "value"): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array, got: ${JSON.stringify(value)}`)
  }
  return value
}

export function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Event types observed on an SSE stream, in arrival order. */
export function sseEventTypes(events: SseEvent[]): string[] {
  return events.map((item) => String(record(record(item.data, "sse data").event, "sse event").type))
}

/** Durable cursor of one SSE event. */
export function sseCursor(event: SseEvent): number {
  return Number(record(event.data, "sse data").cursor)
}

function makeApi(server: Server): Api {
  const call = server.call

  const createSession: Api["createSession"] = async (input = {}) => {
    const result = await call({
      method: "POST",
      path: "/api/session",
      body: {
        runtimeScope: { directory: scratchDirectory("session") },
        model: DEMO_MODEL,
        ...input,
      },
    })
    check(result.status === 200, `seed createSession failed: ${result.status} ${result.text}`)
    return record(record(result.body, "create response").data, "session info")
  }

  const prompt: Api["prompt"] = async (sessionID, input = {}) => {
    const result = await call({
      method: "POST",
      path: `/api/session/${sessionID}/prompt`,
      body: { prompt: { text: "hello demo" }, ...input },
    })
    check(result.status === 200, `seed prompt failed: ${result.status} ${result.text}`)
    return record(record(result.body, "prompt response").data, "admitted input")
  }

  const awaitAssistant: Api["awaitAssistant"] = async (sessionID, options = {}) => {
    const deadline = Date.now() + (options.timeoutMs ?? 15_000)
    let last = ""
    for (;;) {
      const result = await call({ path: `/api/session/${sessionID}/message?order=asc` })
      last = result.text
      if (result.status === 200) {
        const data = array(record(result.body, "messages response").data, "messages")
        const done = data.some((message) => {
          if (!message || typeof message !== "object" || Array.isArray(message)) return false
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- guarded above; parsed JSON objects are string-keyed records
          const item = message as Record<string, unknown>
          if (item.type !== "assistant") return false
          const content = Array.isArray(item.content) ? item.content.map((part) => record(part, "content part")) : []
          const hasDemoText = content.some((part) => part.type === "text" && part.text === DEMO_TEXT)
          const completed = record(item.time ?? {}, "assistant time").completed !== undefined
          return hasDemoText && completed
        })
        if (done) return data
      }
      check(Date.now() <= deadline, `demo assistant reply never appeared for ${sessionID}; last response: ${last}`)
      await Bun.sleep(50)
    }
  }

  const roundTrip: Api["roundTrip"] = async () => {
    const session = await createSession()
    await prompt(String(session.id))
    const messages = await awaitAssistant(String(session.id))
    return { session, messages }
  }

  return { call, stream: server.stream, createSession, prompt, awaitAssistant, roundTrip }
}

type Definition<S> = {
  readonly method: Method
  readonly path: string
  readonly name: string
  readonly server: ServerOptions
  readonly timeout: number
  readonly seed?: (api: Api) => Promise<S>
  readonly request?: (ctx: Ctx<S>) => Omit<RequestSpec, "method"> & { method?: Method }
}

class ScenarioBuilder<S = undefined> {
  constructor(private readonly definition: Definition<S>) {}

  /**
   * Run this scenario against a server built with the given options: daemon
   * transport `password` and/or `config` (an explicit env map for the server's
   * `Config` reads such as `GTE_AGENT_AUTH_MODE` / `GTE_AGENT_AUTH_TOKEN`).
   */
  server(options: ServerOptions) {
    return this.clone({ server: options })
  }

  /** Per-scenario timeout in milliseconds (default 30s). */
  timeout(ms: number) {
    return this.clone({ timeout: ms })
  }

  /**
   * Seed typed state through the API before the main request. Call `seeded`
   * before `at` — it resets any previously configured request builder.
   */
  seeded<Next>(seed: (api: Api) => Promise<Next>): ScenarioBuilder<Next> {
    return new ScenarioBuilder<Next>({
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the stale request builder is reset below, so no field depends on the old state type
      ...(this.definition as unknown as Definition<Next>),
      seed,
      request: undefined,
    })
  }

  /** Build the request from seeded state. Path defaults to the scenario path, method to the scenario method. */
  at(request: (ctx: Ctx<S>) => Omit<RequestSpec, "method"> & { method?: Method }) {
    return this.clone({ request })
  }

  /** Terminal: assert the response status only. */
  status(expected: number, inspect?: (result: CallResult, ctx: Ctx<S>) => void | Promise<void>): Scenario {
    return this.finish(async (ctx) => {
      const result = await ctx.api.call(this.spec(ctx))
      this.assertStatus(result, expected)
      if (inspect) await inspect(result, ctx)
    })
  }

  /** Terminal: assert status + JSON content type, then inspect the parsed body. */
  json(expected: number, inspect?: (body: unknown, ctx: Ctx<S>, result: CallResult) => void | Promise<void>): Scenario {
    return this.finish(async (ctx) => {
      const result = await ctx.api.call(this.spec(ctx))
      this.assertStatus(result, expected)
      check(
        result.contentType.includes("application/json"),
        `${this.definition.name}: expected a JSON response, got "${result.contentType}": ${result.text}`,
      )
      if (inspect) await inspect(result.body, ctx, result)
    })
  }

  /** Terminal: open the SSE stream, collect events until `until`, then inspect. */
  sse(options: StreamOptions, inspect?: (outcome: StreamResult, ctx: Ctx<S>) => void | Promise<void>): Scenario {
    return this.finish(async (ctx) => {
      const outcome = await ctx.api.stream(this.spec(ctx), options)
      check(outcome.status === 200, `${this.definition.name}: expected SSE status 200, got ${outcome.status}`)
      check(
        outcome.contentType.includes("text/event-stream"),
        `${this.definition.name}: expected text/event-stream, got "${outcome.contentType}"`,
      )
      check(
        !outcome.timedOut,
        `${this.definition.name}: SSE stream timed out before the stop condition; saw events: ${JSON.stringify(
          outcome.events.map((item) => item.raw),
        )}`,
      )
      if (inspect) await inspect(outcome, ctx)
    })
  }

  private clone(next: Partial<Definition<S>>) {
    return new ScenarioBuilder<S>({ ...this.definition, ...next })
  }

  private spec(ctx: Ctx<S>): RequestSpec {
    const definition = this.definition
    const base = definition.request?.(ctx)
    return { method: definition.method, path: definition.path, ...base }
  }

  private assertStatus(result: CallResult, expected: number) {
    check(
      result.status === expected,
      `${this.definition.name}: expected status ${expected}, got ${result.status}: ${result.text}`,
    )
  }

  private finish(run: (ctx: Ctx<S>) => Promise<void>): Scenario {
    const definition = this.definition
    return {
      name: `${definition.method} ${definition.path} ${definition.name}`,
      timeout: definition.timeout,
      run: async () => {
        const server = makeServer(definition.server)
        const api = makeApi(server)
        try {
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- `.seeded(...)` pairs the seed result with the request/assertion state type
          const state = (definition.seed ? await definition.seed(api) : undefined) as S
          await run({ api, state })
        } finally {
          await server.dispose()
        }
      },
    }
  }
}

const make =
  (method: Method) =>
  (path: string, name: string): ScenarioBuilder =>
    new ScenarioBuilder({ method, path, name, server: {}, timeout: 30_000 })

export const http = {
  get: make("GET"),
  post: make("POST"),
  put: make("PUT"),
  patch: make("PATCH"),
  del: make("DELETE"),
}

/** Register each scenario as a bun test. */
export function exercise(scenarios: Scenario[]) {
  for (const scenario of scenarios) {
    test(scenario.name, scenario.run, { timeout: scenario.timeout })
  }
}
