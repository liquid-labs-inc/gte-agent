/**
 * Auth-stub status, derived from the same environment configuration the
 * canonical runtime reads (packages/core/src/gte-auth.ts ConfigService).
 * There is no dedicated auth status route in Phase 1.
 */

export const DEV_PRINCIPAL_ID = "dev_principal"
export const DEV_AUTHORITY_ID = "dev_authority"

export type AuthStatus = {
  readonly mode: "disabled" | "bearer"
  /** True when running on the auth stub with synthetic identities. */
  readonly stub: boolean
  readonly principalID: string
  readonly authorityIDs: readonly string[]
}

export function readAuthStatus(env: Record<string, string | undefined> = process.env): AuthStatus {
  const mode = env["GTE_AGENT_AUTH_MODE"] === "bearer" ? "bearer" : "disabled"
  const authorities = (env["GTE_AGENT_AUTHORITY_IDS"] ?? DEV_AUTHORITY_ID)
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return {
    mode,
    stub: mode === "disabled",
    principalID: env["GTE_AGENT_PRINCIPAL_ID"] ?? DEV_PRINCIPAL_ID,
    authorityIDs: authorities.length > 0 ? authorities : [DEV_AUTHORITY_ID],
  }
}

export function formatAuthStatus(status: AuthStatus): string {
  const mode = status.stub ? "disabled (stub)" : status.mode
  return `auth ${mode} · principal ${status.principalID} · authority ${status.authorityIDs.join(",")}`
}
