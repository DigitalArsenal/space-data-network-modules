#!/usr/bin/env node
// Development run of the site-registry stages without a node: the native
// build of the module's translation unit (tools/native/main.cpp) replays the
// stage chain while this script performs the HTTP requests the stages ask
// for, one at a time and a second apart per host, as the node's http
// capability would. Answers are kept under --cache (keyed by request), so a
// rerun replays them offline; --record copies the answers a fixture set needs.
//
//   node tools/run-native.mjs --native <sr-native> --cache <dir> --out <dir> [--run-at-ms <ms>] [--offline]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: { native: { type: "string" }, cache: { type: "string" }, out: { type: "string" }, "run-at-ms": { type: "string" }, offline: { type: "boolean" } } });
const STAGES = ["plan", "entities_a", "entities_b", "entities_c", "parties", "articles_a", "articles_b", "articles_c", "finish"];
mkdirSync(args.cache, { recursive: true });
mkdirSync(args.out, { recursive: true });
const runAt = Number(args["run-at-ms"] ?? Date.now());
const lastByHost = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function frames(list) {
  const parts = [Buffer.alloc(4)];
  parts[0].writeUInt32LE(list.length);
  for (const [port, bytes] of list) {
    const p = Buffer.from(port);
    const h = Buffer.alloc(4); h.writeUInt32LE(p.length);
    const n = Buffer.alloc(4); n.writeUInt32LE(bytes.length);
    parts.push(h, p, n, Buffer.from(bytes));
  }
  return Buffer.concat(parts);
}
async function perform(req) {
  const key = createHash("sha256").update(`${req.method}\n${req.url.replace(/[?&]sdn-req=[^&]*/, "")}\n${req.bodyB64 ?? ""}`).digest("hex");
  const file = path.join(args.cache, `${key}.bin`);
  if (existsSync(file)) return readFileSync(file);
  if (args.offline) throw new Error(`offline: no recorded answer for ${req.url.slice(0, 160)}`);
  const host = new URL(req.url).host;
  const wait = 1000 - (Date.now() - (lastByHost.get(host) ?? 0));
  if (wait > 0) await sleep(wait);
  let status = 0;
  let body = Buffer.alloc(0);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.bodyB64 ? Buffer.from(req.bodyB64, "base64") : undefined, signal: AbortSignal.timeout(req.timeoutMs ?? 120000) });
    status = r.status;
    body = Buffer.from(await r.arrayBuffer());
    lastByHost.set(host, Date.now());
    if (status !== 429 && status < 500) break;
    await sleep(30000 * attempt);
  }
  const head = Buffer.alloc(8);
  head.write("$HRB");
  head.writeInt32LE(status, 4);
  const frame = Buffer.concat([head, body]);
  if (status >= 200 && status < 300) writeFileSync(file, frame);
  process.stderr.write(`  ${status} ${(body.length / 1e6).toFixed(2)} MB ${req.url.slice(0, 120)}\n`);
  return frame;
}

let state = null;
let requests = [];
for (const stage of STAGES) {
  const inputs = [];
  if (stage === "plan") inputs.push(["config", Buffer.from(JSON.stringify({ access: "anonymous", run_at_ms: runAt, producer_peer_id: "local-native-run" }))]);
  else inputs.push(["state", state]);
  for (const r of requests) inputs.push(["response", await perform(r)]);
  const dir = path.join(args.out, stage);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const input = path.join(dir, "inputs.bin");
  writeFileSync(input, frames(inputs));
  execFileSync(args.native, [stage, input, dir], { stdio: ["ignore", "inherit", "inherit"], maxBuffer: 1 << 30 });
  rmSync(input);
  const outputs = readFileSync(path.join(dir, "outputs.txt"), "utf8").trim().split("\n").map((l) => l.split("\t"));
  requests = outputs.filter(([port]) => port === "request").map(([, f]) => JSON.parse(readFileSync(f, "utf8")));
  const s = outputs.find(([port]) => port === "state");
  if (s) state = readFileSync(s[1]);
  process.stderr.write(`${stage}: ${requests.length} requests, state ${state ? (state.length / 1e6).toFixed(2) : 0} MB\n`);
}
