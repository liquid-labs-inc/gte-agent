import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Command } from "@gte-agent/core/command"
import { Model } from "@gte-agent/core/model"
import { Provider } from "@gte-agent/core/provider"
import { testEffect } from "./lib/effect"

const it = testEffect(Command.runtimeScopeLayer)

describe("Command", () => {
  it.effect("applies command transforms and preserves later overrides", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const transform = yield* command.transform()
      yield* transform((editor) => {
        editor.update("review", (command) => {
          command.template = "First"
          command.description = "Review code"
        })
        editor.update("review", (command) => {
          command.template = "Second"
          command.model = {
            id: Model.ID.make("claude"),
            providerID: Provider.ID.make("anthropic"),
            variant: Model.VariantID.make("high"),
          }
        })
      })

      expect(yield* command.get("review")).toEqual(
        new Command.Info({
          name: "review",
          template: "Second",
          description: "Review code",
          model: {
            id: Model.ID.make("claude"),
            providerID: Provider.ID.make("anthropic"),
            variant: Model.VariantID.make("high"),
          },
        }),
      )
      expect(yield* command.list()).toEqual([
        new Command.Info({
          name: "review",
          template: "Second",
          description: "Review code",
          model: {
            id: Model.ID.make("claude"),
            providerID: Provider.ID.make("anthropic"),
            variant: Model.VariantID.make("high"),
          },
        }),
      ])
    }),
  )
})
