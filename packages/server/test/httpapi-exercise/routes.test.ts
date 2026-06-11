/**
 * Route-level coverage for the canonical GTE Agent HTTP API (health, session
 * create/list/intent/prompt, messages, context). SSE coverage lives in
 * ./events.test.ts and auth probes in ./auth.test.ts.
 */
import "./setup"
import { describe } from "bun:test"
import { array, check, DEMO_MODEL, DEMO_TEXT, exercise, http, record } from "./dsl"
import { scratchDirectory } from "./setup"

const TRACKED_ADDRESS = `0x${"ab".repeat(20)}`

describe("health", () => {
  exercise([
    http.get("/api/health", "reports healthy").json(200, (body) => {
      check(record(body).healthy === true, `health should report healthy: ${JSON.stringify(body)}`)
    }),
  ])
})

describe("session.create", () => {
  exercise([
    http
      .post("/api/session", "creates a session bound to the auth stub principal")
      .at(() => {
        const directory = scratchDirectory("create")
        return { path: "/api/session", body: { runtimeScope: { directory }, model: DEMO_MODEL } }
      })
      .json(200, (body) => {
        const data = record(record(body, "response").data, "session info")
        check(String(data.id).startsWith("ses_"), `session id should use the ses_ prefix: ${String(data.id)}`)
        check(data.principalID === "dev_principal", `principalID should be the stub principal: ${String(data.principalID)}`)
        check(data.authorityID === "dev_authority", `authorityID should be the stub authority: ${String(data.authorityID)}`)
        check(record(data.model, "model").providerID === "gte-agent-demo", "model should round-trip")
        check(typeof record(data.time, "time").created === "number", "time.created should encode as epoch millis")
        check(typeof data.title === "string" && data.title.length > 0, "session should get a title")
      }),
    http
      .post("/api/session", "honors an explicit session id")
      .at(() => ({
        path: "/api/session",
        body: { id: "ses_httpapi_explicit", runtimeScope: { directory: scratchDirectory("explicit") } },
      }))
      .json(200, (body) => {
        check(record(record(body).data).id === "ses_httpapi_explicit", "explicit session id should be used")
      }),
    http
      .post("/api/session", "returns the existing session for a duplicate id with the same identity")
      .seeded((api) => api.createSession({ id: "ses_httpapi_dup" }))
      .at(({ state }) => ({
        path: "/api/session",
        body: { id: "ses_httpapi_dup", runtimeScope: state.runtimeScope },
      }))
      .json(200, (body, { state }) => {
        const data = record(record(body).data)
        check(data.id === "ses_httpapi_dup", "duplicate create should return the recorded session")
        check(data.principalID === state.principalID, "duplicate create should keep the recorded principal")
        check(
          record(data.time, "time").created === record(state.time, "seeded time").created,
          "duplicate create should not mint a new session",
        )
      }),
    http
      .post("/api/session", "rejects a payload without a runtime scope")
      .at(() => ({ path: "/api/session", body: {} }))
      .json(400, (body) => {
        const error = record(body)
        check(error._tag === "InvalidRequestError", `expected InvalidRequestError, got ${JSON.stringify(body)}`)
        check(String(error.message).includes("runtimeScope"), "schema error should mention the missing key")
      }),
    http
      .post("/api/session", "rejects a session id without the ses prefix")
      .at(() => ({
        path: "/api/session",
        body: { id: "bogus_id", runtimeScope: { directory: scratchDirectory("bad-id") } },
      }))
      .json(400, (body) => {
        check(record(body)._tag === "InvalidRequestError", `expected InvalidRequestError, got ${JSON.stringify(body)}`)
      }),
    http
      .post("/api/session", "rejects acting for an authority outside the stub grant set")
      .at(() => ({
        path: "/api/session",
        body: { runtimeScope: { directory: scratchDirectory("forbidden") }, authorityID: "other_authority" },
      }))
      .json(403, (body) => {
        const error = record(body)
        check(error._tag === "ForbiddenError", `expected ForbiddenError, got ${JSON.stringify(body)}`)
        check(String(error.message).includes("other_authority"), "error should name the denied authority")
      }),
  ])
})

