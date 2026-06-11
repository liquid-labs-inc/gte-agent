import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, Message, ToolCallPart } from "../../src"
import { Auth, LLMClient } from "../../src/route"
import * as OpenAICodex from "../../src/providers/openai-codex"
import * as OpenAICodexResponses from "../../src/protocols/openai-codex-responses"
import { it } from "../lib/effect"
import { dynamicResponse } from "../lib/http"
import { sseEvents } from "../lib/sse"

const SESSION_ID = "0d51e1f0-0000-4000-8000-000000000000"

const provider = OpenAICodex.configure({
  accessToken: "fixture-access-token",
  accountId: "acct_fixture",
  sessionId: SESSION_ID,
})

const model = provider.model("gpt-5.5")

const request = LLM.request({
  id: "req_codex_1",
  model,
  system: "You are GTE, a read-only trading-data assistant.",
  prompt: "Say hello.",
  generation: { maxTokens: 20, temperature: 0, topP: 0.5 },
})

const completedResponse = sseEvents({ type: "response.completed", response: { id: "resp_1" } })

describe("OpenAI Codex Responses route", () => {
  it.effect("hoists the system prompt into instructions and strips generation knobs", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAICodexResponses.OpenAICodexResponsesBody>(request)

      expect(prepared.route).toBe("openai-codex-responses")
      expect(prepared.protocol).toBe("openai-codex-responses")
      expect(prepared.body).toEqual({
        model: "gpt-5.5",
        input: [{ role: "user", content: [{ type: "input_text", text: "Say hello." }] }],
        stream: true,
        instructions: "You are GTE, a read-only trading-data assistant.",
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "medium", summary: "auto" },
        text: { verbosity: "low" },
      })
    }),
  )

  it.effect("forces store false even when provider options ask for stored responses", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAICodexResponses.OpenAICodexResponsesBody>(
        LLM.updateRequest(request, {
          providerOptions: { openai: { store: true } },
        }),
      )

      expect(prepared.body.store).toBe(false)
    }),
  )

  it.effect("always includes encrypted reasoning content for stateless continuations", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAICodexResponses.OpenAICodexResponsesBody>(
        LLM.request({
          model: provider.model("codex-mini-latest"),
          prompt: "Hi.",
        }),
      )

      expect(prepared.body.include).toEqual(["reasoning.encrypted_content"])
    }),
  )

  it.effect("merges provider-option instructions ahead of the system prompt", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAICodexResponses.OpenAICodexResponsesBody>(
        LLM.updateRequest(request, {
          providerOptions: { openai: { instructions: "Base instructions." } },
        }),
      )

      expect(prepared.body.instructions).toBe(
        "Base instructions.\n\nYou are GTE, a read-only trading-data assistant.",
      )
    }),
  )

  it.effect("sends an empty instructions field when there is no system prompt", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAICodexResponses.OpenAICodexResponsesBody>(
        LLM.request({ model, prompt: "Hi." }),
      )

      expect(prepared.body.instructions).toBe("")
    }),
  )

  it.effect("lowers tool calls and tool results like the Responses protocol", () =>
    Effect.gen(function* () {
      const prepared = yield* LLMClient.prepare<OpenAICodexResponses.OpenAICodexResponsesBody>(
        LLM.request({
          model,
          messages: [
            Message.user("What is the weather?"),
            Message.assistant([ToolCallPart.make({ id: "call_1", name: "get_weather", input: { city: "Paris" } })]),
            Message.tool({ id: "call_1", name: "get_weather", result: { temperature: "72F" } }),
          ],
        }),
      )

      expect(prepared.body.input).toEqual([
        { role: "user", content: [{ type: "input_text", text: "What is the weather?" }] },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' },
        { type: "function_call_output", call_id: "call_1", output: '{"temperature":"72F"}' },
      ])
    }),
  )

  it.effect("sends codex headers, bearer token, and account id to the codex backend", () =>
    LLMClient.generate(request).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.url).toBe("https://chatgpt.com/backend-api/codex/responses")
            expect(web.headers.get("authorization")).toBe("Bearer fixture-access-token")
            expect(web.headers.get("chatgpt-account-id")).toBe("acct_fixture")
            expect(web.headers.get("originator")).toBe("codex_cli_rs")
            expect(web.headers.get("session_id")).toBe(SESSION_ID)
            expect(web.headers.get("openai-beta")).toBe("responses=experimental")
            return input.respond(completedResponse, { headers: { "content-type": "text/event-stream" } })
          }),
        ),
      ),
    ),
  )

  it.effect("omits the account id header when the credential has none", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: OpenAICodex.configure({ accessToken: "fixture-access-token" }).model("gpt-5.5"),
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.headers.get("chatgpt-account-id")).toBeNull()
            expect(web.headers.get("session_id")).toMatch(/^[0-9a-f-]{36}$/)
            return input.respond(completedResponse, { headers: { "content-type": "text/event-stream" } })
          }),
        ),
      ),
    ),
  )

  it.effect("lets a custom originator and base URL override the codex defaults", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: OpenAICodex.configure({
          accessToken: "fixture-access-token",
          baseURL: "https://codex.test/backend-api/codex/",
          originator: "gte_agent",
          sessionId: SESSION_ID,
        }).model("gpt-5.5"),
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.url).toBe("https://codex.test/backend-api/codex/responses")
            expect(web.headers.get("originator")).toBe("gte_agent")
            return input.respond(completedResponse, { headers: { "content-type": "text/event-stream" } })
          }),
        ),
      ),
    ),
  )

  it.effect("lets an explicit auth pipeline replace the access-token bearer", () =>
    LLMClient.generate(
      LLM.updateRequest(request, {
        model: OpenAICodex.configure({
          auth: Auth.bearer("refreshed-token"),
          sessionId: SESSION_ID,
        }).model("gpt-5.5"),
      }),
    ).pipe(
      Effect.provide(
        dynamicResponse((input) =>
          Effect.gen(function* () {
            const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
            expect(web.headers.get("authorization")).toBe("Bearer refreshed-token")
            return input.respond(completedResponse, { headers: { "content-type": "text/event-stream" } })
          }),
        ),
      ),
    ),
  )

  it.effect("fails with a missing-credential auth error when the access token is empty", () =>
    Effect.gen(function* () {
      const error = yield* LLMClient.generate(
        LLM.updateRequest(request, {
          model: OpenAICodex.configure({ accessToken: "" }).model("gpt-5.5"),
        }),
      ).pipe(
        Effect.flip,
        Effect.provide(
          dynamicResponse((input) => Effect.die(new Error(`unexpected request to ${input.request.url}`))),
        ),
      )

      expect(error.reason).toMatchObject({ _tag: "Authentication", kind: "missing" })
    }),
  )

  it.effect("streams text and tool calls through the shared Responses parser", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(request).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.succeed(
              input.respond(
                sseEvents(
                  { type: "response.output_text.delta", item_id: "msg_1", delta: "GTE " },
                  { type: "response.output_text.delta", item_id: "msg_1", delta: "is live." },
                  {
                    type: "response.output_item.added",
                    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "" },
                  },
                  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"city":"Paris"}' },
                  {
                    type: "response.output_item.done",
                    item: {
                      type: "function_call",
                      id: "fc_1",
                      call_id: "call_1",
                      name: "get_weather",
                      arguments: '{"city":"Paris"}',
                    },
                  },
                  {
                    type: "response.completed",
                    response: { id: "resp_1", usage: { input_tokens: 10, output_tokens: 7, total_tokens: 17 } },
                  },
                ),
                { headers: { "content-type": "text/event-stream" } },
              ),
            ),
          ),
        ),
      )

      expect(response.text).toBe("GTE is live.")
      expect(response.toolCalls).toMatchObject([{ name: "get_weather", input: { city: "Paris" } }])
      expect(response.usage?.totalTokens).toBe(17)
    }),
  )
})

