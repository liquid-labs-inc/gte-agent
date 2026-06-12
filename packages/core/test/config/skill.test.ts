import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Config } from "@gte-agent/core/config"
import { ConfigSkillPlugin } from "@gte-agent/core/config/plugin/skill"
import { Global } from "@gte-agent/core/global"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { Skill } from "@gte-agent/core/skill"
import { runtimeScope } from "../fixture/runtime-scope"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigSkillPlugin.Plugin", () => {
  it.effect("registers configured skill directories and URLs", () =>
    Effect.gen(function* () {
      const directory = AbsolutePath.make("/repo/packages/app")
      const sources: Skill.Source[] = []
      const transform = Effect.fnUntraced(function* () {
        return Effect.fnUntraced(function* (update: (editor: Skill.Editor) => void) {
          update({
            source: (source) => sources.push(source),
            list: () => sources,
          })
        })
      })

      yield* ConfigSkillPlugin.Plugin.effect.pipe(
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Directory({ type: "directory", path: AbsolutePath.make("/repo/.opencode") }),
                new Config.Document({
                  type: "document",
                  info: decode({
                    skills: ["./skills", "~/shared-skills", "/opt/skills", "https://example.test/skills/"],
                  }),
                }),
              ]),
          }),
        ),
        Effect.provideService(Global.Service, Global.Service.of(Global.make({ home: "/home/test" }))),
        Effect.provideService(RuntimeScope.Service, RuntimeScope.Service.of(runtimeScope({ directory }))),
        Effect.provideService(
          Skill.Service,
          Skill.Service.of({
            transform,
            sources: () => Effect.succeed(sources),
            list: () => Effect.succeed([]),
            forAgent: () => Effect.succeed([]),
          }),
        ),
      )

      expect(sources).toEqual([
        new Skill.DirectorySource({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.opencode", "skill")),
        }),
        new Skill.DirectorySource({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.opencode", "skills")),
        }),
        new Skill.DirectorySource({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }),
        new Skill.DirectorySource({
          type: "directory",
          path: AbsolutePath.make(path.join("/home/test", "shared-skills")),
        }),
        new Skill.DirectorySource({ type: "directory", path: AbsolutePath.make("/opt/skills") }),
        new Skill.UrlSource({ type: "url", url: "https://example.test/skills/" }),
      ])
    }),
  )
})
