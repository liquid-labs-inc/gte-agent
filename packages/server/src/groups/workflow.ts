import { Session } from "@gte-agent/core/session"
import { WorkflowSchema } from "@gte-agent/core/workflow/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import {
  ForbiddenError,
  SessionNotFoundError,
  WorkflowDisabledError,
  WorkflowRunNotFoundError,
} from "../errors"
import { GTEAuthorization } from "../middleware/authorization"

export const WORKFLOW_ACTIONS = ["pause", "resume", "stop"] as const

/** Control payload: pause/resume/stop a run, or stop a single agent with agentID. */
export const WorkflowControl = Schema.Struct({
  action: Schema.Literals(WORKFLOW_ACTIONS).annotate({
    description: "Run control: pause halts new spawns, resume replays from the cache, stop ends the run.",
  }),
  agentID: Schema.String.pipe(Schema.optional).annotate({
    description: "When action is stop, stop only this inflight agent and let the run continue.",
  }),
}).annotate({ identifier: "WorkflowControlRequest" })

/** Applied control outcome: whether the runtime acted on the run or agent. */
export const WorkflowControlResult = Schema.Struct({
  applied: Schema.Boolean,
}).annotate({ identifier: "WorkflowControlResult" })

const errors = [ForbiddenError, SessionNotFoundError, WorkflowDisabledError]

export const WorkflowGroup = HttpApiGroup.make("workflow")
  .add(
    HttpApiEndpoint.get("list", "/api/session/:sessionID/workflow", {
      params: { sessionID: Session.ID },
      success: Schema.Struct({ data: Schema.Array(WorkflowSchema.RunInfo) }).annotate({
        identifier: "WorkflowListResponse",
      }),
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "session.workflow.list",
        summary: "List workflow runs",
        description: "List the session's workflow run snapshots, newest first.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("get", "/api/session/:sessionID/workflow/:runID", {
      params: { sessionID: Session.ID, runID: WorkflowSchema.RunID },
      success: Schema.Struct({ data: WorkflowSchema.RunInfo }).annotate({ identifier: "WorkflowGetResponse" }),
      error: [...errors, WorkflowRunNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "session.workflow.get",
        summary: "Get a workflow run",
        description: "Fetch a single workflow run snapshot by id.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("control", "/api/session/:sessionID/workflow/:runID/control", {
      params: { sessionID: Session.ID, runID: WorkflowSchema.RunID },
      payload: WorkflowControl,
      success: Schema.Struct({ data: WorkflowControlResult }).annotate({ identifier: "WorkflowControlResponse" }),
      error: [...errors, WorkflowRunNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "session.workflow.control",
        summary: "Control a workflow run",
        description: "Pause, resume, or stop a run; stop with agentID stops one inflight agent.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "workflows",
      description: "Dynamic workflow run observation and control routes.",
    }),
  )
  .middleware(GTEAuthorization)
