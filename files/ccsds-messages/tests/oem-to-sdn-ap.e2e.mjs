#!/usr/bin/env node
// E2E (task modules-ccsds-messages-sds-1-276-rebuild-20261104): propagator/sdn-ap fits the $OEM read_oem writes, as written.
// - read_oem reads fixtures/real/nasa-iss.oem (NASA's public ISS OEM, public domain; fixtures/PROVENANCE.md): one $OEM
//   block of 181 states, one per data line of the file.
// - propagator/sdn-ap's fit (its dist, through the SDK harness, under stock SGP4XP: Jacchia 1970 on the theory's flux
//   model) takes those bytes unchanged: no refusal (invalid-oem is gone), one $OCM on 'elements' with
//   FIT_STATISTICS.CONVERGED true and ORBIT_DETERMINATION.OD_OBSERVATIONS_USED equal to the 181 states fed.
// JS only moves bytes and compares numbers the modules produced.
//   cd files/ccsds-messages && node tests/oem-to-sdn-ap.e2e.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { FORMAT, PORT, read } from "./lib/ndm_frames.mjs";
import { createStandaloneHarness } from "../../../propagator/sdn-ap/node_modules/space-data-module-sdk/src/testing/isomorphicHarness.js";
import { configuration, XP_FORCES } from "../../../propagator/sdn-ap/test/lib/pcf.mjs";
import * as flatbuffers from "../../../propagator/sdn-ap/node_modules/flatbuffers/mjs/flatbuffers.js";
import { OEM } from "../../../propagator/sdn-ap/node_modules/spacedatastandards.org/lib/js/OEM/OEM.js";
import { OCM } from "../../../propagator/sdn-ap/node_modules/spacedatastandards.org/lib/js/OCM/OCM.js";

const file = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };

const message = fs.readFileSync(file("../fixtures/real/nasa-iss.oem"));
const dataLines = message.toString("utf8").split(/\r?\n/).filter((line) => /^\d{4}-\d{2}-\d{2}T/.test(line)).length;

const cc = await createBrowserModuleHarness({
  wasmSource: fs.readFileSync(file("../dist/isomorphic/module.wasm")),
  manifest: JSON.parse(fs.readFileSync(file("../plugin-manifest.json"), "utf8")),
  surface: "direct",
});
const r = await cc.invoke(read("OEM", message, FORMAT.OEM[0]));
await cc.destroy();
if (r.statusCode !== 0) throw new Error(`read_oem: ${r.errorCode} ${r.errorMessage}`);
const oem = new Uint8Array(r.outputs.find((o) => o.portId === PORT.OEM).payload);
const view = new DataView(oem.buffer, oem.byteOffset, oem.byteLength);
const plain = view.getUint32(0, true) === oem.length - 4 ? oem.subarray(4) : oem;
const blocks = OEM.getRootAsOEM(new flatbuffers.ByteBuffer(plain)).unpack().EPHEMERIS_DATA_BLOCK;
const states = blocks.reduce((n, b) => n + b.EPHEMERIS_DATA_LINES.length, 0);
console.log(`read_oem: ${oem.length} bytes, ${blocks.length} block, ${states} states (${dataLines} data lines in the file)`);
check(blocks.length === 1 && states === 181 && dataLines === 181, `the $OEM holds ${blocks.length} block(s) and ${states} states; the file ${dataLines} data lines`);

const ap = await createStandaloneHarness("browser", file("../../../propagator/sdn-ap/dist/isomorphic/module.wasm"), { surface: "direct" });
const T = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name });
const fit = await ap.invoke({ methodId: "fit", inputs: [
  { portId: "ephemeris", typeRef: T("OEM"), payload: oem },
  configuration({ theory: "SGP4XP", forces: XP_FORCES }),
] });
await ap.destroy?.();
console.log(`fit: status ${fit.statusCode}${fit.statusCode === 0 ? "" : ` ${fit.errorCode}: ${fit.errorMessage}`}`);
check(fit.errorCode !== "invalid-oem", `fit refused the $OEM read_oem wrote: invalid-oem (${fit.errorMessage})`);
check(fit.statusCode === 0, `fit: ${fit.errorCode} ${fit.errorMessage}`);
if (fit.statusCode === 0) {
  check(fit.outputs.length === 1 && fit.outputs[0].portId === "elements" && fit.outputs[0].typeRef?.fileIdentifier === "$OCM",
    `fit outputs ${fit.outputs.map((o) => `${o.portId}:${o.typeRef?.fileIdentifier}`).join(", ")}`);
  const ocm = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(new Uint8Array(fit.outputs[0].payload))).unpack();
  const od = ocm.ORBIT_DETERMINATION;
  const s = od?.FIT_STATISTICS;
  console.log(`$OCM: OD_OBSERVATIONS_USED ${od?.OD_OBSERVATIONS_USED}, CONVERGED ${s?.CONVERGED}, ITERATIONS ${s?.ITERATIONS}, FIT_RMS_KM ${s?.FIT_RMS_KM}, ${s?.FIT_START} to ${s?.FIT_STOP}`);
  check(s?.CONVERGED === true, `the fit did not converge (CONVERGED ${s?.CONVERGED})`);
  check(od?.OD_OBSERVATIONS_USED === states, `OD_OBSERVATIONS_USED ${od?.OD_OBSERVATIONS_USED}, not the ${states} states fed`);
}

if (failures.length) {
  console.log(`\nFAIL ${failures.length}\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nPASS sdn-ap fit takes read_oem's $OEM unchanged: no invalid-oem, converged, OD_OBSERVATIONS_USED ${states} = the states fed`);
