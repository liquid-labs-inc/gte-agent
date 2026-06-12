import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Tool, ToolFailure } from "@gte-agent/llm"
import { DynamicToolRuntime } from "@gte-agent/core/dynamic-tool/runtime"
import { Permission } from "@gte-agent/core/permission"
import { SessionSchema } from "@gte-agent/core/session/schema"
import { ApplicationTools } from "@gte-agent/core/tool/application-tools"
import { ToolRegistry } from "@gte-agent/core/tool/registry"
import { it } from "./lib/effect"

const sessionID = SessionSchema.ID.make("ses_dynamic_tool_runtime")

const permission = Layer.mock(Permission.Service, { assert: () => Effect.void })

/**
 * A stub gte_* tool so the proxy path exercises a real registry round trip
 * without the GteData service. The worker, the message protocol, and the
 * allowlist are all real.
 */
const echoTool = Effect.gen(function* () {
  const registry = yield* ToolRegistry.Service
  yield* registry.contribute((editor) =>
    editor.set("gte_echo", {
      tool: Tool.make({
        description: "echo",
        parameters: Schema.Struct({ value: Schema.Number }),
        success: Schema.Struct({ value: Schema.Number }),
      }),
      execute: ({ parameters }) => Effect.succeed({ value: parameters.value }),
    }),
  )
})

const harness = <A, E>(
  body: Effect.Effect<A, E, DynamicToolRuntime.Service>,
  options?: DynamicToolRuntime.Options,
) =>
  Effect.gen(function* () {
    const registry = ToolRegistry.layer.pipe(Layer.provide(permission), Layer.provide(ApplicationTools.layer))
    const runtime = DynamicToolRuntime.layerWith({ timeoutMs: 10_000, ...options }).pipe(Layer.provide(registry))
    return yield* echoTool.pipe(
      Effect.andThen(body),
      Effect.provide(Layer.mergeAll(registry, runtime)),
    )
  })

const run = (code: string, params: unknown = {}) =>
  Effect.gen(function* () {
    const runtime = yield* DynamicToolRuntime.Service
    return yield* runtime.execute({ sessionID, name: "test_tool", code, params })
  })

const failure = (code: string, params: unknown = {}) => run(code, params).pipe(Effect.flip)

describe("DynamicToolRuntime", () => {
  it.live("evaluates code over params and returns the resolved value", () =>
    harness(
      run("return params.a + params.b", { a: 2, b: 3 }).pipe(Effect.map((result) => expect(result).toBe(5))),
    ),
  )

  it.live("gte() proxies through the registry and resolves with the tool result", () =>
    harness(
      run("const echoed = await gte('gte_echo', { value: 20 })\nreturn echoed.value + 1").pipe(
        Effect.map((result) => expect(result).toBe(21)),
      ),
    ),
  )

  it.live("gte() rejects tools outside the gte_* allowlist", () =>
    harness(
      failure("return await gte('websearch', { query: 'x' })").pipe(
        Effect.map((error) => expect(error.message).toContain("gte() can only call the read-only gte_* data tools")),
      ),
    ),
  )

  it.live("the per-invocation gte() call cap fails the overflowing call", () =>
    harness(
      failure(
        "for (let i = 0; i < 4; i++) await gte('gte_echo', { value: i })\nreturn 'unreachable'",
      ).pipe(Effect.map((error) => expect(error.message).toContain("call limit reached"))),
      { maxCalls: 3 },
    ),
  )

  it.live("banned globals are undefined inside tool code", () =>
    harness(
      run("return [typeof fetch, typeof Bun, typeof process, typeof require].join(',')").pipe(
        Effect.map((result) => expect(result).toBe("undefined,undefined,undefined,undefined")),
      ),
    ),
  )

  it.live("a hung invocation times out and the failure names the tool", () =>
    harness(
      failure("await new Promise(() => {})").pipe(
        Effect.map((error) => expect(error.message).toBe("Tool test_tool timed out after 0.3s")),
      ),
      { timeoutMs: 300 },
    ),
  )

  it.live("thrown errors surface their message as the tool failure", () =>
    harness(
      failure("throw new Error('market not found')").pipe(
        Effect.map((error) => {
          expect(error).toBeInstanceOf(ToolFailure)
          expect(error.message).toBe("market not found")
        }),
      ),
    ),
  )

  it.live("non-clonable values degrade to their JSON shape", () =>
    harness(
      run("return { ok: true, fn: () => 1 }").pipe(Effect.map((result) => expect(result).toEqual({ ok: true }))),
    ),
  )
})
