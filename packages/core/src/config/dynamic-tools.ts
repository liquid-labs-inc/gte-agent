export * as ConfigDynamicTools from "./dynamic-tools"

import { Schema } from "effect"

export const Info = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable the tool workshop and saved dynamic tools (default true)",
  }),
}).annotate({ identifier: "Config.DynamicTools" })
export type Info = typeof Info.Type
