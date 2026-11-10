#!/usr/bin/env node
// E2E (issue 316, SPEC 18): a record without a carried forecast flies bit for bit as the build before the carried
// forecast flies it, and fit without OUTPUT writes that build's record. That build's dist (review-0's 0.6.6 at
// d74d3129, or with CARRIED_IDENTITY_BASE=0.6.5 main's 0.6.5 at 3a3661eaf) from git, in the system's temporary folder;
// on the same inputs:
// - fit (the AP and XP fixture fits): no forecast in a record fitted without OUTPUT. Since review-0 M1 (SPEC 12.1) the
//   fits land elsewhere than the base's by design; SDN_AP_CARRIED_FIT_IDENTITY=1 still compares the residuals call's
//   $OCM byte for byte with PRODUCER's version masked and its $ODR with its two CIDs of that $OCM masked;
// - propagate of each record in TEME, GCRF and EME2000 at the fixture grid: the $OEM byte for byte;
// - load_epochs of both records and an SGP4 record, then sdnap_epochs_set_at and sdnap_epochs_at (TEME and Earth-fixed)
//   at 40 times: every double the same (Object.is); propagate_epochs: the $OEM byte for byte.
// JS only moves bytes and compares what the two builds produced.
//   node test/carried-identity.e2e.mjs
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";
import { pcfOutputFrame } from "spacedatastandards.org/lib/js/PCF/pcfOutputFrame.js";
import { packageRoot, wasmPath } from "./lib/module.mjs";
import { T, fixtureSets, flight, GRID_OUTPUT } from "./lib/ocm.mjs";
import { configuration } from "./lib/pcf.mjs";
import { jdOf } from "./lib/frames.mjs";

