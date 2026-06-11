import { afterEach, expect, test } from "bun:test"
import type { TestRendererSetup } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { readAuthStatus } from "../src/api/auth"
import { createApi } from "../src/api/client"
import { createEventSubscriber } from "../src/api/events"
import { createGteApi } from "../src/api/gte"
import { createModelsApi } from "../src/api/models"
import { createCompletionSources, type CompletionItem, type CompletionSources } from "../src/state/autocomplete"
import { App } from "../src/ui/app"
import { PromptInput } from "../src/ui/prompt-input"
import { createMockApi, makeSession } from "./fixture/api"

const BASE_URL = "http://gte-agent.internal"

let active: TestRendererSetup | undefined

afterEach(() => {
  if (active && !active.renderer.isDestroyed) active.renderer.destroy()
  active = undefined
})

/**
 * A lone ESC sits in the stdin parser's 20ms disambiguation buffer (it could
 * be the start of an escape sequence) and only flushes as a keypress on a real
 * timer; wait that out so frame assertions are deterministic.
 */
async function pressEscape(setup: TestRendererSetup) {
  setup.mockInput.pressEscape()
  await new Promise((resolve) => setTimeout(resolve, 40))
}

/** Standalone prompt with full arg-completion wiring against the mock GTE API. */
async function mountPrompt(options?: { markets?: string[] }) {
  const mock = createMockApi({ markets: options?.markets ?? ["ETH-USD", "BTC-USD"] })
  const submitted: string[] = []
  const setup = await testRender(
    () => (
      <PromptInput
        onSubmit={(text) => submitted.push(text)}
        completionSources={createCompletionSources(createGteApi({ baseUrl: BASE_URL, fetch: mock.fetch }))}
      />
    ),
    { width: 80, height: 24 },
  )
  active = setup
  await setup.waitForFrame((frame) => frame.includes("prompt"))
  return { setup, submitted }
}

test("typing / opens the command dropdown and continued typing refines it", async () => {
  const { setup } = await mountPrompt()

  await setup.mockInput.typeText("/")
  const all = await setup.waitForFrame((frame) => frame.includes("/markets [query]"))
  // First row is highlighted and usage strings render next to names.
  expect(all).toContain("▸ /markets")
  expect(all).toContain("· tab/enter accept · esc dismiss")

  await setup.mockInput.typeText("boo")
  const filtered = await setup.waitForFrame(
    (frame) => frame.includes("/book <symbol>") && !frame.includes("/markets [query]"),
  )
  expect(filtered).toContain("▸ /book")
})

test("non-slash input never opens the dropdown", async () => {
  const { setup } = await mountPrompt()

  await setup.mockInput.typeText("hello /book")
  const frame = await setup.waitForFrame((frame) => frame.includes("hello /book"))
  expect(frame).not.toContain("▸ ")
  expect(frame).not.toContain("/book <symbol>")
})

test("tab accepts the highlighted command and chains into symbol arg completion", async () => {
  const { setup } = await mountPrompt()

  await setup.mockInput.typeText("/boo")
  await setup.waitForFrame((frame) => frame.includes("/book <symbol>"))
  setup.mockInput.pressTab()

  // Accepted text lands in the input and the dropdown switches to symbols.
  const symbols = await setup.waitForFrame((frame) => frame.includes("ETH-USD") && frame.includes("BTC-USD"))
  expect(symbols).toContain("/book")
  expect(symbols).toContain("▸ ETH-USD")
  expect(symbols).not.toContain("/book <symbol>")
})

test("arrow keys move the highlight with wrap-around", async () => {
  const { setup } = await mountPrompt()

  await setup.mockInput.typeText("/book ")
  await setup.waitForFrame((frame) => frame.includes("▸ ETH-USD"))

  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("▸ BTC-USD"))

  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("▸ ETH-USD"))

  setup.mockInput.pressArrow("up")
  const wrapped = await setup.waitForFrame((frame) => frame.includes("▸ BTC-USD"))
  expect(wrapped).not.toContain("▸ ETH-USD")
})

test("enter accepts the selected symbol, then submits once acceptance is a no-op", async () => {
  const { setup, submitted } = await mountPrompt()

  await setup.mockInput.typeText("/book ")
  await setup.waitForFrame((frame) => frame.includes("▸ ETH-USD"))
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("▸ BTC-USD"))

  // First Enter completes the token instead of submitting.
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("/book BTC-USD"))
  expect(submitted).toEqual([])

  // The completed token resolves to itself, so the next Enter submits.
  setup.mockInput.pressEnter()
  await setup.waitFor(() => submitted.length === 1)
  expect(submitted).toEqual(["/book BTC-USD"])
  // Submission clears the input and the dropdown with it.
  const cleared = await setup.waitForFrame((frame) => frame.includes("type a prompt and press enter"))
  expect(cleared).not.toContain("▸ ")
})

test("esc dismisses the dropdown and continued typing reopens it", async () => {
  const { setup } = await mountPrompt()

  await setup.mockInput.typeText("/mar")
  await setup.waitForFrame((frame) => frame.includes("▸ /market"))

  await pressEscape(setup)
  const dismissed = await setup.waitForFrame((frame) => !frame.includes("▸ /market"))
  // The typed text survives dismissal.
  expect(dismissed).toContain("/mar")

  await setup.mockInput.typeText("k")
  const reopened = await setup.waitForFrame((frame) => frame.includes("▸ /market"))
  expect(reopened).toContain("/markets [query]")
})

