/**
 * Component coverage for the M7 /models overlay and provider auth wizard:
 *
 * - /models opens the modal picker (grouped by provider, auth status, current
 *   and default markers, fuzzy filter); Esc closes back to the prompt
 * - selecting an authed model applies it (session + global default via the
 *   select route) and the durable switched event confirms in the transcript
 * - selecting an unauthed model chains into the wizard (method picker →
 *   masked paste / OAuth progress → confirmation); Esc backs out one step
 * - pasted secrets render only as mask characters and never appear in frames
 * - OAuth: authorize URL + waiting state, callback completion, paste-redirect
 *   fallback, and Esc invalidating a late callback
 * - /models <provider>/<model> selects directly, skipping the picker
 * - the status line shows the session's active model (or the global default)
 */
import { afterEach, expect, test } from "bun:test"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { readAuthStatus } from "../src/api/auth"
import { createApi } from "../src/api/client"
import { createEventSubscriber } from "../src/api/events"
import { createGteApi } from "../src/api/gte"
import { createModelsApi } from "../src/api/models"
import { App } from "../src/ui/app"
import { createMockApi, makeSession } from "./fixture/api"

const BASE_URL = "http://gte-agent.internal"

let active: TestRendererSetup | undefined

afterEach(() => {
  if (active && !active.renderer.isDestroyed) active.renderer.destroy()
  active = undefined
})

/** A lone ESC sits ~20ms in the stdin disambiguation buffer; wait it out. */
async function pressEscape(setup: TestRendererSetup) {
  setup.mockInput.pressEscape()
  await new Promise((resolve) => setTimeout(resolve, 40))
}

async function mount(mock: ReturnType<typeof createMockApi>) {
  const setup = await testRender(
    () => (
      <App
        api={createApi({ baseUrl: BASE_URL, fetch: mock.fetch })}
        gte={createGteApi({ baseUrl: BASE_URL, fetch: mock.fetch })}
        models={createModelsApi({ baseUrl: BASE_URL, fetch: mock.fetch })}
        subscribe={createEventSubscriber({ baseUrl: BASE_URL, fetch: mock.fetch })}
        auth={readAuthStatus({})}
        server={{ mode: "in-process", url: BASE_URL }}
        directory="/tmp/gta-test"
        version="0.0.0-test"
        pollIntervalMs={40}
        onExit={() => {}}
      />
    ),
    { width: 140, height: 44 },
  )
  active = setup
  return setup
}

/** Mount, open the seeded session, and land on the prompt. */
async function openSession(mock: ReturnType<typeof createMockApi>) {
  const setup = await mount(mock)
  await setup.waitForFrame((frame) => frame.includes("alpha session"))
  setup.mockInput.pressKey("ARROW_DOWN")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("type a prompt and press enter"))
  return setup
}

/**
 * Submit a /models command line through the real prompt input. A bare
 * "/models" keeps the command dropdown open, so Esc (consumed by the
 * dropdown) dismisses it before Enter submits. With an arg, Enter either
 * falls through to submit directly (empty/no-op arg dropdown) and must NOT be
 * preceded by Esc — an unconsumed Esc would close the whole session.
 */
async function submitModels(setup: TestRendererSetup, text: string) {
  await setup.mockInput.typeText(text)
  if (!text.includes(" ")) await pressEscape(setup)
  setup.mockInput.pressEnter()
}

const seeded = (options?: Parameters<typeof createMockApi>[0]) =>
  createMockApi({ sessions: [makeSession({ id: "ses_alpha", title: "alpha session" })], ...options })

test("/models opens the picker grouped by provider with auth status and markers; esc closes it", async () => {
  const mock = seeded({ defaultModel: { id: "claude-fable-5", providerID: "anthropic" } })
  const setup = await openSession(mock)

  await submitModels(setup, "/models")
  // Wait on overlay-only text: the status line also names the default model.
  const picker = await setup.waitForFrame((frame) => frame.includes("Anthropic — authed (api key via env)"))
  expect(picker).toContain("OpenAI — needs setup")
  expect(picker).toContain("openai/gpt-5.5")
  expect(picker).toContain("· needs setup")
  expect(picker).toContain("anthropic/claude-fable-5 (default)")
  // The first model row is highlighted; the prompt input is replaced.
  expect(picker).toContain("▸ anthropic/claude-fable-5")
  expect(picker).not.toContain("type a prompt and press enter")

  await pressEscape(setup)
  const closed = await setup.waitForFrame((frame) => frame.includes("type a prompt and press enter"))
  expect(closed).not.toContain("filter:")
})

