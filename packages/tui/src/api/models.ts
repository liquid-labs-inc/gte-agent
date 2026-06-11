/**
 * Typed raw-fetch wrapper for the Milestone 7 model-catalog and provider-auth
 * routes (`/api/models`, `/api/auth/...`). The generated SDK predates these
 * routes, so — like the GTE data client — this goes straight to the canonical
 * HTTP API through the same fetch function as everything else.
 *
 * SECURITY: pasted credentials flow through `storeApiKey` / `oauthComplete`
 * request bodies only. Responses never contain secret material (the server
 * guarantees it; nothing here logs, stores, or rethrows request bodies).
 */

/** `variant` admits null so SDK session models (nullable optionals) assign cleanly. */
export type ModelRef = { readonly id: string; readonly providerID: string; readonly variant?: string | null }

export type ModelsAuthStatus = {
  readonly authenticated: boolean
  readonly method?: "api_key" | "oauth"
  readonly source?: "config" | "store" | "env"
}

export type CatalogModel = {
  readonly id: string
  readonly name: string
  readonly family?: string
  readonly status: "alpha" | "beta" | "deprecated" | "active"
  readonly released: number
  readonly capabilities: { readonly tools: boolean }
  readonly limit: { readonly context: number; readonly output: number }
  readonly isDefault: boolean
}

export type CatalogProvider = {
  readonly id: string
  readonly name: string
  readonly auth: ModelsAuthStatus
  readonly models: readonly CatalogModel[]
}

export type ModelsCatalog = {
  readonly providers: readonly CatalogProvider[]
  readonly default?: ModelRef
  readonly session?: { readonly id: string; readonly model?: ModelRef }
}

export type ProviderAuthState = {
  readonly provider: string
  readonly method: "api_key" | "oauth" | "env" | "none"
  readonly authed: boolean
  readonly accountId: boolean
}

export type OAuthStart = {
  readonly flow: string
  readonly url: string
  readonly callback: { readonly listening: boolean; readonly port?: number }
}

export class ModelsRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly tag?: string,
  ) {
    super(message)
    this.name = "ModelsRequestError"
  }
}

export interface ModelsApi {
  /** Curated catalog grouped by provider, with auth status and current selections. */
  list(sessionID?: string): Promise<ModelsCatalog>
  /** Strict selection: persists on the session (when given) and as the global default. */
  select(input: {
    providerID: string
    modelID: string
    variant?: string
    sessionID?: string
  }): Promise<{ model: ModelRef; name: string; auth: ModelsAuthStatus }>
  authStatus(): Promise<readonly ProviderAuthState[]>
  /** Store a pasted API key (or Anthropic setup-token; the server classifies it). */
  storeApiKey(provider: string, key: string, type?: "api_key" | "setup_token"): Promise<ProviderAuthState>
  oauthStart(provider: string): Promise<OAuthStart>
  /**
   * Finish a pending OAuth flow. Without `redirect` this waits server-side for
   * the localhost callback (long poll); with `redirect` it completes from a
   * pasted redirect URL.
   */
  oauthComplete(provider: string, flow: string, redirect?: string): Promise<ProviderAuthState>
}

export function createModelsApi(input: { baseUrl: string; fetch: typeof fetch }): ModelsApi {
  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await input.fetch(`${input.baseUrl}${path}`, init)
    const text = await response.text()
    let body: unknown
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      body = undefined
    }
    if (!response.ok) {
      const error = (body ?? {}) as { _tag?: string; message?: string }
      const message = typeof error.message === "string" ? error.message : `Request failed: HTTP ${response.status}`
      throw new ModelsRequestError(message, response.status, error._tag)
    }
    return body
  }

  const post = (path: string, body: Record<string, unknown>) =>
    request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const enc = encodeURIComponent

  return {
    async list(sessionID) {
      const result = (await request(
        sessionID === undefined ? "/api/models" : `/api/models?sessionID=${enc(sessionID)}`,
      )) as { data: ModelsCatalog }
      return result.data
    },

    async select(selection) {
      const result = (await post("/api/models/select", {
        providerID: selection.providerID,
        modelID: selection.modelID,
        ...(selection.variant === undefined ? {} : { variant: selection.variant }),
        ...(selection.sessionID === undefined ? {} : { sessionID: selection.sessionID }),
      })) as { data: { model: ModelRef; name: string; auth: ModelsAuthStatus } }
      return result.data
    },

    async authStatus() {
      const result = (await request("/api/auth/status")) as { data: readonly ProviderAuthState[] }
      return result.data
    },

    async storeApiKey(provider, key, type) {
      const result = (await post(`/api/auth/${enc(provider)}/api-key`, {
        key,
        ...(type === undefined ? {} : { type }),
      })) as { data: ProviderAuthState }
      return result.data
    },

    async oauthStart(provider) {
      const result = (await post(`/api/auth/${enc(provider)}/oauth/start`, {})) as { data: OAuthStart }
      return result.data
    },

    async oauthComplete(provider, flow, redirect) {
      const result = (await post(`/api/auth/${enc(provider)}/oauth/complete`, {
        flow,
        ...(redirect === undefined ? {} : { redirect }),
      })) as { data: ProviderAuthState }
      return result.data
    },
  }
}
