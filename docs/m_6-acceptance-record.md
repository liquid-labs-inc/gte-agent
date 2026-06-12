# Milestone 6: Phase 1 Acceptance Record

Date: 2026-06-11
Branch: `initial-skeleton` (uncommitted multi-agent work)
Scope: Verification Checklist items 1–16 of `docs/m_6-phase-1-acceptance-plan.md`. Item 17 (`packages/opencode` removal) is owned by a concurrent agent and is intentionally excluded from this record.

Verdict legend: PASS / PASS-WITH-NOTES / MANUAL-REMAINING / FAIL.

## Per-Item Results

| # | Item | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Launch `gta` | PASS | `bun run packages/tui/src/index.ts --help` and `--version` exit 0; `gta` bin mapping at `packages/tui/package.json` (`"bin": { "gta": "./src/index.ts" }`); pty smoke (`script(1)` pseudo-tty) rendered the full layout ("GTE Agent · gta v1.16.0", sessions pane, data workspace, status bar) and terminated on SIGTERM (exit 143); subprocess smoke tests `packages/tui/test/cli.test.ts` ("--help prints usage and exits 0", "unknown flag prints usage and exits 1"). |
| 2 | In-process worker default + `gte-agent serve` HTTP listener | PASS | Worker default: `packages/tui/test/worker-bridge.test.ts` "worker serves /api/health over the in-process channel"; pty frame shows "server up · in-process worker http://gte-agent.internal". `--listen`: worker-bridge test "listen starts a real HTTP listener on demand". Headless: `bun run packages/cli/src/index.ts serve --port 41734` printed `server listening on http://127.0.0.1:41734`; `GET /api/health` with the daemon `x-gte-agent-daemon-authorization` header returned `{"healthy":true}`. |
| 3 | Create a session | PASS | Live `POST /api/session` through the running `serve` listener returned 200 with `ses_…` id, `principalID: "dev_principal"`, `authorityID: "dev_authority"`; route suite `packages/server/test/httpapi-exercise/routes.test.ts` `session.create` (explicit id, duplicate-id idempotency, schema and authority rejections). |
| 4 | Demo prompt streaming | PASS (non-interactive) | `packages/tui/test/worker-bridge.test.ts` "session create + prompt streams demo runner output over bridged SSE"; `routes.test.ts` `session.prompt` describe. Visual streaming in a live terminal: see Manual-Remaining. |
| 5 | Replay/list session history | PASS | `routes.test.ts` `session.list` and `session.messages` describes (58/58 server tests pass); duplicate-create test proves persistence round-trip ("duplicate create should not mint a new session"). |
| 6 | Auth-stub visibility | PASS | `packages/tui/test/app.test.tsx` "boots and renders the main layout with auth-stub status…" asserts "auth disabled (stub)", `dev_authority`; pty frame rendered "auth disabled (stub) · principal dev_principal · authority dev_authority"; live API probe with no `GTE_AGENT_AUTH_MODE` set returned the stub principal/authority (item 3 evidence). |
| 7 | `GTE_AGENT_GTE_ENV` consistency | PASS | `GET /api/gte/env` via `webHandler`: unset → `{"env":"hyperliquid-dev",…}`, `GTE_AGENT_GTE_ENV=hyperliquid-prod` → `{"env":"hyperliquid-prod",…,"validEnvs":["hyperliquid-dev","hyperliquid-prod"]}`. Invalid env (`bogus-env`) fails layer build, exit 1: `error: Invalid GTE_AGENT_GTE_ENV "bogus-env". Valid values (owned by gte-ts GteEnvKey): hyperliquid-dev, hyperliquid-prod.` (`packages/core/src/gte-data/gte-data.ts:197`). Tools and routes share the one `GteData` service: `packages/core/src/runtime-scope-layer.ts:42`, `packages/core/src/tool/builtins.ts:39`; pty frame shows `env: hyperliquid-dev` in the data workspace. |
| 8 | Public market slash commands → panels + compact snapshots | PASS (non-interactive) | `packages/tui/test/slash.test.ts` "/book resolves the symbol, records a snapshot, pins the panel, and sets the primary market", "/quote records an estimate-only snapshot and never opens a panel"; `packages/tui/test/data-workspace.test.tsx` "a slash command patches intent, records a snapshot, and renders the live panel". Live upstream: `GET /api/gte/markets?limit=1` returned real hyperliquid-dev data with full provenance. |
| 9 | Address-scoped reads with explicit address | PASS | `slash.test.ts` "address commands prefer an explicit address over the tracked address"; `packages/core/test/gte-tools.test.ts` "prefers an explicit address over the session tracked address and normalizes case". |
| 10 | Tracked address fallback | PASS | `slash.test.ts` "/track sets and clears the tracked address through session intent" and "address commands fall back to the session tracked address"; `gte-tools.test.ts` "falls back to the session tracked address when no address argument is given". |
| 11 | Live panels update automatically | PASS (non-interactive) | `packages/core/test/panel-manager.test.ts` "activates pinned panels on first attach and publishes throttled updates", "diffs subscriptions when session intent changes"; `data-workspace.test.tsx` "ephemeral panel updates re-render the panel without growing the transcript". Visual confirmation with real streams: see Manual-Remaining. |
| 12 | HTTP fallback when streams unavailable | PASS (non-interactive) | `panel-manager.test.ts` "publishes degraded on stream error and recovers to live when data resumes", "publishes degraded when the subscription itself cannot be established"; `data-workspace.test.tsx` "degraded panels fall back to HTTP snapshot polling with an honest source label". |
| 13 | Agent tools: one-shot snapshots with provenance | PASS | `packages/core/test/runtime-scope-layer.test.ts` asserts the default registry `definitions()` equals `application_context` + the 23 read-only `gte_*` tools and settles `gte_quote`/`gte_balances` calls as typed errors through the canonical registry; `gte-tools.test.ts` "executes a market tool end-to-end with symbol resolution and provenance", "health tool returns a provenance-wrapped snapshot without address or symbol". Live responses carry `provenance{env,source,timestamp,params}` (items 8/14). |
| 14 | Symbol resolution + address validation | PASS-WITH-NOTES | Resolver: `packages/core/test/gte-data.test.ts` (exact pass-through "BTC-USD", normalization "btc-usd"→"BTC-USD", search-before-LLM fallback); `slash.test.ts` "ambiguous symbols surface candidates and never guess", "invalid explicit addresses are rejected before any request"; `gte-tools.test.ts` "rejects an invalid explicit address before any request is made". Live: `/api/gte/resolve-symbol?q=btc` → resolved `BTC-USD-PERP`; `q=BTC-USD-PERP` → exact pass-through; `q=hype` → honest `ambiguous` with candidates. Note: live `q=btc-usd` returns 503 because the hyperliquid upstream search endpoint rejects symbol-shaped non-canonical queries (`market symbol "BTC-USD" is not canonical; use MARKET-QUOTE-PERP`) — upstream search behavior, recorded as a known limitation below. |
| 15 | No hidden mutation + import-audit gate | PASS | Registry review: the 23 registered tools (`gte_markets`, `gte_market`, `gte_market_data`, `gte_book`, `gte_trades`, `gte_candles`, `gte_market_context`, `gte_quote`, `gte_positions`, `gte_open_orders`, `gte_order_history`, `gte_trade_history`, `gte_balances`, `gte_balance_history`, `gte_pnl`, `gte_funding`, `gte_account`, `gte_allowance`, `gte_leverage`, `gte_fees`, `gte_twap_history`, `gte_next_subaccount`, `gte_health`) plus `application_context` are all reads; all 27 slash commands in `packages/tui/src/commands/slash.ts:45-71` are market/address reads, panel opens, or local session intent (`/track`, `/env`) — no order placement, cancel/replace, TWAP mutation, leverage setting, or signing anywhere. Gate proof: baseline `bun run audit:gte` → "gte import audit passed (644 files scanned)" exit 0; with a scratch `import { createGteOrderClient } from "gte-ts"` in `packages/core/src/tool/gte/scratch-audit-proof.ts` → "gte import audit FAILED: 2 violation(s) (645 files scanned)" exit 1 (import-binding + bare-name detections); scratch deleted; re-run clean (exit 0). CI: `.github/workflows/audit.yml` runs `bun test audit-gte-imports.test.ts` then `bun run audit:gte` on push/PR; `.husky/pre-push` runs `bun run audit:gte`. |
| 16 | `packages/server` route suite | PASS | `bun test` in `packages/server`: 58 pass, 0 fail (5 files: httpapi-exercise routes/auth/events/snapshot + live-session-events). |
| 17 | `packages/opencode` removal | EXCLUDED | Owned by a concurrent agent; not evaluated here. |

