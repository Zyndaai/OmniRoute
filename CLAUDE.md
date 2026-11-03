# CLAUDE.md

@AGENTS.md

**All project rules live in [`AGENTS.md`](AGENTS.md)** — the single source of truth for every AI
assistant (architecture, conventions, testing, git workflow, the Hard Rules, PII learnings). Read
it in full; do not re-add project rules here. Everything below applies ONLY to Claude Code.

## Git — Claude Code specifics

- Work on `main` in the main checkout. Do not create a worktree (`EnterWorktree` or
  `git worktree add`) unless the operator asks for one.
- **Replicate the `git stash` ban verbatim in the prompt of every subagent that touches git**
  (Agent tool / Workflow scripts) — subagents do not inherit this file.
- Strip any harness-appended `Co-Authored-By` trailer or "Generated with Claude Code" footer
  before committing (Hard Rule #16).

## Operator key — Claude Code specifics

When `.env.operator` is missing or its key is rejected (AGENTS.md → "Managing a hosted
instance"), start `scripts/ops/set-operator-key.ps1` in the operator's Terminal panel
(`run_in_terminal`) so they paste the key there, not in chat. Read the key only by sourcing
`.env.operator` in a Bash call; never `cat`, `echo` or otherwise print it.

## Scratch / temporary files — use `_artifacts/`

Write temporary files (exports, generated zips, one-off intermediate outputs) to `_artifacts/` at
the repository root instead of a system temp directory. It is a root `_*` path: gitignored, on
disk only, never tracked, and easy for the operator to find and delete in one place.