test("typing in the picker fuzzy-filters rows and drops emptied provider groups", async () => {
  const setup = await openSession(seeded())

  await submitModels(setup, "/models")
  await setup.waitForFrame((frame) => frame.includes("anthropic/claude-fable-5"))

  await setup.mockInput.typeText("gpt")
  const filtered = await setup.waitForFrame(
    (frame) => frame.includes("▸ openai/gpt-5.5") && !frame.includes("anthropic/claude-fable-5"),
  )
  expect(filtered).toContain("openai/gpt-5.4-mini")
  expect(filtered).not.toContain("Anthropic —")

  await setup.mockInput.typeText("zzz")
  const emptied = await setup.waitForFrame((frame) => frame.includes("no models match"))
  expect(emptied).not.toContain("▸ ")
})

test("selecting an authed model applies session + global default and confirms in the transcript", async () => {
  const mock = seeded()
  const setup = await openSession(mock)

  await submitModels(setup, "/models")
  await setup.waitForFrame((frame) => frame.includes("▸ anthropic/claude-fable-5"))
  setup.mockInput.pressEnter()

  const confirmed = await setup.waitForFrame((frame) => frame.includes("Model set to anthropic/claude-fable-5"))
  expect(confirmed).toContain("Claude Fable 5")
  expect(mock.selections).toEqual([{ providerID: "anthropic", modelID: "claude-fable-5", sessionID: "ses_alpha" }])
  expect(mock.defaultModel).toEqual({ id: "claude-fable-5", providerID: "anthropic" })
  expect(mock.sessionModels.get("ses_alpha")).toEqual({ id: "claude-fable-5", providerID: "anthropic" })

  // The durable switched event confirms in the transcript; enter closes the
  // overlay and the status line shows the session's active model.
  setup.mockInput.pressEnter()
  const idle = await setup.waitForFrame(
    (frame) => frame.includes("type a prompt and press enter") && frame.includes("model switched to"),
  )
  expect(idle).toContain("model switched to anthropic/claude-fable-5")
  expect(idle).toContain("idle · model anthropic/claude-fable-5 · principal")
})

test("selecting an unauthed model chains into the wizard and esc backs out one step at a time", async () => {
  const mock = seeded()
  const setup = await openSession(mock)

  await submitModels(setup, "/models")
  await setup.waitForFrame((frame) => frame.includes("anthropic/claude-fable-5"))
  await setup.mockInput.typeText("gpt")
  await setup.waitForFrame((frame) => frame.includes("▸ openai/gpt-5.5"))
  setup.mockInput.pressEnter()

  const method = await setup.waitForFrame((frame) => frame.includes("openai needs setup — choose a method:"))
  expect(method).toContain("▸ Paste API key")
  expect(method).toContain("Sign in with ChatGPT")
  expect(mock.selections).toEqual([])

  // Esc: method → picker (the "gpt" filter survives the round trip) → closed.
  await pressEscape(setup)
  const backToPicker = await setup.waitForFrame((frame) => frame.includes("filter: gpt"))
  expect(backToPicker).toContain("▸ openai/gpt-5.5")
  await pressEscape(setup)
  await setup.waitForFrame((frame) => frame.includes("type a prompt and press enter"))
  // The session itself stays open (esc was consumed by the overlay).
  expect(mock.hasStream("ses_alpha")).toBe(true)
})

test("pasting an API key is masked, never rendered, and applies the originally chosen model", async () => {
  const mock = seeded()
  const setup = await openSession(mock)
  const secret = "sk-test-SUPERSECRETVALUE123"

  await submitModels(setup, "/models openai/gpt-5.5")
  await setup.waitForFrame((frame) => frame.includes("openai needs setup — choose a method:"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("input is masked and never shown"))

  // Typed and bracket-pasted characters both land in the masked buffer.
  await setup.mockInput.typeText("sk-test-")
  await setup.mockInput.pasteBracketedText("SUPERSECRETVALUE123")
  const masked = await setup.waitForFrame((frame) => frame.includes("•".repeat(secret.length)))
  expect(masked).not.toContain("SUPERSECRETVALUE123")
  expect(masked).not.toContain(secret)

  setup.mockInput.pressEnter()
  const confirmed = await setup.waitForFrame((frame) => frame.includes("Model set to openai/gpt-5.5"))
  expect(confirmed).not.toContain("SUPERSECRETVALUE123")
  // The secret reached the auth route once and nowhere else.
  expect(mock.apiKeys).toEqual([{ provider: "openai", key: secret, type: undefined }])
  expect(mock.selections).toEqual([{ providerID: "openai", modelID: "gpt-5.5", sessionID: "ses_alpha" }])
})

test("oauth sign-in shows the authorize URL, waits for the browser, and applies on callback completion", async () => {
  const mock = seeded()
  const setup = await openSession(mock)

  await submitModels(setup, "/models openai/gpt-5.5")
  await setup.waitForFrame((frame) => frame.includes("choose a method:"))
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("▸ Sign in with ChatGPT"))
  setup.mockInput.pressEnter()

  const waiting = await setup.waitForFrame((frame) => frame.includes("waiting for browser…"))
  expect(waiting).toContain("https://auth.openai.com/oauth/authorize")
  // The overlay long-polls the callback completion (no redirect).
  await setup.waitFor(() => mock.oauthCompletions.length === 1)
  expect(mock.oauthCompletions[0]).toEqual({ provider: "openai", flow: "flow_1", redirect: undefined })

  mock.completeOauth("flow_1")
  await setup.waitForFrame((frame) => frame.includes("Model set to openai/gpt-5.5"))
  expect(mock.selections).toEqual([{ providerID: "openai", modelID: "gpt-5.5", sessionID: "ses_alpha" }])
  expect(mock.providers.find((provider) => provider.id === "openai")?.authed).toBe(true)
})

