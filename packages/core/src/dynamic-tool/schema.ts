export * as DynamicToolSchema from "./schema"

import { Schema } from "effect"
import { ScriptGuard } from "../sandbox/script-guard"

/**
 * A self-authored tool definition: the model (or a user file) supplies a name,
 * a description, a flat parameter schema, and the JavaScript body that
 * computes the result. Parameters are deliberately a small JSON-Schema subset
 * — flat, primitive-typed, optionally enumerated — so the provider wire shape
 * stays trivially valid and the model cannot author schemas it then fails to
 * satisfy.
 */

export const ParameterSpec = Schema.Struct({
  type: Schema.Literals(["string", "number", "boolean"]),
  description: Schema.String.pipe(Schema.optional),
  /** Allowed values; only meaningful for string parameters. */
  enum: Schema.Array(Schema.String).pipe(Schema.optional),
  /** Defaults to true: omit a parameter from a call only when this is false. */
  required: Schema.Boolean.pipe(Schema.optional),
}).annotate({ identifier: "DynamicTool.ParameterSpec" })
export type ParameterSpec = typeof ParameterSpec.Type

export const Definition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Record(Schema.String, ParameterSpec),
  /** The body of an async function whose only bindings are `params` and `gte`. */
  code: Schema.String,
}).annotate({ identifier: "DynamicTool.Definition" })
export type Definition = typeof Definition.Type

/**
 * Tool names ride the provider wire next to the shipped tools, so they follow
 * the same shape (lowercase snake_case). The `gte_` prefix stays reserved for
 * the shipped read-only data tools.
 */
export function validName(name: string): boolean {
  return /^[a-z][a-z0-9_]{1,63}$/.test(name) && !name.startsWith("gte_")
}

/** Worker bindings; also the syntax-check scope for the static guard. */
export const BINDINGS = ["params", "gte"] as const

export class InvalidCodeError extends Schema.TaggedErrorClass<InvalidCodeError>()(
  "DynamicToolSchema.InvalidCodeError",
  {
    reason: Schema.String,
  },
) {}

export function validateCode(code: string): InvalidCodeError | undefined {
  const reason = ScriptGuard.violation(code, BINDINGS, {
    singular: "Tool code",
    plural: "Tool code",
    remedy: "tool code may only compute over gte() data",
  })
  return reason === undefined ? undefined : new InvalidCodeError({ reason })
}

/**
 * Provider wire shape for the parameter record: tool input schemas must
 * declare `type: "object"` at the top level (see @gte-agent/llm tool notes).
 */
export function toJsonSchema(parameters: Definition["parameters"]) {
  return {
    type: "object" as const,
    properties: Object.fromEntries(
      Object.entries(parameters).map(([key, spec]) => [
        key,
        {
          type: spec.type,
          ...(spec.description === undefined ? {} : { description: spec.description }),
          ...(spec.enum === undefined ? {} : { enum: [...spec.enum] }),
        },
      ]),
    ),
    required: Object.entries(parameters).flatMap(([key, spec]) => (spec.required === false ? [] : [key])),
    additionalProperties: false,
  }
}
