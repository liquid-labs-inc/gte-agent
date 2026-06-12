import { Effect } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { HttpTransport } from "../route/transport"
import { Protocol } from "../route/protocol"
import { LLMRequest, mergeProviderOptions } from "../schema"
import * as OpenAIResponses from "./openai-responses"

const ADAPTER = "openai-codex-responses"

// The ChatGPT Codex backend (`chatgpt.com/backend-api/codex`) speaks the
// OpenAI Responses wire protocol, but it is an undocumented deployment that
// only accepts ChatGPT OAuth access tokens — never API keys. This adapter
// mirrors observed codex-CLI behavior; OpenAI can change the backend at any
// time, so behavior is pinned with recorded fixtures and the official
// API-key Responses route stays fully independent.
//
// Assumptions inherited from the codex CLI (upstream is undocumented):
//
// - Requests are streamed SSE (`stream: true`) and stateless
//   (`store: false`); the backend rejects stored responses for OAuth
//   credentials, so `store` is forced regardless of provider options.
// - The system prompt travels in the top-level `instructions` field, not as
//   a `system` role input item; the codex CLI never sends `system` items.
//   The field is always present. Whether the backend validates its content
//   is unverified — we send the caller's system prompt as-is.
// - Because requests are stateless, reasoning continuity requires
//   `include: ["reasoning.encrypted_content"]`; the codex CLI always sends
//   it, so the adapter guarantees it is present.
// - Generation knobs (`max_output_tokens`, `temperature`, `top_p`) are never
//   sent by the codex CLI and are stripped here rather than risking a 400
//   from the backend.
// - The codex CLI sends `originator` and `session_id` headers plus the
//   `OpenAI-Beta: responses=experimental` opt-in; the bearer access token and
//   the `chatgpt-account-id` header (when the OAuth profile carries an
//   account id) are applied by the provider facade.
export const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex"
export const PATH = "/responses"
export const DEFAULT_ORIGINATOR = "codex_cli_rs"
export const RESPONSES_BETA = "responses=experimental"

export type OpenAICodexResponsesBody = OpenAIResponses.OpenAIResponsesBody

const ENCRYPTED_REASONING = "reasoning.encrypted_content" as const

// Force `store: false` on the request before the base protocol sees it so
// message lowering (inline encrypted reasoning instead of item references)
// and the stream parser's reasoning lifecycle agree with the body we send.
const statelessRequest = (request: LLMRequest) =>
  LLMRequest.update(request, {
    providerOptions: mergeProviderOptions(request.providerOptions, { openai: { store: false } }),
  })

const fromRequest = Effect.fn("OpenAICodexResponses.fromRequest")(function* (request: LLMRequest) {
  const base = yield* OpenAIResponses.protocol.body.from(statelessRequest(request))
  const head = base.input[0]
  const system = head !== undefined && "role" in head && head.role === "system" ? head.content : undefined
  const { max_output_tokens: _maxOutputTokens, temperature: _temperature, top_p: _topP, ...body } = base
  return {
    ...body,
    input: system === undefined ? base.input : base.input.slice(1),
    instructions: [base.instructions, system]
      .filter((text): text is string => typeof text === "string" && text.length > 0)
      .join("\n\n"),
    store: false as const,
    include: base.include?.includes(ENCRYPTED_REASONING) ? base.include : [...(base.include ?? []), ENCRYPTED_REASONING],
  }
})

/**
 * The codex-responses protocol — the OpenAI Responses protocol as deployed on
 * the ChatGPT Codex backend. Reuses the Responses body schema and streaming
 * state machine wholesale; only request construction differs (stateless,
 * instructions-carried system prompt, stripped generation knobs).
 */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: OpenAIResponses.protocol.body.schema,
    from: fromRequest,
  },
  stream: {
    ...OpenAIResponses.protocol.stream,
    initial: (request) => OpenAIResponses.protocol.stream.initial(statelessRequest(request)),
  },
})

export const httpTransport = HttpTransport.sseJson.with<OpenAICodexResponsesBody>()

export const route = Route.make({
  id: ADAPTER,
  provider: "openai",
  protocol,
  endpoint: Endpoint.path<OpenAICodexResponsesBody>(PATH, { baseURL: DEFAULT_BASE_URL }),
  auth: Auth.none,
  transport: httpTransport,
  headers: () => ({
    "openai-beta": RESPONSES_BETA,
    originator: DEFAULT_ORIGINATOR,
  }),
})

export * as OpenAICodexResponses from "./openai-codex-responses"
