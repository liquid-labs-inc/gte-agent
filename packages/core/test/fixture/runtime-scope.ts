import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { Project } from "@gte-agent/core/project"
import { AbsolutePath } from "@gte-agent/core/schema"

export function runtimeScope(ref: RuntimeScope.Ref, input: { projectDirectory?: AbsolutePath; vcs?: Project.Vcs } = {}) {
  return {
    directory: ref.directory,
    project: { id: Project.ID.global, directory: input.projectDirectory ?? ref.directory },
    vcs: input.vcs,
  } satisfies RuntimeScope.Interface
}
