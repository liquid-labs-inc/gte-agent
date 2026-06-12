---
name: workflows
description: Plan and execute dynamic workflows - phased, parallel subagent orchestration for tasks too large for one conversation (audits, migrations, cross-checked research). Use when the user says "ultracode", "workflow", or asks for work fanned out across many agents.
---

# Dynamic Workflows

A workflow runs a large task as **phases of parallel subagents** with the plan held in a written artifact, not in your context. You are the runtime: you read (or write) a workflow definition, execute its phases with the `task` tool, keep intermediate results out of your context, and deliver one synthesized result.

Use a workflow when the task needs more agents than a single turn can coordinate, or when the user wants the orchestration repeatable. Good fits: codebase-wide audits, many-file migrations, research that needs sources cross-checked, plans drafted from several independent angles. For a couple of delegated lookups, just use the `task` tool directly — no workflow ceremony.

## Triggers

- The keyword `ultracode` anywhere in the prompt → run that task as a workflow.
- Natural-language requests: "use a workflow", "run a workflow", "fan this out".
- A saved workflow invoked by name (see Saved Workflows below).

## Execution procedure

### 1. Plan phases

Decompose the task into 2-5 named phases. Each phase is a set of agents that can run in parallel; phases run in sequence because later phases consume earlier results. Write the plan to the user in one short message before starting (phase names + agent counts + models), and ask for confirmation only if the run looks expensive (>20 agents or whole-repo scope) — otherwise proceed.

Standard quality patterns to build in:

- **Fan-out/reduce:** N agents each own a shard (directory, file list, question angle); one final agent synthesizes.
- **Adversarial review:** a second phase of agents attacks the first phase's findings ("find what's wrong or missing in this finding") before anything is reported.
- **Multi-angle drafting:** several agents draft a plan independently from different premises; a judge agent weighs them.
- **Claim voting:** for research, have independent agents verify each claim; drop claims that don't survive majority cross-checking.

### 2. Write the run script

Persist the plan before executing so the orchestration is reviewable and rerunnable. Write it to `.opencode/workflows/runs/<slug>-<YYYYMMDD-HHmm>.md` using this format:

```markdown
---
name: <slug>
description: <one line>
args: <what input the workflow takes, or "none">
---

## Phase 1: <name>
- agents: <count and sharding rule, e.g. "one per directory under src/routes/">
- type: <task subagent_type, e.g. explore | general>
- prompt template: |
    <the exact prompt each agent gets, with {shard} placeholders>

## Phase 2: <name>
...

## Synthesis
- <how the final answer is assembled, what gets filtered, output format>
```

Tell the user the script path when the run starts.

### 3. Execute phases

For each phase, launch **all of that phase's agents in a single message** (parallel `task` calls). Use `background=true` when you have non-overlapping work to do meanwhile; otherwise foreground and wait.

Rules:

- **Concurrency cap: 16 agents in flight.** Shard work so no phase needs more; if it does, batch the phase into waves of ≤16.
- **Total cap: do not exceed 1,000 agents in a run.** If sharding would exceed it, coarsen the shards.
- **Keep results out of your context.** Tell every agent to write its full findings to a file under `.opencode/workflows/runs/<run>/phase-<n>/<shard>.md` and return only a 2-3 line summary plus the file path. Later phases read the files, not your transcript.
- **Model routing:** use cheap/fast agents (`explore` type, smaller model) for read-only scouting; reserve the strong model for judgment phases (review, synthesis). Pass `subagent_type` accordingly.
- **Failures:** if an agent fails or returns garbage, retry it once with the failure noted in the prompt; after that, record the shard as failed and continue. Report failed shards in the final summary.

### 4. Synthesize and report

The final phase is a single agent (or you, if results are small) that reads the phase outputs and produces the deliverable. Report to the user: the result, agent counts per phase, failed shards if any, and the run script path. Do not paste intermediate agent transcripts.

## Saved workflows

Reusable workflow definitions live in:

- `.opencode/workflows/*.md` — project, shared via repo (wins name collisions)
- `.claude/workflows/*` — Claude Code compatibility, treat read-only
- `~/.config/opencode/workflows/*.md` — personal, all projects

When the user invokes one by name ("run deep-research on X", "/deep-research X"), read the definition, bind their input as `args`, and execute it with the procedure above. When a one-off run worked well and the user wants to keep it, save the run script (frontmatter `name` becomes the invocation name) into the project or personal directory — ask which.

## Cost discipline

Workflows burn tokens. Before a large run, offer the user a small slice first (one directory, one question angle). Track roughly how many agents you've spawned; surface the count in your progress updates and final report. If the user says stop, stop launching new agents — completed shard files are kept, and the run can resume by skipping shards whose output files already exist (cached results).
