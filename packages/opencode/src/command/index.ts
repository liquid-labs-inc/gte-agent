import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { SessionID, MessageID } from "@/session/schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import { EventV2 } from "@opencode-ai/core/event"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import { Workflow } from "@/workflow"
import { WorkflowRegistry } from "@/workflow/registry"

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: EventV2.define({
    type: "command.executed",
    schema: {
      name: Schema.String,
      sessionID: SessionID,
      arguments: Schema.String,
      messageID: MessageID,
    },
  }),
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill", "workflow"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
  WORKFLOW: "workflow",
} as const

const WORKFLOW_TEMPLATE = [
  "<workflow-request>",
  "The user asked for this task to run as an ultrathink workflow.",
  "Write a workflow orchestration script (phase/agent/map/log/args API) for the task below and launch it with the `workflow` tool.",
  "The script coordinates; spawned agents do all the actual work. Fan independent items out with map(). Return the synthesized result from the script.",
  "After launching, briefly tell the user what is running; you will be notified when the workflow completes.",
  "</workflow-request>",
  "",
  "Task: $ARGUMENTS",
].join("\n")

function workflowTemplate(item: WorkflowRegistry.SavedWorkflow) {
  return [
    `Launch the saved workflow \"${item.name}\" by calling the \`workflow\` tool now.`,
    `- name: \"${item.name}\"`,
    "- args: derive from the invocation input below — pass a parsed JSON value when it is valid JSON, the raw string otherwise, and omit args entirely when empty.",
    "- script: the exact script below, verbatim and unmodified.",
    "",
    "Invocation input: $ARGUMENTS",
    "",
    "<workflow_script>",
    item.script,
    "</workflow_script>",
  ].join("\n")
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }

      if (Workflow.enabled(cfg)) {
        commands[Default.WORKFLOW] = {
          name: Default.WORKFLOW,
          description: "run a task as an ultrathink workflow",
          source: "workflow",
          get template() {
            return WORKFLOW_TEMPLATE
          },
          hints: hints(WORKFLOW_TEMPLATE),
        }
        const dirs = yield* config.directories()
        for (const item of WorkflowRegistry.discover(dirs)) {
          if (commands[item.name]) continue
          const template = workflowTemplate(item)
          commands[item.name] = {
            name: item.name,
            description: item.description ?? `saved workflow (${item.scope})`,
            source: "workflow",
            get template() {
              return template
            },
            hints: hints(template),
          }
        }
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            return item.content
          },
          hints: [],
        }
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    return Service.of({ get, list })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(MCP.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export * as Command from "."
