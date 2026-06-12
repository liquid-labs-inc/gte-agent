import * as Tool from "./tool"
import DESCRIPTION from "./workflow.txt"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { Config } from "@/config/config"
import { Effect, Schema } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { Database } from "@opencode-ai/core/database/database"
import { MessageV2 } from "../session/message-v2"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Scope } from "effect"
import { Workflow } from "@/workflow"
import { WorkflowRuntime } from "@/workflow/runtime"
import type { AgentExecutionRequest, AgentExecutor } from "@/workflow/run"
import type { TaskPromptOps } from "./task"

const id = "workflow"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({
    description: "Short kebab-case name for this workflow run (e.g. 'audit-sql-usage')",
  }),
  script: Schema.String.annotate({
    description:
      "The JavaScript orchestration script. Body of an async function using only the injected API: phase, agent, map, log, args.",
  }),
  args: Schema.optional(Schema.Unknown).annotate({
    description: "Structured input exposed to the script as the `args` global",
  }),
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Default true: run in the background and get notified on completion. Set false only when you need the result before continuing.",
  }),
})

function renderOutput(input: {
  runID: string
  state: "running" | "completed" | "error"
  scriptPath?: string
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "workflow_error" : "workflow_result"
  return [
    `<workflow id="${input.runID}" state="${input.state}"${input.scriptPath ? ` script="${input.scriptPath}"` : ""}>`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</workflow>",
  ].join("\n")
}

const BACKGROUND_STARTED = [
  "The workflow is running in the background. You will be notified automatically when it finishes.",
  "Do not poll for progress or duplicate its work. The user can watch it with /workflows.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")

export const WorkflowTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const runtime = yield* WorkflowRuntime.Service
    const database = yield* Database.Service
    const scope = yield* Scope.Scope

    const run = Effect.fn("WorkflowTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      if (!Workflow.enabled(cfg)) {
        return yield* Effect.fail(new Error("Dynamic workflows are disabled (disableWorkflows / GTE_AGENT_DISABLE_WORKFLOWS)"))
      }

      const validation = Workflow.WorkflowScript.validate(params.script)
      if (!validation.ok) return yield* Effect.fail(new Error(validation.error))

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.name],
          always: ["*"],
          metadata: { name: params.name },
        })
      }

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("WorkflowTool requires promptOps in ctx.extra"))

      const parent = yield* sessions.get(ctx.sessionID)
      const parentAgent = parent.agent
        ? yield* agents.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const parentModel = { providerID: msg.info.providerID, modelID: msg.info.modelID }
      const parentVariant = msg.info.variant

      const bridge = yield* EffectBridge.make()

      const runAgent = Effect.fn("WorkflowTool.runAgent")(function* (request: AgentExecutionRequest) {
        const type = request.type ?? "general"
        const info = yield* agents.get(type)
        if (!info) return yield* Effect.fail(new Error(`Unknown agent type: ${type}`))

        const session = yield* sessions.create({
          parentID: ctx.sessionID,
          title: `${params.name}/${request.phase} (@${info.name} workflow agent)`,
          agent: info.name,
          permission: [
            ...deriveSubagentSessionPermission({
              parentSessionPermission: parent.permission ?? [],
              parentAgent,
              subagent: info,
            }),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        })
        request.onSession?.(session.id)

        const override = request.model?.includes("/")
          ? {
              providerID: ProviderV2.ID.make(request.model.slice(0, request.model.indexOf("/"))),
              modelID: ModelV2.ID.make(request.model.slice(request.model.indexOf("/") + 1)),
            }
          : undefined
        const model = override ?? info.model ?? parentModel
        const variant = request.variant ?? (override || info.model ? undefined : parentVariant)

        const execute = Effect.gen(function* () {
          const parts = yield* ops.resolvePromptParts(request.prompt)
          const result = yield* ops.prompt({
            messageID: MessageID.ascending(),
            sessionID: session.id,
            model: { providerID: model.providerID, modelID: model.modelID },
            variant,
            agent: info.name,
            tools: {
              todowrite: false,
              task: false,
              workflow: false,
              ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
            },
            parts,
          })
          const text = result.parts.findLast((item) => item.type === "text")?.text ?? ""
          const tokens =
            result.info.role === "assistant"
              ? { input: result.info.tokens.input, output: result.info.tokens.output }
              : { input: 0, output: 0 }
          return { text, tokens }
        })

        return yield* execute.pipe(Effect.onInterrupt(() => ops.cancel(session.id).pipe(Effect.ignore)))
      })

      const executor: AgentExecutor = (request, signal) => {
        const abort = Effect.callback<never, Error>((resume) => {
          const fail = () =>
            resume(Effect.fail(signal.reason instanceof Error ? signal.reason : new Error("Agent aborted")))
          if (signal.aborted) {
            fail()
            return
          }
          signal.addEventListener("abort", fail, { once: true })
          return Effect.sync(() => signal.removeEventListener("abort", fail))
        })
        return bridge.promise(Effect.raceFirst(runAgent(request), abort))
      }

      const started = yield* runtime.start({
        name: params.name,
        script: params.script,
        args: params.args,
        parentSessionID: ctx.sessionID,
        executor,
      })

      const metadata = {
        runId: started.id,
        scriptPath: started.scriptPath,
        parentSessionId: ctx.sessionID,
        background: true,
      }
      yield* ctx.metadata({ title: params.name, metadata })

      const inject = Effect.fn("WorkflowTool.injectResult")(function* (state: "completed" | "error", text: string) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant: parentVariant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  runID: started.id,
                  state,
                  scriptPath: started.scriptPath,
                  summary:
                    state === "completed"
                      ? `Workflow completed: ${params.name}`
                      : `Workflow failed: ${params.name}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      if (params.background === false) {
        const result = yield* background.wait({ id: started.id })
        if (result.info?.status === "completed") {
          return {
            title: params.name,
            metadata,
            output: renderOutput({
              runID: started.id,
              state: "completed",
              scriptPath: started.scriptPath,
              text: result.info.output ?? "",
            }),
          }
        }
        return yield* Effect.fail(new Error(result.info?.error ?? "Workflow failed"))
      }

      yield* background.wait({ id: started.id }).pipe(
        Effect.flatMap((result) => {
          if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
          if (result.info?.status === "error") return inject("error", result.info.error ?? "")
          return Effect.void
        }),
        Effect.forkIn(scope, { startImmediately: true }),
      )

      return {
        title: params.name,
        metadata,
        output: renderOutput({
          runID: started.id,
          state: "running",
          scriptPath: started.scriptPath,
          summary: "Workflow started",
          text: BACKGROUND_STARTED,
        }),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
