# Follow-up Skill-first Positioning Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox syntax for tracking.

**Goal:** Align Follow-up's public and agent-facing documentation around a Skill-first, plugin-enhanced Signal / Attention product boundary without changing runtime behavior.

**Architecture:** Keep the Skill as the portable interaction and orchestration surface, define an optional DeepSeek Harness plugin as the rich information-center surface, and document Follow-up Core/Contract, Feed Pipeline, Delivery Runtime, and Local User State as separate responsibilities. Treat all generated digest content as Signal by default and require explicit handoff plus downstream governance before it becomes Work or Memory.

**Tech Stack:** Markdown documentation, Codex/Agent Skill conventions, existing Node.js and GitHub Actions architecture.

---

## Chunk 1: Product Baseline

### Task 0: Record the dirty-worktree baseline

**Files:**
- Inspect only: repository working tree

- [x] Run `git status --short` and save the pre-edit output in the task transcript.
- [x] Run `git diff --name-only` and record which runtime, config, Feed, workflow, and documentation files were already modified.
- [x] Limit this task's edits to `README.md`, `README.zh-CN.md`, `SKILL.md`, and new positioning spec/plan files.

### Task 1: Add the canonical positioning document

**Files:**
- Create: `docs/superpowers/specs/2026-08-28-skill-first-positioning-design.md`

- [x] State the Skill-first positioning and one-sentence promise.
- [x] Define Skill, Feed Pipeline, Delivery Runtime, and Local User State boundaries.
- [x] Define the DeepSeek Harness information-center plugin as an optional projection over the same Core/Contract.
- [x] Distinguish the seven-category source taxonomy from the six currently generated live feeds.
- [x] Define Follow-up's relationship with LifeSub, Malow, and GoldenWave.
- [x] Add knowledge inflation guardrails and current-versus-future capability truth.

## Chunk 2: Public Positioning

### Task 2: Update the Chinese README

**Files:**
- Modify: `README.zh-CN.md`

- [x] Replace “知识策展系统” with “信息信号与注意力策展系统”.
- [x] Explain that Skill is the product entry, not the entire runtime.
- [x] Describe the plugin-enhanced information center as a future capability, not a current implementation.
- [x] Add the six responsibility elements: Skill, future plugin projection, Core/Contract, Feed Pipeline, Delivery Runtime, and Local User State.
- [x] Add the personal AI system relationship.
- [x] State that digests are Signals and do not automatically enter GoldenWave.

### Task 3: Update the English README

**Files:**
- Modify: `README.md`

- [x] Mirror the Chinese positioning and boundaries.
- [x] Link the canonical positioning document.
- [x] Preserve the seven-category source strategy while marking industry reports and enforced per-user channel switches as not yet implemented.

## Chunk 3: Agent-facing Contract

### Task 4: Update the Skill instructions

**Files:**
- Modify: `SKILL.md`

- [x] Make the description discriminating for signal and attention curation.
- [x] Add Signal-versus-Knowledge semantics.
- [x] Preserve Skill portability when the DeepSeek Harness plugin is unavailable.
- [x] Prevent direct formal knowledge writes and unsupported handoff claims.
- [x] Make the no-authoritative-write rule permanent: future contracts emit proposals only.
- [x] Require separate authorization for scheduling, credentials, external delivery, and cross-project writes.
- [x] Preserve existing deterministic preparation and delivery workflow.

## Chunk 4: Verification

### Task 5: Verify documentation consistency

**Files:**
- Verify: `README.zh-CN.md`
- Verify: `README.md`
- Verify: `SKILL.md`
- Verify: `docs/superpowers/specs/2026-08-28-skill-first-positioning-design.md`

- [x] Run `git diff --check`.
- [x] Search for obsolete top-level claims that call Follow-up a knowledge authority.
- [x] Confirm current runtime behavior is not presented as future Handoff functionality.
- [x] Verify each “current capability” claim against `.github/workflows/generate-feed.yml`, `scripts/generate-feed.js`, `scripts/prepare-digest.js`, `scripts/deliver.js`, and `config/config-schema.json`.
- [x] Confirm the DeepSeek Harness plugin is consistently described as a future projection over shared Core/Contract state.
- [x] Confirm Handoff lifecycle wording is `user action → proposal → downstream decision`, never direct authoritative write.
- [x] Compare the path-scoped documentation diff against the recorded dirty-worktree baseline; do not interpret pre-existing script, configuration, Feed, or workflow modifications as changes from this task.
