import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMError, LLMEvent } from "../../src"
import { LLMClient } from "../../src/route"
import * as OpenAICodex from "../../src/providers/openai-codex"
import { weatherTool } from "../recorded-scenarios"
import { recordedTests } from "../recorded-test"

// The replay cassettes for this suite are hand-authored against the observed
// codex-responses wire shape (see the adapter's assumption notes) — the
// backend is undocumented, so they pin the adapter's behavior rather than a
// live recording. Re-recording with RECORD=true requires a real ChatGPT OAuth
// access token in CHATGPT_OAUTH_ACCESS_TOKEN (plus CHATGPT_ACCOUNT_ID) and
// overwrites the hand-authored pins.
const model = OpenAICodex.configure({
  accessToken: process.env.CHATGPT_OAUTH_ACCESS_TOKEN ?? "fixture-access-token",
  accountId: process.env.CHATGPT_ACCOUNT_ID ?? "fixture-account",
  sessionId: "8f4f2b9c-3a60-4d2b-9c5e-1f2a3b4c5d6e",
}).model("gpt-5.5")

const textRequest = LLM.request({
  id: "recorded_codex_text",
  model,
  system: "You are a concise assistant.",
  prompt: "Reply with the single word: pong.",
})

const toolRequest = LLM.request({
  id: "recorded_codex_tool",
  model,
  system: "Use the get_weather tool, then answer in one short sentence.",
  prompt: "What is the weather in Paris?",
  tools: [weatherTool],
})

const recorded = recordedTests({
  prefix: "openai-codex-responses",
  provider: "openai",
  protocol: "openai-codex-responses",
  requires: ["CHATGPT_OAUTH_ACCESS_TOKEN", "CHATGPT_ACCOUNT_ID"],
})

describe("OpenAI Codex Responses recorded", () => {
  recorded.effect("streams a text turn", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(textRequest)

      expect(response.text).toBe("pong")
      expect(response.events.find(LLMEvent.is.finish)?.reason).toBe("stop")
      expect(response.usage?.inputTokens).toBe(42)
      expect(response.usage?.cacheReadInputTokens).toBe(12)
      expect(response.usage?.outputTokens).toBe(4)
      expect(response.usage?.totalTokens).toBe(46)
    }),
  )

  recorded.effect.with("streams a tool call turn", { tags: ["tool"] }, () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(toolRequest)

      expect(response.toolCalls).toMatchObject([{ id: "call_codex_1", name: "get_weather", input: { city: "Paris" } }])
      expect(response.events.find(LLMEvent.is.finish)?.reason).toBe("tool-calls")
    }),
  )

  recorded.effect.with("maps invalid credentials to an authentication error", { tags: ["sad-path"] }, () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(
        LLM.updateRequest(textRequest, { id: "recorded_codex_unauthorized" }),
      ).pipe(Effect.flip)

      expect(error).toBeInstanceOf(LLMError)
      expect(error.reason).toMatchObject({ _tag: "Authentication", kind: "invalid" })
      expect(error.message).toContain("HTTP 401")
    }),
  )
})
