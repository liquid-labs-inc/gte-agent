# httpapi-exercise

Route-level coverage for the canonical GTE Agent server, rewritten from the
quarantined opencode `httpapi-exercise` pattern (scenario-per-route builder
DSL). Nothing here imports `packages/opencode`.

## How it works

- `setup.ts` — hermetic env bootstrap. Must stay the **first import** of every
  file here: core captures `GTE_AGENT_*` env vars at module load. It points
  `GTE_AGENT_HOME` at a temp dir and forces `GTE_AGENT_DB=":memory:"`.
- `harness.ts` — `makeServer(options)` builds a fetch-style web handler from
  `createRoutes(password)` (no TCP). Each server instance gets its own
  in-memory database and an explicit per-instance `ConfigProvider`
  (`options.config`) for `GTE_AGENT_AUTH_*`-style configuration — Effect's
  default provider snapshots `process.env` once per process, so mutating env
  vars between tests would not work.
- `dsl.ts` — the scenario builder (`http.get/post/patch/...`), seeding helpers
  (`api.createSession`, `api.prompt`, `api.awaitAssistant`, `api.roundTrip`),
  and `exercise([...])`, which registers each scenario as a bun test.

Every scenario runs against a **fresh server** (fresh in-memory DB) and
disposes it afterwards, so there are no mutation/reset flags and no ordering
hazards. Seeding goes through the HTTP API itself.

## Adding a scenario for a new route

```ts
http
  .post("/api/session/:sessionID/thing", "does the thing")          // method, route, behavior
  .server({ password: "...", config: { GTE_AGENT_AUTH_MODE: "..." } }) // optional transport/auth config
  .seeded((api) => api.createSession())                              // optional typed setup state
  .at(({ state }) => ({                                              // build the request from state
    path: `/api/session/${String(state.id)}/thing`,
    body: { ... },
    headers: { ... },
  }))
  .json(200, (body, ctx) => { ... })                                 // or .status(...) / .sse(...)
```

Drop the scenario into the matching `exercise([...])` block (or a new
`describe`). For streaming routes use `.sse({ until, timeoutMs }, inspect)`
with a deterministic stop condition — prompts against the demo model
(`gte-agent-demo`) produce a fixed event sequence ending in
`session.next.step.ended`.

## Known coverage limitations

- `ConflictError` (409) on session **create** is unreachable through HTTP: the
  session service captures the stub `devContext` at layer build, so every
  request acts as `dev_principal`/`dev_authority` and a duplicate-id create is
  idempotent instead of conflicting. Prompt-conflict 409 *is* covered.
- Cross-principal ownership probes (ForbiddenError on reads of another
  principal's session) are likewise unreachable until per-request auth context
  propagation lands; the reachable variant — creating a session for an
  authority outside the stub grant set (403) — is covered in `routes.test.ts`.
