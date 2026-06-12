# Security Policy

This repository is in the GTE Agent retrofit phase. Only the retained runtime skeleton is in scope.

## Scope

In scope:

- Retained runtime packages.
- Server authentication and authorization boundaries.
- Durable session, permission, and typed tool boundaries.

Out of scope:

- Removed OpenCode product surfaces.
- Historical documents under `docs/historical-opencode`.
- Local development configuration that requires direct filesystem access to the repo.

Server mode is opt-in. When enabled, set `OPENCODE_SERVER_PASSWORD` to require HTTP Basic Auth. Without this, the local server intentionally runs unauthenticated and warns at startup.

GTE Agent is not yet a trading execution runtime. Future real-liquidity functionality needs separate security, approval, audit, and disclosure guidance before it is enabled.

## Reporting

Report vulnerabilities through this repository's GitHub Security Advisory flow. Include the affected package or command, reproduction steps, expected impact, actual impact, and relevant logs.
