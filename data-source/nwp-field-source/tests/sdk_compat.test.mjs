// data-source/nwp-field-source SDK-compat tests: the compiled wasm in the SDK browser harness, its node config stubbed
// through plugin.getConfig, select_messages fed REAL .idx inventories of NOAA's public GFS/GEFS buckets (tests/fixtures,
// the 2026-10-06 00 UTC run). The messages it must choose are re-derived here from the world-clouds reference fetchers'
// rules (Cesium_Weather tools/fetch-motion-wxf.mjs, fetch-model-clouds-wxf.mjs, fetch-gfs-wxf.mjs, fetch-gfs-profile-wxf.mjs).

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateArtifactWithStandards } from "space-data-module-sdk/compliance";
import { inspectModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const FIXTURES = new URL("./fixtures/", import.meta.url);
const NO_VALIDATORS = "Thu, 01 Jan 1970 00:00:00 GMT";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const GFS = "https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.20261006/00/atmos";
const GEFS = "https://noaa-gefs-pds.s3.amazonaws.com/gefs.20261006/00/atmos/pgrb2ap5";
const FILES = {
  "gfs-1p00-motion": { url: `${GFS}/gfs.t00z.pgrb2.1p00.f024`, idx: "gfs.t00z.pgrb2.1p00.f024.idx", lead: 24 },
  "gefs-0p50-spread": { url: `${GEFS}/gespr.t00z.pgrb2a.0p50.f024`, idx: "gespr.t00z.pgrb2a.0p50.f024.idx", lead: 24 },
  "gfs-0p50-clouds": { url: `${GFS}/gfs.t00z.pgrb2.0p50.f024`, idx: "gfs.t00z.pgrb2.0p50.f024.idx", lead: 24 },
  "gfs-0p25-physics": { url: `${GFS}/gfs.t00z.pgrb2.0p25.f000`, idx: "gfs.t00z.pgrb2.0p25.f000.idx", lead: 0 },
};

// The reference fetchers' choices
const MOTION = [1000, 925, 850, 700, 500, 400, 300, 250, 200].map((p) => `${p} mb`);
const PROFILE = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100].map((p) => `${p} mb`);
const instantaneous = (t) => t === "anl" || /^\d+ hour fcst$/.test(t);
const REFERENCE = {
  "gfs-1p00-motion": (v, l, t, lead) => MOTION.includes(l) && (v === "UGRD" || v === "VGRD" || (v === "HGT" && lead <= 12)) && instantaneous(t),
  "gefs-0p50-spread": (v, l, t) => MOTION.includes(l) && (v === "UGRD" || v === "VGRD") && instantaneous(t),
  "gfs-0p50-clouds": (v, l, t) => instantaneous(t) && ["TCDC:entire atmosphere", "LCDC:low cloud layer", "MCDC:middle cloud layer", "HCDC:high cloud layer"].includes(`${v}:${l}`),
  "gfs-0p25-physics": (v, l, t) => instantaneous(t) && (
    ["TMP:2 m above ground", "DPT:2 m above ground", "UGRD:10 m above ground", "VGRD:10 m above ground", "HPBL:surface", "CAPE:surface", "HGT:surface",
      "LCDC:low cloud layer", "MCDC:middle cloud layer", "HCDC:high cloud layer"].includes(`${v}:${l}`) ||
    (["TMP", "HGT", "UGRD", "VGRD", "RH", "VVEL"].includes(v) && PROFILE.includes(l)) || (["TMP", "HGT", "UGRD", "VGRD"].includes(v) && l === "tropopause")),
};
// the wanted messages of an inventory as byte ranges, adjacent ones merged (each under 64 MiB)
function referenceRanges(product, idxText, lead) {
  const rows = idxText.trim().split("\n").map((l) => l.split(":"));
  const ranges = [];
  rows.forEach((f, i) => {
    if (!REFERENCE[product](f[3], f[4], f[5], lead)) return;
    const a = Number(f[1]), b = i + 1 < rows.length ? Number(rows[i + 1][1]) - 1 : null;
    const last = ranges.at(-1);
    if (last && last[1] !== null && last[1] + 1 === a && (b === null || b - last[0] + 1 <= 64 * 1024 * 1024)) last[1] = b; else ranges.push([a, b]);
  });
  return { ranges, messages: rows.filter((f) => REFERENCE[product](f[3], f[4], f[5], lead)).length };
}

