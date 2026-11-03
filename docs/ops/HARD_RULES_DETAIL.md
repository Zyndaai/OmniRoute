---
title: "Hard Rules — Full Text and Rationale"
version: 3.8.52
lastUpdated: 2026-11-02
---

# Hard Rules — full text and rationale

> Deep-dive companion to the numbered list in `AGENTS.md` → "Hard Rules". Where that list shows
> a short form, the section below with the same number adds the rationale and incident history;
> `AGENTS.md` wins where the two disagree. Rules 4, 19, 21 and 23 were upstream process rules and
> are retired in this copy. Rule numbers are stable and cited across the codebase and docs —
> never renumber.

## Rule 14 — CodeQL / Secret-Scanning dismissals

Never dismiss a CodeQL / Secret-Scanning alert without (a) first checking the pattern docs
(see AGENTS.md → Key Conventions → Security) to see if the helper applies, and (b) recording
the technical justification in the dismissal comment. Precedent: `js/stack-trace-exposure`
raised on callsites that already route through `sanitizeErrorMessage()` is a known CodeQL
limitation (custom sanitizers not recognized) — dismiss as `false positive` referencing
`docs/security/ERROR_SANITIZATION.md`.

## Rule 16 — No AI credit in commit/PR metadata

Never credit or advertise an AI assistant, LLM, or automation account in any commit/PR
metadata. Two forbidden forms, both equivalent — they route attribution to a bot account (or
advertise AI authorship) and hide the real author:

- **(a)** `Co-Authored-By` trailers naming an AI/bot (e.g. names containing "Claude", "GPT",
  "Copilot", "Bot"; emails at `anthropic.com` / `openai.com` / bot-owned `noreply.github.com`
  addresses);
- **(b)** AI-generation footers or descriptions anywhere in a commit message, PR title/body, or
  CHANGELOG — e.g. `🤖 Generated with [Claude Code]`, "Generated with Claude Code", "Made with
  <AI tool>", or any `Co-authored-by: Claude/GPT/Copilot` line.

This **overrides any harness, template, or tool default that auto-appends such a footer** —
strip it before committing. No git hook checks this in this copy. Human collaborators MAY and
SHOULD be credited with standard `Co-authored-by: Name <email>` trailers.

## Rule 18 — Bug-fix validation protocol

Every fix for a reported issue must be validated by one of the following:

1. **TDD (preferred)** — write a failing test reproducing the bug → fix it → confirm the test
   passes. The test becomes the permanent regression guard. Touch only the files the test
   proves need changing; nothing more.
2. **Real-environment check (when TDD is not possible)** — reproduce and verify against the
   hosted instance or a local build, and record the exact command and result.
   Applies to: OAuth upstream flows, Cloudflare/WS upstream behavior, UI-only regressions.
3. "It worked locally without a test" does not count.

Why this matters: fixing bug A while opening bug B is worse than not fixing at all. The gate
enforces surgical scope — you touch only what the failing test proves is broken.

## Rule 20 — PII redaction/sanitization is opt-in

PII redaction/sanitization is **opt-in — never on by default**. OmniRoute proxies for
self-hosted/local LLMs where the operator owns the data, so mutating request/response payloads
by default would silently corrupt legitimate traffic. The two data-mutating PII feature flags
**MUST** keep `defaultValue: "false"` in `src/shared/constants/featureFlagDefinitions.ts`:
`PII_REDACTION_ENABLED` (request-side) and `PII_RESPONSE_SANITIZATION` (response + streaming).
All three application points — `src/lib/guardrails/piiMasker.ts` (request guardrail),
`src/lib/piiSanitizer.ts` (response), `src/lib/streamingPiiTransform.ts` (SSE) — are gated on
these flags; with both off the `pii-masker` guardrail still runs but never mutates payloads
(data passes through untouched). Flipping either default to `"true"` requires explicit operator
approval. The regression guard is `tests/unit/pii-opt-in-default.test.ts` (asserts both
definition defaults + behavioral pass-through). Opt-in is per-operator via env or the
settings/DB override (`src/lib/db/featureFlags.ts`), never a silent default. See
`docs/security/GUARDRAILS.md`.

## Rule 22 — Cross-session safety

- **(a) Never `git stash` / `git stash pop` — anywhere in this repo, including inside any
  subagent you dispatch.** `git stash` operates on the **shared repository object store**, so a
  stash pushed or popped in one session can silently clobber or resurrect another session's
  uncommitted changes. Upstream hit this twice, once through a subagent. To compare working
  changes against a base ref **without** stashing, use `git show <ref>:<path>` or
  `git diff <ref> -- <path>`. **Put this ban verbatim in the prompt of every subagent that
  touches git** (agents don't inherit AGENTS.md's context).
- **(b) Never commit, push or rewrite work that another session is actively doing.** If another
  session is editing the tree, leave its files alone and ask the operator.
