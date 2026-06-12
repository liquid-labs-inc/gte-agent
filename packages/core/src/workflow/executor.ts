export * as WorkflowExecutor from "./executor"

import { Cause, Context, Effect, Layer, Schema } from "effect"
import { Agent } from "../agent"
import { Catalog } from "../catalog"
import { Model } from "../model"
import { Provider } from "../provider"
import { Session } from "../session"
import { Prompt } from "../session/prompt"
import { SessionSchema } from "../session/schema"
import { WorkflowSchema } from "./schema"

export class ExecutionError extends Schema.TaggedErrorClass<ExecutionError>()("WorkflowExecutor.ExecutionError", {
  message: Schema.String,
}) {}

export type Request = {
  /** Parent session whose runtime scope and authority the agent inherits. */
  readonly sessionID: SessionSchema.ID
  readonly runID: WorkflowSchema.RunID
  readonly agentID: string
  readonly phase: string
  readonly prompt: string
  readonly type?: string
  /** Model override as "providerID/modelID". */
  readonly model?: string
  readonly variant?: string
}

export type Result = {
  /** Child session that executed the agent. */
  readonly sessionID?: SessionSchema.ID
  readonly text: string
  readonly tokens: WorkflowSchema.Tokens
  /** Effective "providerID/modelID" the agent ran with, when one was selected. */
  readonly model?: string
  readonly variant?: string
  /** Script-requested override that was unavailable; `model`/`variant` carry the parent fallback. */
  readonly requestedModel?: string
  readonly requestedVariant?: string
  /** Set when a requested model/variant was unavailable and the parent model was used instead. */
  readonly fallback?: string
}

export interface Interface {
  readonly execute: (request: Request) => Effect.Effect<Result, ExecutionError>
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/WorkflowExecutor") {}

/**
 * Effect failures (tagged errors, Cause wrappers) often carry an empty
 * `message` and stringify uselessly; agent failures must always surface a
 * readable reason in the run snapshot and the parent transcript.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  if (error !== null && typeof error === "object" && "_tag" in error && typeof error._tag === "string")
    return error._tag
  const text = String(error)
  if (text && text !== "[object Object]" && text !== "Error") return text
  return "Workflow agent failed"
}

/**
 * Executes workflow agents as real child sessions: one `Session.create` with
 * the parent session's runtime scope and authority, one prompt, one drain to
 * durable settlement through the regular session machinery (same tool
 * registry, same permission derivation, same transcript). The final assistant
 * text and the turn's token usage are the agent's result.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const catalog = yield* Catalog.Service

    /**
     * Resolves the script's model/variant request against the curated catalog.
     * A model or variant unavailable in this environment falls back to the
     * parent session's model rather than failing the run over a routing
     * preference; the effective choice lands in the run snapshot and a log
     * line, never silently.
     */
    const resolveModel = Effect.fnUntraced(function* (parent: SessionSchema.Info, request: Request) {
      const parentRef = parent.model
      // The exact override the script asked for, recorded on every fallback so
      // the snapshot carries requested-vs-effective without parsing the log line.
      const requestedFields = {
        ...(request.model === undefined ? {} : { requestedModel: request.model }),
        ...(request.variant === undefined ? {} : { requestedVariant: request.variant }),
      }
      if (request.model === undefined && request.variant === undefined) return { ref: parentRef }
      const requested =
        request.model !== undefined && request.model.includes("/")
          ? {
              providerID: Provider.ID.make(request.model.slice(0, request.model.indexOf("/"))),
              id: Model.ID.make(request.model.slice(request.model.indexOf("/") + 1)),
            }
          : parentRef
      if (request.model !== undefined && !request.model.includes("/")) {
        return {
          ref: parentRef,
          ...requestedFields,
          fallback: `model "${request.model}" is not a providerID/modelID reference; using the parent session's model`,
        }
      }
      // No model to resolve against (default-model session with no parent ref):
      // a script-requested variant cannot be honored, so surface the request and
      // a fallback rather than dropping it silently from the snapshot.
      if (requested === undefined)
        return {
          ref: undefined,
          ...requestedFields,
          fallback:
            "no model is selected for the parent session, so the script's model/variant request was dropped; the agent runs with the session default",
        }
      const found = yield* catalog.model.get(requested.providerID, requested.id).pipe(Effect.option)
      if (found._tag === "None") {
        // The parent's own model is not in the catalog. When a variant was also
        // requested it cannot ride along on the bare parent ref, so record the
        // request and the fallback; with no variant requested there is nothing
        // to surface.
        if (requested === parentRef)
          return request.variant === undefined
            ? { ref: parentRef }
            : {
                ref: parentRef,
                ...requestedFields,
                fallback: `the parent session's model is not in the catalog, so variant "${request.variant}" was dropped`,
              }
        return {
          ref: parentRef,
          ...requestedFields,
          fallback: `model ${requested.providerID}/${requested.id} is unavailable; using the parent session's model`,
        }
      }
      if (request.variant !== undefined && !found.value.variants.some((variant) => variant.id === request.variant)) {
        return {
          ref: parentRef,
          ...requestedFields,
          fallback: `variant "${request.variant}" is unavailable on ${requested.providerID}/${requested.id}; using the parent session's model`,
        }
      }
      return {
        ref: {
          id: requested.id,
          providerID: requested.providerID,
          variant: request.variant === undefined ? undefined : Model.VariantID.make(request.variant),
        },
      }
    })

