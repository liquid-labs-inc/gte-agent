export * as DynamicToolSaved from "./saved"

import path from "path"
import { unlink } from "node:fs/promises"
import { Effect, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { RuntimeScope } from "../runtime-scope"
import { DynamicToolSchema } from "./schema"

/**
 * Saved dynamic tools: one JSON `Definition` per file under `.gte-agent/tools/`
 * in the project (shared through the repo) and `~/.gte-agent/tools/` globally.
 * JSON rather than the saved-workflow `.mjs` frontmatter format because a
 * definition carries a structured parameter schema a comment block cannot hold
 * faithfully. The project wins name collisions; workshop creations always
 * write the global directory, and project files are repo-owned (the workshop
 * refuses to remove them). Invalid files are skipped with a structured
 * warning, never a crash.
 */

export const DIRECTORY = ".gte-agent/tools"

export type Scope = "global" | "project"

export type Saved = {
  readonly definition: DynamicToolSchema.Definition
  readonly scope: Scope
  readonly file: string
}

/**
 * Discovers every saved dynamic tool visible to the current runtime scope.
 * Global before project so a project file with the same name overrides it;
 * the result is sorted by name for stable listings.
 */
export const discover = Effect.fn("DynamicToolSaved.discover")(function* () {
  const scope = yield* RuntimeScope.Service
  const global = yield* Global.Service
  const byName = new Map<string, Saved>()
  for (const found of yield* scan(path.join(global.home, DIRECTORY), "global"))
    byName.set(found.definition.name, found)
  for (const found of yield* scan(path.join(scope.project.directory, DIRECTORY), "project"))
    byName.set(found.definition.name, found)
  return [...byName.values()].toSorted((a, b) => a.definition.name.localeCompare(b.definition.name))
})

/** Persists a definition to the global directory and returns the saved record. */
export const save = Effect.fn("DynamicToolSaved.save")(function* (definition: DynamicToolSchema.Definition) {
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const file = path.join(global.home, DIRECTORY, `${definition.name}.json`)
  const encoded = yield* Schema.encodeEffect(DynamicToolSchema.Definition)(definition)
  yield* fs.writeWithDirs(file, JSON.stringify(encoded, null, 2) + "\n")
  return { definition, scope: "global", file } satisfies Saved
})

/** Deletes a global definition file; a missing file is already-removed, not an error. */
export const remove = Effect.fn("DynamicToolSaved.remove")(function* (name: string) {
  const global = yield* Global.Service
  yield* Effect.promise(() =>
    unlink(path.join(global.home, DIRECTORY, `${name}.json`)).catch(() => undefined),
  )
})

const decodeDefinition = Schema.decodeUnknownEffect(DynamicToolSchema.Definition)

const scan = Effect.fn("DynamicToolSaved.scan")(function* (directory: string, scope: Scope) {
  const fs = yield* FSUtil.Service
  const files = yield* fs
    .glob("*.json", { cwd: directory, absolute: true, dot: true, symlink: true })
    .pipe(Effect.catch(() => Effect.succeed([] as string[])))
  const loaded = yield* Effect.forEach(files.toSorted(), (file) => load(fs, file, scope))
  return loaded.filter((item) => item !== undefined)
})

const load = Effect.fn("DynamicToolSaved.load")(function* (fs: FSUtil.Interface, file: string, scope: Scope) {
  const definition = yield* fs.readJson(file).pipe(
    Effect.flatMap(decodeDefinition),
    Effect.catch(() => Effect.succeed(undefined)),
  )
  if (definition === undefined) {
    yield* Effect.logWarning("Skipping unreadable or malformed saved dynamic tool").pipe(
      Effect.annotateLogs({ file, scope }),
    )
    return undefined
  }
  if (!DynamicToolSchema.validName(definition.name)) {
    yield* Effect.logWarning("Skipping saved dynamic tool with an invalid name").pipe(
      Effect.annotateLogs({ file, scope, name: definition.name }),
    )
    return undefined
  }
  const invalid = DynamicToolSchema.validateCode(definition.code)
  if (invalid !== undefined) {
    yield* Effect.logWarning("Skipping saved dynamic tool with invalid code").pipe(
      Effect.annotateLogs({ file, scope, name: definition.name, reason: invalid.reason }),
    )
    return undefined
  }
  return { definition, scope, file } satisfies Saved
})
