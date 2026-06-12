# GTE Agent

This repository is being retrofitted from opencode into the GTE Agent runtime skeleton.

Milestone 1 keeps the local development substrate needed to build the trading-native runtime:

- Canonical session/event runtime in `packages/core`.
- Typed tool and permission primitives.
- LLM request and streaming support in `packages/llm`.
- Local SQLite persistence for development and tests.
- Server, SDK, CLI, plugin, MCP, command, and skill mechanisms for future GTE-owned policy.
- A temporary TUI carve-out path in `packages/opencode`.

Removed OpenCode product surfaces include the browser app, public docs/marketing site, desktop app, Storybook, VS Code extension, hosted console/stats/slack products, localization docs, public share product docs, and release/deploy automation.

The root `docs/` folder contains internal retrofit planning. This is not final GTE Agent product documentation.

## Development

Install dependencies with Bun, then use focused package commands:

```sh
bun install
bun --cwd packages/core typecheck
bun --cwd packages/server typecheck
bun --cwd packages/cli typecheck
bun --cwd packages/sdk/js typecheck
```

Do not run tests from the repo root. Run tests from package directories.

The current default branch is `dev`.
