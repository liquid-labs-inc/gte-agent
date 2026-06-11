import { LLM, LLMClient, LLMError, LLMEvent, SystemPart } from "@gte-agent/llm"
import { Cause, DateTime, Effect, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { Event } from "../../event"
import { Model } from "../../model"
import { Provider } from "../../provider"
import { SessionSchema } from "../schema"
import { SessionEvent } from "../event"
import { SessionMessage } from "../message"
import { SessionStore } from "../store"
import { Service, StepLimitExceededError } from "./index"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { ToolRegistry } from "../../tool/registry"
import { SessionRunnerModel } from "./model"
import { SessionRunnerSystemPrompt } from "./system-prompt"
import { Database } from "../../database/database"
import { SessionInput } from "../input"
import { Question } from "../../question"
import { SystemContextRegistry } from "../../system-context-registry"
import { SessionContextEpoch } from "../context-epoch"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Bound model steps.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - [x] Load Session placement and chronological projected history.
 *   - [x] Resolve the selected model through the runtime-scope runner environment.
 *   - [ ] Load the selected agent and effective permissions.
 *   - [ ] Build provider/model-specific base instructions and environment facts.
 *   - [x] Load global and upward project `AGENTS.md` instructions.
 *   - [ ] Load configured and remote instructions plus nearby nested instructions discovered while files are read.
 *   - [ ] List available skills in the system prompt and expose a tool for loading skill bodies.
 *   - [ ] Resolve referenced files, directories, agents, repositories, MCP resources, and media.
 *   - [ ] Apply steering reminders, plugin transforms, and structured-output policy.
 *   - [ ] Compact or summarize history when context pressure requires it.
 *
 * - One provider turn
 *   - [x] Translate every projected Session message variant into canonical
 *     `@gte-agent/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, output truncation, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable activity recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads projected history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and a
 * bounded explicit loop starts the next provider turn after local settlement.
 */

// QUESTION: Did this exist previously, or did we add this limit? Does it make sense?
const MAX_STEPS = 25

/**
 * Human-readable transcript message for a model-resolution failure. Selection
 * and credentials are managed through `/models`, so every message points
 * there. Never includes credential material (none of these errors carry any).
 */
const describeModelError = (error: SessionRunnerModel.Error): string => {
  switch (error._tag) {
    case "SessionRunnerModel.ModelNotSelectedError":
      return "No model is selected for this session and no global default is configured. Use /models to choose a model."
    case "Catalog.ProviderNotFound":
      return `The selected provider "${error.providerID}" is not in the model catalog. Use /models to choose a supported model.`
    case "Catalog.ModelNotFound":
      return `The selected model "${error.providerID}/${error.modelID}" is not in the model catalog. Use /models to choose a supported model.`
    case "SessionRunnerModel.UnsupportedApiError":
      return `The selected model "${error.providerID}/${error.modelID}" has no supported route (${error.api}). Use /models to choose a supported model.`
    case "AuthStore.MissingCredentialsError":
      return `No credentials are configured for provider "${error.providerID}". Use /models to authenticate.`
    case "AuthStore.InvalidAuthFileError":
      return `The credential store at ${error.path} could not be read. Re-authenticate with /models.`
    case "AuthOpenAI.RefreshError":
      return `Refreshing the ChatGPT sign-in failed (${error.reason}). Use /models to re-authenticate OpenAI.`
    default:
      return `Model resolution failed: ${String(error)}. Use /models to select and authenticate a model.`
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* Event.Service
    const llm = yield* LLMClient.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const systemContext = yield* SystemContextRegistry.Service
    // Optional product prompt (GTE persona + session context). Compositions
    // without it (tests, embedders) run with the epoch baseline alone.
    const systemPrompt = Option.getOrUndefined(yield* Effect.serviceOption(SessionRunnerSystemPrompt.Service))
    const db = (yield* Database.Service).db
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, never>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: dismissing a question halts the loop instead of becoming model-facing tool output.
    const isQuestionRejected = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some((reason) => Cause.isDieReason(reason) && reason.defect instanceof Question.RejectedError)

    const runTurn = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: "steer" | "queue" | undefined,
    ) {
      const session = yield* getSession(sessionID)
      const initialized = yield* SessionContextEpoch.initialize(db, systemContext, session.id, session.runtimeScope)
      const toolFibers = yield* FiberSet.make<void, never>()
      let needsContinuation = false
      if (promotion) {
        const cutoff = yield* SessionInput.latestSeq(db, session.id)
        if (promotion === "steer") yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        if (promotion === "queue") {
          yield* SessionInput.promoteNextQueued(db, events, session.id)
          yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
        }
      }
      // Resolved after prompt promotion so a selection or credential failure
      // lands in the transcript after the user message it answers. The typed
      // error still propagates; the published step is the visible surface
      // directing the user to /models.
      const model = yield* models.resolve(session).pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            const assistantMessageID = SessionMessage.ID.create()
            const timestamp = yield* DateTime.now
            yield* events.publish(SessionEvent.Step.Started, {
              sessionID: session.id,
              timestamp,
              assistantMessageID,
              agent: session.agent ?? "build",
              model: session.model ?? { id: Model.ID.make("unconfigured"), providerID: Provider.ID.gteAgent },
            })
            yield* events.publish(SessionEvent.Step.Failed, {
              sessionID: session.id,
              timestamp,
              assistantMessageID,
              error: { type: "unknown", message: describeModelError(error) },
            })
          }),
        ),
      )
      const system =
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, systemContext, session.id, session.runtimeScope))
      const context = yield* store.runnerContext(session.id, system.baselineSeq)
      const gteBaseline = systemPrompt === undefined ? undefined : yield* systemPrompt.baseline(session)
      const request = LLM.request({
        model,
        system: [
          ...(gteBaseline === undefined || gteBaseline.length === 0 ? [] : [SystemPart.make(gteBaseline)]),
          ...(system.baseline.length > 0 ? [SystemPart.make(system.baseline)] : []),
        ],
        messages: toLLMMessages(context, model),
        tools: yield* tools.definitions(),
      })
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: session.agent ?? "build",
        model: {
          id: Model.ID.make(model.id),
          providerID: Provider.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
      })
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent) => withPublication(publisher.publish(event))
      const providerStream = llm.stream(request).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            yield* publish(event)
            if (event.type !== "tool-call" || event.providerExecuted) return
            needsContinuation = true
            yield* tools.settle({ sessionID: session.id, call: event }).pipe(
              Effect.catchCause((cause) => {
                if (isQuestionRejected(cause)) return Effect.failCause(cause)
                return Effect.succeed({
                  result: { type: "error" as const, value: String(Cause.squash(cause)) },
                  output: undefined,
                })
              }),
              Effect.flatMap((settlement) =>
                publish(
                  LLMEvent.toolResult({
                    id: event.id,
                    name: event.name,
                    result: settlement.result,
                    output: settlement.output,
                  }),
                ),
              ),
              FiberSet.run(toolFibers),
            )
          }),
        ),
        Effect.ensuring(withPublication(publisher.flush())),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          let llmFailure: LLMError | undefined
          if (stream._tag === "Failure") {
            for (const reason of stream.cause.reasons) {
              if (!Cause.isFailReason(reason)) continue
              if (reason.error instanceof LLMError) llmFailure = reason.error
            }
          }
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
            yield* withPublication(
              events.publish(SessionEvent.Step.Failed, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(),
                error: { type: "unknown", message: llmFailure.reason.message },
              }),
            )
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          if (settled._tag === "Failure" && isQuestionRejected(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
            return yield* Effect.interrupt
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted"))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true))
          const attempt = stream._tag === "Failure" ? stream : settled
          if (attempt._tag === "Failure") return yield* Effect.failCause(attempt.cause)
          return !publisher.hasProviderError() && needsContinuation
        }),
      )
    }, Effect.scoped)

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force?: boolean
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (input.force !== true && !hasSteer && !hasQueue) return
      yield* failInterruptedTools(input.sessionID)
      let promotion: "steer" | "queue" | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let openActivity = input.force === true || hasSteer || hasQueue
      while (openActivity) {
        let needsContinuation = true
        for (let step = 0; step < MAX_STEPS; step++) {
          needsContinuation = yield* runTurn(input.sessionID, promotion)
          promotion = "steer"
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
          if (!needsContinuation) break
        }
        if (needsContinuation)
          return yield* new StepLimitExceededError({ sessionID: input.sessionID, limit: MAX_STEPS })
        openActivity = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = openActivity ? "queue" : undefined
      }
    })

    return Service.of({
      run,
    })
  }),
)

export const defaultLayer = layer
