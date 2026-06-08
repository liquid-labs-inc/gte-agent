import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Command } from "@gte-agent/core/command"
import { Config } from "@gte-agent/core/config"
import { ConfigCommandPlugin } from "@gte-agent/core/config/plugin/command"
import { FSUtil } from "@gte-agent/core/fs-util"
import { Model } from "@gte-agent/core/model"
import { Provider } from "@gte-agent/core/provider"
import { AbsolutePath } from "@gte-agent/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Command.runtimeScopeLayer, FSUtil.defaultLayer))
const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigCommandPlugin.Plugin", () => {
  it.live("loads inline and file-based commands in config order", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "commands", "nested"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "commands", "review.md"),
              `---
description: File review
agent: reviewer
model: anthropic/claude
variant: high
subtask: true
---
Review files`,
            )
            await fs.writeFile(path.join(tmp.path, "commands", "nested", "docs.md"), "Write docs")
            await fs.writeFile(path.join(tmp.path, "commands", "empty.md"), "")
          })

          const command = yield* Command.Service
          yield* ConfigCommandPlugin.Plugin.effect.pipe(
            Effect.provideService(Command.Service, command),
            Effect.provideService(
              Config.Service,
              Config.Service.of({
                entries: () =>
                  Effect.succeed([
                    new Config.Document({
                      type: "document",
                      info: decode({ commands: { review: { template: "Inline review" } } }),
                    }),
                    new Config.Directory({ type: "directory", path: AbsolutePath.make(tmp.path) }),
                  ]),
              }),
            ),
          )

          expect(yield* command.list()).toEqual([
            new Command.Info({
              name: "review",
              template: "Review files",
              description: "File review",
              agent: "reviewer",
              model: {
                providerID: Provider.ID.make("anthropic"),
                id: Model.ID.make("claude"),
                variant: Model.VariantID.make("high"),
              },
              subtask: true,
            }),
            new Command.Info({ name: "empty", template: "" }),
            new Command.Info({ name: "nested/docs", template: "Write docs" }),
          ])
        }),
      ),
    ),
  )
})
