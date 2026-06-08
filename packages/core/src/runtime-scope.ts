export * as RuntimeScope from "./runtime-scope"

import { Context, Effect, Layer, Schema } from "effect"
import { Project } from "./project"
import { AbsolutePath } from "./schema"

export const Ref = Schema.Struct({
  directory: AbsolutePath,
}).annotate({ identifier: "RuntimeScope.Ref" })
export type Ref = typeof Ref.Type

export class Info extends Schema.Class<Info>("RuntimeScope.Info")({
  directory: AbsolutePath,
  project: Schema.Struct({
    id: Project.ID,
    directory: AbsolutePath,
  }),
}) {}

export interface Interface extends Info {
  readonly vcs?: Project.Vcs
}

export class Service extends Context.Service<Service, Interface>()("@gte-agent/RuntimeScope") {
  static layer(input: Interface) {
    return Layer.succeed(this, this.of(input))
  }
}

export function response<S extends Schema.Top>(data: S) {
  return Schema.Struct({ runtimeScope: Info, data })
}

export const layer = (ref: Ref) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const project = yield* Project.Service
      const resolved = yield* project.resolve(ref.directory)
      return Service.of({
        directory: ref.directory,
        project: { id: resolved.id, directory: resolved.directory },
        vcs: resolved.vcs,
      })
    }),
  )

export function fromRef(ref: Ref) {
  return new Info({ directory: ref.directory, project: { id: Project.ID.global, directory: ref.directory } })
}

export const current = Effect.map(
  Service,
  (scope) => new Info({ directory: scope.directory, project: scope.project }),
)
