# Milestone 6: Phase 1 Acceptance

This document is the source-of-truth plan for Milestone 6 of the GTE Agent retrofit.

Milestone 6 closes Phase 1 by proving the user-facing product works end to end and remains read-only. It should verify integration across `gta`, the canonical runtime, auth stubs, `gte-ts` configuration, TUI panels, slash commands, agent tools, and the no-mutation boundary.

## Goal

Establish acceptance for Phase 1:

- `gta` is runnable.
- The TUI is usable.
- Sessions work through the canonical runtime.
- Read-only GTE data tools and panels work through `gte-ts`.
- Auth remains stubbed.
- No hidden trading mutation path is exposed.

## End State

After Milestone 6:

- `gta` launches the TUI from a clean checkout.
- The TUI runs the canonical runtime in-process via its worker by default, and a real HTTP listener works behind explicit network flags or `gte-agent serve`.
- Users can create/select/reopen sessions.
- Prompt admission, deterministic demo-runner streaming, and replay/list history work.
- Auth-disabled mode is easy to use and shows synthetic principal/authority state.
- `GTE_AGENT_GTE_ENV` configures the shared `gte-ts` data client.
- Public market slash commands open/focus live panels and record compact transcript snapshots.
- Address-scoped slash commands require an explicit address or session tracked address.
- Agent-callable tools use the same read-only data operations as slash commands.
- TUI panels are live-by-default where stable streams exist and fall back to HTTP snapshots/refresh where needed.
- Tool and command results include provenance.
- No trading mutation, signing, order placement, cancel/replace, TWAP mutation, leverage setting, or order preview path is reachable by default.
- `packages/opencode` removal criteria are either satisfied or documented as remaining blockers.

## Acceptance Areas

### `gta` TUI

Verify:

- `gta` launches the TUI.
- `gte-agent` can remain as a lower-priority developer/compatibility alias.
- The TUI does not depend on `packages/opencode`.
- The TUI presents a transcript/prompt area and separate data workspace.
- The TUI shows service/session/auth-stub status clearly.

### Canonical Runtime

Verify through the TUI and direct CLI/API where useful:

- In-process worker server launch via `gta`, plus headless `gte-agent serve` with an HTTP listener.
- The `httpapi-exercise`-style route test suite for `packages/server` (added in Milestone 4) passes.
- Session create.
- Session list.
- Session select/reopen.
- Prompt admission.
- Demo model stream.
- Event stream.
- Message replay/history.
- Local SQLite persistence.

### Auth Stubs

Verify:

- Auth-disabled mode works without real GTE login.
- Synthetic principal and authority are present.
- The TUI displays auth-stub status.
- No login UX, token storage, real token introspection, wallet ownership, or authenticated account binding is required.

### GTE Data Configuration

Verify:

- `GTE_AGENT_GTE_ENV` is the only GTE data environment setting required by GTE Agent.
- Valid environment names come from `gte-ts`.
- Slash commands, TUI panels, symbol resolution, address-scoped reads, and agent tools use the same configured data client.
- Changing `GTE_AGENT_GTE_ENV` affects all data surfaces consistently.

### Read Tools And Panels

Verify core public market reads:

- Markets list/search.
- Market summary.
- Market data.
- Order book.
- Trades.
- Candles/chart.
- Market context when stable.
- Read-only quote estimate.

Verify address-scoped reads:

- Positions.
- Open orders.
- Order history.
- Trade history.
- Balances.
- Balance history.
- PnL.
- Funding.
- Account metrics.
- Allowance.
- Leverage read.
- Fees.
- TWAP history.
- Next subaccount.

Verify advanced and diagnostic reads when stable:

- GTE data API health.
- Liquidations panel.
- Bench metrics panel.

Verify live panel behavior:

- Slash commands open or focus panels.
- Stable streams update panels automatically.
- HTTP fallback works when streaming is unavailable.
- Stream updates do not spam the transcript.
- Reopening a session restores panel intent, selected market, and tracked address.

### Agent Tools

Verify:

- Agent tools are one-shot reads.
- Agent tools share the same data operations as slash commands.
- Tool outputs include provenance.
- The model can analyze read data.
- The model cannot execute trades or call mutation paths.
- If fresh data is needed, the model calls a read tool again.

