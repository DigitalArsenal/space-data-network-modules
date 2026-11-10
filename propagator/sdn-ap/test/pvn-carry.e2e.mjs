#!/usr/bin/env node
// E2E (task modules-sdn-ap-fit-carries-input-pvn-20261104): fit carries the ephemeris source's PVN onto the $OCM.
// An SDS 1.278.0 $OEM has no PROVENANCE; its source module writes the source's $PVN beside it, and fit takes that
// $PVN on 'provenance' (none, or one per 'ephemeris' frame in their order). On the 24 h arc of test/lib/fixture-inputs.mjs
// fitted as stock SGP4XP:
// - with an ILRS $PVN (SOURCE_KIND Observation, ORIGINATOR ILRS, LICENSE_CLASS Reproducible, all 13 fields set): the
//   $OCM's PROVENANCE equals it in 12 of 12 fields other than PRODUCER, and PRODUCER is this module and version;
// - without one: PROVENANCE is this module's (PROVIDER_ID the module id, PRODUCER id and version, every other field
//   unset);
// - the two $OCM are equal in every field but PROVENANCE, and their MEAN_ELEMENTS equal those of
//   test/fixtures/xp-fit-data-sigma.ocm (test/record-fit-fixtures.mjs) bit for bit;
//   OD_OBSERVATIONS_USED is the fitted-state count (FIT_STATES) in both: neither the $OEM nor the $PVN has a typed
//   observation count to copy;
// - two ephemeris frames with two $PVN: each $OCM carries its own frame's; with one $PVN: provenance-count; an $OEM
//   on 'provenance': invalid-pvn; no USER_DEFINED_PARAMETERS.
// JS only moves bytes and compares fields the module wrote.
//   node test/pvn-carry.e2e.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { OCM } from "spacedatastandards.org/lib/js/OCM/OCM.js";
import { PVNT } from "spacedatastandards.org/lib/js/PVN/PVN.js";
import { pvnSourceKind } from "spacedatastandards.org/lib/js/PVN/pvnSourceKind.js";
import { pvnLicenseClass } from "spacedatastandards.org/lib/js/PVN/pvnLicenseClass.js";
import { assertNoUserDefined } from "../../../common/tests/no-user-defined.mjs";
import { ensureBuilt, wasmPath, packageRoot } from "./lib/module.mjs";
import { configuration, XP_FORCES } from "./lib/pcf.mjs";
import { arcOem } from "./lib/fixture-inputs.mjs";

ensureBuilt();
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const h = await createStandaloneHarness("browser", wasmPath, { surface: "direct" });
const T = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name });
const ocmOf = (bytes) => OCM.getRootAsOCM(new flatbuffers.ByteBuffer(bytes)).unpack();
const was = ocmOf(fs.readFileSync(fileURLToPath(new URL("fixtures/xp-fit-data-sigma.ocm", import.meta.url)))).MEAN_ELEMENTS;
const { pluginId, version } = JSON.parse(fs.readFileSync(`${packageRoot}plugin-manifest.json`, "utf8"));
const PRODUCER = `${pluginId} ${version}`;
const FIELDS = ["SOURCE_ID", "SOURCE_KIND", "ORIGINATOR", "PROVIDER_ID", "PRODUCER", "LICENSE_CLASS", "LICENSE_ID", "LINEAGE",
  "SOURCE_URL", "SOURCE_VERSION", "RETRIEVED_AT", "SOURCE_SHA256", "SOURCE_BYTES"];

const pvnBytes = (fields) => {
  const b = new flatbuffers.Builder(512);
  b.finish(Object.assign(new PVNT(), fields).pack(b), "$PVN");
  return b.asUint8Array().slice();
};
const ILRS = {
  SOURCE_ID: "ilrs-npt-crd", SOURCE_KIND: pvnSourceKind.Observation, ORIGINATOR: "ILRS", PROVIDER_ID: "cddis.nasa.gov",
  PRODUCER: "com.spacedatanetwork.estimation 0.6.0", LICENSE_CLASS: pvnLicenseClass.Reproducible, LICENSE_ID: "ilrs", LINEAGE: "ilrs",
  SOURCE_URL: "https://cddis.nasa.gov/archive/slr/data/npt_crd/lageos1/2026/lageos1_20261001.npt", SOURCE_VERSION: "2026-10-02T03:00:00Z",
  RETRIEVED_AT: "2026-10-02T04:00:00.000Z", SOURCE_SHA256: "0123456789abcdef".repeat(4), SOURCE_BYTES: 48211n };
const OTHER = { SOURCE_ID: "operator-ephemeris", SOURCE_KIND: pvnSourceKind.Ephemeris, ORIGINATOR: "OPERATOR B", LICENSE_CLASS: pvnLicenseClass.CiteOnly, LINEAGE: "operator-b" };

const arc = arcOem(24);
const config = configuration({ theory: "SGP4XP", forces: XP_FORCES });
const ephemeris = { portId: "ephemeris", typeRef: T("OEM"), payload: arc };
const provenance = (fields) => ({ portId: "provenance", typeRef: T("PVN"), payload: pvnBytes(fields) });
const fit = (...frames) => h.invoke({ methodId: "fit", inputs: [ephemeris, config, ...frames] });
const elements = (r, label) => {
  check(r.statusCode === 0, `${label}: ${r.errorCode} ${r.errorMessage}`);
  return r.statusCode === 0 ? r.outputs.filter((o) => o.portId === "elements").map((o) => new Uint8Array(o.payload)) : [];
};

