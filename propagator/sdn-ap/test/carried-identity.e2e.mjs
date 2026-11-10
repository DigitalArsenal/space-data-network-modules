#!/usr/bin/env node
// E2E (issue 316, SPEC 18): a record without a carried forecast flies as it did before the carried forecast's version 2,
// and the carried code does not touch it. Two parts:
// - Against the build before version 2 (main's 0.6.9 at c0819777; CARRIED_IDENTITY_BASE names 0.6.8, 0.6.7, 0.6.6 or
//   0.6.5 instead), its dist from git in the system's temporary folder, on the same inputs, for the SGP4XP and SGP4
//   records only: fit (the XP fixture fit) the $OCM byte for byte with PRODUCER's version masked (field by field when
//   the two versions' texts differ in length); propagate in TEME, GCRF and EME2000 at the fixture grid, the $OEM byte
//   for byte; load_epochs of the XP and an SGP4 record, then sdnap_epochs_set_at and sdnap_epochs_at (TEME and
//   Earth-fixed) at 40 times, every double the same (Object.is); propagate_epochs, the $OEM byte for byte.
// - AP records, inside this build: the AP fixture fit (no forecast) at 42 whole-second epochs over the fixture grid,
//   with no SOURCES label; propagate_epochs and load_epochs with sdnap_epochs_at (the covariance asked, as
//   propagate_epochs asks it) every double the same; propagate within 2 cm of them (it times the theory from the
//   record's epoch, the store in minutes from J2000, and an AP state depends on the order of requests, SPEC 9).
// AP's comparison against 0.6.9 (the AP fit's $OCM and $ODR, its propagate, store and propagate_epochs output) was
// dropped on 2026-11-10: it held AP's theory and fit fixed forever, so every change to either broke it by design (the
// cache rework moves AP's output by 0.3 to 13 mm and the fit change every fit above 2,500 km). What it protects for AP,
// that the carried code leaves a record without a forecast alone, is the second part.
// JS only moves bytes and compares what the builds produced.
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
import { oemLines } from "./lib/carried.mjs";

