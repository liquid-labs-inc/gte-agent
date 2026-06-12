// Ultrathink effort mode: a pseudo-variant that resolves to the highest
// reasoning variant the current model offers and opts the session into
// workflow planning for substantive tasks.
//
// Clients may send `variant: "ultrathink"` with any prompt; the server remaps
// it to a real variant in SessionPrompt.createUserMessage and injects the
// workflow-planning instruction. The literal word "ultrathink" in a user
// prompt opts in the same way.
export const ULTRATHINK_VARIANT = "ultrathink"

/** Highest-first preference order for the underlying reasoning variant. */
export const ULTRATHINK_PREFERENCE = ["xhigh", "max", "high"] as const

export function isUltrathink(variant: string | undefined): boolean {
  return variant === ULTRATHINK_VARIANT
}

/** Pick the highest available reasoning variant: xhigh > max > high. */
export function resolveUltrathinkVariant(variants: string[]): string | undefined {
  for (const candidate of ULTRATHINK_PREFERENCE) {
    if (variants.includes(candidate)) return candidate
  }
  return undefined
}

/** Variant options offered by effort cycling, with ultrathink appended when available. */
export function ultrathinkOptions(variants: string[], enabled: boolean): string[] {
  if (!enabled) return variants
  if (variants.length === 0) return variants
  if (!resolveUltrathinkVariant(variants)) return variants
  return [...variants, ULTRATHINK_VARIANT]
}

/** Client-side kill-switch check (config-independent). */
export function ultrathinkDisabledByEnv(): boolean {
  const env = process.env["GTE_AGENT_DISABLE_WORKFLOWS"]
  return env === "1" || env === "true"
}

const KEYWORD = /(^|[^a-zA-Z0-9])ultrathink([^a-zA-Z0-9]|$)/i

export function mentionsUltrathink(text: string): boolean {
  return KEYWORD.test(text)
}

export const ULTRATHINK_INSTRUCTION = [
  "<system-reminder>",
  "ultrathink mode is active for this request.",
  "If the task is substantive (multi-step, parallelizable, research-like, or spanning many files/topics),",
  "plan it as a workflow and launch it with the `workflow` tool: break it into phases, fan independent",
  "work out across agents with map(), and synthesize the results in a final phase.",
  "Handle the task directly only when it is small enough that a workflow would be overhead.",
  "</system-reminder>",
].join("\n")

export * as Ultrathink from "./ultrathink"