## Cross-Package Sweep

- `packages/core` `bun test`: 980 pass / 1 skip / 1 fail — the single failure is the known pre-existing `Watcher > publishes .git/HEAD events` (`packages/core/test/filesystem/watcher.test.ts:231`), which also fails on a clean baseline (macOS fs-events backend does not deliver the `.git/HEAD` write); carried as a known issue, not a Phase 1 regression.
- `packages/tui` `bun test`: 46 pass / 0 fail.
- `packages/server` `bun test`: 58 pass / 0 fail.
- `bun run typecheck` (tsgo): core, server, tui, cli, sdk — all exit 0.
- Root `bun run lint` (oxlint): 0 errors (760 warnings, pre-existing).
- `bun run script/migration.ts --check` in `packages/core`: exit 0.

## Live Upstream Reachability (hyperliquid-dev)

Upstream is reachable. Recorded honestly per plan (upstream failures are not acceptance blockers):

- `GET /api/gte/markets?limit=1` → 200, real market data (`HYPE-USD-PERP`) with `provenance{env:"hyperliquid-dev",source:"http",timestamp,params}`.
- `GET /api/gte/resolve-symbol?q=btc` → 200 resolved `BTC-USD-PERP`; `q=hype` → 200 honest `ambiguous` with candidates.
- `GET /api/gte/health` → 503: upstream `getHealth` currently returns HTTP 404 ("not found") on hyperliquid-dev. The 503 mapping with a typed `ServiceUnavailableError` is correct behavior; the upstream `/health` endpoint itself is unavailable today.
- `GTE_AGENT_GTE_LIVE_TEST=1 bun test packages/core/test/gte-data-live.test.ts`: markets-list and symbol-resolution assertions passed live; the test FAILS only at the final `getHealth()` step with the same upstream `HTTP_404` — upstream availability, not a product defect.

