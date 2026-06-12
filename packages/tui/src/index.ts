#!/usr/bin/env bun
/**
 * `gta` — GTE Agent TUI entry point.
 *
 * Keeps the entry free of JSX, registers the Solid transform plugin at
 * runtime (so `gta` works from any working directory without a bunfig
 * preload), then dynamically imports the TUI runtime.
 */
import { helpText, parseArgs, VERSION } from "./cli"

const parsed = parseArgs(process.argv.slice(2), process.cwd())
if (!parsed.ok) {
  console.error(parsed.error)
  console.error("")
  console.error(helpText())
  process.exit(1)
}

if (parsed.options.help) {
  console.log(helpText())
  process.exit(0)
}

if (parsed.options.version) {
  console.log(VERSION)
  process.exit(0)
}

const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
ensureSolidTransformPlugin()

const { runTui } = await import("./run")
await runTui(parsed.options)
process.exit(0)
