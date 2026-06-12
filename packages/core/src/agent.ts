export * as Agent from "./agent"

import { Array, Context, Effect, Layer, Schema, Scope } from "effect"
import { castDraft, enableMapSet, type Draft } from "immer"
import { Model } from "./model"
import { PermissionSchema } from "./permission/schema"
import { Provider } from "./provider"
import { PositiveInt } from "./schema"
import { State } from "./state"

export const ID = Schema.String.pipe(Schema.brand("Agent.ID"))
export type ID = typeof ID.Type

export const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

export class Info extends Schema.Class<Info>("Agent.Info")({
  id: ID,
  model: Model.Ref.pipe(Schema.optional),
  request: Provider.Request,
  system: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  hidden: Schema.Boolean,
  color: Color.pipe(Schema.optional),
  steps: PositiveInt.pipe(Schema.optional),
  permissions: PermissionSchema.Ruleset,
}) {
  static empty(id: ID) {
    return new Info({
      id,
      request: {
        headers: {},
        body: {},
      },
      mode: "all",
      hidden: false,
      permissions: [],
    })
  }
}

type Data = {
  agents: Map<ID, Info>
}

export type Editor = {
  list: () => readonly Info[]
  get: (id: ID) => Info | undefined
  update: (id: ID, fn: (agent: Draft<Info>) => void) => void
  remove: (id: ID) => void
}

export interface Interface {
  readonly transform: State.Interface<Data, Editor>["transform"]
  readonly update: (update: State.Transform<Editor>) => Effect.Effect<void, never, Scope.Scope>
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly all: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/Agent") {}

enableMapSet()

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = State.create<Data, Editor>({
      initial: () => ({ agents: new Map() }),
      editor: (draft) => ({
        list: () => Array.fromIterable(draft.agents.values()) as Info[],
        get: (id) => draft.agents.get(id),
        update: (id, fn) => {
          const current = draft.agents.get(id) ?? castDraft(Info.empty(id))
          if (!draft.agents.has(id)) draft.agents.set(id, current)
          fn(current)
          current.id = id
        },
        remove: (id) => {
          draft.agents.delete(id)
        },
      }),
    })

    return Service.of({
      transform: state.transform,
      update: Effect.fn("Agent.update")(function* (update) {
        const transform = yield* state.transform()
        yield* transform(update)
      }),
      get: Effect.fn("Agent.get")(function* (id) {
        return state.get().agents.get(id)
      }),
      all: Effect.fn("Agent.all")(function* () {
        return Array.fromIterable(state.get().agents.values())
      }),
    })
  }),
)

export const runtimeScopeLayer = layer
