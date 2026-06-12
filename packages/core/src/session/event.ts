import { Schema } from "effect"
import { ProviderMetadata } from "@gte-agent/llm"
import { Event } from "../event"
import { Model } from "../model"
import { NonNegativeInt } from "../schema"
import { ToolOutput } from "../tool-output"
import { TimeSchema } from "../time-schema"
import { FileAttachment, Prompt } from "./prompt"
import { SessionSchema } from "./schema"
import { RuntimeScope } from "../runtime-scope"
import { RelativePath } from "../schema"
import { SessionMessageID } from "./message-id"

export { FileAttachment }

export const Source = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
  text: Schema.String,
}).annotate({
  identifier: "session.next.event.source",
})
export type Source = typeof Source.Type

const Base = {
  timestamp: TimeSchema.DateTimeUtcFromMillis,
  sessionID: SessionSchema.ID,
}

const options = {
  sync: {
    aggregate: "sessionID",
    version: 1,
  },
} as const
const stepSettlementOptions = {
  sync: {
    aggregate: "sessionID",
    version: 2,
  },
} as const

export const Created = Event.define({
  type: "session.created",
  sync: {
    aggregate: "sessionID",
    version: 2,
  },
  schema: {
    ...Base,
    info: SessionSchema.Info,
  },
})
export type Created = typeof Created.Type

export const UnknownError = Schema.Struct({
  type: Schema.Literal("unknown"),
  message: Schema.String,
}).annotate({
  identifier: "Session.Error.Unknown",
})
export type UnknownError = typeof UnknownError.Type

export const AgentSwitched = Event.define({
  type: "session.next.agent.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    agent: Schema.String,
  },
})
export type AgentSwitched = typeof AgentSwitched.Type

export const ModelSwitched = Event.define({
  type: "session.next.model.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    model: Model.Ref,
  },
})
export type ModelSwitched = typeof ModelSwitched.Type

/**
 * Session-scoped UI intent changed. Carries the full resulting intent state
 * (absent field means cleared) so projection and replay stay idempotent.
 */
export const IntentUpdated = Event.define({
  type: "session.intent.updated",
  ...options,
  schema: {
    ...Base,
    selectedMarket: Schema.String.pipe(Schema.optional),
    trackedAddress: SessionSchema.TrackedAddress.pipe(Schema.optional),
    pinnedPanels: SessionSchema.PinnedPanels.pipe(Schema.optional),
  },
})
export type IntentUpdated = typeof IntentUpdated.Type

export const Moved = Event.define({
  type: "session.next.moved",
  ...options,
  schema: {
    ...Base,
    runtimeScope: RuntimeScope.Ref,
    subdirectory: RelativePath.pipe(Schema.optional),
  },
})
export type Moved = typeof Moved.Type

export const Prompted = Event.define({
  type: "session.next.prompted",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    prompt: Prompt,
    delivery: Schema.Literals(["steer", "queue"]),
  },
})
export type Prompted = typeof Prompted.Type

export namespace PromptLifecycle {
  export const Admitted = Event.define({
    type: "session.next.prompt.admitted",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      prompt: Prompt,
      delivery: Schema.Literals(["steer", "queue"]),
    },
  })
  export type Admitted = typeof Admitted.Type

  export const Promoted = Event.define({
    type: "session.next.prompt.promoted",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      prompt: Prompt,
      timeCreated: TimeSchema.DateTimeUtcFromMillis,
    },
  })
  export type Promoted = typeof Promoted.Type
}

export const ContextUpdated = Event.define({
  type: "session.next.context.updated",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    text: Schema.String,
  },
})
export type ContextUpdated = typeof ContextUpdated.Type

export const Synthetic = Event.define({
  type: "session.next.synthetic",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessageID.ID,
    text: Schema.String,
  },
})
export type Synthetic = typeof Synthetic.Type

