export * as ScriptGuard from "./script-guard"

import { SandboxHardening } from "./hardening"

/**
 * Static guard shared by the script sandboxes (workflow scripts, dynamic tool
 * code). Rejects a script before execution: syntax errors plus the escape
 * hatches the worker sandbox cannot remove at runtime. Dynamic `import()` and
 * `import.meta` survive global stripping, and `eval` / `Function` /
 * `.constructor` / `globalThis` can rebuild them indirectly, so all of them
 * are rejected statically. Defense in depth, not a hard security boundary.
 */

/** Message vocabulary so each sandbox keeps its own established wording. */
export type Subject = {
  /** E.g. "Workflow script" — used as "<singular> is empty". */
  readonly singular: string
  /** E.g. "Workflow scripts" — used as "<plural> cannot use import — <remedy>". */
  readonly plural: string
  /** E.g. "agents do all I/O". */
  readonly remedy: string
}

/** The rejection reason, or undefined when the script passes every check. */
export function violation(script: string, bindings: ReadonlyArray<string>, subject: Subject): string | undefined {
  if (!script.trim()) return `${subject.singular} is empty`
  const code = stripCommentsAndStrings(script)
  if (/\bimport\b/.test(code)) return `${subject.plural} cannot use import — ${subject.remedy}`
  if (/\bexport\s/.test(code)) return `${subject.plural} cannot use export declarations — return a value instead`
  if (/\beval\b/.test(code)) return `${subject.plural} cannot use eval — ${subject.remedy}`
  if (/\bFunction\b/.test(code)) return `${subject.plural} cannot use the Function constructor — ${subject.remedy}`
  // The bracket form is checked against the raw script: the quoted name is
  // string content, which stripping removes.
  if (/\.\s*constructor\b/.test(code) || /\[\s*["'`]\s*constructor/.test(script))
    return `${subject.plural} cannot access .constructor — ${subject.remedy}`
  if (/\bglobalThis\b/.test(code)) return `${subject.plural} cannot access globalThis — ${subject.remedy}`
  // Constructing (not calling) the function surfaces syntax errors with the
  // engine's own message; there is no other way to syntax-check a body.
  try {
    new SandboxHardening.AsyncFunction(...bindings, `"use strict";\n${script}`)
  } catch (error) {
    return `${subject.singular} has a syntax error: ${error instanceof Error ? error.message : String(error)}`
  }
  return undefined
}

/**
 * Best-effort removal of comments and string/template-literal text so the
 * validation regexes don't trip on prompts that merely mention "import".
 * Template interpolations (`${...}`) are code, not text, so their content is
 * preserved for validation. Known gap: regex literals containing quote or
 * backtick characters can confuse the scanner.
 */
function stripCommentsAndStrings(script: string): string {
  return stripCode(script, { index: 0 }, false)
}

/** Consumes code until end of input or, inside a template expression, the matching `}`. */
function stripCode(script: string, state: { index: number }, untilBrace: boolean): string {
  let out = ""
  let depth = 0
  while (state.index < script.length) {
    const current = script[state.index]
    const next = script[state.index + 1]
    if (current === "/" && next === "/") {
      while (state.index < script.length && script[state.index] !== "\n") state.index++
      continue
    }
    if (current === "/" && next === "*") {
      state.index += 2
      while (state.index < script.length && !(script[state.index] === "*" && script[state.index + 1] === "/")) {
        state.index++
      }
      state.index += 2
      continue
    }
    if (current === '"' || current === "'") {
      state.index++
      while (state.index < script.length && script[state.index] !== current) {
        if (script[state.index] === "\\") state.index++
        state.index++
      }
      state.index++
      continue
    }
    if (current === "`") {
      state.index++
      out += stripTemplate(script, state)
      continue
    }
    if (untilBrace) {
      if (current === "{") depth++
      if (current === "}") {
        if (depth === 0) {
          state.index++
          return out
        }
        depth--
      }
    }
    out += current
    state.index++
  }
  return out
}

/** Drops template text but keeps `${...}` interpolation code, which executes. */
function stripTemplate(script: string, state: { index: number }): string {
  let out = ""
  while (state.index < script.length) {
    const current = script[state.index]
    if (current === "\\") {
      state.index += 2
      continue
    }
    if (current === "`") {
      state.index++
      return out
    }
    if (current === "$" && script[state.index + 1] === "{") {
      state.index += 2
      out += `(${stripCode(script, state, true)})`
      continue
    }
    state.index++
  }
  return out
}
