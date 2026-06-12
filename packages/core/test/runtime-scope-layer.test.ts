import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import type { ToolCall } from "@gte-agent/llm"
import { Tool } from "@gte-agent/core/public"
import { Catalog } from "@gte-agent/core/catalog"
import { RuntimeScopeServiceMap } from "@gte-agent/core/runtime-scope-layer"
import { Provider } from "@gte-agent/core/provider"
import { AbsolutePath } from "@gte-agent/core/schema"
import { Session } from "@gte-agent/core/session"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { EXPECTED_GTE_TOOLS } from "./lib/gte-stub"
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

          // Every runtime scope's default registry exposes the application
          // tools plus the read-only gte_* catalog wired through GteTools.
          const expectedTools = ["application_context", ...EXPECTED_GTE_TOOLS].sort()
          const blockedState = yield* update(blocked.path)
          expect(blockedState.providers.some((provider) => provider.id === Provider.ID.make("test"))).toBe(false)
          expect(blockedState.tools.map((tool) => tool.name).sort()).toEqual(expectedTools)
          const allowedState = yield* update(allowed.path)
          expect(allowedState.providers.some((provider) => provider.id === Provider.ID.make("test"))).toBe(true)
          expect(allowedState.tools.map((tool) => tool.name).sort()).toEqual(expectedTools)
        }),
      ),
    ),
  )

  // Proves the gte_* tools execute end-to-end through the canonical
  // runtime-scope registry (the same path a real agent session resolves).
  // Both calls settle as typed tool errors before any HTTP request: quote
  // input validation and address resolution run ahead of every gte-ts call,
  // so this test never touches the network.
  it.live("settles gte tool calls through the default registry as typed errors", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const sessionID = Session.ID.make("ses_runtime_scope_gte")
          const registry = yield* ToolRegistry.Service
          const call = (name: string, input: unknown): ToolCall => ({ type: "tool-call", id: `call-${name}`, name, input })

          const quote = yield* registry.execute({
            sessionID,
            call: call("gte_quote", { symbol: "BTC-USD", side: "buy", baseSize: 1, quoteSize: 100 }),
          })
          expect(quote).toEqual({ type: "error", value: "Provide exactly one of `baseSize` or `quoteSize`." })

          // No SessionStore exists in this scope, so the tracked-address
          // fallback is inert and the tool asks for an explicit address.
          const balances = yield* registry.execute({ sessionID, call: call("gte_balances", {}) })
          expect(balances.type).toBe("error")
          expect(String((balances as { value: unknown }).value)).toContain("no tracked address")
        }).pipe(Effect.scoped, Effect.provide(RuntimeScopeServiceMap.get({ directory: AbsolutePath.make(dir.path) }))),
      ),
    ),
  )
})
