/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { Effect } from "effect"
import { define, ID } from "../plugin"
import { AbsolutePath } from "../schema"
import { Skill } from "../skill"
import customizeOpencodeContent from "./skill/customize-gte-agent.md" with { type: "text" }

export const CustomizeGTEAgentContent = customizeOpencodeContent

export const Plugin = define({
  id: ID.make("skill"),
  effect: Effect.gen(function* () {
    const skill = yield* Skill.Service
    const transform = yield* skill.transform()

    yield* transform((editor) => {
      editor.source(
        new Skill.EmbeddedSource({
          type: "embedded",
          skill: new Skill.Info({
            name: "customize-gte-agent",
            description:
              "Use ONLY when the user is editing or creating gte-agent's own configuration: gte-agent.json, gte-agent.jsonc, files under .gte-agent/, or files under ~/.config/gte-agent/. Also use when creating or fixing gte-agent agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring gte-agent itself.",
            location: AbsolutePath.make("/builtin/customize-gte-agent.md"),
            content: CustomizeGTEAgentContent,
          }),
        }),
      )
    })
  }),
})
