export * as WorkflowSchema from "./schema"

import { Schema } from "effect"
import { NonNegativeInt, withStatics } from "../schema"
import { SessionSchema } from "../session/schema"
import { TimeSchema } from "../time-schema"
import { Identifier } from "../util/identifier"

export const RunID = Schema.String.check(Schema.isStartsWith("wfr_")).pipe(
  Schema.brand("WorkflowRunID"),
  withStatics((schema) => ({
    create: () => schema.make("wfr_" + Identifier.ascending()),
  })),
)
export type RunID = typeof RunID.Type

export const RUN_STATUSES = ["running", "paused", "completed", "failed", "stopped"] as const
export const RunStatus = Schema.Literals(RUN_STATUSES)
export type RunStatus = typeof RunStatus.Type

export const TERMINAL_STATUSES = ["completed", "failed", "stopped"] as const
export const TerminalStatus = Schema.Literals(TERMINAL_STATUSES)
export type TerminalStatus = typeof TerminalStatus.Type

export const AGENT_STATUSES = ["queued", "running", "completed", "failed", "stopped"] as const
export const AgentStatus = Schema.Literals(AGENT_STATUSES)
export type AgentStatus = typeof AgentStatus.Type

export const PhaseStatus = Schema.Literals(["running", "completed"])
export type PhaseStatus = typeof PhaseStatus.Type

/** Token usage aggregated from the child sessions a run spawns. */
export const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
}).annotate({ identifier: "Workflow.Tokens" })
export type Tokens = typeof Tokens.Type

/** Bound on the stored prompt head; the full prompt lives in the child session transcript. */
export const MAX_PROMPT_HEAD = 200

export const AgentInfo = Schema.Struct({
  /** Run-scoped agent id ("a1", "a2", ...): stable across snapshots, meaningless across runs. */
  id: Schema.String,
  phase: Schema.String,
  prompt: Schema.String.check(Schema.isMaxLength(MAX_PROMPT_HEAD)),
  /**
   * Effective "providerID/modelID" once execution settles; reflects any
   * fallback to the parent session's model, so it may differ from what the
   * script requested.
   */
  model: Schema.String.pipe(Schema.optional),
  variant: Schema.String.pipe(Schema.optional),
  /** Child session executing this agent, once created. */
  sessionID: SessionSchema.ID.pipe(Schema.optional),
  status: AgentStatus,
  tokens: Tokens,
  error: Schema.String.pipe(Schema.optional),
  time: Schema.Struct({
    started: TimeSchema.DateTimeUtcFromMillis,
    finished: TimeSchema.DateTimeUtcFromMillis.pipe(Schema.optional),
  }),
}).annotate({ identifier: "Workflow.AgentInfo" })
export type AgentInfo = typeof AgentInfo.Type

export const PhaseInfo = Schema.Struct({
  name: Schema.String,
  status: PhaseStatus,
  agents: NonNegativeInt,
  tokens: Tokens,
}).annotate({ identifier: "Workflow.PhaseInfo" })
export type PhaseInfo = typeof PhaseInfo.Type

export const LogLine = Schema.Struct({
  time: TimeSchema.DateTimeUtcFromMillis,
  message: Schema.String,
}).annotate({ identifier: "Workflow.LogLine" })
export type LogLine = typeof LogLine.Type

/**
 * Full run snapshot: the single shape shared by the ephemeral
 * `session.workflow.updated` event, the HTTP snapshot routes, and the TUI.
 * Snapshot rather than delta so consumers replace state wholesale.
 */
export class RunInfo extends Schema.Class<RunInfo>("Workflow.RunInfo")({
  id: RunID,
  sessionID: SessionSchema.ID,
  name: Schema.String,
  status: RunStatus,
  scriptPath: Schema.String,
  tokens: Tokens,
  time: Schema.Struct({
    started: TimeSchema.DateTimeUtcFromMillis,
    finished: TimeSchema.DateTimeUtcFromMillis.pipe(Schema.optional),
  }),
  /** Ordered by first activation; phase order is the script's observation order. */
  phases: PhaseInfo.pipe(Schema.Array),
  agents: AgentInfo.pipe(Schema.Array),
  /** Recent log() lines, oldest first, bounded by the runtime. */
  logs: LogLine.pipe(Schema.Array),
  result: Schema.String.pipe(Schema.optional),
  error: Schema.String.pipe(Schema.optional),
}) {}
