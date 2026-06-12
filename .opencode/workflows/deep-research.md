---
name: deep-research
description: Investigate a question across many sources with cross-checking - fans out web searches on several angles, verifies claims against each other, returns a cited report
args: the research question (required)
---

## Phase 1: angles
- agents: 4-6, one per question angle
- type: general (needs websearch + webfetch)
- prompt template: |
    Research the following question from this specific angle: {angle}.
    Question: {args}
    Run multiple web searches with distinct queries, fetch the most relevant
    sources, and extract concrete claims with their source URLs. Write your
    full findings (claim + supporting quote + URL per claim) to {outfile}.
    Return only a 3-line summary and the file path.

Angle derivation: split the question into independent perspectives (e.g. official docs,
release notes/changelogs, community reports/issues, benchmarks/data, contrarian takes).

## Phase 2: cross-check
- agents: one per claim cluster from Phase 1 (cap 16; cluster claims by topic)
- type: general
- prompt template: |
    Verify the following claims independently. For each claim, search for
    corroborating AND contradicting sources you have not been given. Mark each
    claim VERIFIED (2+ independent sources agree), DISPUTED (credible sources
    conflict), or UNSUPPORTED (no independent corroboration). Write verdicts
    with evidence to {outfile}. Claims to check: {claims_file}

## Phase 3: synthesis
- agents: 1
- type: general
- prompt template: |
    Read all phase outputs in {run_dir}. Write the final report on: {args}.
    Include only VERIFIED claims in the main body, each with its source citations.
    List DISPUTED claims in a separate "Contested" section with both sides.
    Drop UNSUPPORTED claims entirely. End with a sources list.

## Synthesis
- Deliverable: cited report; claims that failed cross-checking are filtered out
- Report agent counts per phase and any failed shards
