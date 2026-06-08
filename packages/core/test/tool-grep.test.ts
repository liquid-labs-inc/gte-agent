import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FSUtil } from "@gte-agent/core/fs-util"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { FileSystem } from "@gte-agent/core/filesystem"
import { Ripgrep as FileSystemRipgrep } from "@gte-agent/core/filesystem/ripgrep"
import { RuntimeScopeSearch } from "@gte-agent/core/runtime-scope-search"
import { Permission } from "@gte-agent/core/permission"
import { AppProcess } from "@gte-agent/core/process"
import { ProjectReference } from "@gte-agent/core/project-reference"
import { Ripgrep } from "@gte-agent/core/ripgrep"
import { AbsolutePath, RelativePath } from "@gte-agent/core/schema"
import { Session } from "@gte-agent/core/session"
import { GrepTool } from "@gte-agent/core/tool/grep"
import { ToolRegistry } from "@gte-agent/core/tool/registry"
import { runtimeScope } from "./fixture/runtime-scope"
import { tmpdir } from "./fixture/tmpdir"
import { it as runtimeIt } from "./lib/effect"
import { testEffect } from "./lib/effect"

const assertions: Permission.AssertInput[] = []
const searches: RuntimeScopeSearch.GrepInput[] = []
const roots: FileSystem.RootTarget[] = []
let allow = true
let result = new RuntimeScopeSearch.GrepResult({ items: [], truncated: false, partial: false })
let searchFailure: Ripgrep.InvalidPatternError | undefined

const filesystem = Layer.succeed(
  FileSystem.Service,
  FileSystem.Service.of({
    read: () => Effect.die("unused"),
    resolveReadPath: () => Effect.die("unused"),
    resolveRead: () => Effect.die("unused"),
    readResolved: () => Effect.die("unused"),
    readTextPageResolved: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    resolveRoot: (input = {}) =>
      Effect.succeed(
        new FileSystem.RootTarget({
          absolute: `/project/${input.path ?? "."}`,
          real: `/project/${input.path ?? "."}`,
          directory: "/project",
          root: "/project",
          resource: input.reference === undefined ? (input.path ?? ".") : `${input.reference}:${input.path ?? "."}`,
          reference: input.reference,
          type: "directory",
          dev: 1,
        }),
      ),
    revalidateRoot: Effect.succeed,
    resolveList: () => Effect.die("unused"),
    listResolved: () => Effect.die("unused"),
    listPage: () => Effect.die("unused"),
    listPageResolved: () => Effect.die("unused"),
    find: () => Effect.die("unused"),
    grep: () => Effect.die("unused"),
    isIgnored: () => false,
  }),
)
const search = Layer.succeed(
  RuntimeScopeSearch.Service,
  RuntimeScopeSearch.Service.of({
    files: () => Effect.die("unused"),
    grep: (input, root) =>
      Effect.sync(() => {
        searches.push(input)
        if (root) roots.push(root)
        if (searchFailure) throw searchFailure
        return result
      }),
  }),
)
const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    assert: (input) =>
      Effect.sync(() => {
        assertions.push(input)
      }).pipe(Effect.andThen(allow ? Effect.void : Effect.fail(new Permission.DeniedError({ rules: [] })))),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
const grep = GrepTool.layer.pipe(
  Layer.provide(registry),
  Layer.provide(filesystem),
  Layer.provide(search),
  Layer.provide(permission),
)
const it = testEffect(Layer.mergeAll(registry, filesystem, search, permission, grep))
const sessionID = Session.ID.make("ses_grep_tool_test")

const execute = (input: Record<string, unknown>) =>
  ToolRegistry.Service.use((registry) =>
    registry.execute({ sessionID, call: { type: "tool-call", id: "call-grep", name: "grep", input } }),
  )

const settle = (input: Record<string, unknown>) =>
  ToolRegistry.Service.use((registry) =>
    registry.settle({ sessionID, call: { type: "tool-call", id: "call-grep", name: "grep", input } }),
  )

const reset = () => {
  assertions.length = 0
  searches.length = 0
  roots.length = 0
  allow = true
  searchFailure = undefined
  result = new RuntimeScopeSearch.GrepResult({ items: [], truncated: false, partial: false })
}

function references(entries: Record<string, ProjectReference.Resolved>) {
  return ProjectReference.Service.of({
    list: () => Effect.succeed(Object.values(entries)),
    get: (name) => Effect.succeed(entries[name]),
    resolveMention: () => Effect.succeed(undefined),
    ensurePath: () => Effect.void,
    containsManagedPath: () => Effect.succeed(false),
  })
}

function provideLive(directory: string, projectReferences = references({})) {
  const dependencies = Layer.mergeAll(
    FSUtil.defaultLayer,
    FileSystemRipgrep.defaultLayer,
    AppProcess.defaultLayer,
    Layer.succeed(RuntimeScope.Service, RuntimeScope.Service.of(runtimeScope({ directory: AbsolutePath.make(directory) }))),
    Layer.succeed(ProjectReference.Service, projectReferences),
  )
  const filesystem = FileSystem.layer.pipe(Layer.provide(dependencies))
  const search = RuntimeScopeSearch.layer.pipe(
    Layer.provide(filesystem),
    Layer.provide(Ripgrep.layer.pipe(Layer.provide(dependencies))),
    Layer.provide(FSUtil.defaultLayer),
    Layer.provide(dependencies),
  )
  const registry = ToolRegistry.defaultLayer.pipe(Layer.provide(permission))
  const grep = GrepTool.layer.pipe(
    Layer.provide(registry),
    Layer.provide(filesystem),
    Layer.provide(search),
    Layer.provide(permission),
  )
  return Layer.mergeAll(registry, filesystem, search, permission, grep)
}

