#!/usr/bin/env node
// Replay answers recorded by tools/run-native.mjs (--cache) through the WASM
// module in Node (the SDK's browser harness) and time each stage: the CPU a
// run costs in the module's own runtime. Verification tool, not a test.
//   node tools/run-wasm.mjs <cache dir> [run_at_ms]
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";

const [cache, runAt = "1791936000000"] = process.argv.slice(2);
const wasm = fs.readFileSync(fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(new URL("../plugin-manifest.json", import.meta.url)));
const STAGES = ["entities_a", "entities_b", "entities_c", "parties", "articles_a", "articles_b", "articles_c", "finish"];
const key = (r) => createHash("sha256").update(`${r.method}\n${r.url.replace(/[?&]sdn-req=[^&]*/, "")}\n${r.bodyB64 ?? ""}`).digest("hex");
const answer = (r) => fs.readFileSync(`${cache}/${key(r)}.bin`);
const h = await createBrowserModuleHarness({ wasmSource: wasm, manifest, surface: "direct" });
const json = (v) => { const p = Buffer.from(JSON.stringify(v)); return { portId: "config", payload: p, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: p.length } }; };
let t = process.hrtime.bigint();
let result = await h.invoke({ methodId: "plan", inputs: [json({ access: "anonymous", run_at_ms: Number(runAt), producer_peer_id: "replay" })] });
const times = { plan: Number(process.hrtime.bigint() - t) / 1e9 };
for (const stage of STAGES) {
  const requests = result.outputs.filter((f) => f.portId === "request").map((f) => JSON.parse(Buffer.from(f.payload)));
  const state = result.outputs.find((f) => f.portId === "state");
  const inputs = [{ portId: "state", payload: state.payload, typeRef: state.typeRef }, ...requests.map((r) => {
    const p = answer(r);
    return { portId: "response", payload: p, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: p.length } };
  })];
  t = process.hrtime.bigint();
  result = await h.invoke({ methodId: stage, inputs });
  times[stage] = Number(process.hrtime.bigint() - t) / 1e9;
  if (result.statusCode !== 0) throw new Error(`${stage}: ${result.errorMessage}`);
}
const sites = result.outputs.find((f) => f.portId === "sites").payload;
const total = Object.values(times).reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ seconds: times, total: Math.round(total * 100) / 100, sites: sites.length, sha256: createHash("sha256").update(sites).digest("hex"), rssMB: Math.round(process.memoryUsage().rss / 1e6) }));
h.destroy();
