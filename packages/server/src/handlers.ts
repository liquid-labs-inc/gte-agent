import { Session } from "@gte-agent/core/session"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { workflowHandlers } from "./handlers/workflow"
import { authProviderHandlers } from "./handlers/auth-provider"
import { modelsHandlers } from "./handlers/models"
import { messageHandlers } from "./handlers/message"
import { sessionHandlers } from "./handlers/session"
import { sessionSnapshotHandlers } from "./handlers/session-snapshot"
import { healthHandlers } from "./handlers/health"
import { gteDataHandlers } from "./handlers/gte-data"
import { GteData } from "@gte-agent/core/gte-data/gte-data"
import { GtePanelManager } from "@gte-agent/core/gte-data/panel-manager"
import { GteStreams } from "@gte-agent/core/gte-data/streams"
import { SessionSnapshot } from "@gte-agent/core/session/snapshot"
import { Database } from "@gte-agent/core/database/database"
import { Event } from "@gte-agent/core/event"
import { Project } from "@gte-agent/core/project"
import * as SessionExecutionLocal from "@gte-agent/core/session/execution/local"
import { SessionProjector } from "@gte-agent/core/session/projector"
import { SessionRunCoordinator } from "@gte-agent/core/session/run-coordinator"
import { SessionRunnerDefault } from "@gte-agent/core/session/runner/default"
import { SessionStore } from "@gte-agent/core/session/store"
import { GTEAuth } from "@gte-agent/core/gte-auth"
import { AuthStore } from "@gte-agent/core/auth/store"
import { Catalog } from "@gte-agent/core/catalog"
import { FSUtil } from "@gte-agent/core/fs-util"
import { Global } from "@gte-agent/core/global"
import { ModelSelection } from "@gte-agent/core/model-selection"
import { Permission } from "@gte-agent/core/permission"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { SystemContextBuiltIns } from "@gte-agent/core/system-context-builtins"
import { ApplicationTools } from "@gte-agent/core/tool/application-tools"
import { GteTools } from "@gte-agent/core/tool/gte/tools"
import { ToolRegistry } from "@gte-agent/core/tool/registry"
import { WebFetchTool } from "@gte-agent/core/tool/webfetch"
import { WebSearchTool } from "@gte-agent/core/tool/websearch"
import { WorkflowTool } from "@gte-agent/core/tool/workflow"
import { ToolOutputStore } from "@gte-agent/core/tool-output-store"
import { BackgroundJob } from "@gte-agent/core/background-job"
import { Config } from "@gte-agent/core/config"
import { WorkflowExecutor } from "@gte-agent/core/workflow/executor"
import { WorkflowRuntime } from "@gte-agent/core/workflow/runtime"

// An invalid GTE_AGENT_GTE_ENV fails server startup with a clear ConfigError
// listing the valid environment names (owned by the gte-ts GteEnvKey type).
const gteData = GteData.defaultLayer.pipe(Layer.orDie)

// Process-global synthetic runtime scope rooted at the server's working
// directory. The catalog is curated and static and the runner resolves models
// per session through the store, so one scope serves the whole daemon.
const runtimeScope = RuntimeScope.Service.layer(RuntimeScope.fromRef({ directory: AbsolutePath.make(process.cwd()) }))

const handlerEvents = Event.layer.pipe(Layer.provide(Database.defaultLayer), Layer.orDie)

// Curated model catalog shared by the /models routes and the session runner
// (same layer reference, so the runtime memoizes a single Catalog instance).
// `handlerEvents` shares the memoized Event/Database layers with
// `routedSessions`, so durable model-switch events published by a selection
// land on the same bus and database the session projector observes.
const modelCatalog = Catalog.runtimeScopeLayer.pipe(
  Layer.provide(runtimeScope),
  Layer.provide(handlerEvents),
  Layer.orDie,
)

// Phase 1 has no interactive permission surface and the advertised tools are
// read-only, so the runner's tool registry gets the same allow-all permission
// stub as the core runtime-scope composition (core/src/runtime-scope-layer.ts).
const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "allow" }),
    assert: () => Effect.void,
    reply: (input) => Effect.fail(new Permission.NotFoundError({ requestID: input.requestID })),
    get: () => Effect.succeed(undefined),
    list: () => Effect.succeed([]),
    forSession: () => Effect.succeed([]),
  }),
)

const toolRegistry = ToolRegistry.layer.pipe(Layer.provide(permission), Layer.provide(ApplicationTools.layer))

// Read-only gte_* tools registered against the runner's registry, bound to the
// same GteData service the data routes use. SessionStore is provided so the
// session tracked-address fallback is active for address-scoped tools.
const gteTools = GteTools.layer.pipe(
  Layer.provide(toolRegistry),
  Layer.provide(gteData),
  Layer.provide(SessionStore.layer),
  Layer.provide(Database.defaultLayer),
  Layer.orDie,
)