    return Service.of({
      execute: Effect.fn("WorkflowExecutor.execute")(function* (request) {
        const parent = yield* sessions
          .get(request.sessionID)
          .pipe(Effect.mapError((error) => new ExecutionError({ message: describeFailure(error) })))
        const model = yield* resolveModel(parent, request)
        const child = yield* sessions
          .create({
            parentID: parent.id,
            runtimeScope: parent.runtimeScope,
            authorityID: parent.authorityID,
            ...(request.type === undefined ? {} : { agent: Agent.ID.make(request.type) }),
            ...(model.ref === undefined ? {} : { model: model.ref }),
          })
          .pipe(Effect.mapError((error) => new ExecutionError({ message: describeFailure(error) })))
        yield* sessions
          .prompt({ sessionID: child.id, prompt: new Prompt({ text: request.prompt }), resume: false })
          .pipe(Effect.mapError((error) => new ExecutionError({ message: describeFailure(error) })))
        const drained = yield* sessions.resume(child.id).pipe(Effect.exit)
        const context = yield* sessions.context(child.id).pipe(Effect.orElseSucceed(() => []))
        const assistants = context.flatMap((message) => (message.type === "assistant" ? [message] : []))
        const settled = assistants.at(-1)
        if (drained._tag === "Failure") {
          // The runner already published the readable failure into the child
          // transcript (e.g. the /models guidance); prefer it over the raw tag.
          return yield* new ExecutionError({
            message: settled?.error?.message ?? describeFailure(Cause.squash(drained.cause)),
          })
        }
        if (!settled) return yield* new ExecutionError({ message: "Workflow agent produced no assistant reply" })
        if (settled.error)
          return yield* new ExecutionError({ message: settled.error.message || "Workflow agent failed" })
        const tokens = assistants.reduce(
          (total, message) => ({
            input: total.input + (message.tokens?.input ?? 0),
            output: total.output + (message.tokens?.output ?? 0),
            reasoning: total.reasoning + (message.tokens?.reasoning ?? 0),
          }),
          { input: 0, output: 0, reasoning: 0 },
        )
        return {
          sessionID: child.id,
          text: settled.content.findLast((part) => part.type === "text")?.text ?? "",
          tokens,
          ...(model.ref === undefined ? {} : { model: `${model.ref.providerID}/${model.ref.id}` }),
          ...(model.ref?.variant === undefined ? {} : { variant: model.ref.variant }),
          ...("requestedModel" in model && model.requestedModel !== undefined
            ? { requestedModel: model.requestedModel }
            : {}),
          ...("requestedVariant" in model && model.requestedVariant !== undefined
            ? { requestedVariant: model.requestedVariant }
            : {}),
          ...("fallback" in model && model.fallback !== undefined ? { fallback: model.fallback } : {}),
        }
      }),
    })
  }),
)