// the build this branch adds the carried forecast to: review-0's 0.6.6 (the cost lane's), or 0.6.5 (main) with
// CARRIED_IDENTITY_BASE=0.6.5
const BASES = {
  "0.6.6": { commit: "d74d3129db071f9aaaffba3cca421453b348d274", sha256: "5566784bd36613ed3cd4f963f6e2e52b40e08819dfe49e5362b34102413a291c" },
  "0.6.5": { commit: "3a3661eaf9caa84fc776a9959494e1ca14358db1", sha256: "f0b8352a43f305fbdd1ad15c9894e2d28f3179528838cae8f967bf1ea5d089b7" },
};
const BASE_VERSION = process.env.CARRIED_IDENTITY_BASE ?? "0.6.6";
const { commit: BASE_COMMIT, sha256: BASE_SHA256 } = BASES[BASE_VERSION];
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sdn-ap-carried-identity-"));
const basePath = path.join(scratch, `sdn-ap-${BASE_VERSION}.wasm`);
try {
  const bytes = execFileSync("git", ["-C", path.resolve(packageRoot, "../.."), "show", `${BASE_COMMIT}:propagator/sdn-ap/dist/isomorphic/module.wasm`], { maxBuffer: 1 << 26 });
  check(createHash("sha256").update(bytes).digest("hex") === BASE_SHA256, `the ${BASE_VERSION} dist from git is not the committed one`);
  fs.writeFileSync(basePath, bytes);

  const command = (file) => createStandaloneHarness("browser", file, { surface: "command" });
  const direct = (file) => createStandaloneHarness("browser", file, { surface: "direct" });
  const [oldC, newC] = [await command(basePath), await command(wasmPath)];
  const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));
  // the version PRODUCER names, masked to the base's (both are X.Y.Z of five characters)
  const producer = (v) => Buffer.from(`com.spacedatanetwork.sdn-ap-propagator ${v}`);
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "plugin-manifest.json"), "utf8")).version;
  const mask = (buf, from, to) => { const b = Buffer.from(buf); for (let at = b.indexOf(from); at >= 0; at = b.indexOf(from, at + 1)) to.copy(b, at); return b; };

  // fit: the fixtures' AP and XP fits on both builds. Since review-0 M1 (SPEC 12.1: the data sigma, and AP's consider
  // estimator) every fit lands elsewhere than the base's by design, so a fit without OUTPUT is held to carrying no
  // forecast (no POLYNOMIAL_POSITION_RECORDS), and the base's records are flown below
  const oldSets = await fixtureSets(oldC), newSets = await fixtureSets(newC);
  const { ocmOf } = await import("./lib/ocm.mjs");
  for (const kind of ["ap", "xp"]) {
    check((ocmOf(newSets[kind]).POLYNOMIAL_POSITION_RECORDS ?? []).length === 0, `fit ${kind}: a record without OUTPUT carries a forecast`);
  }
  // the residual record of one fit, its CIDs of the $OCM masked (the base comparison only where the estimator does not
  // move the fit: SDN_AP_CARRIED_FIT_IDENTITY=1)
  if (process.env.SDN_AP_CARRIED_FIT_IDENTITY === "1") {
    const { inputs } = await import("./lib/fixture-inputs.mjs");
    const { AP_FORCES } = await import("./lib/ocm.mjs");
    const { arc, rows } = inputs();
    const req = [{ portId: "ephemeris", typeRef: T("OEM"), payload: arc }, configuration({ theory: "AP", forces: AP_FORCES }), { portId: "space_weather", typeRef: T("SPW"), payload: rows.bytes }];
    const a = await oldC.invoke({ methodId: "fit", inputs: req }), b = await newC.invoke({ methodId: "fit", inputs: req });
    const odr = (r) => Buffer.from(r.outputs.find((q) => q.portId === "residuals").payload);
    // the CID text of each $OCM is the only difference: replace the new one's with the old one's (same length)
    const ocmA = Buffer.from(a.outputs.find((q) => q.portId === "elements").payload), ocmB = Buffer.from(b.outputs.find((q) => q.portId === "elements").payload);
    check(same(mask(ocmB, producer(version), producer(BASE_VERSION)), ocmA), `fit (residuals call): the $OCM differs from ${BASE_VERSION}'s beyond PRODUCER`);
    const ra = odr(a), rb = odr(b);
    const cids = (buf) => [...buf.toString("latin1").matchAll(/bafk[a-z2-7]{55}/g)].map((m) => m[0]);
    const [ca, cb] = [cids(ra), cids(rb)];
    check(ca.length === 2 && cb.length === 2, `the $ODR names its $OCM twice (${ca.length}, ${cb.length})`);
    let masked = rb;
    for (let k = 0; k < Math.min(ca.length, cb.length); k++) masked = mask(masked, Buffer.from(cb[k]), Buffer.from(ca[k]));
    check(same(masked, ra), `fit: the $ODR differs from ${BASE_VERSION}'s beyond the CIDs of its $OCM`);
  }

  // propagate: each of the base's records on both builds, three frames
  for (const kind of ["ap", "xp"]) {
    for (const frame of [pcfOutputFrame.TEME, pcfOutputFrame.GCRF, pcfOutputFrame.EME2000]) {
      const req = flight([oldSets[kind]], { output: { ...GRID_OUTPUT, FRAME: frame } });
      const a = await oldC.invoke({ methodId: "propagate", inputs: req }), b = await newC.invoke({ methodId: "propagate", inputs: req });
      check(a.statusCode === 0 && b.statusCode === 0 && same(a.outputs[0].payload, b.outputs[0].payload), `propagate ${kind} frame ${frame}: the $OEM differs from ${BASE_VERSION}'s`);
    }
  }
  // the epoch store: an SGP4 record from ingest_omm beside the two
  const { OMMT } = await import("spacedatastandards.org/lib/js/OMM/OMM.js");
  const flatbuffers = await import("flatbuffers");
  const omm = Object.assign(new OMMT(), { OBJECT_NAME: "SGP4 IDENTITY", NORAD_CAT_ID: 99310, EPOCH: "2026-10-01T00:00:00.000000", MEAN_MOTION: 15.2, ECCENTRICITY: 0.0012,
    INCLINATION: 51.6, RA_OF_ASC_NODE: 40, ARG_OF_PERICENTER: 30, MEAN_ANOMALY: 10, BSTAR: 1e-4, MEAN_ELEMENT_THEORY: 0 });
  const ob = new flatbuffers.Builder(1024);
  ob.finish(omm.pack(ob), "$OMM");
  const ing = await oldC.invoke({ methodId: "ingest_omm", inputs: [{ portId: "omm", typeRef: T("OMM"), payload: ob.asUint8Array() }] });
  const records = [oldSets.ap, oldSets.xp, ...(ing.statusCode === 0 ? [new Uint8Array(ing.outputs[0].payload)] : [])];
  check(records.length === 3, `ingest_omm: ${ing.errorCode} ${ing.errorMessage}`);
  const [oldD, newD] = [await direct(basePath), await direct(wasmPath)];
  const values = [];
  for (const h of [oldD, newD]) {
    const r = await h.invoke({ methodId: "load_epochs", inputs: records.map((payload) => ({ portId: "ocm", typeRef: T("OCM"), payload })) });
    check(r.statusCode === 0, `load_epochs: ${r.errorCode} ${r.errorMessage}`);
    const x = h.instance.exports, n = x.sdnap_epochs_count(), p = x.sdnap_alloc(8 * 6 * 8 + 4 * 8 + 8 * 6);
    const got = [];
    for (let k = 0; k < 40; k++) {
      const { whole, frac } = jdOf(`2026-10-01T${String(Math.floor(k * 1.17) % 24).padStart(2, "0")}:${String((k * 7) % 60).padStart(2, "0")}:${String((k * 13) % 60).padStart(2, "0")}.25`);
      const f = frac + Math.floor(k / 20);
      for (let i = 0; i < n; i++) { x.sdnap_epochs_set_at(i, 0, whole, f, p); got.push(...new Float64Array(h.memory.buffer, p, 6)); }
      for (const frame of [0, 3]) { x.sdnap_epochs_at(whole, f, 0, n, frame, p, 0, 0); got.push(...new Float64Array(h.memory.buffer, p, 6 * n)); }
    }
    values.push(got);
  }
  check(values[0].length === values[1].length && values[0].every((v, k) => Object.is(v, values[1][k])), `the epoch store's states differ from ${BASE_VERSION}'s`);
  {
    const req = [...records.map((payload) => ({ portId: "ocm", typeRef: T("OCM"), payload })), configuration({ output: { ...GRID_OUTPUT, FRAME: pcfOutputFrame.GCRF } })];
    const a = await oldC.invoke({ methodId: "propagate_epochs", inputs: req }), b = await newC.invoke({ methodId: "propagate_epochs", inputs: req });
    check(a.statusCode === 0 && b.statusCode === 0 && a.outputs.length === b.outputs.length && a.outputs.every((o, k) => same(o.payload, b.outputs[k].payload)),
      `propagate_epochs: the $OEM differs from ${BASE_VERSION}'s`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`CARRIED-IDENTITY FAIL: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`CARRIED-IDENTITY PASS: without a carried forecast, fit writes none, and propagate, the epoch store and propagate_epochs fly ${BASE_VERSION}'s records bit for bit${process.env.SDN_AP_CARRIED_FIT_IDENTITY === "1" ? `; fit's $OCM and $ODR are ${BASE_VERSION}'s (PRODUCER and its CIDs masked)` : ""}`);
process.exit(0);
