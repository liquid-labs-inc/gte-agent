# Vendored Package: gte-ts

This directory is a verbatim vendored copy of the upstream `gte-ts` TypeScript SDK.

## Provenance

- Upstream repo: https://github.com/liquid-labs-inc/monorepo.git
- Upstream path: `packages/typescript/gte-ts`
- Monorepo commit SHA at copy time: `73cb48951a394192a1621f2b89dc634980f778b2`
- Last commit touching the package: `289f8f77d396b3d8c8a8792e3c582ddfc82bb94c` (2026-06-10, "Migrate TypeScript workspace from liquid-labs (#421)")
- Copy date: 2026-06-10

## What was copied / excluded

All 91 git-tracked files at the upstream path were copied via `git archive` (source,
tests, examples, `openapi.yaml`, generated OpenAPI client under `src/internal/generated/`,
and tool configs). Excluded: `node_modules/`, `dist/`, and any other untracked build
artifacts. The upstream package has no `LICENSE` or `README.md` file at its root
(nor at the monorepo root); the license is declared MIT via `package.json`.

## Rules

- This copy is **verbatim**. Do not make local edits — no refactors, renames, splits,
  or reformatting. Changes go upstream first, then re-sync this copy.
- Re-sync with `bun run script/sync-gte-ts.ts` (diff) /
  `bun run script/sync-gte-ts.ts --apply` (refresh copy and update the SHAs above).

## Local modifications

None. `package.json` is unmodified from upstream.

## Replacement plan

`gte-ts` is not published to npm yet. When it is, delete this vendored workspace
package and depend on the published `gte-ts` package instead. The package name is
kept as `gte-ts` so consumer imports (`import { createGteDataClient } from "gte-ts"`)
do not change when the swap happens.
