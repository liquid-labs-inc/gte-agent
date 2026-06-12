import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Command } from "@gte-agent/core/command"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { CommandPlugin } from "@gte-agent/core/plugin/command"
import { AbsolutePath } from "@gte-agent/core/schema"
import { runtimeScope } from "../fixture/runtime-scope"
import { testEffect } from "../lib/effect"

const directory = AbsolutePath.make("/repo/packages/app")
const project = AbsolutePath.make("/repo")
const it = testEffect(
  Command.runtimeScopeLayer.pipe(
    Layer.provide(
      Layer.succeed(RuntimeScope.Service, RuntimeScope.Service.of(runtimeScope({ directory }, { projectDirectory: project }))),
    ),
  ),
)

describe("CommandPlugin.Plugin", () => {
  it.effect("registers built-in init and review commands", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* CommandPlugin.Plugin.effect.pipe(
        Effect.provideService(Command.Service, command),
        Effect.provideService(
          RuntimeScope.Service,
          RuntimeScope.Service.of(runtimeScope({ directory }, { projectDirectory: project })),
        ),
      )

      expect(yield* command.get("init")).toMatchObject({
        name: "init",
        description: "guided AGENTS.md setup",
      })
      expect((yield* command.get("init"))?.template).toContain("`/repo`")
      expect(yield* command.get("review")).toMatchObject({
        name: "review",
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        subtask: true,
      })
    }),
  )
})
