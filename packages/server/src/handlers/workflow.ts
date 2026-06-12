import { Config } from "@gte-agent/core/config"
import { Session } from "@gte-agent/core/session"
import { WorkflowRuntime } from "@gte-agent/core/workflow/runtime"
import { WorkflowSchema } from "@gte-agent/core/workflow/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { GTEAgentApi } from "../api"
import { ForbiddenError, SessionNotFoundError, WorkflowDisabledError, WorkflowRunNotFoundError } from "../errors"

const disabled = () => new WorkflowDisabledError({ message: "Dynamic workflows are disabled on this server" })

const notFound = (sessionID: Session.ID) =>
  new SessionNotFoundError({ sessionID, message: `Session not found: ${sessionID}` })

const forbidden = (principalID: string, authorityID: string) =>
  new ForbiddenError({ message: `Principal ${principalID} cannot read authority ${authorityID}` })

const runNotFound = (runID: WorkflowSchema.RunID) =>
  new WorkflowRunNotFoundError({ runID, message: `Workflow run not found: ${runID}` })

export const workflowHandlers = HttpApiBuilder.group(GTEAgentApi, "workflow", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const runtime = yield* WorkflowRuntime.Service
    // Resolve Config once at build so the per-request kill-switch read is a
    // plain layer requirement, not a leaked request-context service.
    const configService = yield* Config.Service

    // Kill switch in front of every route: when off, the feature answers with
    // a typed disabled error rather than acting on the run registry.
    const requireEnabled = WorkflowRuntime.enabled.pipe(
      Effect.provideService(Config.Service, configService),
      Effect.flatMap((enabled) => (enabled ? Effect.void : Effect.fail(disabled()))),
    )

    // Run snapshots carry the session id, but the routes are session-scoped:
    // resolving the session first keeps the not-found / forbidden surface
    // identical to the other session routes.
    const requireSession = (sessionID: Session.ID) =>
      session.get(sessionID).pipe(
        Effect.catchTag("Session.NotFoundError", () => Effect.fail(notFound(sessionID))),
        Effect.catchTag("GTEAuth.ReadDeniedError", (error) =>
          Effect.fail(forbidden(error.principalID, error.authorityID)),
        ),
      )

    // A run is only visible on its own session's routes.
    const requireRun = (sessionID: Session.ID, runID: WorkflowSchema.RunID) =>
      runtime.get(runID).pipe(
        Effect.flatMap((run) =>
          run === undefined || run.sessionID !== sessionID ? Effect.fail(runNotFound(runID)) : Effect.succeed(run),
        ),
      )

    return handlers
      .handle(
        "list",
        Effect.fn(function* (ctx) {
          yield* requireEnabled
          yield* requireSession(ctx.params.sessionID)
          return { data: yield* runtime.list(ctx.params.sessionID) }
        }),
      )
      .handle(
        "get",
        Effect.fn(function* (ctx) {
          yield* requireEnabled
          yield* requireSession(ctx.params.sessionID)
          return { data: yield* requireRun(ctx.params.sessionID, ctx.params.runID) }
        }),
      )
      .handle(
        "control",
        Effect.fn(function* (ctx) {
          yield* requireEnabled
          yield* requireSession(ctx.params.sessionID)
          yield* requireRun(ctx.params.sessionID, ctx.params.runID)
          if (ctx.payload.action === "pause") return { data: { applied: yield* runtime.pause(ctx.params.runID) } }
          if (ctx.payload.action === "resume") return { data: { applied: yield* runtime.resume(ctx.params.runID) } }
          return { data: { applied: yield* runtime.stop(ctx.params.runID, ctx.payload.agentID) } }
        }),
      )
  }),
)
