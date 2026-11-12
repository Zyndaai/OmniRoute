---
title: "Load testing and profiling the hosted instance"
version: 3.8.53
lastUpdated: 2026-11-12
---

# Load testing and profiling the hosted instance

How to measure what the hosted instance (omniport.ink) can carry without hurting real
requests, and how to see where its CPU goes. A run sends synthetic streaming traffic to a mock
provider through the public endpoint while a few real-model probes measure what users would
feel. The scripts are in `scripts/ops/load-test/`. Every step that changes the server or the
instance needs the operator's go-ahead first (see AGENTS.md, "Managing a hosted instance").

## What we know so far

As of 2026-11-12, on the 6-vCPU VPS with ~2.4 s mock answers:

- **One OmniRoute process carries about 20–25 streaming requests a second.** Clean up to 10
  RPS. At 25 RPS the process used a full core (103–109%), the Docker healthcheck (5 s timeout)
  failed, and the probes' first token went from ~1.6 s to ~8.2 s, while the host stayed at 23%
  CPU. It recovered within a minute, with no leak. Longer real answers mean more chunks per
  request, so a real ceiling is lower.
- **At 10 RPS about half the samples were idle.** Of the rest: conversation tracking ~5%
  (since turned off on the instance), `getGlobalModel` registry scans ~3–4% and gamification
  ~1.7% (both removed from the code); nearly everything else is passing and translating stream
  chunks.
