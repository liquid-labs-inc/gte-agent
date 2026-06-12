export * as ConfigWorkflows from "./workflows"

import { Schema } from "effect"

export const Info = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Enable the dynamic workflow tool and its surfaces (default true)",
  }),
}).annotate({ identifier: "Config.Workflows" })
export type Info = typeof Info.Type
