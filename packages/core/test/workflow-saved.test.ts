import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { FSUtil } from "@gte-agent/core/fs-util"
import { Global } from "@gte-agent/core/global"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { WorkflowSaved } from "@gte-agent/core/workflow/saved"
import { runtimeScope } from "./fixture/runtime-scope"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const VALID = `// ---
// name: explicit-name
// description: a saved workflow
// ---
return await agent({ prompt: args })
`

const writeWorkflow = (dir: string, file: string, content: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(dir, WorkflowSaved.DIRECTORY), { recursive: true })
    await fs.writeFile(path.join(dir, WorkflowSaved.DIRECTORY, file), content)
  })

const discover = (home: string, project: string) =>
  WorkflowSaved.discover().pipe(
    Effect.provide(FSUtil.defaultLayer),
    Effect.provide(Global.layerWith({ home })),
    Effect.provide(
      Layer.succeed(
        RuntimeScope.Service,
        RuntimeScope.Service.of(
          runtimeScope(
            { directory: AbsolutePath.make(project) },
            { projectDirectory: AbsolutePath.make(project) },
          ),
        ),
      ),
    ),
  )

const withDirs = (
  use: (dirs: { home: string; project: string }) => Effect.Effect<void, never, never>,
) =>
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

describe("WorkflowSaved.frontmatter", () => {
  it.effect("parses a well-formed block", () =>
    Effect.sync(() => {
      expect(WorkflowSaved.frontmatter(VALID)).toEqual({ name: "explicit-name", description: "a saved workflow" })
    }),
  )

  it.effect("returns empty metadata when there is no block or it is malformed", () =>
    Effect.sync(() => {
      expect(WorkflowSaved.frontmatter("return 1")).toEqual({})
      // Missing closing fence -> not a block.
      expect(WorkflowSaved.frontmatter("// ---\n// name: x\nreturn 1")).toEqual({})
    }),
  )
})

describe("WorkflowSaved.bundled", () => {
  it.effect("ships /deep-research with frontmatter metadata", () =>
    Effect.sync(() => {
      const bundled = WorkflowSaved.bundled()
      expect(bundled.name).toBe("deep-research")
      expect(bundled.scope).toBe("bundled")
      expect(bundled.description).toContain("research")
      expect(bundled.script).toContain("phase(")
    }),
  )
})

describe("WorkflowSaved.discover", () => {
  it.live("includes the bundled deep-research workflow with no user files", () =>
    withDirs(({ home, project }) =>
      Effect.gen(function* () {
        const found = yield* discover(home, project)
        expect(found.map((item) => item.name)).toContain("deep-research")
        expect(found.find((item) => item.name === "deep-research")?.scope).toBe("bundled")
      }),
    ),
  )

  it.live("discovers project and global workflows and parses their frontmatter", () =>
    withDirs(({ home, project }) =>
      Effect.gen(function* () {
        yield* writeWorkflow(home, "globally.mjs", "// ---\n// description: from global\n// ---\nreturn 1")
        yield* writeWorkflow(project, "locally.mjs", VALID)

        const found = yield* discover(home, project)
        const byName = new Map(found.map((item) => [item.name, item]))
        // global file has no name in frontmatter -> basename fallback
        expect(byName.get("globally")?.scope).toBe("global")
        expect(byName.get("globally")?.description).toBe("from global")
        // project file declares an explicit name
        expect(byName.get("explicit-name")?.scope).toBe("project")
        expect(byName.get("explicit-name")?.description).toBe("a saved workflow")
      }),
    ),
  )

  it.live("lets a project workflow win a name collision with a global one", () =>
    withDirs(({ home, project }) =>
      Effect.gen(function* () {
        yield* writeWorkflow(home, "shared.mjs", "// ---\n// description: global wins?\n// ---\nreturn 1")
        yield* writeWorkflow(project, "shared.mjs", "// ---\n// description: project wins\n// ---\nreturn 2")

        const found = yield* discover(home, project)
        const shared = found.filter((item) => item.name === "shared")
        expect(shared).toHaveLength(1)
        expect(shared[0]?.scope).toBe("project")
        expect(shared[0]?.description).toBe("project wins")
      }),
    ),
  )

  it.live("keeps the bundled deep-research when a project file tries to usurp its name", () =>
    withDirs(({ home, project }) =>
      Effect.gen(function* () {
        // A project file claiming the reserved name must not replace the bundled
        // command — the built-in script is the audited one.
        yield* writeWorkflow(project, "deep-research.mjs", "// ---\n// description: hijack\n// ---\nreturn 1")
        const found = yield* discover(home, project)
        const deepResearch = found.filter((item) => item.name === "deep-research")
        expect(deepResearch).toHaveLength(1)
        expect(deepResearch[0]?.scope).toBe("bundled")
        expect(deepResearch[0]?.description).not.toBe("hijack")
      }),
    ),
  )

  it.live("skips invalid scripts and invalid names without crashing", () =>
    withDirs(({ home, project }) =>
      Effect.gen(function* () {
        // Banned token -> WorkflowScript.validate rejects.
        yield* writeWorkflow(project, "bad-script.mjs", 'import fs from "node:fs"\nreturn 1')
        // Frontmatter name with a path separator -> invalid name.
        yield* writeWorkflow(project, "bad-name.mjs", "// ---\n// name: nested/name\n// ---\nreturn 1")
        yield* writeWorkflow(project, "ok.mjs", "return await agent({ prompt: args })")

        const found = yield* discover(home, project)
        const names = found.map((item) => item.name)
        expect(names).toContain("ok")
        expect(names).not.toContain("bad-script")
        expect(names).not.toContain("nested/name")
        // The valid bundled workflow still survives the bad neighbors.
        expect(names).toContain("deep-research")
      }),
    ),
  )
})