test("a pasted redirect URL completes oauth when the callback port cannot bind", async () => {
  const mock = seeded({ oauthListening: false })
  const setup = await openSession(mock)

  await submitModels(setup, "/models openai/gpt-5.5")
  await setup.waitForFrame((frame) => frame.includes("choose a method:"))
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("▸ Sign in with ChatGPT"))
  setup.mockInput.pressEnter()

  const fallback = await setup.waitForFrame((frame) => frame.includes("callback port unavailable"))
  expect(fallback).not.toContain("waiting for browser…")
  // No long-poll was started; the redirect paste is the only completion path.
  expect(mock.oauthCompletions).toEqual([])

  await setup.mockInput.pasteBracketedText("http://localhost:1455/auth/callback?code=abc&state=flow_1")
  await setup.waitForFrame((frame) => frame.includes("state=flow_1"))
  setup.mockInput.pressEnter()

  await setup.waitForFrame((frame) => frame.includes("Model set to openai/gpt-5.5"))
  expect(mock.oauthCompletions).toEqual([
    { provider: "openai", flow: "flow_1", redirect: "http://localhost:1455/auth/callback?code=abc&state=flow_1" },
  ])
})

test("esc during the oauth wait backs out to the method picker and drops the late callback", async () => {
  const mock = seeded()
  const setup = await openSession(mock)

  await submitModels(setup, "/models openai/gpt-5.5")
  await setup.waitForFrame((frame) => frame.includes("choose a method:"))
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("waiting for browser…"))
  await setup.waitFor(() => mock.oauthCompletions.length === 1)

  await pressEscape(setup)
  await setup.waitForFrame((frame) => frame.includes("choose a method:") && !frame.includes("waiting for browser…"))

  // A late callback completion must not apply the model behind the user's back.
  mock.completeOauth("flow_1")
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(mock.selections).toEqual([])
  const frame = await setup.waitForFrame((current) => current.includes("choose a method:"))
  expect(frame).not.toContain("Model set to")
})

test("/models <provider>/<model> with an authed provider applies directly, skipping the picker", async () => {
  const mock = seeded()
  const setup = await openSession(mock)

  await submitModels(setup, "/models anthropic/claude-haiku-4-5")
  await setup.waitForFrame((frame) => frame.includes("Model set to anthropic/claude-haiku-4-5"))
  expect(mock.selections).toEqual([{ providerID: "anthropic", modelID: "claude-haiku-4-5", sessionID: "ses_alpha" }])

  // Direct entry: esc from the confirmation closes the overlay entirely.
  await pressEscape(setup)
  await setup.waitForFrame((frame) => frame.includes("type a prompt and press enter"))
})

test("an unknown direct ref shows an error and falls back to the picker", async () => {
  const mock = seeded()
  const setup = await openSession(mock)

  await submitModels(setup, "/models acme/unknown-model")
  const frame = await setup.waitForFrame((current) => current.includes('Unknown model "acme/unknown-model"'))
  expect(frame).toContain("filter:")
  expect(frame).toContain("anthropic/claude-fable-5")
  expect(mock.selections).toEqual([])
})

test("the status line shows the inherited global default for sessions without their own selection", async () => {
  const mock = seeded({ defaultModel: { id: "claude-fable-5", providerID: "anthropic" } })
  const setup = await openSession(mock)
  const frame = await setup.waitForFrame((current) => current.includes("model anthropic/claude-fable-5 (default)"))
  expect(frame).toContain("idle · model anthropic/claude-fable-5 (default) · principal")
})

test("the prompt autocompletes /models args with provider/model refs and auth detail", async () => {
  const setup = await openSession(seeded({ defaultModel: { id: "claude-fable-5", providerID: "anthropic" } }))

  await setup.mockInput.typeText("/models ")
  const dropdown = await setup.waitForFrame((frame) => frame.includes("▸ anthropic/claude-fable-5"))
  expect(dropdown).toContain("authed (api key via env) · default")
  expect(dropdown).toContain("openai/gpt-5.5")
  expect(dropdown).toContain("needs setup")

  // Accepting a ref completes the text in place.
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("▸ anthropic/claude-haiku-4-5"))
  setup.mockInput.pressTab()
  await setup.waitForFrame((frame) => frame.includes("/models anthropic/claude-haiku-4-5"))
})
