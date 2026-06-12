/**
 * Milestone 9 production gap: websearch and webfetch must reach the model
 * through the production tool registry. Both were implemented and tested in
 * core but composed only into `BuiltInTools.runtimeScopeLayer`, which the
 * server never builds — the same gap fix-list item 1 closed for the workflow
 * tool. This test composes the registry the way the server handlers do (see
 * ../src/handlers.ts `webTools`) and asserts both tools are contributed.
 */
// Hermetic env bootstrap MUST precede any @gte-agent/core import.
import "./httpapi-exercise/setup"
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Permission } from "@gte-agent/core/permission"
import { ApplicationTools } from "@gte-agent/core/tool/application-tools"
import { ToolRegistry } from "@gte-agent/core/tool/registry"
import { WebFetchTool } from "@gte-agent/core/tool/webfetch"
import { WebSearchTool } from "@gte-agent/core/tool/websearch"
import { ToolOutputStore } from "@gte-agent/core/tool-output-store"

const permission = Layer.mock(Permission.Service, { assert: () => Effect.void })

describe("web tools in the production registry", () => {
  test("websearch and webfetch are contributed", async () => {
    const registry = ToolRegistry.layer.pipe(Layer.provide(permission), Layer.provide(ApplicationTools.layer))
    const tools = Layer.mergeAll(
      WebFetchTool.layer,
      WebSearchTool.layer.pipe(Layer.provide(WebSearchTool.defaultConfigLayer)),
    ).pipe(
      Layer.provide(registry),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(ToolOutputStore.defaultLayer),
    )
    const names = await Effect.runPromise(
      Effect.gen(function* () {
        const resolved = yield* ToolRegistry.Service
        return (yield* resolved.definitions()).map((definition) => definition.name)
      }).pipe(Effect.provide(Layer.mergeAll(registry, tools)), Effect.scoped),
    )
    expect(names).toContain("websearch")
    expect(names).toContain("webfetch")
  })
})
