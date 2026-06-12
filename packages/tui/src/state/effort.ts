/**
 * Pure resolution for the `/effort` slash command (Milestone 8).
 *
 * The named tiers re-select the active model with that reasoning-effort variant
 * through the existing models.select path; a named tier the model does not offer
 * is reported up front with the tiers it does offer, never selected blindly (a
 * dangling variant bricks every later turn). `ultrathink` is special: it picks
 * the model's highest tier and turns on the session-local ultrathink flag so the
 * TUI prepends the keyword to later prompts and the server detector adds the
 * workflow-orchestration instruction. A model with no variants can still take
 * `ultrathink` (the flag alone, without a variant change).
 */

export const EFFORT_TIERS = ["low", "medium", "high", "xhigh", "max"] as const
export type EffortTier = (typeof EFFORT_TIERS)[number]

export const EFFORT_NAMES = [...EFFORT_TIERS, "ultrathink"] as const

export function isEffortTier(value: string): value is EffortTier {
  return (EFFORT_TIERS as readonly string[]).includes(value)
}

/** ultrathink resolves to the highest variant the model offers: xhigh, else max, else high. */
export function highestVariant(variants: readonly string[]): string | undefined {
  for (const tier of ["xhigh", "max", "high"]) if (variants.includes(tier)) return tier
  return undefined
}

export type EffortResolution =
  /** Re-select the active model with this variant. */
  | { readonly kind: "select"; readonly variant: EffortTier }
  /** Turn on the ultrathink flag and re-select with the resolved highest variant, when one exists. */
  | { readonly kind: "ultrathink"; readonly variant?: string }
  /** Nothing to do; surface this message. */
  | { readonly kind: "unavailable"; readonly message: string }

/**
 * Resolves `/effort <name>` against a model's available variants. `ultrathink`
 * always succeeds (the flag applies even without a variant); a named tier the
 * model lacks is unavailable so it never persists a dangling variant.
 */
export function resolveEffort(name: string, model: { ref: string; variants: readonly string[] }): EffortResolution {
  if (name === "ultrathink") {
    const variant = highestVariant(model.variants)
    return { kind: "ultrathink", ...(variant === undefined ? {} : { variant }) }
  }
  if (!isEffortTier(name)) {
    return { kind: "unavailable", message: `Unknown effort tier "${name}". Use one of: ${EFFORT_NAMES.join(", ")}.` }
  }
  if (!model.variants.includes(name)) {
    return { kind: "unavailable", message: unavailableMessage(name, model) }
  }
  return { kind: "select", variant: name }
}

function unavailableMessage(name: string, model: { ref: string; variants: readonly string[] }): string {
  if (model.variants.length === 0) {
    return `${model.ref} has no reasoning-effort variants, so /effort ${name} is unavailable. Try /effort ultrathink for workflow orchestration.`
  }
  return `Effort "${name}" is not available for ${model.ref}. It offers: ${model.variants.join(", ")}.`
}
