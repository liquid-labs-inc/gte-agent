import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Command } from "@/command"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"

const it = testEffect(Layer.mergeAll(Command.defaultLayer, CrossSpawnSpawner.defaultLayer))

afterEach(async () => {
  delete process.env["GTE_AGENT_DISABLE_WORKFLOWS"]
  await disposeAllInstances()
})

describe("workflow.commands", () => {
  it.instance("registers /workflow and the bundled /deep-research", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const workflow = yield* command.get("workflow")
      expect(workflow).toBeDefined()
      expect(workflow?.hints).toContain("$ARGUMENTS")
      const template = yield* Effect.promise(() => Promise.resolve(workflow!.template))
      expect(template).toContain("workflow")

      const research = yield* command.get("deep-research")
      expect(research).toBeDefined()
      const researchTemplate = (yield* Effect.promise(() => Promise.resolve(research!.template))) as string
      expect(researchTemplate).toContain("deep-research")
      expect(researchTemplate).toContain("<workflow_script>")
    }),
  )

  it.instance("registers project workflows from .opencode/workflows as commands", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, ".opencode", "workflows")
      yield* Effect.promise(async () => {
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(
          path.join(dir, "triage.mjs"),
          "// ---\n// name: triage\n// description: triage the backlog\n// ---\nreturn 1",
        )
      })
      const command = yield* Command.Service
      const triage = yield* command.get("triage")
      expect(triage).toBeDefined()
      expect(triage?.description).toBe("triage the backlog")
      expect(triage?.source).toBe("workflow")
      const template = (yield* Effect.promise(() => Promise.resolve(triage!.template))) as string
      expect(template).toContain('"triage"')
      expect(template).toContain("<workflow_script>")
    }),
  )

  it.instance("kill switch removes workflow commands", () =>
    Effect.gen(function* () {
      process.env["GTE_AGENT_DISABLE_WORKFLOWS"] = "1"
      const command = yield* Command.Service
      expect(yield* command.get("workflow")).toBeUndefined()
      expect(yield* command.get("deep-research")).toBeUndefined()
    }),
  )
})
