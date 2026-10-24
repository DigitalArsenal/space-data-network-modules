// Parity (browser and native WasmEdge; the owner waived the Docker leg on 2026-10-22, it is never started) of derive,
// omm_from_mpe, derive_omm and answer_propagation_requests: identical request bytes must give byte-identical outputs
// in every lane. A failed run leaves the committed receipt untouched: assert, then write.
//   PATH=$HOME/.wasmedge/bin:$PATH node tests/parity.mjs   (through headless-run: the browser lane)
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { formatParityReport, normalizeParityFixture, runParityHarness } from "space-data-module-sdk/testing";
import { meanElementSource } from "spacedatastandards.org/lib/js/MPE/main.js";

import { FIXTURE, mpeStream, mpeType, ommStream, ommType, prwType, windowRequest } from "./fixtures.mjs";

const AGES = JSON.parse(fs.readFileSync(new URL("./ages-reference.json", import.meta.url), "utf8"));
const mpe = mpeStream(FIXTURE.cases);
const trajectory = AGES.trajectory;
const sets = FIXTURE.cases.filter((c) => c.satnum === trajectory.satnum || c.satnum === 5);
const at = sets.findIndex((c) => c.satnum === trajectory.satnum);
const first = trajectory.samples[0].epochIso, last = trajectory.samples.at(-1).epochIso;
const query = (set) => ({ object: `set ${set}`, set, start: first, stop: last, step_s: trajectory.stepSeconds });
const xp = (_, i) => (i === 1 - at ? { MEAN_ELEMENT_THEORY: meanElementSource.SGP4XP } : {});

const cases = [
  // The ages come from the node config (plugin.getConfig); the parity lanes serve none, so the epoch alone.
  { id: "derive-epoch-only", request: { methodId: "derive", inputs: [{ portId: "elements", payload: mpe, typeRef: mpeType() }] } },
  { id: "omm-from-mpe", request: { methodId: "omm_from_mpe", inputs: [{ portId: "mpe", payload: mpe, typeRef: mpeType() }] } },
  { id: "derive-omm", request: { methodId: "derive_omm", inputs: [{ portId: "omm", payload: ommStream(FIXTURE.cases), typeRef: ommType }] } },
  { id: "derive-omm-refusals", request: { methodId: "derive_omm", inputs: [{ portId: "omm", payload: ommStream([FIXTURE.cases[1], FIXTURE.cases[1], FIXTURE.cases[1]],
    (_, i) => [{ MEAN_ELEMENT_THEORY: meanElementSource.SGP4XP }, { OBJECT_ID: "", NORAD_CAT_ID: 0, OBJECT_NAME: "" }, {}][i]), typeRef: ommType }] } },
  { id: "answer-propagation-requests", request: { methodId: "answer_propagation_requests", inputs: [
    { portId: "requests", payload: await windowRequest([query(at), query(1 - at)]), typeRef: prwType },
    { portId: "element_sets", payload: ommStream(sets, xp), typeRef: ommType }] } },
];

const plan = await normalizeParityFixture({
  name: "epoch-state: derive, omm_from_mpe, derive_omm, answer_propagation_requests ($PRW window request)",
  cases: cases.map((c) => ({ ...c, request: { ...c.request,
    inputs: c.request.inputs.map(({ payload, ...p }) => ({ ...p, payloadHex: Buffer.from(payload).toString("hex") })) } })),
});
const report = await runParityHarness({ wasmPath: fileURLToPath(new URL("../dist/isomorphic/module.wasm", import.meta.url)), plan, lanes: ["browser", "wasmedge"], timeoutMs: 120000, log: console.log });
console.log(formatParityReport(report));
assert.equal(report.ok, true, JSON.stringify(report.failures));
fs.writeFileSync(new URL("../conformance/parity.json", import.meta.url), `${JSON.stringify({ ...report, wasmPath: "dist/isomorphic/module.wasm", dockerLane: "waived by the owner 2026-10-22 (no Docker)" }, null, 2)}\n`);
