#!/usr/bin/env bun
/** Dump the advertised tool definitions exactly as the runner sends them. */
import { Effect, Layer } from "effect"
import { Database } from "@gte-agent/core/database/database"
import { GteData } from "@gte-agent/core/gte-data/gte-data"
import { Permission } from "@gte-agent/core/permission"
import { SessionStore } from "@gte-agent/core/session/store"
import { ApplicationTools } from "@gte-agent/core/tool/application-tools"
import { GteTools } from "@gte-agent/core/tool/gte/tools"
import { ToolRegistry } from "@gte-agent/core/tool/registry"

const database = Database.layerFromPath(":memory:")
const store = SessionStore.layer.pipe(Layer.provide(database))
const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "allow" }),
    assert: () => Effect.void,
    reply: () => Effect.die("unused"),
    get: () => Effect.succeed(undefined),
    list: () => Effect.succeed([]),
    forSession: () => Effect.succeed([]),
  }),
)
const registry = ToolRegistry.layer.pipe(Layer.provide(permission), Layer.provide(ApplicationTools.layer))
const gteData = GteData.defaultLayer
const gteTools = GteTools.layer.pipe(Layer.provide(Layer.mergeAll(registry, gteData, store)))

const program = Effect.gen(function* () {
  const tools = yield* ToolRegistry.Service
  const defs = yield* tools.definitions()
  defs.forEach((def, index) => {
    const schema = def.inputSchema as Record<string, unknown> | undefined
    const type = schema?.["type"]
    const flag = type === "object" ? "" : "  <-- NOT object"
    console.log(`${index}\t${def.name}\ttype=${JSON.stringify(type)}${flag}`)
    if (type !== "object") console.log(JSON.stringify(schema, null, 2))
  })
}).pipe(Effect.provide(Layer.mergeAll(registry, gteTools)), Effect.orDie)

await Effect.runPromise(program)
