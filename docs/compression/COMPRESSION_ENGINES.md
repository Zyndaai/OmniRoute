---
title: "Compression Engines"
version: 3.8.40
lastUpdated: 2026-06-28
---

# Compression Engines

OmniRoute compression is built around engine contracts. A mode can run one engine directly
(`caveman` or `rtk`) or a deterministic stacked pipeline that executes multiple engines in order.

## Modes

| Mode         | Engine path                                                                           | Intended input                               |
| ------------ | ------------------------------------------------------------------------------------- | -------------------------------------------- |
| `off`        | none                                                                                  | Exact prompt preservation                    |
| `lite`       | Caveman lite helpers                                                                  | Low-risk always-on cleanup                   |
| `standard`   | Caveman                                                                               | Natural-language prompt condensation         |
| `aggressive` | Caveman + history/tool summarizers                                                    | Long chat sessions                           |
| `ultra`      | Caveman + pruning helpers                                                             | Context-limit recovery                       |
| `rtk`        | RTK                                                                                   | Terminal, shell, build, test, and git output |
| `omniglyph`  | OmniGlyph                                                                             | Context-as-image on the native provider wire |
| `stacked`    | Pipeline. The request default is `session-dedup -> lite`. `rtk -> caveman` is opt-in. | Mixed tool logs and prose, max savings       |

### OmniGlyph compression profiles

The `omniglyph` engine (package `omniglyph`, 1.4.0+) accepts a named semantic profile, set
globally through `omniglyph.profile` in the compression settings or per step through the
stacked pipeline's step config:

| Profile       | Boundary                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `aggressive`  | Default. The policy the published receipts measured — images system, tool docs and dense history |
| `balanced`    | Keeps live state native, protects the last 8 turns, collapses older closed history               |
| `coding-safe` | Keeps authority, tool schemas and live tool output native, protects the last 12 turns            |
| `passthrough` | Routes without transforming; the engine is skipped                                               |

The profile is a **ceiling, not a floor**: `mergeCompressionProfileOptions` in the package
refuses to let a caller override reopen a lossy lane the profile closed, so a per-step
`preserveSystemPrompt: false` cannot re-enable system compression under `coding-safe`.

Measured on this codebase: `coding-safe` and `balanced` raise `minCompressChars` to its
maximum and keep system, tool schemas and tool results native, so a session that has not
accumulated history yet stops at `below_min_chars` and the engine transforms nothing. That
is why the default is `aggressive` rather than the safest profile.

The package resolves its own model scope and profile from its environment configuration.
OmniRoute never delegates the decision: the adapter pins the model gate to the package's
most restrictive scope, so host environment settings can only narrow the allowlist, never
widen it past OmniRoute's measured receipts.

## Engine Registry

The registry lives in `open-sse/services/compression/engines/registry.ts`. Engines expose a shared
contract:

- `id`: stable engine id such as `caveman` or `rtk`
- `apply(text, config)`: legacy execution path used by stacked pipelines
- `compress(input, config)`: primary execution path returning text + stats
- `getConfigSchema()`: returns the JSON-Schema-like shape of valid config
- `validateConfig(config)`: returns `{ valid, errors[] }`

Registration uses `registerCompressionEngine(engine)` (or `registerEngine` for advanced cases),
which calls `assertValidEngine()` and `validateConfig(defaultConfig)` before accepting.
Use `unregisterCompressionEngine(id)` to remove an engine at runtime.

`strategySelector.ts` registers the built-in engines before compression runs. This lets preview,
runtime compression, stacked mode, tests, and future engines use the same execution path.

### MCP description compression (related)

A separate registry compresses MCP tool description metadata at registry-level — see
`open-sse/mcp-server/descriptionCompressor.ts` and [MCP-SERVER.md](../frameworks/MCP-SERVER.md). It reuses
Caveman rules but operates on tool metadata, not request payloads.

### Additional built-in engines

Beyond Caveman and RTK, the registry ships several specialized lossless /
structural engines (used by stacked pipelines, the playground, and tests):