// with the ILRS $PVN, and without
const [carriedBytes] = elements(await fit(provenance(ILRS)), "fit with the ILRS $PVN");
const [ownBytes] = elements(await fit(), "fit without a $PVN");
let carriedFields = 0;
if (carriedBytes && ownBytes) {
  for (const b of [carriedBytes, ownBytes]) try { assertNoUserDefined(b); } catch (e) { check(false, e.message); }
  const carried = ocmOf(carriedBytes), own = ocmOf(ownBytes);
  for (const f of FIELDS) {
    if (f === "PRODUCER") continue;
    if (carried.PROVENANCE?.[f] === ILRS[f]) ++carriedFields;
    else check(false, `carried ${f}: ${carried.PROVENANCE?.[f]} against the source's ${ILRS[f]}`);
  }
  check(carried.PROVENANCE?.PRODUCER === PRODUCER, `carried PRODUCER: ${carried.PROVENANCE?.PRODUCER}, expected ${PRODUCER}`);
  const ownPvn = own.PROVENANCE ?? {};
  const unset = FIELDS.filter((f) => !["PROVIDER_ID", "PRODUCER"].includes(f) && ownPvn[f] !== new PVNT()[f]);
  check(ownPvn.PROVIDER_ID === pluginId && ownPvn.PRODUCER === PRODUCER && unset.length === 0,
    `own PVN: PROVIDER_ID ${ownPvn.PROVIDER_ID}, PRODUCER ${ownPvn.PRODUCER}, set beyond them ${unset.join(", ")}`);
  // every field but PROVENANCE equal; the elements those recorded
  const rest = (o) => JSON.stringify({ ...o, PROVENANCE: null }, (k, v) => (typeof v === "bigint" ? `${v}n` : v));
  check(rest(carried) === rest(own), "the carried and own $OCM differ beyond PROVENANCE");
  const me = carried.MEAN_ELEMENTS;
  const pairs = [["EPOCH", me.EPOCH, was.EPOCH], ["MEAN_MOTION", me.MEAN_MOTION, was.MEAN_MOTION], ["ECCENTRICITY", me.ECCENTRICITY, was.ECCENTRICITY],
    ["INCLINATION", me.INCLINATION, was.INCLINATION], ["RA_OF_ASC_NODE", me.RA_OF_ASC_NODE, was.RA_OF_ASC_NODE],
    ["ARG_OF_PERICENTER", me.ARG_OF_PERICENTER, was.ARG_OF_PERICENTER], ["MEAN_ANOMALY", me.MEAN_ANOMALY, was.MEAN_ANOMALY],
    ["BTERM", me.BTERM, was.BTERM], ["AGOM", me.AGOM, was.AGOM]];
  for (const [field, got, want] of pairs) check(Object.is(got, want), `${field}: ${got} against the recorded ${want}`);
  const od = carried.ORBIT_DETERMINATION;
  check(od?.OD_OBSERVATIONS_USED === od?.FIT_STATISTICS?.FIT_STATES && od.OD_OBSERVATIONS_USED > 0,
    `OD_OBSERVATIONS_USED ${od?.OD_OBSERVATIONS_USED} against FIT_STATES ${od?.FIT_STATISTICS?.FIT_STATES}`);
  check(carried.HEADER?.ORIGINATOR === own.HEADER?.ORIGINATOR, `HEADER.ORIGINATOR ${carried.HEADER?.ORIGINATOR} against ${own.HEADER?.ORIGINATOR}`);
  console.log(`carried: ${carriedFields} of 12 fields equal the ILRS $PVN, PRODUCER ${carried.PROVENANCE?.PRODUCER}; own: ${ownPvn.PROVIDER_ID} / ${ownPvn.PRODUCER}; ` +
    `n ${me.MEAN_MOTION}, BTERM ${me.BTERM}, ${od?.OD_OBSERVATIONS_USED} states`);
}
check(carriedFields === 12, `carried ${carriedFields} of 12 fields`);

// two ephemeris frames, each with its own $PVN, in their order
const pair = elements(await h.invoke({ methodId: "fit", inputs: [ephemeris, config, provenance(ILRS), ephemeris, provenance(OTHER)] }), "two frames");
check(pair.length === 2, `two frames: ${pair.length} records`);
if (pair.length === 2) {
  const [a, b] = pair.map((x) => ocmOf(x).PROVENANCE ?? {});
  check(a.ORIGINATOR === "ILRS" && a.LICENSE_CLASS === pvnLicenseClass.Reproducible && b.ORIGINATOR === "OPERATOR B" &&
    b.LICENSE_CLASS === pvnLicenseClass.CiteOnly && b.LINEAGE === "operator-b" && b.PROVIDER_ID === null && b.PRODUCER === PRODUCER,
    `two frames: ${a.ORIGINATOR}/${a.LICENSE_CLASS}, ${b.ORIGINATOR}/${b.LICENSE_CLASS}/${b.LINEAGE}/${b.PROVIDER_ID}/${b.PRODUCER}`);
}

// refusals by name
const refused = (label, r, code) => check(r.statusCode !== 0 && r.errorCode === code, `${label}: expected ${code}, got ${r.statusCode === 0 ? "success" : r.errorCode}`);
refused("one $PVN for two frames", await h.invoke({ methodId: "fit", inputs: [ephemeris, config, provenance(ILRS), ephemeris] }), "provenance-count");
refused("an $OEM on provenance", await fit({ portId: "provenance", typeRef: T("PVN"), payload: arc }), "invalid-pvn");

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("\nPVN carry E2E: PASS");
process.exit(0);
