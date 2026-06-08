import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Tool } from "@gte-agent/core/public"
import { Catalog } from "@gte-agent/core/catalog"
import { RuntimeScopeServiceMap } from "@gte-agent/core/runtime-scope-layer"
import { Provider } from "@gte-agent/core/provider"
import { AbsolutePath } from "@gte-agent/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { FSUtil } from "../src/fs-util"
import { Event } from "../src/event"
import { Global } from "../src/global"
import { Project } from "../src/project"
import { ToolRegistry } from "../src/tool/registry"
import { ApplicationTools } from "../src/tool/application-tools"

const applicationTools = ApplicationTools.layer
const it = testEffect(
  RuntimeScopeServiceMap.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Project.defaultLayer,
        Event.defaultLayer,
        FSUtil.defaultLayer,
        Global.defaultLayer,
      ),
    ),
    Layer.provideMerge(applicationTools),
  ),
)

describe("RuntimeScopeServiceMap", () => {
  it.live("isolates runtime-scope state while sharing policy with catalog", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([blocked, allowed]) =>
        Effect.gen(function* () {
          yield* (yield* ApplicationTools.Service).attach({
            application_context: Tool.make({
              description: "Read application context",
              parameters: Schema.Struct({}),
              success: Schema.Struct({ ok: Schema.Boolean }),
              execute: () => Effect.succeed({ ok: true }),
            }),
          })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(blocked.path, "gte-agent.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "test" }] },
              }),
            ),
          )

          const update = (directory: string) =>
            Effect.gen(function* () {
              const catalog = yield* Catalog.Service
              const transform = yield* catalog.transform()
              yield* transform((editor) => editor.provider.update(Provider.ID.make("test"), () => {}))
              return {
                providers: yield* catalog.provider.all(),
                tools: yield* (yield* ToolRegistry.Service).definitions(),
              }
            }).pipe(Effect.scoped, Effect.provide(RuntimeScopeServiceMap.get({ directory: AbsolutePath.make(directory) })))

          const blockedState = yield* update(blocked.path)
          expect(blockedState.providers.some((provider) => provider.id === Provider.ID.make("test"))).toBe(false)
          expect(blockedState.tools.map((tool) => tool.name).sort()).toEqual(["application_context"])
          const allowedState = yield* update(allowed.path)
          expect(allowedState.providers.some((provider) => provider.id === Provider.ID.make("test"))).toBe(true)
          expect(allowedState.tools.map((tool) => tool.name).sort()).toEqual(["application_context"])
        }),
      ),
    ),
  )
})
