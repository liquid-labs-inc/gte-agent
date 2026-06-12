// Typed workflow events published through the EventV2 bridge so the TUI and
// server API can subscribe to live run progress.
import { Schema } from "effect"
import { EventV2 } from "@opencode-ai/core/event"

export const RunStatus = Schema.Literals(["running", "paused", "completed", "error", "cancelled"])
export const AgentStatus = Schema.Literals(["queued", "running", "completed", "error", "cancelled"])

export const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
})

export const Event = {
  RunStarted: EventV2.define({
    type: "workflow.run.started",
    schema: {
      runID: Schema.String,
      name: Schema.String,
      sessionID: Schema.optional(Schema.String),
      scriptPath: Schema.optional(Schema.String),
    },
  }),
  RunUpdated: EventV2.define({
    type: "workflow.run.updated",
    schema: {
      runID: Schema.String,
      status: RunStatus,
    },
  }),
  RunFinished: EventV2.define({
    type: "workflow.run.finished",
    schema: {
      runID: Schema.String,
      status: Schema.Literals(["completed", "error", "cancelled"]),
      error: Schema.optional(Schema.String),
    },
  }),
  PhaseStarted: EventV2.define({
    type: "workflow.phase.started",
    schema: {
      runID: Schema.String,
      name: Schema.String,
    },
  }),
  PhaseFinished: EventV2.define({
    type: "workflow.phase.finished",
    schema: {
      runID: Schema.String,
      name: Schema.String,
    },
  }),
  AgentStarted: EventV2.define({
    type: "workflow.agent.started",
    schema: {
      runID: Schema.String,
      agentID: Schema.String,
      phase: Schema.String,
    },
  }),
  AgentFinished: EventV2.define({
    type: "workflow.agent.finished",
    schema: {
      runID: Schema.String,
      agentID: Schema.String,
      phase: Schema.String,
      status: AgentStatus,
      tokens: Tokens,
    },
  }),
  Log: EventV2.define({
    type: "workflow.log",
    schema: {
      runID: Schema.String,
      message: Schema.String,
    },
  }),
}

export * as WorkflowSchema from "./schema"
