export * as WorkflowScript from "./script"

import { Schema } from "effect"

export class InvalidScriptError extends Schema.TaggedErrorClass<InvalidScriptError>()(
  "WorkflowScript.InvalidScriptError",
  {
    reason: Schema.String,
  },
) {}

const AsyncFunction = async function () {}.constructor as new (...parameters: string[]) => unknown

/**
 * Rejects a script before execution: syntax errors plus the escape hatches the
 * worker sandbox cannot remove at runtime. Dynamic `import()` and `import.meta`
 * survive global stripping, and `eval` / `Function` / `.constructor` /
 * `globalThis` can rebuild them indirectly, so all of them are rejected
 * statically. Defense in depth, not a hard security boundary: the script's
 * only capabilities are coordination either way.
 */
export function validate(script: string): InvalidScriptError | undefined {
  if (!script.trim()) return new InvalidScriptError({ reason: "Workflow script is empty" })
  const code = stripCommentsAndStrings(script)
  if (/\bimport\b/.test(code))
    return new InvalidScriptError({ reason: "Workflow scripts cannot use import — agents do all I/O" })
  if (/\bexport\s/.test(code))
    return new InvalidScriptError({
      reason: "Workflow scripts cannot use export declarations — return a value instead",
    })
  if (/\beval\b/.test(code))
    return new InvalidScriptError({ reason: "Workflow scripts cannot use eval — agents do all I/O" })
  if (/\bFunction\b/.test(code))
    return new InvalidScriptError({
      reason: "Workflow scripts cannot use the Function constructor — agents do all I/O",
    })
  // The bracket form is checked against the raw script: the quoted name is
  // string content, which stripping removes.
  if (/\.\s*constructor\b/.test(code) || /\[\s*["'`]\s*constructor/.test(script))
    return new InvalidScriptError({ reason: "Workflow scripts cannot access .constructor — agents do all I/O" })
  if (/\bglobalThis\b/.test(code))
    return new InvalidScriptError({ reason: "Workflow scripts cannot access globalThis — agents do all I/O" })
  // Constructing (not calling) the function surfaces syntax errors with the
  // engine's own message; there is no other way to syntax-check a body.
  try {
    new AsyncFunction("phase", "agent", "map", "log", "args", `"use strict";\n${script}`)
  } catch (error) {
    return new InvalidScriptError({
      reason: `Workflow script has a syntax error: ${error instanceof Error ? error.message : String(error)}`,
    })
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