test("symbol candidates fuzzy-refine and a stale-token typo empties the dropdown", async () => {
  const { setup } = await mountPrompt({ markets: ["ETH-USD", "ETC-USD", "BTC-USD"] })

  await setup.mockInput.typeText("/trades et")
  const refined = await setup.waitForFrame(
    (frame) => frame.includes("ETH-USD") && frame.includes("ETC-USD") && !frame.includes("BTC-USD"),
  )
  expect(refined).toContain("▸ ")

  await setup.mockInput.typeText("zzz")
  const emptied = await setup.waitForFrame((frame) => !frame.includes("ETH-USD"))
  expect(emptied).not.toContain("▸ ")
})

/**
 * Prompt whose symbol fetches resolve only when the test says so, modelling a
 * slow HTTP roundtrip. Each provider call queues one manually-resolvable
 * promise (in call order).
 */
async function mountPromptWithDeferredSymbols() {
  const pending: Array<(items: readonly CompletionItem[]) => void> = []
  const sources: CompletionSources = {
    symbol: () => new Promise((resolve) => pending.push(resolve)),
    "model-ref": async () => [],
  }
  const submitted: string[] = []
  const setup = await testRender(
    () => <PromptInput onSubmit={(text) => submitted.push(text)} completionSources={sources} />,
    { width: 80, height: 24 },
  )
  active = setup
  await setup.waitForFrame((frame) => frame.includes("prompt"))
  const resolveNext = (symbols: string[]) => {
    const resolve = pending.shift()
    if (resolve === undefined) throw new Error("no symbol fetch in flight")
    resolve(symbols.map((symbol) => ({ insert: symbol, label: symbol })))
  }
  return { setup, submitted, resolveNext, pending }
}

test("a stale arg fetch resolving after backspacing out never overwrites the command list", async () => {
  const { setup, resolveNext } = await mountPromptWithDeferredSymbols()

  // Entering the arg stage starts a symbol fetch that we hold in flight...
  await setup.mockInput.typeText("/book ")
  await setup.waitForFrame((frame) => frame.includes("/book"))

  // ...then backspacing returns to the command stage before it resolves.
  setup.mockInput.pressBackspace()
  await setup.waitForFrame((frame) => frame.includes("▸ /book"))

  // The late result must be dropped, not rendered under the "commands" title.
  resolveNext(["ETH-USD"])
  await new Promise((resolve) => setTimeout(resolve, 50))
  const frame = await setup.waitForFrame((f) => f.includes("▸ /book"))
  expect(frame).not.toContain("ETH-USD")
  expect(frame).toContain("/book <symbol>")
})

test("async results landing after arrow navigation clamp the highlight into range", async () => {
  const { setup, resolveNext } = await mountPromptWithDeferredSymbols()

  await setup.mockInput.typeText("/book ")
  resolveNext(["ETH-USD", "ETC-USD", "BTC-USD"])
  await setup.waitForFrame((frame) => frame.includes("▸ ETH-USD"))

  // Refining keeps the stale 3-item list while the new fetch is in flight;
  // navigate to the last stale row before the shorter result arrives.
  await setup.mockInput.typeText("b")
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressArrow("down")
  await setup.waitForFrame((frame) => frame.includes("▸ BTC-USD"))

  resolveNext(["BTC-USD"])
  const clamped = await setup.waitForFrame((frame) => frame.includes("▸ BTC-USD") && !frame.includes("ETH-USD"))
  expect(clamped).toContain("▸ BTC-USD")

  // The clamped highlight is live: Tab accepts it instead of no-opping.
  setup.mockInput.pressTab()
  await setup.waitForFrame((frame) => frame.includes("/book BTC-USD"))
})

test("in the app, esc closes the dropdown first and only then the session", async () => {
  const mock = createMockApi({ sessions: [makeSession({ id: "ses_alpha", title: "alpha session" })] })
  active = await testRender(
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
        onExit={() => {}}
      />
    ),
    { width: 120, height: 40 },
  )

  await active.waitForFrame((frame) => frame.includes("alpha session"))
  active.mockInput.pressKey("ARROW_DOWN")
  active.mockInput.pressEnter()
  await active.waitForFrame((frame) => frame.includes("prompt"))

  // Command completion works app-wide with zero extra wiring.
  await active.mockInput.typeText("/boo")
  await active.waitForFrame((frame) => frame.includes("▸ /book"))

  // First Esc only dismisses the dropdown; the session stays open.
  await pressEscape(active)
  const stillOpen = await active.waitForFrame((frame) => !frame.includes("▸ /book"))
  expect(stillOpen).toContain("prompt")
  expect(stillOpen).not.toContain("+ new session")

  // Second Esc closes the session as before.
  await pressEscape(active)
  const list = await active.waitForFrame((frame) => frame.includes("+ new session"))
  expect(list).toContain("alpha session")
})

test("enter with the dropdown open accepts in the app instead of prompting the server", async () => {
  const mock = createMockApi({ sessions: [makeSession({ id: "ses_alpha", title: "alpha session" })] })
  active = await testRender(
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
        onExit={() => {}}
      />
    ),
    { width: 120, height: 40 },
  )

  await active.waitForFrame((frame) => frame.includes("alpha session"))
  active.mockInput.pressKey("ARROW_DOWN")
  active.mockInput.pressEnter()
  await active.waitForFrame((frame) => frame.includes("prompt"))

  await active.mockInput.typeText("/healt")
  await active.waitForFrame((frame) => frame.includes("▸ /health"))
  active.mockInput.pressEnter()

  // Acceptance completed "/health " without submitting anything.
  await active.waitForFrame((frame) => frame.includes("/health") && !frame.includes("▸ /health"))
  expect(mock.prompts).toEqual([])
})
