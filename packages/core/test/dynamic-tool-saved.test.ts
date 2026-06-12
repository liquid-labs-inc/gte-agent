import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { DynamicToolSaved } from "@gte-agent/core/dynamic-tool/saved"
import { FSUtil } from "@gte-agent/core/fs-util"
import { Global } from "@gte-agent/core/global"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { runtimeScope } from "./fixture/runtime-scope"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const VALID = {
  name: "double_number",
  description: "Doubles a number",
  parameters: { value: { type: "number" } },
  code: "return params.value * 2",
}

const writeTool = (dir: string, file: string, content: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(dir, DynamicToolSaved.DIRECTORY), { recursive: true })
    await fs.writeFile(path.join(dir, DynamicToolSaved.DIRECTORY, file), content)
  })

const provided = (home: string, project: string) =>
  Layer.mergeAll(
    FSUtil.defaultLayer,
    Global.layerWith({ home }),
    Layer.succeed(
      RuntimeScope.Service,
      RuntimeScope.Service.of(
        runtimeScope({ directory: AbsolutePath.make(project) }, { projectDirectory: AbsolutePath.make(project) }),
      ),
    ),
  )

const withDirs = (use: (dirs: { home: string; project: string }) => Effect.Effect<void, never, never>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const home = path.join(tmp.path, "home")
        const project = path.join(tmp.path, "project")
        yield* Effect.promise(() => fs.mkdir(home, { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))
        yield* use({ home, project })
      }),
    ),
    Effect.scoped,
  )

describe("DynamicToolSaved", () => {
  it.live("save persists to the global directory and discover round-trips it", () =>
    withDirs(({ home, project }) =>
      Effect.gen(function* () {
        const saved = yield* DynamicToolSaved.save(VALID).pipe(Effect.provide(provided(home, project)))
        expect(saved.scope).toBe("global")
        expect(saved.file).toBe(path.join(home, DynamicToolSaved.DIRECTORY, "double_number.json"))

        const found = yield* DynamicToolSaved.discover().pipe(Effect.provide(provided(home, project)))
        expect(found).toHaveLength(1)
        expect(found[0]?.definition).toEqual(VALID)
        expect(found[0]?.scope).toBe("global")
      }).pipe(Effect.orDie),
    ),
  )

  it.live("a project file wins a name collision with a global one", () =>
    withDirs(({ home, project }) =>
      Effect.gen(function* () {
        yield* writeTool(home, "shared.json", JSON.stringify({ ...VALID, name: "shared", description: "global" }))
        yield* writeTool(project, "shared.json", JSON.stringify({ ...VALID, name: "shared", description: "project" }))

        const found = yield* DynamicToolSaved.discover().pipe(Effect.provide(provided(home, project)))
        const shared = found.filter((item) => item.definition.name === "shared")
        expect(shared).toHaveLength(1)
        expect(shared[0]?.scope).toBe("project")
        expect(shared[0]?.definition.description).toBe("project")
      }).pipe(Effect.orDie),
    ),
  )

  it.live("skips malformed JSON, invalid names, and invalid code without crashing", () =>
    withDirs(({ home, project }) =>
      Effect.gen(function* () {
        yield* writeTool(project, "broken.json", "{ not json")
        yield* writeTool(project, "bad-name.json", JSON.stringify({ ...VALID, name: "gte_usurper" }))
        yield* writeTool(project, "bad-code.json", JSON.stringify({ ...VALID, name: "bad_code", code: "eval('1')" }))
        yield* writeTool(project, "ok.json", JSON.stringify(VALID))

        const found = yield* DynamicToolSaved.discover().pipe(Effect.provide(provided(home, project)))
        expect(found.map((item) => item.definition.name)).toEqual(["double_number"])
      }).pipe(Effect.orDie),
    ),
  )

  it.live("remove deletes the global file and tolerates a missing one", () =>
    withDirs(({ home, project }) =>
      Effect.gen(function* () {
        yield* DynamicToolSaved.save(VALID).pipe(Effect.provide(provided(home, project)))
        yield* DynamicToolSaved.remove("double_number").pipe(Effect.provide(provided(home, project)))
        yield* DynamicToolSaved.remove("double_number").pipe(Effect.provide(provided(home, project)))
        const found = yield* DynamicToolSaved.discover().pipe(Effect.provide(provided(home, project)))
        expect(found).toHaveLength(0)
      }).pipe(Effect.orDie),
    ),
  )
})
