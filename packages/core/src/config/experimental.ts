export * as ConfigExperimental from "./experimental"

import { Schema } from "effect"
import { Catalog } from "../catalog"
import { Policy } from "../policy"

// Each core domain exports the policy actions it supports. Adding an action to
// this union makes it valid in authored config while keeping Policy generic.
export const PolicyAction = Schema.Union([Catalog.PolicyActions])

export class ExperimentalPolicy extends Schema.Class<ExperimentalPolicy>("Config.Experimental.Policy")({
  ...Policy.Info.fields,
  action: PolicyAction,
}) {}

export class Experimental extends Schema.Class<Experimental>("Config.Experimental")({
  policies: ExperimentalPolicy.pipe(Schema.Array, Schema.optional),
}) {}
