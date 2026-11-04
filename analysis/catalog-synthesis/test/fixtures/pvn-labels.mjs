// The pvn-labels E2E input and the module outputs before the labels moved to typed fields (pvn-labels.before.json,
// recorded from the dist of modules ea824356 with `node test/fixtures/pvn-labels.mjs --record`).
// Input (synthetic element values): the stored records storage.query answers, one per precedence rule: 90001 a hard-pass
// fit fresher than Space-Track (ours wins), 90002 a hard-pass fit staler (Space-Track wins), 90003 an interim fit
// fresher (Space-Track wins by gate), 90004 an SGP4-XP Space-Track set alone, 90005 an interim fit alone.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { Builder } from "flatbuffers";
import { OMM, OMMT } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { meanElementSource } from "spacedatastandards.org/lib/js/OMM/meanElementSource.js";
import { encodeTimerTick } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const here = (p) => new URL(p, import.meta.url).pathname;
export const BEFORE = here("./pvn-labels.before.json");

function omm(norad, epoch, originator, theory = meanElementSource.SGP4) {
  const t = new OMMT();
  t.CCSDS_OMM_VERS = 3.0;
  t.ORIGINATOR = originator;
  t.OBJECT_NAME = `SYNTH ${norad}`;
  t.OBJECT_ID = `2026-${String(norad - 89000).padStart(3, "0")}A`;
  t.CENTER_NAME = "EARTH";
  t.MEAN_ELEMENT_THEORY = theory;
  t.EPOCH = epoch;
  Object.assign(t, { MEAN_MOTION: 15.1 + (norad % 10) / 100, ECCENTRICITY: 0.0011, INCLINATION: 53.05, RA_OF_ASC_NODE: 10 + (norad % 10), ARG_OF_PERICENTER: 90.5,
    MEAN_ANOMALY: 270.25, BSTAR: 0.00021, MEAN_MOTION_DOT: 1.2e-5, MEAN_MOTION_DDOT: 0, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 1234 });
  t.CLASSIFICATION_TYPE = "U";
  t.NORAD_CAT_ID = norad;
  const b = new Builder(1024);
  OMM.finishOMMBuffer(b, t.pack(b));
  return b.asUint8Array().slice();
}
const stored = (cid, sourceName, data) => ({ CID: cid, SourceTags: { SourceName: sourceName, ProviderID: sourceName === "spacetrack-gp" ? "space-track" : sourceName }, Data: data });
const fit = (n, e) => omm(n, e, "SDN-OD");
const gp = (n, e, theory) => omm(n, e, "18 SPCS", theory);

export const RECORDS = [
  stored("cid-fit-90001", "spacex-starlink", fit(90001, "2026-10-10T12:00:00.000000")),
  stored("cid-st-90001", "spacetrack-gp", gp(90001, "2026-10-10T06:00:00.000000")),
  stored("cid-fit-90002", "iss", fit(90002, "2026-10-10T01:00:00.000000")),
  stored("cid-st-90002", "spacetrack-gp", gp(90002, "2026-10-10T06:00:00.000000")),
  stored("cid-fit-90003", "glonass", fit(90003, "2026-10-10T12:00:00.000000")),
  stored("cid-st-90003", "spacetrack-gp", gp(90003, "2026-10-10T06:00:00.000000")),
  stored("cid-st-90004", "spacetrack-gp", gp(90004, "2026-10-10T06:00:00.000000", meanElementSource.SGP4XP)),
  stored("cid-fit-90005", "glonass", fit(90005, "2026-10-10T12:00:00.000000")),
];
// norad -> [winner CID, precedence rule]
export const WINNERS = {
  90001: ["cid-fit-90001", "ours-hardpass-fresher"],
  90002: ["cid-st-90002", "spacetrack-ours-not-fresher"],
  90003: ["cid-st-90003", "spacetrack-ours-gate-interim"],
  90004: ["cid-st-90004", "spacetrack-sole-source"],
  90005: ["cid-fit-90005", "ours-sole-source-gate-interim"],
};
const TICK = { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" };
const FIRED_MS = 1_791_259_200_000;

// { port: [payloads] } (status carries several notices).
export async function drive(wasmPath, manifestPath) {
  const dispatch = (operation) => {
    if (operation === "plugin.getConfig") return {};
    if (operation === "storage.query") return RECORDS;
    throw new Error(`unexpected hostcall operation: ${operation}`);
  };
  const host = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")), surface: "command", hostcallDispatch: dispatch });
  try {
    const tick = { portId: "tick", typeRef: TICK, payload: encodeTimerTick({ triggerId: "catalog-synthesis-pull", scheduledMs: FIRED_MS, firedMs: FIRED_MS, sequence: 1 }) };
    const r = await host.invoke({ methodId: "synthesize_catalog", inputs: [tick] });
    if (r.statusCode !== 0) throw new Error(`synthesize_catalog: ${r.errorCode} ${r.errorMessage}`);
    const out = {};
    for (const f of r.outputs) (out[f.portId] ??= []).push(new Uint8Array(f.payload));
    return out;
  } finally {
    host.destroy();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv[2] === "--record") {
  const out = await drive(here("../../dist/isomorphic/module.wasm"), here("../../dist/plugin-manifest.json"));
  fs.writeFileSync(BEFORE, `${JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.map((x) => Buffer.from(x).toString("base64"))])), null, 1)}\n`);
  console.log(`recorded ${Object.keys(out).join(", ")} -> ${BEFORE}`);
}
