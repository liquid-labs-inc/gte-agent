import type { Config, Redacted } from "effect"
import { Auth } from "../route/auth"
import type { RouteDefaultsInput } from "../route/client"
import { ProviderID, type ModelID } from "../schema"
import * as OpenAICodexResponses from "../protocols/openai-codex-responses"
import { withOpenAIOptions, type OpenAIProviderOptionsInput } from "./openai-options"

// The codex route serves the same `openai` provider identity as the official
// API: catalog rows, costs, and model ids are shared. Selection between this
// facade and the official `OpenAI` facade happens by credential type — OAuth
// (ChatGPT sign-in) credentials route here, API keys keep the official path.
export const id = ProviderID.make("openai")

export const routes = [OpenAICodexResponses.route]

export type AccessTokenInput = string | Redacted.Redacted<string> | Config.Config<string | Redacted.Redacted<string>>

// OAuth access tokens never come from environment variables, so unlike the
// API-key facades there is no env fallback here: callers must pass the token
// (or a custom `Auth` that resolves it, e.g. with refresh-at-request-time).
export type CodexAuthOption =
  | { readonly auth: Auth; readonly accessToken?: never }
  | { readonly accessToken: AccessTokenInput; readonly auth?: never }

export type Options = RouteDefaultsInput &
  CodexAuthOption & {
    readonly baseURL?: string
    readonly queryParams?: Record<string, string>
    /** ChatGPT account id from the OAuth access-token JWT; sent as `chatgpt-account-id` when present. */
    readonly accountId?: string
    /** Conversation id sent as the `session_id` header. Defaults to a random UUID per `configure` call. */
    readonly sessionId?: string
    /** Client identity sent as the `originator` header. Defaults to the codex CLI's value. */
    readonly originator?: string
    readonly providerOptions?: OpenAIProviderOptionsInput
  }

const auth = (options: Options) => {
  if ("auth" in options && options.auth) return options.auth
  return Auth.optional("accessToken" in options ? options.accessToken : undefined, "accessToken").bearer()
}

const defaults = (options: Options) => {
  const {
    accessToken: _accessToken,
    auth: _auth,
    baseURL: _baseURL,
    queryParams: _queryParams,
    accountId: _accountId,
    sessionId: _sessionId,
    originator: _originator,
    ...rest
  } = options
  return rest
}

export const configure = (options: Options) => {
  const route = OpenAICodexResponses.route.with({
    auth: auth(options),
    endpoint: { baseURL: options.baseURL, query: options.queryParams },
    headers: {
      session_id: options.sessionId ?? crypto.randomUUID(),
      ...(options.originator ? { originator: options.originator } : {}),
      ...(options.accountId ? { "chatgpt-account-id": options.accountId } : {}),
    },
  })
  const modelDefaults = defaults(options)
  const responses = (modelID: string | ModelID) =>
    route.with(withOpenAIOptions(modelID, modelDefaults, { textVerbosity: true })).model({ id: modelID })

  return {
    id,
    model: responses,
    responses,
    configure,
  }
}

export const provider = {
  id,
  configure,
}
