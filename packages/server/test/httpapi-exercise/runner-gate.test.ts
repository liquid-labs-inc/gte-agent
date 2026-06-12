/**
 * Server-level pin for the Milestone 7 session-runner gate (checklist item 7).
 *
 * The canonical handlers compose `SessionRunnerDefault.layer`, whose behavior
 * is decided by GTE_AGENT_LLM at layer build time:
 *
 * - "demo" (this suite's default via ../preload.ts) → deterministic demo client.
 * - anything else (including unset) → the real provider path, which fails
 *   visibly when the session's model cannot be resolved through the curated
 *   catalog and auth store. The demo client is never a silent fallback.
 *
 * These scenarios exist so a regression back to a hardwired demo runner (or a
 * silent demo fallback on the real path) fails this suite instead of only the
 * manual end-to-end check.
 */
import "./setup"
import { test } from "bun:test"
import { makeServer, type Server } from "./harness"
import { array, check, record, DEMO_MODEL, DEMO_TEXT } from "./dsl"
import { scratchDirectory } from "./setup"

const createSession = async (server: Server) => {
  const result = await server.call({
    method: "POST",
    path: "/api/session",
    body: { runtimeScope: { directory: scratchDirectory("runner-gate") }, model: DEMO_MODEL },
  })
  check(result.status === 200, `createSession failed: ${result.status} ${result.text}`)
  return String(record(record(result.body, "create response").data, "session info").id)
}

const prompt = async (server: Server, sessionID: string) => {
  const result = await server.call({
    method: "POST",
    path: `/api/session/${sessionID}/prompt`,
    body: { prompt: { text: "hello gate" } },
  })
  check(result.status === 200, `prompt failed: ${result.status} ${result.text}`)
}

/** Poll messages until a completed assistant message is projected; return it. */
const awaitCompletedAssistant = async (server: Server, sessionID: string) => {
  const deadline = Date.now() + 15_000
  let last = ""
  for (;;) {
    const result = await server.call({ path: `/api/session/${sessionID}/message?order=asc` })
    last = result.text
    if (result.status === 200) {
      const messages = array(record(result.body, "messages response").data, "messages").map((message) =>
        record(message, "message"),
      )
      const assistant = messages.find(
        (message) => message.type === "assistant" && record(message.time ?? {}, "time").completed !== undefined,
      )
      if (assistant) return { assistant, text: result.text }
    }
    check(Date.now() <= deadline, `no completed assistant message for ${sessionID}; last response: ${last}`)
    await Bun.sleep(50)
  }
}

const withGate = async (value: string | undefined, body: (server: Server) => Promise<void>) => {
  const previous = process.env.GTE_AGENT_LLM
  if (value === undefined) delete process.env.GTE_AGENT_LLM
  else process.env.GTE_AGENT_LLM = value
  // The gate reads process.env when the runner layer is built (lazily, on the
  // server's first request), so the env override must span the whole scenario.
  const server = makeServer()
  try {
    await body(server)
  } finally {
    if (previous === undefined) delete process.env.GTE_AGENT_LLM
    else process.env.GTE_AGENT_LLM = previous
    await server.dispose()
  }
}

test("GTE_AGENT_LLM=demo streams the deterministic demo reply through the gated runner", async () => {
  await withGate("demo", async (server) => {
    const sessionID = await createSession(server)
    await prompt(server, sessionID)
    const { assistant } = await awaitCompletedAssistant(server, sessionID)
    check(assistant.finish === "stop", `expected demo finish "stop", got: ${JSON.stringify(assistant)}`)
    const content = array(assistant.content, "assistant content").map((part) => record(part, "content part"))
    check(
      content.some((part) => part.type === "text" && part.text === DEMO_TEXT),
      `expected the demo text, got: ${JSON.stringify(content)}`,
    )
  })
}, 30_000)

test("a non-demo GTE_AGENT_LLM takes the real path and fails visibly, never the demo fallback", async () => {
  await withGate("production", async (server) => {
    const sessionID = await createSession(server)
    await prompt(server, sessionID)
    const { assistant, text } = await awaitCompletedAssistant(server, sessionID)
    // The demo provider ref is not in the curated catalog, so the real path
    // surfaces a visible transcript error pointing the user at /models.
    check(assistant.finish === "error", `expected a visible error finish, got: ${JSON.stringify(assistant)}`)
    const message = String(record(assistant.error ?? {}, "assistant error").message)
    check(message.includes("/models"), `expected the error to direct the user to /models, got: ${message}`)
    check(!text.includes(DEMO_TEXT), "the demo reply must never appear on the real path")
  })
}, 30_000)
