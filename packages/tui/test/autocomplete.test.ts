import { describe, expect, test } from "bun:test"
import { createGteApi } from "../src/api/gte"
import { createModelsApi } from "../src/api/models"
import { SLASH_COMMANDS, type CommandSpec } from "../src/commands/slash"
import {
  acceptCompletion,
  completionRequest,
  createCompletionSources,
  filterCommands,
  filterItems,
  moveSelection,
  type CompletionItem,
} from "../src/state/autocomplete"
import { createMockApi } from "./fixture/api"

const BASE_URL = "http://gte-agent.internal"

describe("arg-completion declarations", () => {
  const spec = (name: string): CommandSpec => {
    const found = SLASH_COMMANDS.find((candidate) => candidate.name === name)
    if (found === undefined) throw new Error(`missing command spec /${name}`)
    return found
  }

  test("symbol-taking commands complete their symbol position", () => {
    for (const name of ["market", "data", "book", "trades", "chart", "context", "quote", "liquidations"]) {
      expect(spec(name).argCompletions?.[0]).toBe("symbol")
    }
    // Address-first commands complete the symbol at position 1, never the address.
    for (const name of ["allowance", "leverage"]) {
      expect(spec(name).argCompletions?.[0]).toBeUndefined()
      expect(spec(name).argCompletions?.[1]).toBe("symbol")
    }
  })

  test("commands without declared sources stay completion-free", () => {
    for (const name of ["markets", "health", "env", "track", "positions"]) {
      expect(spec(name).argCompletions).toBeUndefined()
    }
  })
})

describe("completionRequest", () => {
  test("non-slash input never completes", () => {
    expect(completionRequest("", SLASH_COMMANDS)).toBeUndefined()
    expect(completionRequest("hello", SLASH_COMMANDS)).toBeUndefined()
    expect(completionRequest("what is /book?", SLASH_COMMANDS)).toBeUndefined()
  })

  test("a bare or partial command completes the command stage", () => {
    expect(completionRequest("/", SLASH_COMMANDS)).toEqual({ stage: "command", query: "" })
    expect(completionRequest("/bo", SLASH_COMMANDS)).toEqual({ stage: "command", query: "bo" })
  })

  test("a trailing space after a symbol command starts symbol completion", () => {
    expect(completionRequest("/book ", SLASH_COMMANDS)).toEqual({
      stage: "arg",
      source: "symbol",
      query: "",
      replaceFrom: 6,
    })
  })

  test("a partial token refines the symbol query and tracks its start", () => {
    expect(completionRequest("/book ET", SLASH_COMMANDS)).toEqual({
      stage: "arg",
      source: "symbol",
      query: "ET",
      replaceFrom: 6,
    })
    // Command names are case-insensitive, matching parseSlashCommand.
    expect(completionRequest("/BOOK ET", SLASH_COMMANDS)).toMatchObject({ stage: "arg", source: "symbol" })
  })

  test("positional sources only fire on their own arg index", () => {
    // /allowance <address> [symbol]: no completion for the address...
    expect(completionRequest("/allowance 0xab", SLASH_COMMANDS)).toBeUndefined()
    // ...but the symbol position completes.
    expect(completionRequest("/allowance 0xab ", SLASH_COMMANDS)).toEqual({
      stage: "arg",
      source: "symbol",
      query: "",
      replaceFrom: 16,
    })
    expect(completionRequest("/allowance 0xab et", SLASH_COMMANDS)).toMatchObject({ query: "et", replaceFrom: 16 })
    // /chart <symbol> [interval]: intervals have no source yet.
    expect(completionRequest("/chart eth 5", SLASH_COMMANDS)).toBeUndefined()
  })

  test("unknown and completion-free commands close the dropdown after the name", () => {
    expect(completionRequest("/nope ", SLASH_COMMANDS)).toBeUndefined()
    expect(completionRequest("/health ", SLASH_COMMANDS)).toBeUndefined()
    expect(completionRequest("/markets et", SLASH_COMMANDS)).toBeUndefined()
  })

  test("leading whitespace completes like parseSlashCommand executes", () => {
    // parseSlashCommand trims, so "  /boo" still runs; completion matches.
    expect(completionRequest("  /", SLASH_COMMANDS)).toEqual({ stage: "command", query: "" })
    expect(completionRequest("  /bo", SLASH_COMMANDS)).toEqual({ stage: "command", query: "bo" })
    // replaceFrom stays an index into the ORIGINAL (untrimmed) text.
    expect(completionRequest("  /book ET", SLASH_COMMANDS)).toEqual({
      stage: "arg",
      source: "symbol",
      query: "ET",
      replaceFrom: 8,
    })
    expect(completionRequest("   ", SLASH_COMMANDS)).toBeUndefined()
  })

  test("multiple spaces between args still index positions correctly", () => {
    expect(completionRequest("/allowance   0xab   ET", SLASH_COMMANDS)).toMatchObject({
      stage: "arg",
      source: "symbol",
      query: "ET",
    })
  })
})

describe("filterCommands", () => {
  test("an empty query lists the full registry in declaration order", () => {
    const items = filterCommands(SLASH_COMMANDS, "")
    expect(items.map((item) => item.label)).toEqual(SLASH_COMMANDS.map((spec) => `/${spec.name}`))
    expect(items[0].detail).toBe("/markets [query]")
  })

  test("fuzzy queries rank and narrow", () => {
    const labels = filterCommands(SLASH_COMMANDS, "boo").map((item) => item.label)
    expect(labels[0]).toBe("/book")
    expect(labels).not.toContain("/env")
    expect(filterCommands(SLASH_COMMANDS, "ordhis").map((item) => item.label)).toContain("/order-history")
  })

  test("no matches yields an empty list", () => {
    expect(filterCommands(SLASH_COMMANDS, "zzzzzz")).toEqual([])
  })
})

