#!/usr/bin/env node
// Records the fit fixtures of the data-sigma weighting (SPEC 12.1) with the built module and nothing else: on the inputs
// of the 0.4.0 fixtures (test/lib/fixture-inputs.mjs: 24 h of propagator/ffm's 550 km trajectory, 70 x 70, Sun and Moon,
// no drag, no radiation pressure), the module's fit under AP's forces (caps 31 and 20, NRLMSISE-00 on the fixture rows)
// and under stock SGP4XP, and of the SGP4XP set its sdnap_covariance_at on the fixture grid and its export_omm:
//   test/fixtures/ap-fit-data-sigma.ocm, xp-fit-data-sigma.ocm   the fits' $OCM bytes
//   test/fixtures/xp-fit-data-sigma.cov   sdnap_covariance_at of the SGP4XP set at GRID's minutes (42 little-endian
//                                         doubles a time: the TEME state, then the 6 x 6 row-major)
//   test/fixtures/xp-fit-data-sigma.omm   export_omm of the SGP4XP set
// fit.e2e.mjs, pvn-carry.e2e.mjs, covariance.e2e.mjs and epoch-store.e2e.mjs compare against them. Rerun after a change that
// moves the fit's numbers, and say in the change why the new numbers are right. JS only moves bytes.
//   node test/record-fit-fixtures.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { ensureBuilt, wasmPath } from "./lib/module.mjs";
import { configuration, XP_FORCES } from "./lib/pcf.mjs";
import { T, AP_FORCES } from "./lib/ocm.mjs";
import { inputs, GRID } from "./lib/fixture-inputs.mjs";

ensureBuilt();
const h = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const x = h.instance.exports;
const mem = () => h.memory.buffer;
const out = (name, bytes) => {
  fs.writeFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), bytes);
  console.log(`test/fixtures/${name}: ${bytes.length} B`);
};
const { arc, rows } = inputs();
const fit = async (config, spw = null) => {
  const r = await h.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: T("OEM"), payload: arc }, config,
    ...(spw ? [{ portId: "space_weather", typeRef: T("SPW"), payload: spw }] : [])] });
  if (r.statusCode !== 0) throw new Error(`fit: ${r.errorCode} ${r.errorMessage}`);
  return new Uint8Array(r.outputs.find((o) => o.portId === "elements").payload);
};
const ap = await fit(configuration({ theory: "AP", forces: AP_FORCES }), rows.bytes);
const xp = await fit(configuration({ theory: "SGP4XP", forces: XP_FORCES }));
out("ap-fit-data-sigma.ocm", ap);
out("xp-fit-data-sigma.ocm", xp);
const minutes = [];
for (let t = 0; t <= GRID.minutes; t += GRID.step / 60) minutes.push(t);
const po = x.sdnap_alloc(xp.length), pm = x.sdnap_alloc(8 * minutes.length), pout = x.sdnap_alloc(8 * 42 * minutes.length);
new Uint8Array(mem(), po, xp.length).set(xp);
new Float64Array(mem(), pm, minutes.length).set(minutes);
const status = x.sdnap_covariance_at(po, xp.length, pm, minutes.length, pout);
if (status !== 0) throw new Error(`sdnap_covariance_at: ${status}`);
out("xp-fit-data-sigma.cov", Buffer.from(mem().slice(pout, pout + 8 * 42 * minutes.length)));
x.sdnap_free(po); x.sdnap_free(pm); x.sdnap_free(pout);
const exported = await h.invoke({ methodId: "export_omm", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: xp }] });
if (exported.statusCode !== 0) throw new Error(`export_omm: ${exported.errorCode} ${exported.errorMessage}`);
out("xp-fit-data-sigma.omm", new Uint8Array(exported.outputs[0].payload));
process.exit(0);
