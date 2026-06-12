// Saved-workflow discovery. Workflows are single .mjs files in
// `<config dir>/workflows/` — `.opencode/workflows/` in a project (shared via
// the repo) and `~/.config/opencode/workflows/` globally. Each registers as a
// slash command `/<name>`; project definitions win name collisions.
import fs from "fs"
import path from "path"
import { Glob } from "@opencode-ai/core/util/glob"
import { Global } from "@opencode-ai/core/global"
import { WorkflowScript } from "./script"
import DEEP_RESEARCH from "./deep-research.txt"

export type SavedWorkflow = {
  name: string
  description?: string
  /** Full file content (frontmatter included) — valid workflow tool input. */
  script: string
  file?: string
  scope: "bundled" | "global" | "project"
}

export function bundled(): SavedWorkflow[] {
  const meta = WorkflowScript.frontmatter(DEEP_RESEARCH)
  return [
    {
      name: meta.name ?? "deep-research",
      description: meta.description,
      script: DEEP_RESEARCH,
      scope: "bundled",
    },
  ]
}

function scan(dir: string, scope: "global" | "project"): SavedWorkflow[] {
  const matches = Glob.scanSync("workflows/*.{mjs,js}", { cwd: dir, absolute: true, dot: true, symlink: true })
  const found: SavedWorkflow[] = []
  for (const file of matches.toSorted()) {
    let content: string
    try {
      content = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    const meta = WorkflowScript.frontmatter(content)
    const name = meta.name ?? path.basename(file).replace(/\.(mjs|js)$/, "")
    if (!WorkflowScript.validName(name)) continue
    found.push({ name, description: meta.description, script: content, file, scope })
  }
  return found
}

/**
 * Discovers saved workflows. `directories` are the config directories for the
 * instance (global config dir + project `.opencode` dirs); precedence is
 * bundled < global < project so the project always wins name collisions.
 */
export function discover(directories: string[], globalDir: string = Global.Path.config): SavedWorkflow[] {
  const byName = new Map<string, SavedWorkflow>()
  for (const item of bundled()) byName.set(item.name, item)
  const ordered = [...directories].toSorted((a, b) => {
    const aGlobal = a === globalDir ? 0 : 1
    const bGlobal = b === globalDir ? 0 : 1
    return aGlobal - bGlobal
  })
  for (const dir of ordered) {
    for (const item of scan(dir, dir === globalDir ? "global" : "project")) {
      byName.set(item.name, item)
    }
  }
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name))
}

export * as WorkflowRegistry from "./registry"
