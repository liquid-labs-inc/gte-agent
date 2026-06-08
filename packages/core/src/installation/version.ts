declare global {
  const GTE_AGENT_VERSION: string
  const GTE_AGENT_CHANNEL: string
}

export const InstallationVersion = typeof GTE_AGENT_VERSION === "string" ? GTE_AGENT_VERSION : "local"
export const InstallationChannel = typeof GTE_AGENT_CHANNEL === "string" ? GTE_AGENT_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
