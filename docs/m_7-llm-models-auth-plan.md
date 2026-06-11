# Milestone 7: Real LLM Responses, `/models`, Provider Auth, And Prompt Autocomplete

This document is the source-of-truth plan for Milestone 7. It reopens Phase 1: Milestone 6 acceptance proved the runtime, TUI, and read-only data surfaces, but every agent reply is still the hardcoded demo stream from `packages/core/src/session/runner/demo.ts`. The LLM is the core of an agent; Phase 1 cannot be considered complete while the agent cannot think.

Status: planned, not started.

## Goal

Make `gta` a real agent. A user can open `/models`, pick a supported Anthropic or OpenAI model, authenticate that provider by pasting an API key or signing in (OAuth, following OpenClaw's flows), and then get real streamed LLM responses with the existing read-only GTE data tools available to the model. The TUI prompt gains slash-command autocomplete.

## End State

After Milestone 7:

- Prompting a session with a configured model and valid credentials streams a real LLM response (text deltas, tool calls, finish events) through the existing canonical event channel.
- The model can call the Phase 1 read-only GTE data tools during a turn (multi-step tool-calling loop), with tool results settling durably into the transcript as before.
- `/models` in the TUI opens a modal overlay: a fuzzy-filterable list of supported models grouped by provider, each row showing auth status. `/models <provider>/<model>` (e.g. `/models anthropic/claude-fable-5`) selects directly, skipping the picker.
- Selecting a model whose provider is unauthenticated chains into an auth wizard: method picker (paste API key / sign in) → masked paste input or browser OAuth progress view → confirmation. Esc backs out at any step.
- Supported auth methods:
  - Anthropic: pasted API key, or pasted Claude setup-token (Pro/Max OAuth credential).
  - OpenAI: pasted API key, or ChatGPT sign-in via PKCE OAuth (browser launch, localhost callback on port 1455, paste-redirect fallback for headless environments, token exchange, refresh-token rotation).
- OpenAI requests route by credential type: API keys use the official OpenAI API (existing `@ai-sdk/openai` path); ChatGPT OAuth tokens use the `chatgpt.com/backend-api` codex-responses protocol via a new adapter in `packages/llm`.
- Credentials live in `~/.gte-agent/auth.json` (mode 0600), profile-keyed (`"anthropic:default"`, `"openai:default"`), with `type: "api_key" | "oauth"` entries. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) remain a fallback. Secrets never enter `config.json` or project-local config.
- Model selection persists per session (strict: an unreachable or unauthenticated model produces a visible error, never a silent fallback) and the first/explicit selection writes the global default in `~/.gte-agent/config.json` so new sessions inherit it.
- Prompting with no model configured or no credentials yields a visible transcript error directing the user to `/models`. The demo LLM client survives only behind `GTE_AGENT_LLM=demo` for deterministic tests; it is never a silent fallback.
- The agent runs with a minimal GTE-owned system prompt: read-only trading-data assistant persona, the read-only boundary stated, tool catalog and session context (env, tracked address, selected market) described.
- Typing `/` in the prompt input opens a fuzzy-filtered autocomplete dropdown of slash commands (name + usage); Tab/Enter accepts, arrows navigate, Esc dismisses. Commands can declare arg-completion sources; `/models` completes provider/model refs and symbol-taking commands complete market symbols.
- Auth machinery is owned by `packages/core` and exposed through `packages/server` routes; the TUI is a thin client. Token refresh happens inside the session runner at request time.

## Scope

### 1. Curated Model Catalog