describe("session.list", () => {
  const sessionIDs = (body: unknown) =>
    array(record(body, "list response").data, "sessions").map((item) => String(record(item, "session").id))

  exercise([
    http.get("/api/session", "returns an empty list on a fresh server").json(200, (body) => {
      check(sessionIDs(body).length === 0, `expected no sessions, got ${JSON.stringify(body)}`)
      record(record(body).cursor, "cursor")
    }),
    http
      .get("/api/session", "lists created sessions newest first by default")
      .seeded(async (api) => {
        const ids: string[] = []
        for (let index = 0; index < 3; index += 1) {
          ids.push(String((await api.createSession()).id))
          await Bun.sleep(5)
        }
        return ids
      })
      .json(200, (body, { state }) => {
        check(
          JSON.stringify(sessionIDs(body)) === JSON.stringify([...state].reverse()),
          `expected newest-first order ${JSON.stringify([...state].reverse())}, got ${JSON.stringify(sessionIDs(body))}`,
        )
      }),
    http
      .get("/api/session", "lists sessions oldest first with order=asc")
      .seeded(async (api) => {
        const ids: string[] = []
        for (let index = 0; index < 2; index += 1) {
          ids.push(String((await api.createSession()).id))
          await Bun.sleep(5)
        }
        return ids
      })
      .at(() => ({ path: "/api/session?order=asc" }))
      .json(200, (body, { state }) => {
        check(
          JSON.stringify(sessionIDs(body)) === JSON.stringify(state),
          `expected oldest-first order ${JSON.stringify(state)}, got ${JSON.stringify(sessionIDs(body))}`,
        )
      }),
    http
      .get("/api/session", "pages through sessions with the opaque cursor")
      .seeded(async (api) => {
        const ids: string[] = []
        for (let index = 0; index < 3; index += 1) {
          ids.push(String((await api.createSession()).id))
          await Bun.sleep(5)
        }
        return ids
      })
      .at(() => ({ path: "/api/session?limit=2" }))
      .json(200, async (body, { api, state }) => {
        const pageOne = sessionIDs(body)
        check(pageOne.length === 2, `first page should have 2 sessions, got ${pageOne.length}`)
        const next = record(record(body).cursor, "cursor").next
        check(typeof next === "string" && next.length > 0, "first page should expose cursor.next")
        const result = await api.call({ path: `/api/session?cursor=${encodeURIComponent(next)}&limit=2` })
        check(result.status === 200, `cursor page failed: ${result.status} ${result.text}`)
        const pageTwo = sessionIDs(result.body)
        check(pageTwo.length === 1, `second page should have the remaining session, got ${JSON.stringify(pageTwo)}`)
        const combined = [...pageOne, ...pageTwo]
        check(new Set(combined).size === 3, `pages should not overlap: ${JSON.stringify(combined)}`)
        check(
          JSON.stringify([...combined].sort()) === JSON.stringify([...state].sort()),
          `pages should cover all created sessions: ${JSON.stringify(combined)} vs ${JSON.stringify(state)}`,
        )
      }),
    http
      .get("/api/session", "filters sessions by runtime scope directory")
      .seeded(async (api) => {
        const session = await api.createSession()
        await api.createSession()
        return session
      })
      .at(({ state }) => ({
        path: `/api/session?directory=${encodeURIComponent(String(record(state.runtimeScope, "scope").directory))}`,
      }))
      .json(200, (body, { state }) => {
        check(
          JSON.stringify(sessionIDs(body)) === JSON.stringify([String(state.id)]),
          `directory filter should isolate one session, got ${JSON.stringify(sessionIDs(body))}`,
        )
      }),
    http
      .get("/api/session", "applies the title search filter")
      .seeded(async (api) => {
        await api.createSession()
      })
      .at(() => ({ path: "/api/session?search=no-such-session-title" }))
      .json(200, (body) => {
        check(sessionIDs(body).length === 0, "search miss should return no sessions")
      }),
    http
      .get("/api/session", "rejects a malformed cursor")
      .at(() => ({ path: "/api/session?cursor=not-a-cursor" }))
      .json(400, (body) => {
        check(record(body)._tag === "InvalidCursorError", `expected InvalidCursorError, got ${JSON.stringify(body)}`)
      }),
    http
      .get("/api/session", "rejects a non-positive limit")
      .at(() => ({ path: "/api/session?limit=0" }))
      .json(400, (body) => {
        check(record(body)._tag === "InvalidRequestError", `expected InvalidRequestError, got ${JSON.stringify(body)}`)
      }),
  ])
})

