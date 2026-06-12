// Workflow script validation and the saved-workflow file format.
//
// Saved workflow = one .mjs file whose content is the body of an async
// function (top-level `await` and `return` are valid) with an optional
// frontmatter comment block:
//
//   // ---
//   // name: triage-issues
//   // description: Triage a list of GitHub issues with cross-review
//   // ---

export type ValidationResult = { ok: true } | { ok: false; error: string }

export type Frontmatter = {
  name?: string
  description?: string
  /** Script body with the frontmatter block removed. */
  body: string
}

const AsyncFunction = async function () {}.constructor as new (...params: string[]) => unknown

/**
 * Validates a workflow script before execution. Catches syntax errors and the
 * escape hatches the worker sandbox cannot remove at runtime (dynamic
 * `import()` and `import.meta` survive global stripping, so they are rejected
 * statically here).
 */
export function validate(script: string): ValidationResult {
  if (typeof script !== "string" || !script.trim()) return { ok: false, error: "Workflow script is empty" }
  const stripped = stripCommentsAndStrings(script)
  if (/\bimport\s*(\(|\.)/.test(stripped))
    return { ok: false, error: "Workflow scripts cannot use import() or import.meta — agents do all I/O" }
  if (/\bimport\s+[\w{*"']/.test(stripped))
    return { ok: false, error: "Workflow scripts cannot use import declarations — agents do all I/O" }
  if (/\bexport\s+/.test(stripped))
    return { ok: false, error: "Workflow scripts cannot use export declarations — return a value instead" }
  // Defense in depth for the worker sandbox: indirect code evaluation can
  // smuggle a dynamic import() inside a string the static checks above never
  // see (e.g. new Function('return import("node:fs")')). Orchestration
  // scripts have no legitimate use for any of these.
  if (/\beval\s*\(/.test(stripped))
    return { ok: false, error: "Workflow scripts cannot use eval — agents do all I/O" }
  if (/\bFunction\s*\(/.test(stripped) || /\bnew\s+Function\b/.test(stripped))
    return { ok: false, error: "Workflow scripts cannot use the Function constructor — agents do all I/O" }
  if (/\.\s*constructor\b/.test(stripped) || /\[\s*["'`]?constructor/.test(stripped))
    return { ok: false, error: "Workflow scripts cannot access .constructor — agents do all I/O" }
  if (/\bglobalThis\b/.test(stripped))
    return { ok: false, error: "Workflow scripts cannot access globalThis — agents do all I/O" }
  try {
    new AsyncFunction("phase", "agent", "map", "log", "args", `"use strict";\n${script}`)
  } catch (error) {
    return { ok: false, error: `Workflow script has a syntax error: ${error instanceof Error ? error.message : error}` }
  }
  return { ok: true }
}

/**
 * Best-effort removal of comments and string/template literals so the
 * validation regexes don't trip on prompts that merely mention "import".
 */
function stripCommentsAndStrings(script: string): string {
  let out = ""
  let i = 0
  while (i < script.length) {
    const ch = script[i]
    const next = script[i + 1]
    if (ch === "/" && next === "/") {
      while (i < script.length && script[i] !== "\n") i++
      continue
    }
    if (ch === "/" && next === "*") {
      i += 2
      while (i < script.length && !(script[i] === "*" && script[i + 1] === "/")) i++
      i += 2
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch
      i++
      while (i < script.length && script[i] !== quote) {
        if (script[i] === "\\") i++
        i++
      }
      i++
      continue
    }
    out += ch
    i++
  }
  return out
}

/** Parses the leading `// ---` frontmatter comment block, if present. */
export function frontmatter(script: string): Frontmatter {
  const lines = script.split(/\r?\n/)
  let index = 0
  while (index < lines.length && !lines[index].trim()) index++
  if (lines[index]?.trim() !== "// ---") return { body: script }
  const fields: Record<string, string> = {}
  let end = -1
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === "// ---") {
      end = i
      break
    }
    const match = line.match(/^\/\/\s*([\w-]+)\s*:\s*(.*)$/)
    if (!match) return { body: script }
    fields[match[1].toLowerCase()] = match[2].trim()
  }
  if (end === -1) return { body: script }
  return {
    name: fields["name"],
    description: fields["description"],
    body: lines.slice(end + 1).join("\n"),
  }
}

/** Renders a frontmatter block for saving a run's script as a command. */
export function withFrontmatter(input: { name: string; description?: string; body: string }): string {
  const existing = frontmatter(input.body)
  return [
    "// ---",
    `// name: ${input.name}`,
    ...(input.description ? [`// description: ${input.description}`] : []),
    "// ---",
    existing.body.replace(/^\n+/, ""),
  ].join("\n")
}

/** Saved workflows must be valid slash-command names. */
export function validName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(name)
}

export * as WorkflowScript from "./script"
