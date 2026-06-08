import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { Project } from "@gte-agent/core/project"
import { AbsolutePath } from "@gte-agent/core/schema"
import { testEffect } from "./lib/effect"

const ref = { directory: AbsolutePath.make("/repo/packages/app") }
const projectLayer = Layer.succeed(
  Project.Service,
  Project.Service.of({
    directories: () => Effect.succeed([]),
    resolve: () =>
      Effect.succeed({
        id: Project.ID.make("project"),
        directory: AbsolutePath.make("/repo"),
        vcs: { type: "git", store: AbsolutePath.make("/repo/.git") },
      }),
    commit: () => Effect.void,
  }),
)
const it = testEffect(RuntimeScope.layer(ref).pipe(Layer.provide(projectLayer)))

describe("RuntimeScope", () => {
  it.effect("resolves the current project and vcs information", () =>
    Effect.gen(function* () {
      const scope = yield* RuntimeScope.Service

      expect(scope.directory).toBe(AbsolutePath.make("/repo/packages/app"))
      expect(scope.project.id).toBe(Project.ID.make("project"))
      expect(scope.project.directory).toBe(AbsolutePath.make("/repo"))
      expect(scope.vcs).toEqual({
        type: "git",
        store: AbsolutePath.make("/repo/.git"),
      })
    }),
  )
})
