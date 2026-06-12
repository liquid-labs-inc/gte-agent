import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { WorkflowRegistry } from "@/workflow/registry"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-registry-"))
const globalDir = path.join(tmp, "global-config")
const projectDir = path.join(tmp, "project", ".opencode")

function write(dir: string, name: string, content: string) {
  fs.mkdirSync(path.join(dir, "workflows"), { recursive: true })
  fs.writeFileSync(path.join(dir, "workflows", name), content, "utf8")
}

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("workflow registry", () => {
  test("bundled deep-research is always available", () => {
    const items = WorkflowRegistry.discover([], globalDir)
    const deep = items.find((item) => item.name === "deep-research")
    expect(deep).toBeDefined()
    expect(deep!.scope).toBe("bundled")
    expect(deep!.description).toBeTruthy()
    expect(deep!.script).toContain("phase(")
  })

  test("discovers project and global workflows with frontmatter metadata", () => {
    write(globalDir, "audit.mjs", "// ---\n// name: audit\n// description: global audit\n// ---\nreturn 1")
    write(projectDir, "triage.mjs", "// ---\n// name: triage\n// description: project triage\n// ---\nreturn 2")
    const items = WorkflowRegistry.discover([globalDir, projectDir], globalDir)
    const audit = items.find((item) => item.name === "audit")
    const triage = items.find((item) => item.name === "triage")
    expect(audit?.scope).toBe("global")
    expect(audit?.description).toBe("global audit")
    expect(triage?.scope).toBe("project")
    expect(triage?.description).toBe("project triage")
  })

  test("falls back to filename when frontmatter has no name", () => {
    write(projectDir, "no-meta.mjs", "return 'plain'")
    const items = WorkflowRegistry.discover([projectDir], globalDir)
    expect(items.some((item) => item.name === "no-meta" && item.scope === "project")).toBe(true)
  })

  test("project beats global on name collisions", () => {
    write(globalDir, "release.mjs", "// ---\n// name: release\n// description: from global\n// ---\nreturn 'g'")
    write(projectDir, "release.mjs", "// ---\n// name: release\n// description: from project\n// ---\nreturn 'p'")
    const items = WorkflowRegistry.discover([globalDir, projectDir], globalDir)
    const release = items.filter((item) => item.name === "release")
    expect(release).toHaveLength(1)
    expect(release[0].scope).toBe("project")
    expect(release[0].description).toBe("from project")
  })

  test("project beats global regardless of directory order", () => {
    const items = WorkflowRegistry.discover([projectDir, globalDir], globalDir)
    const release = items.filter((item) => item.name === "release")
    expect(release).toHaveLength(1)
    expect(release[0].scope).toBe("project")
  })

  test("saved workflows can override the bundled deep-research", () => {
    write(projectDir, "deep-research.mjs", "// ---\n// name: deep-research\n// description: custom\n// ---\nreturn 'mine'")
    const items = WorkflowRegistry.discover([projectDir], globalDir)
    const deep = items.filter((item) => item.name === "deep-research")
    expect(deep).toHaveLength(1)
    expect(deep[0].scope).toBe("project")
  })

  test("skips files with invalid names", () => {
    write(projectDir, "-bad-name.mjs", "return 1")
    const items = WorkflowRegistry.discover([projectDir], globalDir)
    expect(items.some((item) => item.name === "-bad-name")).toBe(false)
  })
})