function bytesInput(portId, payload) {
  return { portId, typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: payload.byteLength }, payload };
}
const jsonInput = (portId, value) => bytesInput(portId, encoder.encode(JSON.stringify(value)));
function rawResponseFrame(body, status = 200) {
  const frame = new Uint8Array(8 + body.byteLength);
  frame.set([0x24, 0x48, 0x52, 0x42]);
  new DataView(frame.buffer).setInt32(4, status, true);
  frame.set(body, 8);
  return frame;
}
async function createHarness(t, config = {}) {
  const harness = await createBrowserModuleHarness({
    wasmSource: new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => { if (operation === "plugin.getConfig") return config; throw new Error(`unexpected hostcall ${operation}`); },
  });
  t.after(() => harness.destroy());
  return harness;
}
function framesOn(response, port) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  return response.outputs.filter((f) => f.portId === port).map((f) => JSON.parse(decoder.decode(f.payload)));
}

test("nwp-field-source artifact passes SDK compliance", async () => {
  const report = await validateArtifactWithStandards({ manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")), wasmPath: fileURLToPath(ISOMORPHIC_WASM_PATH), standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues, null, 2));
});

test("nwp-field-source imports only the hostcall bridge and WASI", async () => {
  const inspection = await inspectModule(new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)));
  assert.deepEqual(Array.from(new Set(inspection.imports.map((entry) => entry.module))).sort(), ["space_data_module_host", "wasi_snapshot_preview1"]);
});

test("plan: the run's inventories, sixteen per invocation, the rest as backlog", async (t) => {
  const harness = await createHarness(t, { nwp_run: "20261006T00" });
  const response = await harness.invoke({ methodId: "plan", inputs: [jsonInput("tick", {})] });
  const requests = framesOn(response, "requests");
  const jobs = framesOn(response, "jobs");
  assert.equal(requests.length, 16);
  assert.equal(jobs.length, 16);
  // 129 leads (0..384 by 3) of motion, spread and clouds, and two physics leads: 389 inventories, 373 left as backlog
  assert.equal(response.yielded, true);
  assert.equal(response.backlogRemaining, 3 * 129 + 2 - 16);
  // products in order, leads 0, 3, 6, ...: the first sixteen are GFS 1 deg motion leads 0..45
  jobs.forEach((j, k) => {
    assert.deepEqual(j, { product: "gfs-1p00-motion", url: `${GFS}/gfs.t00z.pgrb2.1p00.f${String(3 * k).padStart(3, "0")}`, run: "20261006T00", lead: 3 * k, heights_to: 12 });
    assert.equal(requests[k].url, `${j.url}.idx`);
    assert.equal(requests[k].headers["If-Modified-Since"], NO_VALIDATORS);
    assert.equal(requests[k].responseWire, "raw-body-v1");
  });
});

test("plan: a set run must be a 6-hourly cycle; live access off emits a status", async (t) => {
  const bad = await (await createHarness(t, { nwp_run: "20261006T03" })).invoke({ methodId: "plan", inputs: [jsonInput("tick", {})] });
  assert.equal(bad.errorCode, "invalid-run");
  const off = await (await createHarness(t, { nwp_live_access: false })).invoke({ methodId: "plan", inputs: [jsonInput("tick", {})] });
  assert.deepEqual(framesOn(off, "status"), [{ skipped: "live-access-disabled" }]);
  const unknown = await (await createHarness(t, { nwp_run: "20261006T00", nwp_products: "ecmwf-hres" })).invoke({ methodId: "plan", inputs: [jsonInput("tick", {})] });
  assert.equal(unknown.errorCode, "unknown-product");
});

