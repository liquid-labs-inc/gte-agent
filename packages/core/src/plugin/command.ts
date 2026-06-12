export * as CommandPlugin from "./command"

import { Effect } from "effect"
import { Command } from "../command"
import { RuntimeScope } from "../runtime-scope"
import { define, ID } from "../plugin"
import PROMPT_INITIALIZE from "./command/initialize.txt"
import PROMPT_REVIEW from "./command/review.txt"

export const Plugin = define({
  id: ID.make("command"),
  effect: Effect.gen(function* () {
    const command = yield* Command.Service
    const location = yield* RuntimeScope.Service
    const transform = yield* command.transform()

    yield* transform((editor) => {
      editor.update("init", (command) => {
        command.template = PROMPT_INITIALIZE.replace("${path}", location.project.directory)
        command.description = "guided AGENTS.md setup"
      })
      editor.update("review", (command) => {
        command.template = PROMPT_REVIEW.replace("${path}", location.project.directory)
        command.description = "review changes [commit|branch|pr], defaults to uncommitted"
        command.subtask = true
      })
    })
  }),
})
