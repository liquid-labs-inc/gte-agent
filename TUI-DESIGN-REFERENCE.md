# /workflows TUI — Canonical Design Reference (from Anthropic's official dynamic-workflows screenshot)

REVIEWER: match this layout in the /workflows run view. Polish guidance — correctness/wiring still takes priority over pixel-matching. Source image: ~/clawd/tmp-shots/cc_workflows_hero.png

Overall: classic TUI titled-box style, monospace, thin borders with inline labels interrupting the top border edge. Minimal palette: default fg, muted gray, green = done, accent (blue) = active/selected.

## Header (full width)
- Line 1: workflow name (bold, accent color), e.g. `react-to-solid-migration`
- Line 2: one-line run description (muted), with right-aligned `28/35 agents · 5m30s` (completed/total agents + elapsed)

## Two-panel body

### Left panel — "Phases" (~25% width, title inline in top border)
One row per phase: status glyph + name + right-aligned agent count.
- Completed: green ✓ + name + `12/12` (muted count)
- Active/selected: accent `❯` + ordinal + name + `3/10` — whole row accent-colored
- Pending: muted ordinal number (4, 5, 6), no glyph, no count

### Right panel — phase detail (~75% width)
Title inline in border: `<PhaseName> · 10 agents`. One row per agent, 3 column groups:
1. Status glyph + agent name — green ✓ done (default fg text) / muted ● running (all-muted text). Names like `infra:package.json`
2. Model name, muted (e.g. `Opus 4.8`)
3. Right-aligned stats: `48.7k tok · 9 tools · 28s` — duration segment only when done; running agents show `50.5k tok · 8 tools`

Stats right-align to the panel edge; character-grid column alignment.

## Navigation
Keep existing screens (list → run → phase → agent) and the keybind footer, but make the RUN view this two-panel phases+agents layout — that is the canonical look users expect.