describe("session.intent", () => {
  exercise([
    http
      .patch("/api/session/:sessionID/intent", "persists session-scoped UI intent")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({
        path: `/api/session/${String(state.id)}/intent`,
        body: {
          selectedMarket: "ETH/USDC",
          trackedAddress: TRACKED_ADDRESS,
          pinnedPanels: [{ panel: "book", key: "ETH/USDC" }],
        },
      }))
      .json(200, (body) => {
        const data = record(record(body).data)
        check(data.selectedMarket === "ETH/USDC", `selectedMarket should persist: ${JSON.stringify(data.selectedMarket)}`)
        check(data.trackedAddress === TRACKED_ADDRESS, "trackedAddress should persist")
        const panels = array(data.pinnedPanels, "pinnedPanels")
        check(panels.length === 1 && record(panels[0]).panel === "book", "pinned panels should persist")
      }),
    http
      .patch("/api/session/:sessionID/intent", "keeps omitted intent fields and clears explicit nulls")
      .seeded(async (api) => {
        const session = await api.createSession()
        const result = await api.call({
          method: "PATCH",
          path: `/api/session/${String(session.id)}/intent`,
          body: { selectedMarket: "BTC/USDC", trackedAddress: TRACKED_ADDRESS },
        })
        check(result.status === 200, `seed intent update failed: ${result.status} ${result.text}`)
        return session
      })
      .at(({ state }) => ({
        path: `/api/session/${String(state.id)}/intent`,
        body: { trackedAddress: null },
      }))
      .json(200, (body) => {
        const data = record(record(body).data)
        check(data.selectedMarket === "BTC/USDC", "omitted selectedMarket should stay unchanged")
        check(data.trackedAddress == null, `null should clear trackedAddress: ${JSON.stringify(data.trackedAddress)}`)
      }),
    http
      .patch("/api/session/:sessionID/intent", "rejects a malformed tracked address")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({
        path: `/api/session/${String(state.id)}/intent`,
        body: { trackedAddress: "not-an-address" },
      }))
      .json(400, (body) => {
        check(record(body)._tag === "InvalidRequestError", `expected InvalidRequestError, got ${JSON.stringify(body)}`)
      }),
    http
      .patch("/api/session/:sessionID/intent", "returns SessionNotFoundError for a missing session")
      .at(() => ({ path: "/api/session/ses_httpapi_missing/intent", body: { selectedMarket: "ETH/USDC" } }))
      .json(404, (body) => {
        const error = record(body)
        check(error._tag === "SessionNotFoundError", `expected SessionNotFoundError, got ${JSON.stringify(body)}`)
        check(error.sessionID === "ses_httpapi_missing", "error should echo the session id")
      }),
  ])
})

