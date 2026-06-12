export * as BuiltInTools from "./builtins"

import { Layer } from "effect"
import { BashTool } from "./bash"
import { ApplyPatchTool } from "./apply-patch"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { GteTools } from "./gte/tools"
import { QuestionTool } from "./question"
import { ReadTool } from "./read"
import { SkillTool } from "./skill"
import { TodoWriteTool } from "./todowrite"
import { WebFetchTool } from "./webfetch"
import { WebSearchTool } from "./websearch"
import { WorkflowTool } from "./workflow"
import { WriteTool } from "./write"

/**
 * Composes only the shipped RuntimeScope-scoped built-in tool contributions.
 * Each tool retains its implementation and focused tests independently. Dynamic
 * MCP and plugin tools later use separate scoped ToolRegistry transforms, while
 * provider/model filtering belongs to a future materialization phase rather
 * than this static list. The caller intentionally supplies shared RuntimeScope
 * services once to this merged set.
 *
 * TODO: Port the remaining launch-follow-up leaves deliberately: edit fuzzy
 * parity, task, LSP,
 * repo_clone, repo_overview, plan_exit, and Rune/code mode. Keep MCP and plugin
 * contributions separate from this static built-in list.
 */
export const runtimeScopeLayer = Layer.mergeAll(
  ApplyPatchTool.layer,
  BashTool.layer,
  EditTool.layer,
  GlobTool.layer,
  GrepTool.layer,
  // Read-only GTE data tools bound to the shared env-configured GteData
  // service. Adds GteData.ConfigError to this layer's error channel on
  // purpose: an invalid GTE_AGENT_GTE_ENV should fail the composition root
  // eagerly (fail fast at startup) rather than on the first gte_* call.
  GteTools.runtimeScopeLayer,
  QuestionTool.layer,
  ReadTool.layer,
  SkillTool.layer,
  TodoWriteTool.layer,
  WebFetchTool.layer,
  WebSearchTool.layer.pipe(Layer.provide(WebSearchTool.defaultConfigLayer)),
  // Dynamic workflow orchestration, gated on the kill switch: the layer
  // contributes nothing when GTE_AGENT_DISABLE_WORKFLOWS is truthy or config
  // sets `workflows.enabled: false`.
  WorkflowTool.layer,
  WriteTool.layer,
)