### Resolution And Validation

Verify:

- Exact market symbols pass through unchanged.
- Common ticker normalization works.
- `gte-ts` search is used before LLM fallback.
- LLM fallback can call read-only search/list tools and asks for disambiguation when needed.
- Address-scoped reads validate EVM addresses before calling `gte-ts`.
- Missing address prompts for an address unless a session tracked address exists.

### No Hidden Trading Mutation

The import audit is an automated CI check (added in Milestone 5), not a one-time manual review: a grep/lint gate that fails the build if active paths import `createGteOrderClient`, signer adapters, signing helpers, or order/account write resources from the vendored `gte-ts`. Milestone 6 verifies the gate exists, runs in CI, and actually fails when a forbidden import is introduced. The command/tool registry review remains a manual acceptance step.

Verify by command/tool registry review and the automated import audit:

- No slash command exposes order placement, cancel, replace, TWAP mutation, leverage setting, or signing.
- No agent tool exposes order placement, cancel, replace, TWAP mutation, leverage setting, or signing.
- The default TUI cannot reach mutation paths.
- Active data-tool paths do not import `createGteOrderClient`.
- Active data-tool paths do not import signer adapters.
- Active data-tool paths do not import order mutation resources.
- Active data-tool paths do not import or expose `AccountsWrite.setLeverage`.

Address-scoped account and portfolio reads are allowed because GTE is a DEX and those reads are public. They must still require an explicit address or tracked address in Phase 1 because there is no authenticated user address yet.

### `packages/opencode` Removal Criteria

Verify or record blockers:

- `gta` TUI exists on the canonical runtime.
- No active imports, route mounts, package scripts, build scripts, tests, or SDK generation paths depend on `packages/opencode`.
- All useful TUI patterns have been copied, rewritten, or rejected.
- All useful test harness patterns (`httpapi-exercise` route DSL, `cli-process` subprocess harness, `@opentui/core/testing` component tests) have been extracted or deliberately rejected.
- Docs no longer direct future implementation work to `packages/opencode` except as historical context.
- Active TUI has no legacy share, sync, workspace, filesystem, shell, or coding-tool coupling.

The intent is to delete `packages/opencode` during Milestone 6, once the TUI carve-out and harness extraction are reviewed and all criteria are met. If a criterion is unmet, record it as a blocker with an owner instead of deleting.

## Out Of Scope

- Production GTE/server-side persistence.
- Real GTE login.
- Authenticated account defaults.
- Wallet signing.
- Trading execution.
- Order preview.
- Risk gates.
- Trading memory.
- Final provider/model policy.
- Final extension policy.
- Final TUI design for authenticated trading.

## Verification Checklist

1. Launch `gta`.
2. Confirm the in-process worker server is running; separately verify `gte-agent serve` exposes an HTTP listener.
3. Create a session.
4. Prompt the demo runner and see streamed output.
5. Replay/list session history.
6. Confirm auth-stub status is visible.
7. Set `GTE_AGENT_GTE_ENV` and confirm all data surfaces use it.
8. Run public market slash commands and see panels plus compact transcript snapshots.
9. Run address-scoped read commands with explicit address.
10. Set a session tracked address and run address-scoped reads without repeating it.
11. Verify live panels update automatically where streams are stable.
12. Verify HTTP fallback behavior where streams are unavailable.
13. Verify agent-callable tools return one-shot snapshots with provenance.
14. Verify symbol resolution and address validation behavior.
15. Review the command and tool registries for hidden mutation/signing reachability, and verify the automated import-audit CI gate runs and fails on a forbidden import.
16. Verify the `packages/server` route test suite passes.
17. Evaluate the `packages/opencode` removal criteria and delete the package, or record remaining blockers with owners.

## Risks

- A working TUI can still fail Phase 1 if it uses a separate config path from agent tools.
- A read-looking command can become a mutation path if it imports the wrong `gte-ts` client.
- Address-scoped reads can be mistaken for authenticated account context if the TUI does not label them clearly.
- Live panels can make session replay noisy if continuous updates are persisted as transcript messages.
- Leaving `packages/opencode` as an informal dependency can postpone deletion indefinitely.