// Web tools for the production registry. Both are implemented and tested in
// core but were composed only into BuiltInTools.runtimeScopeLayer, which the
// server never builds — the same gap fix-list item 1 closed for the workflow
// tool. websearch works keyless (per-session provider selection); the
// EXA/PARALLEL key and enable env vars refine it through defaultConfigLayer.
const webTools = Layer.mergeAll(
  WebFetchTool.layer,
  WebSearchTool.layer.pipe(Layer.provide(WebSearchTool.defaultConfigLayer)),
).pipe(
  Layer.provide(toolRegistry),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(ToolOutputStore.defaultLayer),
  Layer.orDie,
)

// Production session runner (checklist item 7): the deterministic demo client
// survives only behind GTE_AGENT_LLM=demo; the default path resolves the
// session's model through the curated catalog and ~/.gte-agent/auth.json and
// streams real provider turns with the GTE system prompt and the read-only
// tool registry. `gteData` feeds the system prompt's GTE-environment line.
const sessionRunner = SessionRunnerDefault.layer.pipe(
  Layer.provide(Layer.mergeAll(toolRegistry, gteTools, modelCatalog, SystemContextBuiltIns.layer, gteData)),
  Layer.provide(runtimeScope),
  Layer.provide(SessionStore.layer),
  Layer.provide(handlerEvents),
  Layer.provide(Database.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.defaultLayer),
  Layer.orDie,
)

const routedSessions = Session.layer.pipe(
  Layer.provide(SessionProjector.layer),
  Layer.provide(SessionExecutionLocal.layer),
  Layer.provide(SessionRunCoordinator.layer),
  Layer.provide(sessionRunner),
  Layer.provide(GTEAuth.defaultLayer),
  Layer.provide(SessionStore.layer),
  Layer.provide(Event.layer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(Project.defaultLayer),
  Layer.orDie,
)

// Layer references shared with `routedSessions` (Event.layer, Database,
// SessionStore) are memoized per runtime build, so the panel manager, the
// snapshot service, and the SSE handler all observe the same event bus and
// database as the session service.
const gteStreams = GteStreams.layer.pipe(Layer.provide(GteData.ConfigService.defaultLayer), Layer.orDie)
const panelManager = GtePanelManager.layer.pipe(
  Layer.provide(gteStreams),
  Layer.provide(SessionStore.layer),
  Layer.provide(Event.layer),
  Layer.provide(Database.defaultLayer),
  Layer.orDie,
)
const sessionSnapshots = SessionSnapshot.layer.pipe(
  Layer.provide(SessionStore.layer),
  Layer.provide(Event.layer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(GTEAuth.defaultLayer),
  Layer.orDie,
)
// LLM provider credentials (~/.gte-agent/auth.json). The auth-provider handlers
// also need an HttpClient (token exchange), provided in routes.ts.
const authStore = AuthStore.defaultLayer.pipe(Layer.orDie)

// Model selection for the /models routes, over the shared curated catalog.
const modelSelection = ModelSelection.defaultLayer.pipe(
  Layer.provideMerge(modelCatalog),
  Layer.provide(authStore),
  Layer.provide(handlerEvents),
  Layer.orDie,
)

// Config for the workflow kill switch (flag + `workflows.enabled`), read from
// the server's working-directory config files like the rest of core's Config.
const config = Config.runtimeScopeLayer.pipe(
  Layer.provide(runtimeScope),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.defaultLayer),
  Layer.orDie,
)

// Workflow agents run as real child sessions, so the executor takes the same
// routed Session service and curated catalog the runner uses; the runtime
// publishes its durable and ephemeral events onto the shared event bus.
const workflowExecutor = WorkflowExecutor.layer.pipe(
  Layer.provide(routedSessions),
  Layer.provide(modelCatalog),
  Layer.orDie,
)
const workflowRuntime = WorkflowRuntime.layer.pipe(
  Layer.provide(workflowExecutor),
  Layer.provide(handlerEvents),
  Layer.provide(Global.defaultLayer),
  Layer.orDie,
)
// Dynamic workflow orchestration, gated on the kill switch: the layer
// contributes the tool into the same `toolRegistry` the runner advertises only
// when GTE_AGENT_DISABLE_WORKFLOWS is unset and `workflows.enabled` is not
// false, so without this wiring the tool would never reach the running model.
const workflowTool = WorkflowTool.layer.pipe(
  Layer.provide(toolRegistry),
  Layer.provide(workflowRuntime),
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStore.layer),
  Layer.provide(config),
  Layer.provide(Database.defaultLayer),
  Layer.orDie,
)

export const gteAgentHandlers = Layer.mergeAll(
  healthHandlers,
  sessionHandlers,
  sessionSnapshotHandlers.pipe(Layer.provide(sessionSnapshots)),
  messageHandlers,
  gteDataHandlers.pipe(Layer.provide(gteData)),
  authProviderHandlers.pipe(Layer.provide(authStore)),
  modelsHandlers.pipe(Layer.provide(modelSelection)),
  workflowHandlers.pipe(Layer.provide(workflowRuntime), Layer.provide(config)),
  // effectDiscard: contributing the workflow tool is the build's only effect.
  workflowTool,
  // effectDiscard likewise: contributes websearch and webfetch into the
  // registry the runner advertises.
  webTools,
).pipe(Layer.provide(routedSessions), Layer.provide(panelManager), Layer.provide(handlerEvents))