## Known Limitations Carried Into Post-Phase-1

1. Pre-existing core test failure: `Watcher > publishes .git/HEAD events` (macOS fs-events; fails on clean baseline). Only failing test in the tree.
2. Cross-principal ownership probes (`NotFoundError` for foreign sessions, `AuthorityConflictError` 409) are unreachable over HTTP because `Session.layer` resolves the auth `RequestContext` once at layer build — a stub-auth limitation deferred to the real-auth phase (documented in `packages/server/test/httpapi-exercise/auth.test.ts:14-17`).
3. SDK branded types generate as `unknown` in `packages/sdk/js/src/gen/types.gen.ts` — pre-existing hey-api generation quirk.
4. Upstream hyperliquid-dev `/health` endpoint returns 404 (2026-06-11); `gte_health` / `/api/gte/health` / the live smoke test surface it as a typed 503 until upstream restores it.
5. Live symbol resolution of dash-form ticker queries that are not canonical (e.g. `btc-usd` on hyperliquid envs where the canonical symbol is `BTC-USD-PERP`) fails with an upstream search rejection instead of resolving; plain tickers (`btc`) resolve correctly. Candidate resolver enhancement for the next phase.
6. Stale local dev state: a `gte-agent-local.db` created by pre-rename/older-schema builds in the default tmp home (`$TMPDIR/gte-agent/data`) causes session create to 500; a clean home (fresh checkout/first run) works. Environmental only — no migration path is promised across pre-release dev schemas.

## Remaining Manual Interactive Checks (human, real terminal)

- Visual TUI session flow: create/select/reopen sessions with the keyboard; confirm prompt admission and demo-runner streaming render incrementally in the transcript.
- Live panel rendering: run `/book <symbol>` / `/trades <symbol>` / `/chart <symbol>` against hyperliquid-dev and watch panels auto-update without transcript spam; verify degraded→live source-label transitions during a real network blip.
- Session reopen restores panel intent, selected market, and tracked address visually.
- `gta --listen` manual probe from a second terminal while the TUI is open.
- Terminal restore (alternate-screen exit) on quit via ctrl+c in an interactive shell.