describe("session.prompt", () => {
  exercise([
    http
      .post("/api/session/:sessionID/prompt", "admits a prompt for the demo model")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({
        path: `/api/session/${String(state.id)}/prompt`,
        body: { prompt: { text: "hello demo" } },
      }))
      .json(200, (body, { state }) => {
        const data = record(record(body).data, "admitted input")
        check(String(data.id).startsWith("msg_"), `admitted id should use the msg_ prefix: ${String(data.id)}`)
        check(data.sessionID === state.id, "admitted input should belong to the session")
        check(data.delivery === "steer", "default delivery should be steer")
        check(record(data.prompt, "prompt").text === "hello demo", "prompt text should round-trip")
        check(typeof data.admittedSeq === "number", "admittedSeq should be a number")
        check(typeof data.timeCreated === "number", "timeCreated should encode as epoch millis")
      }),
    http
      .post("/api/session/:sessionID/prompt", "is idempotent for the same message id and prompt")
      .seeded(async (api) => {
        const session = await api.createSession()
        const admitted = await api.prompt(String(session.id), {
          id: "msg_httpapi_idempotent",
          prompt: { text: "same prompt" },
        })
        return { session, admitted }
      })
      .at(({ state }) => ({
        path: `/api/session/${String(state.session.id)}/prompt`,
        body: { id: "msg_httpapi_idempotent", prompt: { text: "same prompt" } },
      }))
      .json(200, (body, { state }) => {
        const data = record(record(body).data)
        check(data.id === "msg_httpapi_idempotent", "idempotent admit should return the same message id")
        check(data.admittedSeq === state.admitted.admittedSeq, "idempotent admit should keep the original sequence")
      }),
    http
      .post("/api/session/:sessionID/prompt", "conflicts when the message id is reused with a different prompt")
      .seeded(async (api) => {
        const session = await api.createSession()
        await api.prompt(String(session.id), { id: "msg_httpapi_conflict", prompt: { text: "original" } })
        return session
      })
      .at(({ state }) => ({
        path: `/api/session/${String(state.id)}/prompt`,
        body: { id: "msg_httpapi_conflict", prompt: { text: "different" } },
      }))
      .json(409, (body) => {
        check(record(body)._tag === "ConflictError", `expected ConflictError, got ${JSON.stringify(body)}`)
      }),
    http
      .post("/api/session/:sessionID/prompt", "returns SessionNotFoundError for a missing session")
      .at(() => ({ path: "/api/session/ses_httpapi_missing/prompt", body: { prompt: { text: "hello" } } }))
      .json(404, (body) => {
        const error = record(body)
        check(error._tag === "SessionNotFoundError", `expected SessionNotFoundError, got ${JSON.stringify(body)}`)
        check(error.sessionID === "ses_httpapi_missing", "error should echo the session id")
        check(typeof error.message === "string", "error should carry a message")
      }),
    http
      .post("/api/session/:sessionID/prompt", "rejects a payload without a prompt")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({ path: `/api/session/${String(state.id)}/prompt`, body: {} }))
      .json(400, (body) => {
        check(record(body)._tag === "InvalidRequestError", `expected InvalidRequestError, got ${JSON.stringify(body)}`)
      }),
  ])
})