// the build version 2 starts from: main's 0.6.9; review-0's 0.6.8, 0.6.7 (version 1), 0.6.6 (before the carried
// forecast) or 0.6.5 by CARRIED_IDENTITY_BASE
const BASES = {
  "0.6.9": { commit: "c08197778347274f1edb60b224748bb8ba02a253", sha256: "8ec4a1b9ec1462eca788582b7dfbec0cb03429e494e258c03c740a58fc0d9370" },
  "0.6.8": { commit: "7d5b6ef7d8ab90c83ec7fecdaf539a08dc68691e", sha256: "c19f8cae856ba0117763873e068438a8d493987a288a9648f79d194263a6b6b0" },
  "0.6.7": { commit: "64e5f2018afba14a0abd58cfafad007ea2e17215", sha256: "1104598edeebe41cb8daa81bba3c9e82e3181d012a053aefd07d09611b2b81f5" },
  "0.6.6": { commit: "d74d3129db071f9aaaffba3cca421453b348d274", sha256: "5566784bd36613ed3cd4f963f6e2e52b40e08819dfe49e5362b34102413a291c" },
  "0.6.5": { commit: "3a3661eaf9caa84fc776a9959494e1ca14358db1", sha256: "f0b8352a43f305fbdd1ad15c9894e2d28f3179528838cae8f967bf1ea5d089b7" },
};
const BASE_VERSION = process.env.CARRIED_IDENTITY_BASE ?? "0.6.9";
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
  // the version PRODUCER names: masked byte for byte to the base's when the two are of one length (X.Y.Z of five
  // characters), else every field compared with PRODUCER's text set to the base's (0.6.10 is a character longer: the
  // buffer's layout moves with it)
  const producer = (v) => Buffer.from(`com.spacedatanetwork.sdn-ap-propagator ${v}`);
  const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "plugin-manifest.json"), "utf8")).version;
  const mask = (buf, from, to) => { const b = Buffer.from(buf); for (let at = b.indexOf(from); at >= 0; at = b.indexOf(from, at + 1)) to.copy(b, at); return b; };
  const { OCM } = await import("spacedatastandards.org/lib/js/OCM/OCM.js");
  const flatbuffers = await import("flatbuffers");
  const fields = (bytes) => JSON.stringify(OCM.getRootAsOCM(new flatbuffers.ByteBuffer(new Uint8Array(bytes))).unpack(),
    (k, v) => (typeof v === "bigint" ? String(v) : v === producer(version).toString() ? producer(BASE_VERSION).toString() : v));
  const sameOcm = (fresh, base) => (version.length === BASE_VERSION.length ? same(mask(fresh, producer(version), producer(BASE_VERSION)), base) : fields(fresh) === fields(base));

  // --- against the base: the SGP4XP and SGP4 records
  const oldSets = await fixtureSets(oldC), newSets = await fixtureSets(newC);
  check(sameOcm(newSets.xp, oldSets.xp), `fit xp: the $OCM differs from ${BASE_VERSION}'s beyond PRODUCER`);
  for (const frame of [pcfOutputFrame.TEME, pcfOutputFrame.GCRF, pcfOutputFrame.EME2000]) {
    const req = flight([oldSets.xp], { output: { ...GRID_OUTPUT, FRAME: frame } });
    const a = await oldC.invoke({ methodId: "propagate", inputs: req }), b = await newC.invoke({ methodId: "propagate", inputs: req });
    check(a.statusCode === 0 && b.statusCode === 0 && same(a.outputs[0].payload, b.outputs[0].payload), `propagate xp frame ${frame}: the $OEM differs from ${BASE_VERSION}'s`);
  }
  // the epoch store: an SGP4 record from ingest_omm beside the XP record
  const { OMMT } = await import("spacedatastandards.org/lib/js/OMM/OMM.js");
  const omm = Object.assign(new OMMT(), { OBJECT_NAME: "SGP4 IDENTITY", NORAD_CAT_ID: 99310, EPOCH: "2026-10-01T00:00:00.000000", MEAN_MOTION: 15.2, ECCENTRICITY: 0.0012,
    INCLINATION: 51.6, RA_OF_ASC_NODE: 40, ARG_OF_PERICENTER: 30, MEAN_ANOMALY: 10, BSTAR: 1e-4, MEAN_ELEMENT_THEORY: 0 });
  const ob = new flatbuffers.Builder(1024);
  ob.finish(omm.pack(ob), "$OMM");
  const ing = await oldC.invoke({ methodId: "ingest_omm", inputs: [{ portId: "omm", typeRef: T("OMM"), payload: ob.asUint8Array() }] });
  const records = [oldSets.xp, ...(ing.statusCode === 0 ? [new Uint8Array(ing.outputs[0].payload)] : [])];
  check(records.length === 2, `ingest_omm: ${ing.errorCode} ${ing.errorMessage}`);
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

  // --- AP inside this build: propagate, propagate_epochs and the epoch store fly the record without a forecast alike
  {
    const ap = newSets.ap;
    const state = (l) => [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT];
    // whole-second epochs over the fixture grid, ascending (a text both sides read to the same double)
    const grid = await newC.invoke({ methodId: "propagate", inputs: flight([ap], { output: { ...GRID_OUTPUT, FRAME: pcfOutputFrame.TEME } }) });
    const epochs = grid.statusCode === 0 ? oemLines(grid.outputs[0].payload).filter((_, k) => k % 7 === 0).map((l) => `${l.EPOCH.slice(0, 19)}.000000`) : [];
    const at = { output: { EPOCHS: epochs, FRAME: pcfOutputFrame.TEME } };
    const pr = await newC.invoke({ methodId: "propagate", inputs: flight([ap], at) });
    const pe = await newC.invoke({ methodId: "propagate_epochs", inputs: flight([ap], at) });
    check(epochs.length > 10 && pr.statusCode === 0 && pe.statusCode === 0, `AP: propagate ${pr.errorCode ?? ""} or propagate_epochs ${pe.errorCode ?? ""} refused`);
    const a = pr.statusCode === 0 ? oemLines(pr.outputs[0].payload) : [], b = pe.statusCode === 0 ? oemLines(pe.outputs[0].payload) : [];
    check(a.every((l) => l.source == null) && b.every((l) => l.source == null), "AP: a record without a forecast writes a SOURCES label");
    const d = await direct(wasmPath);
    const r = await d.invoke({ methodId: "load_epochs", inputs: [{ portId: "ocm", typeRef: T("OCM"), payload: ap }] });
    check(r.statusCode === 0, `AP: load_epochs ${r.errorCode} ${r.errorMessage}`);
    // with the covariance asked, as propagate_epochs asks it for a record that carries one
    const x = d.instance.exports, p = x.sdnap_alloc(48), cov = x.sdnap_alloc(8 * 36);
    const store = epochs.map((e) => { const { whole, frac } = jdOf(e); x.sdnap_epochs_at(whole, frac, 0, 1, 0, p, 0, cov); return Array.from(new Float64Array(d.memory.buffer, p, 6)); });
    // the store's two calls are one path: to the bit
    check(b.length === epochs.length && b.every((l, k) => state(l).every((v, q) => Object.is(v, store[k][q]))), "AP: propagate_epochs and load_epochs with sdnap_epochs_at differ");
    // propagate times the theory from the record's epoch, the store in minutes from J2000, and an AP state depends on
    // the order of requests (SPEC 9: up to 12.7 mm at 500 km): within 2 cm
    const worst = Math.max(...a.map((l, k) => Math.hypot(l.X - store[k][0], l.Y - store[k][1], l.Z - store[k][2])));
    check(a.length === epochs.length && worst < 2e-5, `AP: propagate is ${worst} km from the store, over 2 cm`);
    console.log(`AP: ${epochs.length} epochs; propagate_epochs and the store the same to the bit; propagate within ${(worst * 1e6).toFixed(3)} mm of them`);
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`CARRIED-IDENTITY FAIL: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`CARRIED-IDENTITY PASS: without a carried forecast, the SGP4XP and SGP4 records' fit, propagate, epoch store and propagate_epochs are ${BASE_VERSION}'s bit for bit (PRODUCER masked); an AP record flies alike through propagate_epochs and the epoch store (to the bit) and propagate (within 2 cm)`);
process.exit(0);
