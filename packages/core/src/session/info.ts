import { DateTime } from "effect"
import { Agent } from "../agent"
import { Model } from "../model"
import { Project } from "../project"
import { Provider } from "../provider"
import { AbsolutePath, RelativePath } from "../schema"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { GTEAuth } from "../gte-auth"
import { RuntimeScope } from "../runtime-scope"

export function fromRow(row: typeof SessionTable.$inferSelect): SessionSchema.Info {
  return SessionSchema.Info.make({
    id: SessionSchema.ID.make(row.id),
    projectID: Project.ID.make(row.project_id),
    principalID: GTEAuth.PrincipalID.make(row.principal_id),
    authorityID: GTEAuth.AuthorityID.make(row.authority_id),
    title: row.title,
    parentID: row.parent_id ? SessionSchema.ID.make(row.parent_id) : undefined,
    agent: row.agent ? Agent.ID.make(row.agent) : undefined,
    model: row.model
      ? {
          id: Model.ID.make(row.model.id),
          providerID: Provider.ID.make(row.model.providerID),
          variant: Model.VariantID.make(row.model.variant ?? "default"),
        }
      : undefined,
    cost: row.cost,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: {
        read: row.tokens_cache_read,
        write: row.tokens_cache_write,
      },
    },
    runtimeScope: RuntimeScope.Ref.make({
      directory: AbsolutePath.make(row.directory),
    }),
    subpath: row.path ? RelativePath.make(row.path) : undefined,
    selectedMarket: row.selected_market ?? undefined,
    trackedAddress: row.tracked_address ?? undefined,
    pinnedPanels: row.pinned_panels ?? undefined,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
      archived: row.time_archived ? DateTime.makeUnsafe(row.time_archived) : undefined,
    },
  })
}