export namespace Shell {
  export const Started = Event.define({
    type: "session.next.shell.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      callID: Schema.String,
      command: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.define({
    type: "session.next.shell.ended",
    ...options,
    schema: {
      ...Base,
      callID: Schema.String,
      output: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Step {
  export const Started = Event.define({
    type: "session.next.step.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      agent: Schema.String,
      model: Model.Ref,
      snapshot: Schema.String.pipe(Schema.optional),
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.define({
    type: "session.next.step.ended",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      finish: Schema.String,
      cost: Schema.Finite,
      tokens: Schema.Struct({
        input: Schema.Finite,
        output: Schema.Finite,
        reasoning: Schema.Finite,
        cache: Schema.Struct({
          read: Schema.Finite,
          write: Schema.Finite,
        }),
      }),
      snapshot: Schema.String.pipe(Schema.optional),
    },
  })
  export type Ended = typeof Ended.Type

  export const Failed = Event.define({
    type: "session.next.step.failed",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      error: UnknownError,
    },
  })
  export type Failed = typeof Failed.Type
}

export namespace Text {
  export const Started = Event.define({
    type: "session.next.text.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      textID: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Text.Ended is the replayable full-value boundary.
  export const Delta = Event.define({
    type: "session.next.text.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      textID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.text.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      textID: Schema.String,
      text: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Reasoning {
  export const Started = Event.define({
    type: "session.next.reasoning.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      reasoningID: Schema.String,
      providerMetadata: ProviderMetadata.pipe(Schema.optional),
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Reasoning.Ended is the replayable full-value boundary.
  export const Delta = Event.define({
    type: "session.next.reasoning.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      reasoningID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.reasoning.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessageID.ID,
      reasoningID: Schema.String,
      text: Schema.String,
      providerMetadata: ProviderMetadata.pipe(Schema.optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Tool {
  const ToolBase = {
    ...Base,
    assistantMessageID: SessionMessageID.ID,
    callID: Schema.String,
  }

  export namespace Input {
    export const Started = Event.define({
      type: "session.next.tool.input.started",
      ...options,
      schema: {
        ...ToolBase,
        name: Schema.String,
      },
    })
    export type Started = typeof Started.Type

    // Stream fragments are live-only; Input.Ended is the replayable raw-input boundary.
    export const Delta = Event.define({
      type: "session.next.tool.input.delta",
      schema: {
        ...ToolBase,
        delta: Schema.String,
      },
    })
    export type Delta = typeof Delta.Type

    export const Ended = Event.define({
      type: "session.next.tool.input.ended",
      ...options,
      schema: {
        ...ToolBase,
        text: Schema.String,
      },
    })
    export type Ended = typeof Ended.Type
  }

  export const Called = Event.define({
    type: "session.next.tool.called",
    ...options,
    schema: {
      ...ToolBase,
      tool: Schema.String,
      input: Schema.Record(Schema.String, Schema.Unknown),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(Schema.optional),
      }),
    },
  })
  export type Called = typeof Called.Type

  /**
   * Replayable bounded running-tool state. Tools should checkpoint semantic
   * transitions or at a bounded cadence, not persist every stdout/stderr chunk.
   */
  export const Progress = Event.define({
    type: "session.next.tool.progress",
    ...options,
    schema: {
      ...ToolBase,
      structured: ToolOutput.Structured,
      content: Schema.Array(ToolOutput.Content),
    },
  })
  export type Progress = typeof Progress.Type

  export const Success = Event.define({
    type: "session.next.tool.success",
    ...options,
    schema: {
      ...ToolBase,
      structured: ToolOutput.Structured,
      content: Schema.Array(ToolOutput.Content),
      result: Schema.Unknown.pipe(Schema.optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(Schema.optional),
      }),
    },
  })
  export type Success = typeof Success.Type

  export const Failed = Event.define({
    type: "session.next.tool.failed",
    ...options,
    schema: {
      ...ToolBase,
      error: UnknownError,
      result: Schema.Unknown.pipe(Schema.optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(Schema.optional),
      }),
    },
  })
  export type Failed = typeof Failed.Type
}

export const RetryError = Schema.Struct({
  message: Schema.String,
  statusCode: Schema.Finite.pipe(Schema.optional),
  isRetryable: Schema.Boolean,
  responseHeaders: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  responseBody: Schema.String.pipe(Schema.optional),
  metadata: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
}).annotate({
  identifier: "session.next.retry_error",
})
export type RetryError = typeof RetryError.Type

export const Retried = Event.define({
  type: "session.next.retried",
  ...options,
  schema: {
    ...Base,
    attempt: Schema.Finite,
    error: RetryError,
  },
})
export type Retried = typeof Retried.Type

export namespace Compaction {
  export const Started = Event.define({
    type: "session.next.compaction.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessageID.ID,
      reason: Schema.Union([Schema.Literal("auto"), Schema.Literal("manual")]),
    },
  })
  export type Started = typeof Started.Type

  export const Delta = Event.define({
    type: "session.next.compaction.delta",
    ...options,
    schema: {
      ...Base,
      text: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  export const Ended = Event.define({
    type: "session.next.compaction.ended",
    ...options,
    schema: {
      ...Base,
      text: Schema.String,
      include: Schema.String.pipe(Schema.optional),
    },
  })
  export type Ended = typeof Ended.Type
}

/** Primitive cell value allowed in a snapshot row (no nesting; keeps payloads compact). */
export const SnapshotCell = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]).annotate({
  identifier: "Session.SnapshotCell",
})
export type SnapshotCell = typeof SnapshotCell.Type

export const SnapshotRow = Schema.Record(Schema.String, SnapshotCell).annotate({
  identifier: "Session.SnapshotRow",
})
export type SnapshotRow = typeof SnapshotRow.Type

/** Hard cap on tabular rows persisted per transcript snapshot. */
export const MAX_SNAPSHOT_ROWS = 10

/**
 * Compact, schema-bounded summary recorded into the transcript by read-only
 * data commands. Never raw stream payloads: at most a title, a small field
 * map, up to MAX_SNAPSHOT_ROWS trimmed rows, and a note.
 */
export const SnapshotSummary = Schema.Struct({
  title: Schema.String.pipe(Schema.optional),
  fields: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
  rows: Schema.Array(SnapshotRow).check(Schema.isMaxLength(MAX_SNAPSHOT_ROWS)).pipe(Schema.optional),
  note: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "Session.SnapshotSummary" })
export type SnapshotSummary = typeof SnapshotSummary.Type

/**
 * Provenance persisted with a snapshot. `env` is a plain string (not the
 * gte-ts literal union) so durable replay never breaks when upstream renames
 * or adds environments.
 */
export const SnapshotProvenance = Schema.Struct({
  env: Schema.String,
  source: Schema.Literals(["http", "ws", "fallback"]),
  timestamp: Schema.String,
  symbol: Schema.String.pipe(Schema.optional),
  address: Schema.String.pipe(Schema.optional),
  params: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
}).annotate({ identifier: "Session.SnapshotProvenance" })
export type SnapshotProvenance = typeof SnapshotProvenance.Type

/**
 * Durable transcript record of a one-shot read-only data snapshot (slash
 * command or tool surface). Continuous panel updates never produce these.
 */
export const SnapshotRecorded = Event.define({
  type: "session.snapshot.recorded",
  ...options,
  schema: {
    ...Base,
    /** Command or surface that produced the snapshot, e.g. "/book" or "markets". */
    command: Schema.String,
    panel: SessionSchema.PanelType.pipe(Schema.optional),
    key: Schema.String.pipe(Schema.optional),
    summary: SnapshotSummary,
    provenance: SnapshotProvenance,
  },
})
export type SnapshotRecorded = typeof SnapshotRecorded.Type

const DurableDefinitions = [
  Created,
  AgentSwitched,
  ModelSwitched,
  IntentUpdated,
  Moved,
  Prompted,
  PromptLifecycle.Admitted,
  PromptLifecycle.Promoted,
  ContextUpdated,
  Synthetic,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Ended,
  Tool.Input.Started,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  Reasoning.Started,
  Reasoning.Ended,
  Retried,
  Compaction.Started,
  Compaction.Delta,
  Compaction.Ended,
  SnapshotRecorded,
] as const
const EphemeralDefinitions = [Text.Delta, Tool.Input.Delta, Reasoning.Delta] as const

export const Durable = Schema.Union(DurableDefinitions, { mode: "oneOf" }).pipe(Schema.toTaggedUnion("type"))
export type DurableEvent = typeof Durable.Type

export const All = Schema.Union([...DurableDefinitions, ...EphemeralDefinitions], { mode: "oneOf" }).pipe(
  Schema.toTaggedUnion("type"),
)
export type Event = typeof All.Type
export type Type = Event["type"]

export * as SessionEvent from "./event"
