export * as AuthAnthropic from "./anthropic"

import type { AuthSchema } from "./schema"

/** Claude setup-tokens (issued by `claude setup-token`) are long-lived OAuth access tokens. */
export const SETUP_TOKEN_PREFIX = "sk-ant-oat"

/** Beta flag Anthropic requires when authenticating with an OAuth bearer instead of x-api-key. */
export const OAUTH_BETA = "oauth-2025-04-20"

export function apiKeyProfile(key: string): AuthSchema.Profile {
  return { type: "api_key", key }
}

/** Setup-tokens cannot be refreshed: `refresh: ""` and `expires: 0` mark them never-expiring. */
export function setupTokenProfile(token: string): AuthSchema.Profile {
  return { type: "oauth", access: token, refresh: "", expires: 0 }
}

/**
 * Classifies a pasted Anthropic credential: setup-tokens (`sk-ant-oat…`) become
 * oauth profiles, anything else an api_key profile. Returns undefined for blank input.
 */
export function fromPaste(pasted: string): AuthSchema.Profile | undefined {
  const value = pasted.trim()
  if (value.length === 0) return undefined
  if (value.startsWith(SETUP_TOKEN_PREFIX)) return setupTokenProfile(value)
  return apiKeyProfile(value)
}

/**
 * Request auth headers per credential type: api_key profiles use x-api-key,
 * oauth profiles send an OAuth bearer plus the required anthropic-beta flag.
 */
export function requestHeaders(profile: AuthSchema.Profile): Record<string, string> {
  if (profile.type === "api_key") return { "x-api-key": profile.key }
  return { authorization: `Bearer ${profile.access}`, "anthropic-beta": OAUTH_BETA }
}
