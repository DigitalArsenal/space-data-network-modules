// The pvn-labels E2E input and the module outputs before the labels moved to typed fields (pvn-labels.before.json,
// recorded from the dist of modules ea824356 with `node test/fixtures/pvn-labels.mjs --record`).
// Input: the synthetic SES-E fixture (PROVENANCE.md), its first row made an EPHEMERIS_TYPE 4 (SGP4-XP) row whose BSTAR
// column holds BTERM and MEAN_MOTION_DDOT column AGOM (m**2/kg, synthetic values).
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { encodeHttpResponse, encodeTimerTick, decodeHttpRequest } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const here = (p) => new URL(p, import.meta.url).pathname;
export const BEFORE = here("./pvn-labels.before.json");
export const TYPE4 = { EPHEMERIS_TYPE: 4, BSTAR: 0.0123, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0.0042 };
export const CONFIG = { token: "SES-E", sourceName: "ses" };

export function body() {
  const feed = JSON.parse(fs.readFileSync(here("./SES-E.trimmed.json"), "utf8"));
  feed[0] = { ...feed[0], ...TYPE4 };
  return new TextEncoder().encode(JSON.stringify(feed));
}

const TICK = { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" };
const HRSP = { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" };

// request (one token) then parse of the answer: { port: payload } of the parse.
export async function drive(wasmPath, manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const host = await createBrowserModuleHarness({ wasmSource: new Uint8Array(fs.readFileSync(wasmPath)), manifest, surface: "direct", hostOptions: { config: CONFIG } });
  try {
    const tick = { portId: "tick", typeRef: TICK, payload: encodeTimerTick({ triggerId: "supgp-pull", firedMs: Date.UTC(2026, 9, 14) }) };
    const asked = await host.invoke({ methodId: "request", inputs: [tick] });
    if (asked.statusCode !== 0) throw new Error(`request: ${asked.errorMessage}`);
    const req = decodeHttpRequest(asked.outputs.find((f) => f.portId === "requests").payload);
    const payload = encodeHttpResponse({ url: req.url, status: 200, headers: { "content-type": "application/json" }, body: body(), context: req.context, retrievedMs: Date.UTC(2026, 9, 14, 1) });
    const r = await host.invoke({ methodId: "parse", inputs: [{ portId: "response", typeRef: HRSP, payload }] });
    if (r.statusCode !== 0) throw new Error(`parse: ${r.errorMessage}`);
    return Object.fromEntries(r.outputs.map((f) => [f.portId, new Uint8Array(f.payload)]));
  } finally {
    host.destroy();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv[2] === "--record") {
  const out = await drive(here("../../dist/isomorphic/module.wasm"), here("../../dist/plugin-manifest.json"));
  fs.writeFileSync(BEFORE, `${JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Buffer.from(v).toString("base64")])), null, 1)}\n`);
  console.log(`recorded ${Object.keys(out).join(", ")} -> ${BEFORE}`);
}
