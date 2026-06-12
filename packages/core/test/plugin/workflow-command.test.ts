import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, type Scope } from "effect"
import { Command } from "@gte-agent/core/command"
import { Config } from "@gte-agent/core/config"
import { FSUtil } from "@gte-agent/core/fs-util"
import { Global } from "@gte-agent/core/global"
import { RuntimeScope } from "@gte-agent/core/runtime-scope"
import { AbsolutePath } from "@gte-agent/core/schema"
import { WorkflowCommandPlugin } from "@gte-agent/core/plugin/workflow-command"
import { WorkflowSaved } from "@gte-agent/core/workflow/saved"
import { runtimeScope } from "../fixture/runtime-scope"
import { tmpdir } from "../fixture/tmpdir"
import { it } from "../lib/effect"

const configWith = (info: Config.Info) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({ entries: () => Effect.succeed([new Config.Document({ type: "document", info })]) }),
  )

const writeWorkflow = (dir: string, file: string, content: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.join(dir, WorkflowSaved.DIRECTORY), { recursive: true })
    await fs.writeFile(path.join(dir, WorkflowSaved.DIRECTORY, file), content)
  })

/**
 * The kill-switch flag is read from the environment when the plugin effect
 * runs, so each test sets it explicitly and restores it.
 */
const withFlag = <A, E, R>(value: string | undefined, body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const saved = process.env.GTE_AGENT_DISABLE_WORKFLOWS
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (saved === undefined) delete process.env.GTE_AGENT_DISABLE_WORKFLOWS
        else process.env.GTE_AGENT_DISABLE_WORKFLOWS = saved
      }),
    )
    if (value === undefined) delete process.env.GTE_AGENT_DISABLE_WORKFLOWS
    else process.env.GTE_AGENT_DISABLE_WORKFLOWS = value
    return yield* body
  })

const run = (input: {
  home: string
  project: string
  flag?: string
  config?: Config.Info
  body: (command: Command.Interface) => Effect.Effect<void, never, never>
}) =>
  withFlag(
    input.flag,
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* WorkflowCommandPlugin.Plugin.effect.pipe(
        Effect.provideService(Command.Service, command),
        Effect.provide(configWith(input.config ?? Config.Info.make({}))),
        Effect.provide(FSUtil.defaultLayer),
        Effect.provide(Global.layerWith({ home: input.home })),
        Effect.provide(
          Layer.succeed(
            RuntimeScope.Service,
            RuntimeScope.Service.of(
              runtimeScope(
                { directory: AbsolutePath.make(input.project) },
                { projectDirectory: AbsolutePath.make(input.project) },
              ),
            ),
          ),
        ),
      )
      yield* input.body(command)
    }).pipe(Effect.provide(Command.runtimeScopeLayer)),
  )

const withDirs = (
  body: (dirs: { home: string; project: string }) => Effect.Effect<void, never, Scope.Scope>,
) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const home = path.join(tmp.path, "home")
        const project = path.join(tmp.path, "project")
        yield* Effect.promise(() => fs.mkdir(home, { recursive: true }))
        yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))
        yield* body({ home, project })
      }),
    ),
    Effect.scoped,
  )

describe("WorkflowCommandPlugin.Plugin", () => {
  it.live("registers /workflow and the bundled /deep-research command", () =>
    withDirs(({ home, project }) =>
      run({
        home,
        project,
        body: (command) =>
          Effect.gen(function* () {
            const workflow = yield* command.get("workflow")
            expect(workflow?.description).toBe("run a task as an ultrathink workflow")
            expect(workflow?.template).toContain("$ARGUMENTS")
            expect(workflow?.template).toContain("ultrathink workflow")

            const research = yield* command.get("deep-research")
            expect(research?.template).toContain("Launch the saved workflow")
            expect(research?.template).toContain("$ARGUMENTS")
            // The exact script is embedded verbatim so the model runs it unmodified.
            expect(research?.template).toContain(WorkflowSaved.bundled().script)
          }),
      }),
    ),
  )

  it.live("registers discovered workflows, project winning name collisions", () =>
    withDirs(({ home, project }) =>
      Effect.gen(function* () {
        yield* writeWorkflow(home, "shared.mjs", "// ---\n// description: global one\n// ---\nreturn 1")
        yield* writeWorkflow(project, "shared.mjs", "// ---\n// description: project one\n// ---\nreturn 2")
        yield* run({
          home,
          project,
          body: (command) =>
            Effect.gen(function* () {
              const shared = yield* command.get("shared")
              expect(shared?.description).toBe("project one")
              expect(shared?.template).toContain("return 2")
            }),
        })
      }),
    ),
  )

  it.live("contributes no workflow commands when the flag disables workflows", () =>
    withDirs(({ home, project }) =>
      run({
        home,
        project,
        flag: "1",
        body: (command) =>
          Effect.gen(function* () {
            expect(yield* command.get("workflow")).toBeUndefined()
            expect(yield* command.get("deep-research")).toBeUndefined()
          }),
      }),
    ),
  )

  it.live("contributes no workflow commands when config disables workflows", () =>
    withDirs(({ home, project }) =>
      run({
        home,
        project,
        config: Config.Info.make({ workflows: { enabled: false } }),
        body: (command) =>
          Effect.gen(function* () {
            expect(yield* command.get("workflow")).toBeUndefined()
            expect(yield* command.get("deep-research")).toBeUndefined()
          }),
      }),
    ),
  )
})