describe("session.messages", () => {
  exercise([
    http
      .get("/api/session/:sessionID/message", "returns an empty history for a fresh session")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({ path: `/api/session/${String(state.id)}/message` }))
      .json(200, (body) => {
        check(array(record(body).data, "messages").length === 0, "fresh session should have no messages")
        record(record(body).cursor, "cursor")
      }),
    http
      .get("/api/session/:sessionID/message", "projects the demo round-trip into user and assistant messages")
      .seeded((api) => api.roundTrip())
      .at(({ state }) => ({ path: `/api/session/${String(state.session.id)}/message?order=asc` }))
      .json(200, (body) => {
        const data = array(record(body).data, "messages").map((item) => record(item, "message"))
        check(data.length >= 2, `expected user + assistant messages, got ${data.length}`)
        const user = data[0]
        check(user.type === "user" && user.text === "hello demo", `first message should be the user prompt: ${JSON.stringify(user)}`)
        const assistant = data.find((item) => item.type === "assistant")
        check(assistant !== undefined, "history should include the assistant reply")
        const content = array(assistant.content, "assistant content").map((item) => record(item))
        check(
          content.some((part) => part.type === "text" && part.text === DEMO_TEXT),
          `assistant reply should carry the deterministic demo text: ${JSON.stringify(content)}`,
        )
        check(assistant.finish === "stop", "assistant reply should be finished")
      }),
    http
      .get("/api/session/:sessionID/message", "pages through the timeline with the opaque cursor")
      .seeded((api) => api.roundTrip())
      .at(({ state }) => ({ path: `/api/session/${String(state.session.id)}/message?order=asc&limit=1` }))
      .json(200, async (body, { api, state }) => {
        const pageOne = array(record(body).data, "messages").map((item) => record(item))
        check(pageOne.length === 1, `first page should have one message, got ${pageOne.length}`)
        check(pageOne[0].type === "user", "ascending first page should start with the user message")
        const next = record(record(body).cursor, "cursor").next
        check(typeof next === "string" && next.length > 0, "first page should expose cursor.next")
        const result = await api.call({
          path: `/api/session/${String(state.session.id)}/message?cursor=${encodeURIComponent(next)}&limit=1`,
        })
        check(result.status === 200, `cursor page failed: ${result.status} ${result.text}`)
        const pageTwo = array(record(result.body).data, "messages").map((item) => record(item))
        check(pageTwo.length === 1, "second page should have one message")
        check(pageTwo[0].type === "assistant", `second page should be the assistant reply: ${JSON.stringify(pageTwo)}`)
        check(pageOne[0].id !== pageTwo[0].id, "pages should not overlap")
      }),
    http
      .get("/api/session/:sessionID/message", "rejects combining a cursor with order")
      .seeded((api) => api.roundTrip())
      .at(({ state }) => ({
        path: `/api/session/${String(state.session.id)}/message?cursor=${encodeURIComponent(
          Buffer.from(JSON.stringify({ id: "msg_x", order: "asc", direction: "next" })).toString("base64url"),
        )}&order=asc`,
      }))
      .json(400, (body) => {
        check(record(body)._tag === "InvalidCursorError", `expected InvalidCursorError, got ${JSON.stringify(body)}`)
      }),
    http
      .get("/api/session/:sessionID/message", "rejects a malformed cursor")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({ path: `/api/session/${String(state.id)}/message?cursor=not-a-cursor` }))
      .json(400, (body) => {
        check(record(body)._tag === "InvalidCursorError", `expected InvalidCursorError, got ${JSON.stringify(body)}`)
      }),
    http
      .get("/api/session/:sessionID/message", "returns SessionNotFoundError for a missing session")
      .at(() => ({ path: "/api/session/ses_httpapi_missing/message" }))
      .json(404, (body) => {
        check(record(body)._tag === "SessionNotFoundError", `expected SessionNotFoundError, got ${JSON.stringify(body)}`)
      }),
  ])
})

describe("session.context", () => {
  exercise([
    http
      .get("/api/session/:sessionID/context", "returns the active context after a demo round-trip")
      .seeded((api) => api.roundTrip())
      .at(({ state }) => ({ path: `/api/session/${String(state.session.id)}/context` }))
      .json(200, (body) => {
        const data = array(record(body).data, "context messages").map((item) => record(item))
        check(data.length >= 2, `context should include user + assistant messages, got ${data.length}`)
        check(data.some((item) => item.type === "user"), "context should include the user prompt")
        check(data.some((item) => item.type === "assistant"), "context should include the assistant reply")
      }),
    http
      .get("/api/session/:sessionID/context", "returns an empty context for a fresh session")
      .seeded((api) => api.createSession())
      .at(({ state }) => ({ path: `/api/session/${String(state.id)}/context` }))
      .json(200, (body) => {
        check(array(record(body).data).length === 0, "fresh session should have an empty context")
      }),
    http
      .get("/api/session/:sessionID/context", "returns SessionNotFoundError for a missing session")
      .at(() => ({ path: "/api/session/ses_httpapi_missing/context" }))
      .json(404, (body) => {
        check(record(body)._tag === "SessionNotFoundError", `expected SessionNotFoundError, got ${JSON.stringify(body)}`)
      }),
  ])
})
