export * as WorkflowScript from "./script"

import { Schema } from "effect"
import { ScriptGuard } from "../sandbox/script-guard"

export class InvalidScriptError extends Schema.TaggedErrorClass<InvalidScriptError>()(
  "WorkflowScript.InvalidScriptError",
  {
    reason: Schema.String,
  },
) {}

/**
 * Rejects a script before execution via the shared sandbox guard (see
 * ../sandbox/script-guard.ts for the full rationale): syntax errors plus the
 * escape hatches the worker sandbox cannot remove at runtime. Defense in
 * depth, not a hard security boundary: the script's only capabilities are
 * coordination either way.
 */
export function validate(script: string): InvalidScriptError | undefined {
  const reason = ScriptGuard.violation(script, ["phase", "agent", "map", "log", "args"], {
    singular: "Workflow script",
    plural: "Workflow scripts",
    remedy: "agents do all I/O",
  })
  return reason === undefined ? undefined : new InvalidScriptError({ reason })
}
