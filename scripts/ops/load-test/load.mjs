#!/usr/bin/env node
/**
 * Mixed-load test for a hosted OmniRoute: an open-loop stream of synthetic
 * requests to a mock model, and a few real-model probes in every stage, through
 * the same public endpoint. The headline is how the probes' time to first token
 * moves as the synthetic load grows.
 *
 *   node scripts/ops/load-test/load.mjs --keys-file .env.loadtest \
 *     --stages 0@120,5@180,10@180,25@180,0@120 --probes 20 --out _artifacts/loadtest
 *
 * Stages are `rps@seconds`; rps 0 is a no-load phase (baseline or recovery).
 * The keys file holds LOADTEST_MOCK_KEY (an OmniRoute key allowed only the mock
 * model) and LOADTEST_PROBE_KEY (one allowed only the probe model).
 *
 * `--probe-extra-json` is merged into every probe body. The default turns thinking
 * off, because a Claude Code login thinks unless told not to, which makes the
 * probes' time to first token vary for reasons that have nothing to do with load.
 * Pass '{}' for a probe model that rejects the field. Runbook: docs/ops/LOAD_TESTING.md.
 *
 * Stops the run, rather than going on, when a synthetic request is answered by
 * anything but the mock provider, a probe is answered by the mock, two probes in
 * a stage fail, or most synthetic requests in a stage fail. Every request is
 * written to raw/*.jsonl; summary.json and the printed table are per stage.
 */

import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((arg, i, all) => (arg.startsWith("--") ? [arg.slice(2), all[i + 1]] : null))
    .filter(Boolean)
);
const base = (args.base || "https://omniport.ink").replace(/\/+$/, "");
const mockModel = args["mock-model"] || "stressmock/mock-model";
const probeModel = args["probe-model"] || "cc/claude-haiku-5-5";
const mockProviderMatch = args["mock-provider"] || "openai-compatible-chat-";
const probesPerStage = Number(args.probes || 20);
const maxProbes = Number(args["max-probes"] || 160);
const maxInflight = Number(args["max-inflight"] || 600);
const timeoutMs = Number(args["timeout-ms"] || 60_000);
const probeExtra = JSON.parse(args["probe-extra-json"] || '{"thinking":{"type":"disabled"}}');
const stages = (args.stages || "0@60,5@60,0@60").split(",").map((spec, index, all) => {
  const [rps, seconds] = spec.split("@").map(Number);
  const name = rps > 0 ? `s${rps}` : index === 0 ? "baseline" : index === all.length - 1 ? "recovery" : `idle${index}`;
  return { name, rps, ms: seconds * 1000 };
});

