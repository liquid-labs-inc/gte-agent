import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import type { Scope } from "effect"
import { AuthSchema } from "@gte-agent/core/auth/schema"
import { AuthStore } from "@gte-agent/core/auth/store"
import { FSUtil } from "@gte-agent/core/fs-util"
import { Global } from "@gte-agent/core/global"
import { Provider } from "@gte-agent/core/provider"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const storeLayer = (home: string) =>
  AuthStore.layer.pipe(Layer.provide(FSUtil.defaultLayer), Layer.provide(Global.layerWith({ home })))

const withStore = <A, E>(
  body: (store: AuthStore.Interface, home: string) => Effect.Effect<A, E, AuthStore.Service | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    )
    return yield* Effect.gen(function* () {
      const store = yield* AuthStore.Service
      return yield* body(store, tmp.path)
    }).pipe(Effect.provide(storeLayer(tmp.path)))
  })

describe("AuthSchema", () => {
  it.effect("round-trips the auth file through JSON", () =>
    Effect.sync(() => {
      const file: AuthSchema.File = {
        version: 1,
        profiles: {
          "anthropic:default": { type: "api_key", key: "sk-ant-api03-test" },
          "openai:default": { type: "oauth", access: "at", refresh: "rt", expires: 1750000000000, accountId: "acct" },
        },
      }
      const decoded = Schema.decodeUnknownSync(AuthSchema.File)(JSON.parse(JSON.stringify(file)))
      expect(decoded).toEqual(file)
    }),
  )

  it.effect("profile keys are provider-scoped :default entries", () =>
    Effect.sync(() => {
      expect(AuthSchema.profileKey(Provider.ID.anthropic)).toBe("anthropic:default")
      expect(AuthSchema.profileKey(Provider.ID.openai)).toBe("openai:default")
    }),
  )
})