- Populate the existing Catalog service (`packages/core/src/catalog.ts`) with a curated, static, GTE-owned list (per the "provider/model policy is GTE-owned" decision in `docs/overview.md`):
  - Anthropic: `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`.
  - OpenAI: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`.
  - Exact IDs, context limits, capabilities, and costs verified against provider docs at implementation time; the list is updated via code changes, not runtime fetches.
- No network catalog dependency (no models.dev, no provider `/models` endpoint) in this milestone.
- Catalog rows must carry enough capability metadata for the runner to enable tool calling.

### 2. Auth Store And Flows (`packages/core`)

- New auth module (e.g. `packages/core/src/auth/`) owning `~/.gte-agent/auth.json`:
  - Schema (OpenClaw-compatible shape so multi-profile is a backward-compatible later addition): `{ version: 1, profiles: { "<provider>:default": { type: "api_key", key } | { type: "oauth", access, refresh, expires, accountId? } } }`.
  - File written with mode 0600; atomic rewrite on refresh.
  - Single `:default` profile per provider in this milestone; re-authing overwrites it. No failover, rotation, or profile management UI.
- Credential resolution order for a request: explicit per-model config value → auth.json profile → provider env var. Missing credentials are a typed error surfaced to the TUI.
- Anthropic flows: store pasted API key; store pasted setup-token as an oauth-type profile (requests use the OAuth bearer + required beta headers instead of `x-api-key`).
- OpenAI PKCE flow: generate verifier/challenge + state → return the authorize URL → caller opens browser → transient callback listener on `127.0.0.1:1455` captures the redirect (with a manual paste-redirect-URL fallback when the port cannot bind or the box is headless) → token exchange → extract `accountId` from the access-token JWT → persist `{ access, refresh, expires, accountId }`.
- Token refresh: session runner checks expiry before each request and refreshes/persists transparently; refresh failure is a visible auth error, not a retry loop.

### 3. Server Auth Routes (`packages/server`)

- `GET /auth/status` — per-provider auth state (method, authed/not, no secret material).
- `POST /auth/{provider}/api-key` — store a pasted key (also used for the Anthropic setup-token paste, distinguished by payload type).
- `POST /auth/{provider}/oauth/start` — begin PKCE flow, return authorize URL + flow handle.
- `POST /auth/{provider}/oauth/complete` — finish via callback result or pasted redirect URL.
- Routes covered by `httpapi-exercise`-style tests like the existing session routes. Responses never echo secrets.

### 4. Session Runner: Real LLM Turns With Tools

- Default runtime path resolves the session model through the catalog and auth store and streams via the real provider clients in `packages/llm`; `GTE_AGENT_LLM=demo` is the only way to get the demo client.
- New codex-responses adapter in `packages/llm` for OpenAI OAuth credentials (`chatgpt.com/backend-api`); API-key credentials keep the official `@ai-sdk/openai` path. Adapter behavior pinned with recorded-fixture tests (`packages/http-recorder`).
- Wire the read-only GTE data tool catalog into the LLM request: tools advertised to the model, multi-step tool-call loop per turn, durable tool settlement and transcript projection reused as-is. The import audit (`bun run audit:gte`) continues to gate the read-only boundary.
- Minimal GTE system prompt (read-only trading-data assistant, tool guidance, session context). Full prompt engineering, evals, and formatting policy are later work.
- Model selection: persisted on the session (immutable strictness — unreachable model fails visibly), global default read from config for new sessions. Selecting in `/models` updates both the current session and the global default.

### 5. TUI: `/models` Overlay And Auth Wizard (`packages/tui`)

- `/models` added to the slash-command registry; opens a modal overlay (OpenTUI `<select>` + `fuzzysort`):
  - Models grouped by provider, rows show auth status (authed / needs setup) and the currently selected model.
  - Selecting an authed model applies it (session + global default) and confirms in the transcript.
  - Selecting an unauthed model chains into the wizard: method picker → masked paste input (API key / setup-token) or OAuth progress view (URL shown, "waiting for browser…", paste-redirect fallback input) → confirmation.
  - Esc backs out one step at a time; secrets are masked during entry and never rendered into the transcript.
- `/models <provider>/<model>` selects directly; if unauthed it jumps straight to the wizard for that provider.
- Status surfaces (e.g. the existing status line) show the active model for the session.

### 6. TUI: Prompt Autocomplete

- Typing `/` at the start of the input opens a dropdown anchored to the prompt: fuzzy-filtered (fuzzysort) over the slash-command registry, showing name + usage; arrows navigate, Tab/Enter accepts, Esc dismisses, continued typing refines.
- Commands may declare an arg-completion source; wired in this milestone:
  - `/models` → provider/model refs from the catalog.
  - Symbol-taking commands (`/market`, `/data`, `/book`, `/trades`, `/chart`, …) → market symbols via the existing symbol-resolution surface.
- The mechanism is extensible (later sources: addresses, intervals, session ids) without redesign.
- Component tests via `@opentui/core/testing`, plus pure-function tests for filtering/selection state.

### 7. Documentation

- Update `docs/overview.md`: Phase 1 status reopened (Milestone 7 remaining), end condition extended (real LLM responses, `/models`, provider auth, tools-in-loop, autocomplete), demo-only implication removed, milestone list updated.
- `docs/m_6-acceptance-record.md` remains untouched as the historical M6 record.
- M7 acceptance record (`docs/m_7-acceptance-record.md`) created at delivery, after which Phase 1 closes again.

## Out Of Scope

- Multiple auth profiles per provider, profile selection order, failover, usage stats. (Schema is forward-compatible; UI/logic later.)
- Providers beyond Anthropic and OpenAI; dynamic/runtime model catalogs; user-defined models via config overrides.
- OS keychain credential storage.
- Full prompt engineering surface: persona depth, formatting rules, examples, evals.
- Model variants / reasoning-effort selection UX beyond what the catalog schema already carries.
- Free-text prompt-history autocomplete for non-slash input.
- Real GTE login/authority auth (still stubbed; this milestone's auth is LLM-provider auth only).
- Any trading mutation surface (unchanged Phase 1 boundary).

## Implementation Checklist

1. Curated catalog entries for Anthropic and OpenAI models land in `packages/core`, with capability metadata; catalog tests updated.
2. Auth store module in `packages/core` reads/writes `~/.gte-agent/auth.json` (0600, atomic), with resolution-order and schema tests.
3. Anthropic API-key and setup-token paste flows store correct profile types; request headers verified per credential type.
4. OpenAI PKCE flow: authorize URL generation, callback listener with paste-redirect fallback, token exchange, refresh rotation — covered by tests with recorded/stubbed HTTP.
5. Server auth routes implemented and exercised via route tests; no secret material in any response.
6. Codex-responses adapter in `packages/llm` streams a turn against recorded fixtures; API-key path unchanged.
7. Demo client gated behind `GTE_AGENT_LLM=demo`; default path errors visibly when model/credentials are missing; existing tests migrated to the env gate.
8. Read-only tools advertised to the model; a real multi-step tool-calling turn settles durably; `bun run audit:gte` still passes.
9. Per-session model persistence + global default write verified; unreachable-model strictness verified (no silent fallback).
10. `/models` overlay: picker, auth wizard, direct-arg selection, Esc navigation, secret masking — component and slash-registry tests.
11. Prompt autocomplete: command completion + model-ref and symbol arg sources — component and pure-function tests.
12. Minimal GTE system prompt in the runner; demo/system-prompt behavior snapshot-tested.
13. End-to-end manual check: fresh `~/.gte-agent`, `gta`, `/models`, auth each provider via each method, real streamed reply, a tool-calling turn, autocomplete.
14. `docs/overview.md` updated; M7 acceptance record written at delivery.

## Risks

- **Codex backend instability (largest risk).** `chatgpt.com/backend-api` with the codex-responses protocol is undocumented and can change or break at OpenAI's discretion; third-party-client ToS posture is grey. Mitigation: isolate it in one adapter, pin behavior with recorded fixtures, keep the official API path fully independent so breakage degrades only the OAuth-credential path.
- **OAuth callback environment variance.** Port 1455 may be unavailable; headless/SSH machines cannot open a browser. Mitigation: paste-redirect-URL fallback is first-class, not an afterthought.
- **Latent bugs in the never-exercised tool-call path.** The typed tool registry and settlement have only run against the demo client. Mitigation: budget for fixing settlement/projection issues; cover with recorded-fixture turn tests before the manual check.
- **Secret leakage into transcripts/logs.** Paste inputs and auth routes touch raw secrets. Mitigation: masked inputs, no secret echo in routes/events, and a test asserting transcripts/events never contain stored key material.
- **Demo-gate test churn.** Many existing tests implicitly rely on the demo client being default. Mitigation: set `GTE_AGENT_LLM=demo` centrally in test setup per package rather than per test.
- **Milestone size.** This is the largest Phase 1 milestone; auth flows, the codex adapter, the overlay wizard, autocomplete, and tools-in-loop are separable. Mitigation: land as a sequence of PRs in roughly checklist order, each independently green.