describe("GrepTool", () => {
  it.effect("registers the grep contribution", () =>
    Effect.gen(function* () {
      reset()
      expect(yield* (yield* ToolRegistry.Service).definitions()).toMatchObject([{ name: "grep" }])
    }),
  )

  it.effect("authorizes the regex resource and delegates an active RuntimeScope grep", () =>
    Effect.gen(function* () {
      reset()
      const input = { pattern: "needle", path: "src", include: "*.ts", limit: 2 }

      expect(yield* execute(input)).toEqual({ type: "text", value: "No files found" })
      expect(assertions).toEqual([
        {
          sessionID,
          action: "grep",
          resources: ["needle"],
          save: ["*"],
          metadata: { root: "src", reference: undefined, path: RelativePath.make("src"), include: "*.ts", limit: 2 },
        },
      ])
      expect(searches).toEqual([{ pattern: "needle", path: RelativePath.make("src"), include: "*.ts", limit: 2 }])
      expect(roots).toMatchObject([{ resource: "src" }])
    }),
  )

  it.effect("delegates named reference grep and exposes the canonical selected root in metadata", () =>
    Effect.gen(function* () {
      reset()

      yield* execute({ pattern: "guide", path: "docs", reference: "manual", include: "*.md" })

      expect(assertions[0]).toMatchObject({
        resources: ["guide"],
        metadata: { root: "manual:docs", reference: "manual", path: RelativePath.make("docs"), include: "*.md" },
      })
      expect(searches).toEqual([
        { pattern: "guide", path: RelativePath.make("docs"), reference: "manual", include: "*.md" },
      ])
    }),
  )

  it.effect("does not search when permission is denied", () =>
    Effect.gen(function* () {
      reset()
      allow = false

      expect(yield* execute({ pattern: "secret" })).toEqual({ type: "error", value: "Unable to grep for secret" })
      expect(assertions).toHaveLength(1)
      expect(searches).toEqual([])
    }),
  )

  it.effect("keeps structured results raw while formatting bounded partial previews for models", () =>
    Effect.gen(function* () {
      reset()
      result = new RuntimeScopeSearch.GrepResult({
        items: [
          new RuntimeScopeSearch.Match({
            path: RelativePath.make("src/index.ts"),
            canonical: "/project/src/index.ts",
            resource: "src/index.ts",
            lines: "needle preview",
            linePreviewTruncated: true,
            line: 3,
            offset: 8,
            submatches: [new RuntimeScopeSearch.Submatch({ text: "needle", start: 0, end: 6 })],
            mtime: 1,
          }),
        ],
        truncated: true,
        partial: true,
      })

      const settlement = yield* settle({ pattern: "needle" })
      expect(settlement.output?.structured).toEqual(result)
      expect(settlement.result).toEqual({
        type: "text",
        value:
          "Found 1 matches\nsrc/index.ts:\n  Line 3: needle preview...\n\n(Results are truncated: showing first 1 matches. Consider using a more specific path or pattern.)\n\n(Some paths were inaccessible and skipped)",
      })
    }),
  )

  it.effect("returns a useful tool error for an invalid regex", () =>
    Effect.gen(function* () {
      reset()
      searchFailure = new Ripgrep.InvalidPatternError({
        pattern: "[",
        message: "regex parse error: unclosed character class",
      })

      expect(yield* execute({ pattern: "[" })).toEqual({
        type: "error",
        value: 'Invalid grep pattern "[": regex parse error: unclosed character class',
      })
      expect(searches).toEqual([{ pattern: "[" }])
    }),
  )

  runtimeIt.live("greps active RuntimeScope and named-reference files with include globs", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const docs = path.join(tmp.path, "docs")
        return Effect.gen(function* () {
          reset()
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "src"))
            await fs.mkdir(docs)
            await fs.writeFile(path.join(tmp.path, "src", "index.ts"), "needle ts\n")
            await fs.writeFile(path.join(tmp.path, "src", "notes.txt"), "needle txt\n")
            await fs.writeFile(path.join(docs, "guide.md"), "needle docs\n")
          })

          expect(yield* execute({ pattern: "needle", path: "src", include: "*.ts" })).toEqual({
            type: "text",
            value: "Found 1 matches\nsrc/index.ts:\n  Line 1: needle ts\n",
          })
          expect(yield* execute({ pattern: "needle", reference: "docs", include: "*.md" })).toEqual({
            type: "text",
            value: "Found 1 matches\ndocs:guide.md:\n  Line 1: needle docs\n",
          })
        }).pipe(
          Effect.provide(provideLive(tmp.path, references({ docs: { name: "docs", kind: "local", path: docs } }))),
        )
      }),
    ),
  )
})