const keys = Object.fromEntries(
  readFileSync(args["keys-file"] || ".env.loadtest", "utf8")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2].replace(/^["']|["']$/g, "")])
);
if (!keys.LOADTEST_MOCK_KEY || !keys.LOADTEST_PROBE_KEY) {
  throw new Error("keys file needs LOADTEST_MOCK_KEY and LOADTEST_PROBE_KEY");
}

const runId = `loadtest-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
const outDir = path.join(args.out || "_artifacts/loadtest", runId);
mkdirSync(path.join(outDir, "raw"), { recursive: true });
const syntheticLog = createWriteStream(path.join(outDir, "raw", "synthetic.jsonl"));
const probeLog = createWriteStream(path.join(outDir, "raw", "probes.jsonl"));

const runStart = Date.now();
let stopReason = null;
let inflight = 0;
let probesSent = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One streamed completion: status, served-by headers, time to first content and to the end. */
async function call({ key, model, maxTokens, prompt, extra = {} }) {
  const started = performance.now();
  const row = { status: 0, ttft: null, total: null, done: false, provider: null, model: null, error: null };
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "x-omniroute-no-cache": "true",
      },
      body: JSON.stringify({
        ...extra,
        model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    row.status = response.status;
    row.provider = response.headers.get("x-omniroute-provider");
    row.model = response.headers.get("x-omniroute-model");
    const decoder = new TextDecoder();
    let text = "";
    for await (const part of response.body) {
      const piece = decoder.decode(part, { stream: true });
      text += piece;
      if (row.ttft === null && /"content":"[^"]/.test(text)) row.ttft = Math.round(performance.now() - started);
    }
    row.done = text.includes("[DONE]");
    const usage = text.match(/"usage":(\{[^}]*\})/);
    if (usage) row.usage = JSON.parse(usage[1]);
  } catch (error) {
    row.error = error?.name === "TimeoutError" ? "timeout" : String(error?.message ?? error).slice(0, 120);
  }
  row.total = Math.round(performance.now() - started);
  row.ok = row.status === 200 && row.done && !row.error;
  return row;
}

function stop(reason) {
  if (!stopReason) {
    stopReason = reason;
    console.log(`\n[STOP] ${reason}`);
  }
}

async function synthetic(stage, stats) {
  if (inflight >= maxInflight) {
    stats.dropped++;
    return;
  }
  inflight++;
  stats.launched++;
  const t = Date.now() - runStart;
  const row = await call({ key: keys.LOADTEST_MOCK_KEY, model: mockModel, maxTokens: 64, prompt: "load test" });
  inflight--;
  syntheticLog.write(`${JSON.stringify({ stage: stage.name, t, ...row })}\n`);
  stats.rows.push(row);
  if (row.provider && !row.provider.startsWith(mockProviderMatch)) {
    stop(`synthetic request served by ${row.provider}, not the mock`);
  }
  const failed = stats.rows.filter((r) => !r.ok).length;
  if (failed >= 20 && failed > stats.rows.length / 2) stop(`${stage.name}: ${failed} of ${stats.rows.length} synthetic requests failed`);
}

async function probe(stage, stats) {
  if (probesSent >= maxProbes) return;
  probesSent++;
  const t = Date.now() - runStart;
  const row = await call({
    key: keys.LOADTEST_PROBE_KEY,
    model: probeModel,
    maxTokens: 32,
    prompt: "Reply with the single word: ok",
    extra: probeExtra,
  });
  probeLog.write(`${JSON.stringify({ stage: stage.name, t, ...row })}\n`);
  stats.probes.push(row);
  if (row.provider?.startsWith(mockProviderMatch)) stop(`probe served by the mock (${row.provider})`);
  if (stats.probes.filter((r) => !r.ok).length >= 2) stop(`${stage.name}: two probes failed`);
}

async function runStage(stage) {
  const stats = { launched: 0, dropped: 0, rows: [], probes: [] };
  const started = Date.now();
  const pending = [];
  const probeAt = Array.from({ length: probesPerStage }, (_, i) => ((i + 0.5) * stage.ms) / probesPerStage);
  let nextProbe = 0;
  let launched = 0;
  console.log(`[${stage.name}] ${stage.rps} rps for ${stage.ms / 1000}s`);
  while (!stopReason) {
    const elapsed = Date.now() - started;
    if (elapsed >= stage.ms) break;
    const due = stage.rps > 0 ? Math.floor((elapsed / 1000) * stage.rps) + 1 : 0;
    for (; launched < due; launched++) pending.push(synthetic(stage, stats));
    while (nextProbe < probeAt.length && probeAt[nextProbe] <= elapsed) {
      pending.push(probe(stage, stats));
      nextProbe++;
    }
    await sleep(5);
  }
  await Promise.all(pending);
  return { stage, stats, seconds: (Date.now() - started) / 1000 };
}

const pct = (values, p) => {
  const sorted = values.filter((v) => typeof v === "number").sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};

function summarize({ stage, stats, seconds }) {
  const ok = stats.rows.filter((r) => r.ok);
  const statuses = {};
  for (const r of stats.rows) {
    const key = r.error ? r.error : String(r.status);
    statuses[key] = (statuses[key] || 0) + 1;
  }
  return {
    stage: stage.name,
    offered_rps: stage.rps,
    seconds: Math.round(seconds),
    synthetic: {
      launched: stats.launched,
      dropped: stats.dropped,
      ok: ok.length,
      // Requests launched in the stage over the stage's length, not the time spent waiting for the last answers.
      achieved_rps: Number((ok.length / (stage.ms / 1000)).toFixed(2)),
      statuses,
      ttft_p50: pct(ok.map((r) => r.ttft), 50),
      ttft_p95: pct(ok.map((r) => r.ttft), 95),
      total_p50: pct(ok.map((r) => r.total), 50),
      total_p95: pct(ok.map((r) => r.total), 95),
      total_max: pct(ok.map((r) => r.total), 100),
    },
    probes: {
      n: stats.probes.length,
      ok: stats.probes.filter((r) => r.ok).length,
      ttft_p50: pct(stats.probes.map((r) => r.ttft), 50),
      ttft_p95: pct(stats.probes.map((r) => r.ttft), 95),
      ttft_max: pct(stats.probes.map((r) => r.ttft), 100),
      total_p95: pct(stats.probes.map((r) => r.total), 95),
      providers: [...new Set(stats.probes.map((r) => r.provider))],
    },
  };
}

const results = [];
for (const stage of stages) {
  if (stopReason) break;
  const summary = summarize(await runStage(stage));
  results.push(summary);
  const s = summary.synthetic;
  const p = summary.probes;
  console.log(
    `  synthetic ${s.ok}/${s.launched} ok (${s.achieved_rps}/s, dropped ${s.dropped}) total p50/p95 ${s.total_p50}/${s.total_p95} ms ${JSON.stringify(s.statuses)}\n` +
      `  probes ${p.ok}/${p.n} ok, ttft p50/p95/max ${p.ttft_p50}/${p.ttft_p95}/${p.ttft_max} ms`
  );
}

syntheticLog.end();
probeLog.end();
writeFileSync(
  path.join(outDir, "summary.json"),
  JSON.stringify({ runId, base, mockModel, probeModel, startedAt: new Date(runStart).toISOString(), stopReason, stages: results }, null, 2)
);
console.log(`\n${runId}: ${stopReason ? `stopped (${stopReason})` : "completed"}; results in ${outDir}`);
