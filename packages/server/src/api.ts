import { HttpApi, OpenApi } from "effect/unstable/httpapi"
import { SchemaErrorMiddleware } from "./middleware/schema-error"
import { MessageGroup } from "./groups/message"
import { SessionGroup } from "./groups/session"
import { SessionSnapshotGroup } from "./groups/session-snapshot"
import { HealthGroup } from "./groups/health"
import { GteDataGroup } from "./groups/gte-data"

export const GTEAgentApi = HttpApi.make("gte-agent")
  .add(HealthGroup)
  .add(SessionGroup)
  .add(SessionSnapshotGroup)
  .add(MessageGroup)
  .add(GteDataGroup)
  .annotateMerge(
    OpenApi.annotations({
      title: "GTE Agent API",
      version: "0.0.1",
      description: "Canonical local GTE Agent runtime API.",
    }),
  )
  .middleware(SchemaErrorMiddleware)
