import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "@gte-agent/core/agent"
import { FSUtil } from "@gte-agent/core/fs-util"
import { SkillPlugin } from "@gte-agent/core/plugin/skill"
import { Skill } from "@gte-agent/core/skill"
import { SkillDiscovery } from "@gte-agent/core/skill/discovery"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Skill.layer.pipe(
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(SkillDiscovery.defaultLayer),
    Layer.provideMerge(Agent.runtimeScopeLayer),
  ),
)

describe("SkillPlugin.Plugin", () => {
  it.effect("registers the built-in customize-gte-agent skill", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* SkillPlugin.Plugin.effect.pipe(Effect.provideService(Skill.Service, skill))

      expect(yield* skill.list()).toContainEqual(
        expect.objectContaining({
          name: "customize-gte-agent",
          description: expect.stringContaining("gte-agent's own configuration"),
        }),
      )
    }),
  )
})