for (const [product, file] of Object.entries(FILES)) {
  test(`select_messages: ${product} - the reference's messages from a real inventory, as merged byte ranges`, async (t) => {
    const harness = await createHarness(t, {});
    const idx = fs.readFileSync(new URL(file.idx, FIXTURES), "utf8");
    const response = await harness.invoke({ methodId: "select_messages", inputs: [
      jsonInput("idx_jobs", { product, url: file.url, run: "20261006T00", lead: file.lead, heights_to: 12 }),
      bytesInput("inventories", rawResponseFrame(encoder.encode(idx))),
    ] });
    const requests = framesOn(response, "requests");
    const jobs = framesOn(response, "jobs");
    const want = referenceRanges(product, idx, file.lead);
    assert.ok(want.messages > 0);
    // the first batch: the lead-file's ranges, at most 16 (the parser takes 32 frames a port at a time)
    assert.deepEqual(requests.map((r) => r.headers.Range), want.ranges.slice(0, 16).map(([a, b]) => `bytes=${a}-${b ?? ""}`));
    const batches = Math.ceil(want.ranges.length / 16);
    assert.equal(response.backlogRemaining, batches - 1, "the lead-file's other batches wait as backlog");
    assert.equal(response.yielded, batches > 1);
    for (const r of requests) {
      assert.equal(r.url, file.url);
      assert.equal(r.headers["If-Modified-Since"], NO_VALIDATORS);
      assert.equal(r.timeoutMs, 300000);
    }
    for (const j of jobs) {
      assert.equal(j.url, file.url);
      assert.equal(j.product, product);
      assert.equal(j.run, "20261006T00");
      assert.equal(j.lead, file.lead);
      assert.equal(j.stride, product === "gefs-0p50-spread" ? 2 : 1);
      assert.equal(j.band_rows, product === "gfs-0p25-physics" ? 64 : 0);
      assert.equal(j.spread ?? false, product === "gefs-0p50-spread");
      assert.equal(j.license_class, "OpenAttribution");
    }
    console.log(`${product}: ${want.messages} messages in ${want.ranges.length} range(s)`);
  });
}

test("select_messages: a lead the run lacks is reported, not invented; a count mismatch is refused", async (t) => {
  const harness = await createHarness(t, {});
  const job = { product: "gfs-1p00-motion", url: `${GFS}/gfs.t00z.pgrb2.1p00.f999`, run: "20261006T00", lead: 999, heights_to: 12 };
  const response = await harness.invoke({ methodId: "select_messages", inputs: [jsonInput("idx_jobs", job), bytesInput("inventories", rawResponseFrame(encoder.encode("<Error/>"), 404))] });
  assert.deepEqual(framesOn(response, "status"), [{ missing: [{ inventory: `${job.url}.idx`, http_status: 404 }] }]);
  assert.equal(framesOn(response, "requests").length, 0);
  const mismatch = await harness.invoke({ methodId: "select_messages", inputs: [jsonInput("idx_jobs", job), jsonInput("idx_jobs", job), bytesInput("inventories", rawResponseFrame(encoder.encode("")))] });
  assert.equal(mismatch.errorCode, "job-response-count-mismatch");
});

test("publish_request: one POST when nwp_publish_url is set, nothing otherwise", async (t) => {
  const result = jsonInput("result", { schema: "WXF.fbs", inserted: 18, batch_id: "c".repeat(64) });
  const meta = jsonInput("meta", { schema: "WXF.fbs", provider_id: "noaa-ncep", source_name: "gfs-1p00-motion", batch_id: "c".repeat(64) });
  assert.equal(framesOn(await (await createHarness(t, {})).invoke({ methodId: "publish_request", inputs: [result, meta] }), "request").length, 0);
  const [request] = framesOn(await (await createHarness(t, { nwp_publish_url: "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish" })).invoke({ methodId: "publish_request", inputs: [result, meta] }), "request");
  assert.deepEqual(JSON.parse(Buffer.from(request.bodyB64, "base64").toString("utf8")), { schema: "WXF.fbs", providerId: "noaa-ncep", sourceName: "gfs-1p00-motion", batchId: "c".repeat(64) });
});