describe("AuthStore", () => {
  it.effect("persists profiles to ~/.gte-agent/auth.json with mode 0600", () =>
    withStore((store, home) =>
      Effect.gen(function* () {
        expect(store.file).toBe(path.join(home, ".gte-agent", "auth.json"))
        yield* store.set(Provider.ID.anthropic, { type: "api_key", key: "sk-ant-api03-test" })
        const stat = yield* Effect.promise(() => fs.stat(store.file))
        expect(stat.mode & 0o777).toBe(0o600)
        const written = JSON.parse(yield* Effect.promise(() => fs.readFile(store.file, "utf8")))
        expect(written).toEqual({
          version: 1,
          profiles: { "anthropic:default": { type: "api_key", key: "sk-ant-api03-test" } },
        })
        expect(yield* store.get(Provider.ID.anthropic)).toEqual({ type: "api_key", key: "sk-ant-api03-test" })
        expect(yield* store.get(Provider.ID.openai)).toBeUndefined()
      }),
    ),
  )

  it.effect("re-authing overwrites the single :default profile", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.set(Provider.ID.openai, { type: "api_key", key: "sk-old" })
        yield* store.set(Provider.ID.openai, { type: "oauth", access: "at", refresh: "rt", expires: 123 })
        const file = yield* store.read()
        expect(Object.keys(file.profiles)).toEqual(["openai:default"])
        expect(file.profiles["openai:default"]).toEqual({ type: "oauth", access: "at", refresh: "rt", expires: 123 })
      }),
    ),
  )

  it.effect("remove deletes the provider profile", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.set(Provider.ID.anthropic, { type: "api_key", key: "sk-1" })
        yield* store.remove(Provider.ID.anthropic)
        expect(yield* store.get(Provider.ID.anthropic)).toBeUndefined()
        expect((yield* store.read()).profiles).toEqual({})
      }),
    ),
  )

  it.effect("concurrent writes stay atomic, valid, and leave no temp files", () =>
    withStore((store, home) =>
      Effect.gen(function* () {
        yield* Effect.all(
          [
            store.set(Provider.ID.anthropic, { type: "api_key", key: "sk-a" }),
            store.set(Provider.ID.openai, { type: "oauth", access: "at", refresh: "rt", expires: 1 }),
            store.set(Provider.ID.anthropic, { type: "api_key", key: "sk-b" }),
          ],
          { concurrency: "unbounded" },
        )
        const file = yield* store.read()
        expect(file.version).toBe(1)
        expect(file.profiles["openai:default"]).toEqual({ type: "oauth", access: "at", refresh: "rt", expires: 1 })
        const anthropic = file.profiles["anthropic:default"]
        expect(anthropic?.type).toBe("api_key")
        if (anthropic?.type === "api_key") expect(["sk-a", "sk-b"]).toContain(anthropic.key)
        const entries = yield* Effect.promise(() => fs.readdir(path.join(home, ".gte-agent")))
        expect(entries).toEqual(["auth.json"])
        const stat = yield* Effect.promise(() => fs.stat(store.file))
        expect(stat.mode & 0o777).toBe(0o600)
      }),
    ),
  )

  it.effect("unparsable auth.json surfaces a typed error without contents", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(store.file), { recursive: true })
          await fs.writeFile(store.file, "sk-secret-not-json {")
        })
        const error = yield* Effect.flip(store.read())
        expect(error._tag).toBe("AuthStore.InvalidAuthFileError")
        expect(JSON.stringify(error)).not.toContain("sk-secret-not-json")
      }),
    ),
  )

  it.effect("resolution prefers the explicit per-model config value", () =>
    withStore((store) =>
      Effect.gen(function* () {
        yield* store.set(Provider.ID.anthropic, { type: "api_key", key: "sk-from-store" })
        const credential = yield* store.resolve({
          providerID: Provider.ID.anthropic,
          explicit: "sk-from-config",
          env: ["GTE_AGENT_TEST_UNUSED_KEY"],
        })
        expect(credential).toEqual({ type: "api_key", key: "sk-from-config", source: "config" })
      }),
    ),
  )

  it.effect("resolution prefers the stored profile over env", () =>
    withStore((store) =>
      Effect.gen(function* () {
        process.env.GTE_AGENT_TEST_FALLBACK_KEY = "sk-from-env"
        yield* Effect.addFinalizer(() => Effect.sync(() => delete process.env.GTE_AGENT_TEST_FALLBACK_KEY))
        yield* store.set(Provider.ID.anthropic, { type: "api_key", key: "sk-from-store" })
        const credential = yield* store.resolve({
          providerID: Provider.ID.anthropic,
          env: ["GTE_AGENT_TEST_FALLBACK_KEY"],
        })
        expect(credential).toEqual({ type: "api_key", key: "sk-from-store", source: "store" })
      }),
    ),
  )

  it.effect("resolution surfaces stored oauth profiles with their type", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const profile = { type: "oauth", access: "at", refresh: "rt", expires: 99, accountId: "acct" } as const
        yield* store.set(Provider.ID.openai, profile)
        const credential = yield* store.resolve({ providerID: Provider.ID.openai })
        expect(credential).toEqual({ type: "oauth", profile, source: "store" })
      }),
    ),
  )

  it.effect("resolution falls back to the provider env var", () =>
    withStore((store) =>
      Effect.gen(function* () {
        process.env.GTE_AGENT_TEST_FALLBACK_KEY = "sk-from-env"
        yield* Effect.addFinalizer(() => Effect.sync(() => delete process.env.GTE_AGENT_TEST_FALLBACK_KEY))
        const credential = yield* store.resolve({
          providerID: Provider.ID.openai,
          env: ["GTE_AGENT_TEST_UNSET_KEY", "GTE_AGENT_TEST_FALLBACK_KEY"],
        })
        expect(credential).toEqual({ type: "api_key", key: "sk-from-env", source: "env" })
      }),
    ),
  )

  it.effect("default env fallbacks use the well-known provider variables", () =>
    withStore((store) =>
      Effect.gen(function* () {
        expect(AuthStore.ENV[Provider.ID.anthropic]).toEqual(["ANTHROPIC_API_KEY"])
        expect(AuthStore.ENV[Provider.ID.openai]).toEqual(["OPENAI_API_KEY"])
        const previous = process.env.ANTHROPIC_API_KEY
        process.env.ANTHROPIC_API_KEY = "sk-ant-env"
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.ANTHROPIC_API_KEY
            if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous
          }),
        )
        const credential = yield* store.resolve({ providerID: Provider.ID.anthropic })
        expect(credential).toEqual({ type: "api_key", key: "sk-ant-env", source: "env" })
      }),
    ),
  )

  it.effect("missing credentials are a typed error", () =>
    withStore((store) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          store.resolve({ providerID: Provider.ID.anthropic, env: ["GTE_AGENT_TEST_UNSET_KEY"] }),
        )
        expect(error._tag).toBe("AuthStore.MissingCredentialsError")
        if (error._tag === "AuthStore.MissingCredentialsError") expect(error.providerID).toBe(Provider.ID.anthropic)
      }),
    ),
  )
})