| Engine        | Id              | What it does                                                                                                                                                               |
| ------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CCR           | `ccr`           | Content-Compress-Retrieve (H4): replaces large contiguous text blocks with content-addressed references, so repeated/large blocks are sent once and referenced thereafter. |
| headroom      | `headroom`      | SmartCrusher (H3 + N5): lossless tabular compaction of homogeneous JSON-array payloads into a columnar `[N rows]` form.                                                    |
| ionizer       | `ionizer`       | Head/middle/tail row sampling for very large homogeneous blocks, storing the elided middle as a CCR content-addressed reference.                                           |
| session-dedup | `session-dedup` | Content-addressed cross-turn deduplication (TokenMizer-inspired): elides text already seen in earlier turns of the same session.                                           |

**CCR retrieve-protocol instruction (#8033):** the first time CCR replaces ≥1 block in a
request, the engine prepends a single, idempotent `system` message (leading with the
`[CCR protocol]` sentinel) teaching the caller the marker → tool contract: what a
`[CCR retrieve hash=<24hex> chars=N]` marker means, that the hash must be copied verbatim
(all 24 hex characters — mis-copied hashes are the likely cause of "block not found"
misses), and that a `[dedup:ref sha=...]` marker means "look back in history", not "call the
tool". The note is injected **only when the caller's advertised `tools[]` proves it can
actually reach `omniroute_ccr_retrieve`** (`callerSupportsCcrRetrieve()` in
`open-sse/services/compression/engines/ccr/protocolInstruction.ts`) — a plain
OpenAI-compatible caller without that tool never receives an instruction to call something
it cannot reach. Idempotency is enforced by scanning the message history for the sentinel
before injecting, so multi-turn requests (which replay prior messages) do not stack the
note once per turn.

## Caveman

Caveman mode focuses on semantic condensation of normal prose:

- preserves code blocks, URLs, JSON, paths, and structured data
- removes filler, hedging, repeated context, and verbose connective phrasing
- supports language-aware file rule packs in `open-sse/services/compression/rules/`
- remains available through the legacy `standard`, `aggressive`, and `ultra` modes

The dashboard surface is `Dashboard -> Context & Cache -> Caveman`.

Caveman upstream reports `~75%` fewer output tokens, `65%` average output savings in benchmarks
with a `22-87%` range, and a `~46%` input-compression tool. OmniRoute uses the Caveman input-side
number when documenting stacked prompt/context savings; Caveman output mode remains a separate
response-behavior feature.

## RTK

RTK mode focuses on command and tool output:

- detects output classes such as `git status`, `git branch`, `git diff`, Vitest/Jest/Pytest,
  Cargo/Go tests, TypeScript/Vite/Webpack builds, ESLint, npm audit/installs, Docker logs,
  shell `find`/`grep`, stack traces, and generic logs
- applies 49 JSON filters from `open-sse/services/compression/engines/rtk/filters/`
- supports the RTK-style declarative pipeline: ANSI stripping, replace, match-output short-circuit,
  strip/keep lines, per-line truncation, head/tail/max-line truncation, and on-empty fallback
- supports trust-gated project filters in `.rtk/filters.json` and global filters in
  `DATA_DIR/rtk/filters.json`
- strips ANSI sequences, progress noise, repeated lines, and unhelpful boilerplate
- preserves actionable failures, warnings, summaries, changed files, and tail context
- can optionally retain redacted raw output for recovery/debugging through authenticated management
  routes

The dashboard surface is `Dashboard -> Context & Cache -> RTK`.

Operational details for custom filters, trust, verify, and raw-output recovery live in
[`RTK_COMPRESSION.md`](./RTK_COMPRESSION.md).

RTK upstream reports `60-90%` savings for command-output compression. Its README example shows a
30-minute Claude Code session going from `~118,000` tokens to `~23,900`, or `79.7%` saved.

## Stacked Pipelines

Stacked mode runs pipeline steps in order. The default is:

```txt
rtk -> caveman
```

Use this for coding-agent sessions where a prompt combines command output with human or assistant
prose. RTK reduces noisy tool logs first, then Caveman compresses remaining natural language.

Pipeline steps are configured with `stackedPipeline` in compression settings or through compression
combos.

When both engines reduce the same eligible payload, savings compound:

```txt
combined = 1 - (1 - RTK savings) * (1 - Caveman input savings)
average  = 1 - (1 - 0.80) * (1 - 0.46) = 89.2%
range    = 1 - (1 - 0.60..0.90) * (1 - 0.46) = 78.4-94.6%
```

## MCP Accessibility Tree Filter

The MCP accessibility-tree smart filter is a post-execution compression layer that runs on MCP
**tool results**, not on prompts or context. It targets the verbose accessibility-tree and browser
snapshot payloads returned by tools like Playwright, computer-use, and browser-automation MCP
servers.

### What it does

1. **Noise stripping** — removes empty generic/text entries (`- generic:`, `- text: ""`)
2. **Sibling collapse** — when ≥ `collapseThreshold` (default 30) consecutive lines are structural
   repeats, collapses them into the first `collapseKeepHead` (default 10) lines + a count summary +
   the last `collapseKeepTail` (default 5) lines
3. **Ref preservation** — `[ref=eXX]` anchors required by Playwright/computer-use are never touched
4. **Hard truncation** — if the text after collapse still exceeds `maxTextChars` (default 50,000),
   truncates with a navigation hint so the agent can continue working

### Engine location

```txt
open-sse/services/compression/engines/mcpAccessibility/
  index.ts            ← smartFilterText() entry point
  collapseRepeated.ts ← sibling-collapse algorithm
  constants.ts        ← DEFAULT_MCP_ACCESSIBILITY_CONFIG
```

### Configuration

Controlled by `compression.mcpAccessibility` in global settings (migration 056). Default config:

```json
{
  "enabled": true,
  "maxTextChars": 50000,
  "collapseThreshold": 30,
  "collapseKeepHead": 10,
  "collapseKeepTail": 5,
  "minLengthToProcess": 2000
}
```

The filter is only applied to tool-result payloads whose `type` is `"text"` and whose length
exceeds `minLengthToProcess`. It does not affect prompt compression or request payloads.

### Expected savings

60–80% on browser snapshot tool results, depending on page complexity. The collapse algorithm
is O(n) in line count and adds negligible latency.

### This filter vs the compression engines above

| Aspect      | Caveman / RTK / Stacked   | MCP accessibility filter               |
| ----------- | ------------------------- | -------------------------------------- |
| Target      | Request prompts / context | MCP tool results                       |
| Trigger     | Compression mode setting  | `compression.mcpAccessibility.enabled` |
| Scope       | All SSE messages          | Tool results only                      |
| Ref anchors | N/A                       | Preserved unconditionally              |

---

## Compression Combos

Compression combos are named compression profiles that can be assigned to routing combos:

- `compression_combos`: stores mode, pipeline, RTK config, language config, and default marker
- `compression_combo_assignments`: maps a compression combo to a routing combo
- runtime integration resolves an assigned compression combo before generic combo overrides
- analytics include `compression_combo_id` and `engine`

Dashboard surface: `Dashboard -> Context & Cache -> Compression Combos`.

## API Surface

| Route                                  | Purpose                                                          |
| -------------------------------------- | ---------------------------------------------------------------- |
| `/api/settings/compression`            | Global compression settings (includes `mcpAccessibility` config) |
| `/api/compression/preview`             | Preview any compression mode                                     |
| `/api/compression/language-packs`      | List available Caveman language packs                            |
| `/api/context/caveman/config`          | Caveman settings alias                                           |
| `/api/context/rtk/config`              | RTK defaults and settings                                        |
| `/api/context/rtk/filters`             | RTK filter catalog                                               |
| `/api/context/rtk/test`                | RTK preview/test endpoint                                        |
| `/api/context/rtk/raw-output/[id]`     | Authenticated redacted raw-output recovery                       |
| `/api/context/combos`                  | Compression combo CRUD                                           |
| `/api/context/combos/[id]/assignments` | Routing-combo assignment CRUD                                    |
| `/api/context/analytics`               | Compression analytics alias                                      |

Management routes require management authentication or API-key policy checks.

## MCP Tools

Compression exposes five MCP tools:

| Tool                                | Scope               | Purpose                          |
| ----------------------------------- | ------------------- | -------------------------------- |
| `omniroute_compression_status`      | `read:compression`  | Settings, analytics, cache stats |
| `omniroute_compression_configure`   | `write:compression` | Update global settings           |
| `omniroute_set_compression_engine`  | `write:compression` | Set mode and optional pipeline   |
| `omniroute_list_compression_combos` | `read:compression`  | List compression combos          |
| `omniroute_compression_combo_stats` | `read:compression`  | Read combo/engine analytics      |

## Scope & exclusions

**Embeddings are never compressed.** `open-sse/handlers/embeddings.ts` never calls any
compression engine — the request/response bodies pass straight to the executor untouched.
This is structural today (embeddings and chat completions are disjoint handlers), not a
runtime check, but it means the vector-distortion concern in #8034 has no exposure surface
in the embeddings path.

**Per-model/endpoint exclusion filter (#8034).** For chat completions, an operator can name
model ids / `provider/model` targets that must never be compressed — a guardrail useful if
compression is ever wired closer to an embeddings-adjacent path later, and generally useful
for any model whose exact byte-for-byte prompt matters (deterministic evals, cache-sensitive
prefixes, etc.).

- Settings field: `exclusions?: string[]` on the global compression config
  (`GET`/`PUT /api/settings/compression`), persisted via the existing `key_value` compression
  namespace (`src/lib/db/compression.ts`) — no new table.
- Dashboard tab: **Dashboard → Compression → Exclusions**
  (`/dashboard/compression/exclusions`).
- Pattern syntax: `*` is the only wildcard. Every other regex metacharacter in a pattern is
  escaped before matching, so `gpt-5.6` matches the literal string only, never `gpt-5x6`
  (ReDoS-safe, bounded, no nested quantifiers). Patterns match case-insensitively against
  both the bare model id and the `provider/model` composite — `gpt-5-6`, `openai/gpt-5-6`,
  and `openai/*` all work, and `*` alone excludes every model.
- Matching: `isCompressionExcluded()` / `normalizeCompressionExclusions()` in
  `open-sse/services/compression/exclusions.ts`. `chatCore.ts` checks the excluded target
  right after resolving compression settings, **before any engine runs**, and treats a match
  exactly like compression being globally disabled — the request body is provably
  byte-identical. The skip is recorded via `writeCompressionSkip(..., "excluded")` for
  analytics visibility.
- Default (empty/absent list): identical to pre-#8034 behavior — nothing is excluded.

## Known limitations

- **Caveman language packs `de` / `fr` / `ja` are partial.** They ship `context` +
  `filler` + `structural` rules but no `dedup` / `ultra` packs, so `ultra` intensity is
  no stronger than `full` for those languages (they use only their own rules — there is no
  silent fall-back to the English `dedup`/`ultra` rules, which would mangle foreign text).
  `en` / `es` / `id` / `pt-BR` are complete. Contributions of `dedup.json` + `ultra.json`
  for the partial packs are welcome.
- **Stacked telemetry only lists engines that compressed.** A stacked-pipeline step whose
  engine ran but produced 0 % savings returns `stats:null` and so does not appear in
  `engineBreakdown` — indistinguishable from a step that was skipped. Distinguishing
  "ran, 0 %" from "skipped" would require a breakdown-model change and is deferred.

## Validation

The focused gates for this area are:

```bash
node --import tsx/esm --test tests/unit/compression/rtk-*.test.ts tests/unit/compression/pipeline-integration.test.ts tests/unit/compression/context-compression-api.test.ts
node --import tsx/esm --test tests/unit/compression/*.test.ts tests/golden-set/*.test.ts tests/integration/compression-pipeline.test.ts tests/unit/api/compression/compression-api.test.ts
node --import tsx/esm --test tests/unit/compression/mcpAccessibility*.test.ts
npm run typecheck:core
```
