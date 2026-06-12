export * as WorkflowCommandPlugin from "./workflow-command"

import { Effect } from "effect"
import { Command } from "../command"
import { define, ID } from "../plugin"
import { WorkflowRuntime } from "../workflow/runtime"
import { WorkflowSaved } from "../workflow/saved"

/**
 * Registers saved workflows as slash commands. Each discovered workflow
 * (bundled `/deep-research`, then global, then project — project wins
 * collisions) becomes a `/<name>` command whose template instructs the model to
 * call the `workflow` tool with the file's exact script and the user's argument
 * string as `args`. A standalone `/workflow <task>` command opts any task into
 * the orchestration instruction. The whole registration is gated on the kill
 * switch: when workflows are disabled, no command is contributed.
 */
export const Plugin = define({
  id: ID.make("workflow-command"),
  effect: Effect.gen(function* () {
    if (!(yield* WorkflowRuntime.enabled)) return
    const command = yield* Command.Service
    const transform = yield* command.transform()
    const saved = yield* WorkflowSaved.discover()

    yield* transform((editor) => {
      editor.update("workflow", (item) => {
        item.template = WORKFLOW_TEMPLATE
        item.description = "run a task as an ultrathink workflow"
      })
      for (const workflow of saved) {
        editor.update(workflow.name, (item) => {
          item.template = savedTemplate(workflow)
          item.description = workflow.description ?? `saved workflow (${workflow.scope})`
        })
      }
    })
  }),
})

const WORKFLOW_TEMPLATE = [
  "<workflow-request>",
  "The user asked for this task to run as an ultrathink workflow.",
  "Write a workflow orchestration script (phase/agent/map/log/args API) for the task below and launch it with the `workflow` tool.",
  "The script only coordinates; the agents it spawns do all the reading and acting. Fan independent items out with map(), and synthesize the results in a final phase. Scale the fan-out to the task.",
  "After launching, briefly tell the user what is running; you will be notified when the workflow completes.",
  "</workflow-request>",
  "",
  "Task: $ARGUMENTS",
].join("\n")

function savedTemplate(workflow: WorkflowSaved.Saved) {
  return [
    `Launch the saved workflow "${workflow.name}" by calling the \`workflow\` tool now.`,
    `- name: "${workflow.name}"`,
    "- args: derive from the invocation input below — pass a parsed JSON value when it is valid JSON, the raw string otherwise, and omit args entirely when empty.",
    "- script: the exact script below, verbatim and unmodified.",
    "",
    "Invocation input: $ARGUMENTS",
    "",
    "<workflow_script>",
    workflow.script,
    "</workflow_script>",
  ].join("\n")
}
