export * as WorkflowSaved from "./saved"

import path from "path"
import { Effect } from "effect"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { RuntimeScope } from "../runtime-scope"
import { WorkflowScript } from "./script"
import DEEP_RESEARCH from "./deep-research.txt"

/**
 * Saved workflows: single `.mjs` files under `.gte-agent/workflows/` in the
 * project (shared through the repo) and `~/.gte-agent/workflows/` globally.
 * Each registers as a slash command `/<name>` (see plugin/workflow-command);
 * the project wins name collisions, and one bundled workflow — `/deep-research`
 * — always ships. The leading frontmatter comment block supplies metadata; the
 * file basename is the fallback name. Invalid scripts are skipped with a
 * structured warning, never a crash.
 */

export const DIRECTORY = ".gte-agent/workflows"

/**
 * Names a discovered workflow may not claim: the bundled commands ship with the
 * binary and must not be silently usurped by a project or global file (the
 * built-in script is the audited, tested one). A file using a reserved name is
 * skipped with a warning, so the bundled command always wins.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(["deep-research"])

export type Scope = "bundled" | "global" | "project"

export type Saved = {
  readonly name: string
  readonly description?: string
  /** Full file content (frontmatter included) — valid `workflow` tool input. */
  readonly script: string
  readonly scope: Scope
  /** Source path for discovered files; absent for the bundled workflow. */
  readonly file?: string
}

export type Frontmatter = {
  readonly name?: string
  readonly description?: string
}

/**
 * Command names must be a single lowercase slug segment, no path separators —
 * the TUI lowercases typed commands, so an uppercase name could never match.
 */
export function validName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(name)
}

/**
 * Parses the leading `// ---` … `// ---` frontmatter comment block. Anything
 * that is not a well-formed block (missing close, a non `// key: value` line)
 * yields empty metadata rather than an error: the basename then supplies the
 * name and the workflow still registers.
 */
export function frontmatter(script: string): Frontmatter {
  const lines = script.split(/\r?\n/)
  let start = 0
  while (start < lines.length && !lines[start]?.trim()) start++
  if (lines[start]?.trim() !== "// ---") return {}
  const fields: Record<string, string> = {}
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? ""
    if (line === "// ---") return { name: fields["name"], description: fields["description"] }
    const match = line.match(/^\/\/\s*([\w-]+)\s*:\s*(.*)$/)
    if (!match) return {}
    fields[match[1].toLowerCase()] = match[2].trim()
  }
  return {}
}

/** The bundled `/deep-research` workflow, registered through the same path as user files. */
export function bundled(): Saved {
  const meta = frontmatter(DEEP_RESEARCH)
  return {
    name: meta.name ?? "deep-research",
    ...(meta.description === undefined ? {} : { description: meta.description }),
    script: DEEP_RESEARCH,
    scope: "bundled",
  }
}

/**
 * Discovers every saved workflow visible to the current runtime scope: the
 * bundled workflow first, then global `~/.gte-agent/workflows`, then the
 * project directory. Later sources overwrite earlier ones by name, so the
 * project wins global wins bundled. Invalid scripts and unreadable files are
 * skipped with a warning; the result is sorted by name for stable command order.
 */
export const discover = Effect.fn("WorkflowSaved.discover")(function* () {
  const scope = yield* RuntimeScope.Service
  const global = yield* Global.Service
  const byName = new Map<string, Saved>()
  const deepResearch = bundled()
  byName.set(deepResearch.name, deepResearch)
  // Global before project so a project file with the same name overrides it.
  for (const found of yield* scan(path.join(global.home, DIRECTORY), "global")) byName.set(found.name, found)
  for (const found of yield* scan(path.join(scope.project.directory, DIRECTORY), "project"))
    byName.set(found.name, found)
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name))
})

const scan = Effect.fn("WorkflowSaved.scan")(function* (directory: string, scope: "global" | "project") {
  const fs = yield* FSUtil.Service
  const files = yield* fs
    .glob("*.mjs", { cwd: directory, absolute: true, dot: true, symlink: true })
    .pipe(Effect.catch(() => Effect.succeed([] as string[])))
  const loaded = yield* Effect.forEach(files.toSorted(), (file) => load(fs, file, scope))
  return loaded.filter((item) => item !== undefined)
})

const load = Effect.fn("WorkflowSaved.load")(function* (fs: FSUtil.Interface, file: string, scope: "global" | "project") {
  const script = yield* fs.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (script === undefined) {
    yield* Effect.logWarning("Skipping unreadable saved workflow").pipe(Effect.annotateLogs({ file, scope }))
    return undefined
  }
  const meta = frontmatter(script)
  const name = meta.name ?? path.basename(file).replace(/\.mjs$/, "")
  if (!validName(name)) {
    yield* Effect.logWarning("Skipping saved workflow with an invalid name").pipe(
      Effect.annotateLogs({ file, scope, name }),
    )
    return undefined
  }
  if (RESERVED_NAMES.has(name)) {
    yield* Effect.logWarning("Skipping saved workflow that reuses a reserved built-in command name").pipe(
      Effect.annotateLogs({ file, scope, name }),
    )
    return undefined
  }
  const invalid = WorkflowScript.validate(script)
  if (invalid !== undefined) {
    yield* Effect.logWarning("Skipping invalid saved workflow").pipe(
      Effect.annotateLogs({ file, scope, name, reason: invalid.reason }),
    )
    return undefined
  }
  return {
    name,
    ...(meta.description === undefined ? {} : { description: meta.description }),
    script,
    scope,
    file,
  } satisfies Saved
})
