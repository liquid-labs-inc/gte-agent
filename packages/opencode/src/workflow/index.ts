// Ultrathink workflows: feature gating, ultrathink effort/keyword helpers, and
// the prompt snippets that opt the model into workflow planning.
import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

import { mentionsUltrathink, resolveUltrathinkVariant, ULTRATHINK_VARIANT as VARIANT } from "./ultrathink"

export { WorkflowProtocol } from "./protocol"
export { WorkflowRegistry } from "./registry"
export { WorkflowRunner } from "./run"
export { WorkflowScript } from "./script"
export { Ultrathink } from "./ultrathink"

export const ENV_DISABLE = "GTE_AGENT_DISABLE_WORKFLOWS"

/** Pseudo-variant selected via `/effort ultrathink`. */
export const ULTRATHINK_VARIANT = VARIANT

export function disabledByEnv(env: Record<string, string | undefined> = process.env): boolean {
  const value = env[ENV_DISABLE]?.toLowerCase()
  return value === "1" || value === "true"
}

export function enabled(
  config: Pick<ConfigV1.Info, "disableWorkflows">,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (disabledByEnv(env)) return false
  return config.disableWorkflows !== true
}

/**
 * Resolves the ultrathink pseudo-variant to the highest available reasoning
 * variant for the current model: `xhigh` if available, else `max`, else
 * `high`, else the model's last (conventionally strongest) variant.
 */
export function bestVariant(variants: string[]): string | undefined {
  return resolveUltrathinkVariant(variants) ?? variants.at(-1)
}

/** True when a non-synthetic user text part contains the ultrathink keyword. */
export function hasKeyword(parts: readonly { type: string; text?: unknown; synthetic?: unknown }[]): boolean {
  return parts.some(
    (part) =>
      part.type === "text" && part.synthetic !== true && typeof part.text === "string" && mentionsUltrathink(part.text),
  )
}

/** System prompt addition for `/effort ultrathink` (auto-orchestration). */
export const ULTRATHINK_SYSTEM = [
  "<ultrathink>",
  "Ultrathink effort is active for this session.",
  "For every substantive task (multi-file changes, audits, migrations, research, anything benefiting from parallel work), plan a dynamic workflow and launch it with the `workflow` tool instead of doing the work turn by turn:",
  "1. Break the task into phases; identify what can fan out to parallel agents.",
  "2. Write a workflow script using the injected API: phase(name, fn), agent({ prompt, type?, model?, variant? }), map(items, fn, { concurrency? }), log(message), and `args`. The script's return value is the workflow result.",
  "3. Launch it with the workflow tool, then briefly tell the user what is running. You will be notified when it finishes.",
  "Agents do all file reading/writing and command-running; the script only coordinates. Make agent prompts self-contained. A single request may warrant several workflows in sequence (understand, change, verify).",
  "Trivial questions and single-step edits do not need a workflow.",
  "</ultrathink>",
].join("\n")

/** System prompt addition when the prompt contains the ultrathink keyword or /workflow is used. */
export const KEYWORD_SYSTEM = [
  "<workflow-request>",
  "The user opted this task into workflow execution (ultrathink keyword or /workflow command).",
  "Run the task as a dynamic workflow: write an orchestration script (phase/agent/map/log/args API) and launch it with the `workflow` tool. The script coordinates; spawned agents do all the actual work. Fan independent items out with map() and bounded concurrency. Return the final synthesized result from the script.",
  "After launching, briefly tell the user what is running; you will be notified when the workflow completes.",
  "</workflow-request>",
].join("\n")

export * as Workflow from "."
