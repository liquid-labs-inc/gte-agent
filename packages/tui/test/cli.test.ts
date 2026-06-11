import { describe, expect, test } from "bun:test"
import path from "node:path"
import { helpText, parseArgs } from "../src/cli"

const cwd = "/work/dir"

describe("parseArgs", () => {
  test("defaults to in-process mode with cwd runtime scope", () => {
    const result = parseArgs([], cwd)
    expect(result).toEqual({
      ok: true,
      options: {
        help: false,
        version: false,
        listen: false,
        hostname: "127.0.0.1",
        port: undefined,
        directory: cwd,
      },
    })
  })

  test("--port and --hostname imply --listen", () => {
    const result = parseArgs(["--port", "8123", "--hostname", "0.0.0.0"], cwd)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.options.listen).toBe(true)
    expect(result.options.port).toBe(8123)
    expect(result.options.hostname).toBe("0.0.0.0")
  })

  test("relative --directory resolves against cwd", () => {
    const result = parseArgs(["--directory", "sub/dir"], cwd)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.options.directory).toBe(path.resolve(cwd, "sub/dir"))
  })

  test("rejects unknown flags and invalid ports", () => {
    expect(parseArgs(["--wat"], cwd)).toEqual({ ok: false, error: "Unknown option: --wat" })
    expect(parseArgs(["--port", "no"], cwd)).toEqual({ ok: false, error: "Invalid port: no" })
    expect(parseArgs(["--port"], cwd)).toEqual({ ok: false, error: "--port requires a value" })
  })
})

describe("gta subprocess smoke", () => {
  const entry = path.join(import.meta.dir, "..", "src", "index.ts")

  test("--help prints usage and exits 0", async () => {
    const proc = Bun.spawn([process.execPath, "run", entry, "--help"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(exitCode).toBe(0)
    expect(stdout).toContain("gta — GTE Agent TUI")
    expect(stdout).toContain("--listen")
  })

  test("unknown flag prints usage and exits 1", async () => {
    const proc = Bun.spawn([process.execPath, "run", entry, "--bogus"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(exitCode).toBe(1)
    expect(stderr).toContain("Unknown option: --bogus")
    expect(helpText()).toContain("Usage: gta [options]")
  })
})
