export * as SandboxHardening from "./hardening"

/**
 * Shared hardening for script-sandbox workers (the workflow worker and the
 * dynamic-tool worker). Defense in depth, not a hard security boundary: a
 * sandboxed script can only coordinate through its injected API, and anything
 * it actually does flows through the unchanged session tool and permission
 * regime.
 */

/**
 * Capabilities stripped from the script's scope. Each is removed from the
 * worker global where possible AND shadowed as an `undefined` parameter of
 * the script function, so direct references always see undefined.
 */
export const BANNED_GLOBALS = [
  "Bun",
  "process",
  "require",
  "fetch",
  "WebSocket",
  "XMLHttpRequest",
  "EventSource",
  "Worker",
  "navigator",
  "self",
  "postMessage",
] as const

/**
 * Captured at module load, BEFORE sanitize() poisons the function-constructor
 * prototypes: workers need a working AsyncFunction to build the script body,
 * but after poisoning `(async function(){}).constructor` resolves to undefined.
 */
export const AsyncFunction = async function () {}.constructor as new (
  ...parameters: string[]
) => (...values: unknown[]) => Promise<unknown>

export function sanitize() {
  const globals = globalThis as Record<string, unknown>
  for (const key of BANNED_GLOBALS) {
    try {
      delete globals[key]
    } catch {
      // non-configurable global; defineProperty and parameter shadowing still apply
    }
    try {
      Object.defineProperty(globals, key, { value: undefined, configurable: false, writable: false })
    } catch {
      // non-configurable getter; parameter shadowing still hides it from the script body
    }
  }
  // The static script guard rejects literal `.constructor`, but computed access
  // (map["cons" + "tructor"], map[k], array-join, template-concat) slips past
  // it and reaches the function constructor, which rebuilds eval/import. Poison
  // `constructor` on every function-constructor prototype so the property no
  // longer resolves to a callable regardless of how the name is spelled.
  // Workers capture the exported AsyncFunction at module load, before this runs.
  for (const proto of [
    Function.prototype,
    async function () {}.constructor.prototype,
    function* () {}.constructor.prototype,
    async function* () {}.constructor.prototype,
  ]) {
    try {
      Object.defineProperty(proto, "constructor", { value: undefined, configurable: false, writable: false })
    } catch {
      // already non-configurable; the property cannot be reached as a callable either way
    }
  }
}
