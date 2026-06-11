export * as SessionRunnerDefault from "./default"

import { LLMClient, RequestExecutor } from "@gte-agent/llm/route"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AuthStore } from "../../auth/store"
import { ModelSelection } from "../../model-selection"
import { PluginBoot } from "../../plugin/boot"
import * as SessionRunnerDemo from "./demo"
import * as SessionRunnerLLM from "./llm"
import { SessionRunnerModel } from "./model"
import { SessionRunnerSystemPrompt } from "./system-prompt"

/**
 * Real provider runner: the session's model resolves strictly through the
 * curated catalog and the auth store, requests stream over HTTP through the
 * provider clients in @gte-agent/llm, and the GTE system prompt is applied.
 *
 * Remaining requirements (Event, Database, SessionStore, ToolRegistry,
 * SystemContextRegistry, Catalog, FSUtil, Global) are runtime-scope and
 * process services the embedding composition provides.
 */
const realLayer = SessionRunnerLLM.layer.pipe(
  Layer.provide(SessionRunnerSystemPrompt.layer),
  Layer.provide(LLMClient.layer),
  Layer.provide(RequestExecutor.defaultLayer),
  Layer.provide(SessionRunnerModel.runtimeScopeLayer),
  Layer.provide(ModelSelection.layer),
  Layer.provide(AuthStore.layer),
  Layer.provide(PluginBoot.layer),
  Layer.provide(FetchHttpClient.layer),
)

/**
 * Production session runner gate. The deterministic demo client survives only
 * behind `GTE_AGENT_LLM=demo` (deterministic tests); every other value — and
 * the default — is the real provider path. Missing models or credentials on
 * the real path fail visibly; the demo client is never a silent fallback.
 *
 * The gate reads the environment when the layer is built, not at module load,
 * so test setups that assign `process.env.GTE_AGENT_LLM` before building the
 * runtime are honored.
 */
export const layer = Layer.unwrap(
  Effect.sync(() => (process.env.GTE_AGENT_LLM === "demo" ? SessionRunnerDemo.layer : realLayer)),
)