describe("filterItems", () => {
  const items: CompletionItem[] = [
    { insert: "ETH-USD", label: "ETH-USD" },
    { insert: "BTC-USD", label: "BTC-USD" },
    { insert: "SOL-USD", label: "SOL-USD" },
  ]

  test("empty query keeps provider order", () => {
    expect(filterItems(items, "").map((item) => item.insert)).toEqual(["ETH-USD", "BTC-USD", "SOL-USD"])
  })

  test("fuzzy query narrows", () => {
    expect(filterItems(items, "eth").map((item) => item.insert)).toEqual(["ETH-USD"])
    expect(filterItems(items, "xrp")).toEqual([])
  })
})

describe("acceptCompletion", () => {
  test("command acceptance replaces the whole text and opens arg entry", () => {
    const request = completionRequest("/bo", SLASH_COMMANDS)
    if (request === undefined) throw new Error("expected command request")
    expect(acceptCompletion("/bo", request, { insert: "/book", label: "/book" })).toBe("/book ")
  })

  test("arg acceptance replaces only the completed token", () => {
    const request = completionRequest("/book ET", SLASH_COMMANDS)
    if (request === undefined) throw new Error("expected arg request")
    expect(acceptCompletion("/book ET", request, { insert: "ETH-USD", label: "ETH-USD" })).toBe("/book ETH-USD")
  })

  test("command acceptance normalizes away leading whitespace", () => {
    const request = completionRequest("  /bo", SLASH_COMMANDS)
    if (request === undefined) throw new Error("expected command request")
    expect(acceptCompletion("  /bo", request, { insert: "/book", label: "/book" })).toBe("/book ")
  })

  test("arg acceptance under leading whitespace replaces only the token", () => {
    const request = completionRequest("  /book ET", SLASH_COMMANDS)
    if (request === undefined) throw new Error("expected arg request")
    expect(acceptCompletion("  /book ET", request, { insert: "ETH-USD", label: "ETH-USD" })).toBe("  /book ETH-USD")
  })

  test("arg acceptance on an empty token appends", () => {
    const request = completionRequest("/allowance 0xab ", SLASH_COMMANDS)
    if (request === undefined) throw new Error("expected arg request")
    expect(acceptCompletion("/allowance 0xab ", request, { insert: "ETH-USD", label: "ETH-USD" })).toBe(
      "/allowance 0xab ETH-USD",
    )
  })
})

describe("moveSelection", () => {
  test("wraps both directions and survives empty lists", () => {
    expect(moveSelection(3, 0, 1)).toBe(1)
    expect(moveSelection(3, 2, 1)).toBe(0)
    expect(moveSelection(3, 0, -1)).toBe(2)
    expect(moveSelection(0, 0, 1)).toBe(0)
  })
})

describe("createCompletionSources", () => {
  const sources = (options?: Parameters<typeof createMockApi>[0]) => {
    const mock = createMockApi({ markets: ["ETH-USD", "BTC-USD", "ETC-USD"], ...options })
    return createCompletionSources(
      createGteApi({ baseUrl: BASE_URL, fetch: mock.fetch }),
      createModelsApi({ baseUrl: BASE_URL, fetch: mock.fetch }),
    )
  }

  test("symbol source returns ambiguous candidates from symbol resolution", async () => {
    const items = await sources().symbol("usd")
    expect(items.map((item) => item.insert).sort()).toEqual(["BTC-USD", "ETC-USD", "ETH-USD"])
  })

  test("symbol source returns the single resolved symbol", async () => {
    expect(await sources().symbol("BTC")).toEqual([{ insert: "BTC-USD", label: "BTC-USD" }])
  })

  test("symbol source returns nothing for unknown symbols", async () => {
    expect(await sources().symbol("doge")).toEqual([])
  })

  test("model-ref source serves provider/model refs from the catalog with auth detail", async () => {
    const items = await sources()["model-ref"]("")
    expect(items.map((item) => item.insert)).toEqual([
      "anthropic/claude-fable-5",
      "anthropic/claude-haiku-4-5",
      "openai/gpt-5.5",
      "openai/gpt-5.4-mini",
    ])
    expect(items[0].detail).toBe("authed (api key via env)")
    expect(items[2].detail).toBe("needs setup")
    // The provider returns the full list; ranking happens in filterItems.
    const filtered = filterItems(items, "claude")
    expect(filtered.map((item) => item.insert)).toEqual(["anthropic/claude-fable-5", "anthropic/claude-haiku-4-5"])
  })

  test("model-ref source marks the persisted global default", async () => {
    const items = await sources({ defaultModel: { id: "claude-fable-5", providerID: "anthropic" } })["model-ref"]("")
    expect(items[0].detail).toBe("authed (api key via env) · default")
    expect(items[1].detail).toBe("authed (api key via env)")
  })

  test("model-ref source without a models api stays empty", async () => {
    const mock = createMockApi({})
    const bare = createCompletionSources(createGteApi({ baseUrl: BASE_URL, fetch: mock.fetch }))
    expect(await bare["model-ref"]("claude")).toEqual([])
  })

  test("model-ref source caches the catalog briefly across keystrokes", async () => {
    const mock = createMockApi({})
    const shared = createCompletionSources(
      createGteApi({ baseUrl: BASE_URL, fetch: mock.fetch }),
      createModelsApi({ baseUrl: BASE_URL, fetch: mock.fetch }),
    )
    await shared["model-ref"]("c")
    await shared["model-ref"]("cl")
    await shared["model-ref"]("cla")
    expect(mock.modelsRequests).toBe(1)
  })
})