- **More cores means more processes,** each with its own data folder and its own share of the
  provider accounts: [Docker guide](../guides/DOCKER_GUIDE.md#scale-out-n-independent-processes).

## Before a run

1. **Record the deployed image digest and health** (`/api/health`, the Grafana dashboards).
2. **Make two scoped API keys** on the instance: one whose model access is only the mock model
   (`stressmock/mock-model`), one whose model access is only the probe model
   (`cc/claude-haiku-5-5`). Check each key is refused (403) on the other's model. Put them in a
   git-ignored keys file as `LOADTEST_MOCK_KEY` and `LOADTEST_PROBE_KEY`.
3. **Point the mock's provider connection at the mock.** The instance has an OpenAI-compatible
   connection, `stressmock-test` (prefix `stressmock`). Its node update needs `name`, `prefix`
   and `apiType` alongside the new base URL, and its API key must match the mock's key file.
   The mock key and the OmniRoute client keys are different credentials.
4. **Budget the probes.** They spend real subscription quota. 20 probes per stage over 5–6
   stages is about 120; check the probe account's weekly use first.
5. **Agree the stages, the stop rules and the window** with the operator. The defaults below
   start at no load, rise through 5, 10 and 25 RPS, and end with a recovery stage.

## Where the mock runs

No tunnel service may sit between OmniRoute and the mock: on 10 Nov a Cloudflare tunnel lost
answers at 10 RPS (the mock answered every request at ~2.4 s, OmniRoute logged 499s with no
first byte), so the run measured the tunnel.

| Placement | Base URL | Trade-off | Status |
|---|---|---|---|
| Container on `omniroute_default` | `http://mock-provider:8080/v1` | No extra hop. The server operator starts the container (command in `mock-provider.mjs`) and removes it after. | Preferred. Not tried live yet. |
| Off the server, through an SSH reverse tunnel | `http://<server public IP>:18081/v1` | Adds ~380 ms round trip to every mock call. Needs `GatewayPorts clientspecified` in sshd and a UFW rule letting only `172.18.0.0/16` reach the port; both reverted after. | Used on 12 Nov. |

The provider-URL guard allows private and Docker-network addresses on this instance:
`OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS` is on by default, which blocks only cloud-metadata
addresses (read from `/api/settings/feature-flags` after the 12 Nov run). That run went through the
public IP out of caution, not because a private URL was refused. A port that Docker publishes
skips UFW rules, so never publish the mock's port to reach it from outside.

## Running it

```bash
# where the mock runs (see above)
MOCK_API_KEY_FILE=keys/mock.key node scripts/ops/load-test/mock-provider.mjs

# from any machine that reaches omniport.ink
node scripts/ops/load-test/load.mjs --keys-file .env.loadtest \
  --stages 0@120,5@180,10@180,25@180,0@120 --probes 20 --out _artifacts/loadtest
```

`load.mjs` sends requests at a fixed rate whatever the answers do, sends the probes evenly
through each stage, writes every request to `raw/*.jsonl` and prints a table per stage. It
stops by itself when a synthetic request is served by anything but the mock, a probe is served
by the mock, two probes in a stage fail, or most synthetic requests in a stage fail. Probes go
out with thinking turned off (`--probe-extra-json`), because a Claude Code login thinks unless
told not to, which makes first-token times vary for reasons unrelated to load.

While it runs, watch the container (`docker stats`, `docker inspect` health), the host
(Grafana's Node Exporter dashboard), the mock's `/metrics` counters, and Caddy's request rate.
Stop by hand on any restart or out-of-memory event, a probe answered by the wrong provider,
unexpected 401/403/429 from the mock, or the probe account nearing its quota.

## Reading the results

- **With 20 samples, a "p95" is the largest value.** Report p50 and max per stage, or repeat
  stages for more probes.
- **Separate OmniRoute's wait from the provider's.** The call log (`/api/usage/call-logs`)
  records each call's time to first token as OmniRoute saw it. If that rises with load while
  the provider's own latency does not, the wait is inside OmniRoute.
- **The mock's counters say whether an answer left the mock.** If the mock finished a request
  but the client timed out, the time was lost between them.
- **Compare achieved and offered RPS.** API-key provider connections are auto-protected by the
  global request-queue defaults (60 RPM, 350 ms gap, 6 concurrent, 30 s wait; read them from
  `/api/resilience`). On 6 Nov that fit a "1 RPS ceiling" exactly; on 10–12 Nov the same
  connection was not throttled, for reasons not chased. A plateau at a round number is the
  limiter, not the server.
- **Container CPU above 100% is one core full.** Host CPU low at the same time means the
  limit is the single process.

## Profiling the live server

A CPU profile shows where the busy time goes. It runs on the live container without a restart.
The profiler adds about 10 points of CPU, and opening the inspector is a server change, so ask
first.

1. **Find the server's PID inside the container.** The image has no `ps` or `kill`:

   ```bash
   docker exec omniroute sh -c 'for p in /proc/[0-9]*; do printf "%s " "${p#/proc/}"; tr "\0" " " < "$p/cmdline"; echo; done'
   ```

   The server is the process titled `omniroute (v…)` (PID 20 on 12 Nov).
2. **Open its inspector.** It listens on 127.0.0.1:9229 inside the container only:

   ```bash
   docker exec omniroute node -e 'process.kill(20, "SIGUSR1")'
   ```

3. **Start the load, then record** (46 s here). The script closes the inspector when done:

   ```bash
   docker exec -i omniroute node --input-type=module - 46 /tmp/omniroute.cpuprofile \
     < scripts/ops/load-test/cpu-profile.mjs
   docker cp omniroute:/tmp/omniroute.cpuprofile . && docker exec omniroute rm /tmp/omniroute.cpuprofile
   ```

4. **Summarise it:** `node scripts/ops/load-test/analyze-profile.mjs omniroute.cpuprofile 40`
   prints CPU by area and the top functions by self and inclusive time.
5. **Map minified frames to source.** Production frames point into bundled chunks such as
   `/app/.build/next/server/chunks/707.js` at a line and column. Print the code around one and
   recognise it by its SQL, strings or names:

   ```bash
   docker exec -i omniroute node --input-type=module - \
     /app/.build/next/server/chunks/707.js 35 11628 < scripts/ops/load-test/code-at.mjs
   ```

## Cleanup

- Remove the mock container, or close the tunnel and revert `GatewayPorts` and the UFW rule.
- Point `stressmock-test` back where it was, or disable it.
- Delete both test keys and confirm the probe key gets 401.
- Keep the raw `jsonl`, the summaries and the profile outside the repo (`_artifacts/` is
  git-ignored), and record the results here.
