#!/usr/bin/env node
/**
 * Records a CPU profile of a running OmniRoute through its inspector, then closes
 * the inspector. Run it INSIDE the omniroute container, after the server process
 * got SIGUSR1 (which opens the inspector on 127.0.0.1:9229 inside the container
 * only):
 *
 *   node cpu-profile.mjs <seconds> <out.cpuprofile>
 *
 * Node 22+ (global fetch and WebSocket); no dependencies. Steps and traps:
 * docs/ops/LOAD_TESTING.md, "Profiling the live server".
 */
import { writeFileSync } from "node:fs";

const seconds = Number(process.argv[2] || 60);
const out = process.argv[3] || "/tmp/omniroute.cpuprofile";
const targets = await (await fetch("http://127.0.0.1:9229/json/list")).json();
if (!targets.length) throw new Error("no inspector target on 127.0.0.1:9229 (was SIGUSR1 sent to the server process?)");

const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
const pending = new Map();
let nextId = 0;
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval: 1000 }); // 1 ms
await send("Profiler.start");
console.log(`profiling ${targets[0].title} for ${seconds}s`);
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const { profile } = await send("Profiler.stop");
writeFileSync(out, JSON.stringify(profile));
console.log(`wrote ${out} (${profile.nodes.length} nodes, ${profile.samples.length} samples)`);

// Close the inspector so nothing stays listening after the run. Closing it drops
// this connection too, so the call gets no reply: send it and leave.
ws.send(JSON.stringify({ id: ++nextId, method: "Runtime.evaluate", params: { expression: "process._debugEnd()" } }));
setTimeout(() => process.exit(0), 500);
