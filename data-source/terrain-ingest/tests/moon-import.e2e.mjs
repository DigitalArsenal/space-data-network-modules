// E2E: the Moon terrain IMPORT (import_plan / import_files, flow-moon-import.mjs) publishes what the walk publishes.
// A walk unit is encoded by the import's encoder (terrain-source/tools/body-encode.mjs, real LOLA LDEM_4 from LOLA_DIR),
// staged under a local HTTP server, planned by import_plan, fetched over HTTP as the node's http capability fetches
// it, checked by import_files and handed on: the files and names import_files emits are byte-identical to what
// terrain-source:pack hands the host adapter when the walk runs the same unit at the same clock. A file not staged
// stops the unit (import-not-staged), a file staged under another file's name is refused (import-file-mismatch), and
// a staged unit already imported is past the mark. Asked for without LOLA_DIR's LDEM_4 it fails, never skips.
//
//   LOLA_DIR=~/software/data/lola node --test data-source/terrain-ingest/tests/moon-import.e2e.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { encodeHttpResponse } from "space-data-module-sdk/runtime-contracts";

import { localResponse } from "../../terrain-source/lola-frames.mjs";
import { TYPE as SOURCE_TYPE, STANDARDS_ROOT, flatbuffers } from "../../terrain-source/typed-frames.mjs";
import { createBodyLane, splitSized, dttOf } from "../../terrain-source/tools/body-lane.mjs";
import { createHarness, decodeHttpRequest, decodeIrm, irmRecord, jobIdOf, markFrames, outputs, tickFrame, TYPE } from "./typed.mjs";

const PNM_LIB = await import(new URL(`file://${STANDARDS_ROOT}/lib/js/PNM/main.js`).href);
const LOLA_DIR = process.env.LOLA_DIR ?? path.join(os.homedir(), "software/data/lola");
if (!fs.existsSync(path.join(LOLA_DIR, "ldem_4_float.img"))) {
  throw new Error(`moon-import E2E needs the LOLA LDEM_4 product in LOLA_DIR (${LOLA_DIR}/ldem_4_float.img)`);
}
const ENCODER = fileURLToPath(new URL("../../terrain-source/tools/body-encode.mjs", import.meta.url));
// The host walk's identity and ladder (deployment/solar-system-provider-node/deploy/host-config.py MOON_CAPS head).
const WALK = {
  tileset_id: "nasa-lola-moon",
  dataset_epoch: "2019-03-15T00:00:00.000Z",
  caps: [
    { product: "ldem_4", min_level: 0, max_level: 3, lat_min: -90, lat_max: 90 },
    { product: "ldem_16", min_level: 4, max_level: 5, lat_min: -90, lat_max: 90 },
    { product: "ldem_64", min_level: 6, max_level: 7, lat_min: -90, lat_max: 90 },
  ],
};
const UNIT = 1;  // level 3 from LDEM_4: eight block files
const names = (bytes) => splitSized(bytes).map((s) => PNM_LIB.PNM.getSizePrefixedRootAsPNM(new flatbuffers.ByteBuffer(Uint8Array.from(s))).FILE_NAME());

/** The walk's own frames for `unit` at `clock`: body_plan -> tile -> pack, as flow-moon.mjs runs them. */
async function walkFiles(lane, unit, clock) {
  const inputs = [tickFrame(clock), ...markFrames([irmRecord({ jobId: jobIdOf("nasa-lola-gdr", WALK.tileset_id, WALK.dataset_epoch), next: unit, provider: "nasa-lola" })])];
  const planned = outputs(await lane.ingest.invoke({ methodId: "body_plan", inputs }));
  const requests = Array.from({ length: 16 }, (_, k) => planned.get(`dem_${k}`)?.[0]).filter(Boolean).map(decodeHttpRequest);
  const tile = await lane.source.invoke({ methodId: "tile", inputs: [
    { portId: "plan", typeRef: SOURCE_TYPE.DTT, payload: planned.get("plan")[0] },
    { portId: "options", typeRef: SOURCE_TYPE.MCFG, payload: planned.get("options")[0] },
    ...requests.map((r) => localResponse(LOLA_DIR, r)),
  ] });
  assert.equal(tile.statusCode, 0, tile.errorMessage);
  const pack = await lane.source.invoke({ methodId: "pack", inputs: [
    { portId: "records", typeRef: SOURCE_TYPE.DTT, payload: Uint8Array.from(tile.outputs.find((o) => o.portId === "records").payload) },
    { portId: "options", typeRef: SOURCE_TYPE.MCFG, payload: planned.get("pack")[0] },
  ] });
  assert.equal(pack.statusCode, 0, pack.errorMessage);
  return {
    names: pack.outputs.find((o) => o.portId === "names").payload,
    files: pack.outputs.filter((o) => o.portId === "file").map((o) => Buffer.from(o.payload)),
  };
}

test("an imported unit is published as the walk publishes it", async (t) => {
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), "moon-import-"));
  t.after(() => fs.rmSync(staged, { recursive: true, force: true }));
  const config = path.join(staged, "walk.json");
  fs.writeFileSync(config, JSON.stringify(WALK));
  // 1. The encoder (the import's other half) writes the unit's files under their published names.
  execFileSync(process.execPath, [ENCODER, "--data", LOLA_DIR, "--out", path.join(staged, "files"), "--config", config,
    "--from", String(UNIT), "--to", String(UNIT + 1)], { stdio: "pipe" });

  // 2. Staged behind HTTP, as the node's loopback file server serves them.
  const server = http.createServer((req, res) => {
    const file = path.join(staged, "files", decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(path.join(staged, "files")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  // One walk unit per tick here (import_max_files 1); the next test covers a tick spanning units.
  const importer = await createHarness(t, { ...WALK, import_base_url: `${base}/`, import_from_unit: UNIT, import_max_files: 1 });
  const clock = "2026-10-20T12:00:00Z";

  // 3. import_plan: the walk's unit, its files asked for from the base URL, its own job.
  const planned = outputs(await importer.invoke({ methodId: "import_plan", inputs: [tickFrame(clock)] }));
  const asked = planned.get("files").map(decodeHttpRequest);
  const named = names(planned.get("names")[0]);
  assert.equal(asked.length, named.length);
  assert.ok(named.length >= 1 && named.length <= 32);
  assert.deepEqual(asked.map((r) => r.url), named.map((n) => `${base}/${n}`));
  const job = decodeIrm(planned.get("job")[0]);
  assert.equal(job.jobId, `nasa-lola-gdr+import@${WALK.tileset_id}@${WALK.dataset_epoch}`);
  assert.equal(job.firstIndex, UNIT);
  assert.equal(job.nextIndex, UNIT + 1);

  // 4. The node's http capability fetches them; import_files checks and hands them on.
  const fetchAll = async (requests) => Promise.all(requests.map(async (r) => {
    const res = await fetch(r.url);
    return { portId: "responses", typeRef: TYPE.HRSP, payload: encodeHttpResponse({ url: r.url, status: res.status, body: new Uint8Array(await res.arrayBuffer()) }) };
  }));
  const namesFrame = { portId: "names", typeRef: { schemaName: "PNM.fbs", fileIdentifier: "$PNM", rootTypeName: "PNM", wireFormat: "flatbuffer" }, payload: planned.get("names")[0] };
  const handed = await importer.invoke({ methodId: "import_files", inputs: [...await fetchAll(asked), namesFrame] });
  assert.equal(handed.statusCode, 0, handed.errorMessage);
  const files = handed.outputs.filter((o) => o.portId === "file").map((o) => Buffer.from(o.payload));
  assert.deepEqual(names(handed.outputs.find((o) => o.portId === "names").payload), named);

  // 5. Byte-identical to the walk's own pack output for the unit at the encoder's clock (its tiles' RETRIEVED_AT;
  //    each file is the gzip of its size-prefixed record stream).
  const retrievedAt = dttOf(splitSized(zlib.gunzipSync(files[0]))[0].subarray(4)).PROVENANCE().RETRIEVED_AT();
  const lane = await createBodyLane({ dataDir: LOLA_DIR, config: WALK });
  t.after(() => lane.destroy());
  const walk = await walkFiles(lane, UNIT, retrievedAt);
  assert.deepEqual(names(walk.names), named, "the walk and the import name the same files in the same order");
  for (let k = 0; k < files.length; k++) assert.ok(walk.files[k].equals(files[k]), `${named[k]} differs from the walk's`);

  // 6. A file not staged stops the unit; a file staged under another's name is refused.
  const missing = path.join(staged, "files", named[0]);
  const kept = fs.readFileSync(missing);
  fs.rmSync(missing);
  const stopped = await importer.invoke({ methodId: "import_files", inputs: [...await fetchAll(asked), namesFrame] });
  assert.equal(stopped.errorCode, "import-not-staged");
  if (named.length > 1) {
    fs.writeFileSync(missing, fs.readFileSync(path.join(staged, "files", named[1])));
    const refused = await importer.invoke({ methodId: "import_files", inputs: [...await fetchAll(asked), namesFrame] });
    assert.equal(refused.errorCode, "import-file-mismatch");
  }
  fs.writeFileSync(missing, kept);

  // 7. Past the import's mark the next unit is planned; past the last unit the import is a clean no-op.
  const jobId = `nasa-lola-gdr+import@${WALK.tileset_id}@${WALK.dataset_epoch}`;
  const next = outputs(await importer.invoke({ methodId: "import_plan",
    inputs: [tickFrame(clock), ...markFrames([irmRecord({ jobId, next: UNIT + 1, provider: "nasa-lola" })])] }));
  assert.equal(decodeIrm(next.get("job")[0]).firstIndex, UNIT + 1);
  const drained = await importer.invoke({ methodId: "import_plan",
    inputs: [tickFrame(clock), ...markFrames([irmRecord({ jobId, next: 1e6, provider: "nasa-lola" })])] });
  assert.equal(drained.statusCode, 0);
  assert.equal(drained.outputs.length, 0);
});

// The host's whole ladder (host-config.py MOON_IMPORT_CAPS): the 5 m south pole's walk units are one block file each.
const LADDER = [...WALK.caps,
  { product: "ldem_75s_240m", min_level: 8, max_level: 8, lat_min: -90, lat_max: -75 }, { product: "ldem_75n_240m", min_level: 8, max_level: 8, lat_min: 75, lat_max: 90 },
  { product: "ldem_75s_120m", min_level: 9, max_level: 9, lat_min: -90, lat_max: -80 }, { product: "ldem_75n_120m", min_level: 9, max_level: 9, lat_min: 80, lat_max: 90 },
  { product: "ldem_75s_60m", min_level: 10, max_level: 10, lat_min: -90, lat_max: -85 }, { product: "ldem_128", min_level: 8, max_level: 8, lat_min: -73.125, lat_max: 73.125 },
  { product: "ldem_256", min_level: 9, max_level: 9, lat_min: -78.75, lat_max: 78.75 }, { product: "ldem_75n_60m", min_level: 10, max_level: 10, lat_min: 84.375, lat_max: 90 },
  { product: "ldem_80s_20m", min_level: 11, max_level: 11, lat_min: -90, lat_max: -80.15625 }, { product: "ldem_512", min_level: 10, max_level: 10, lat_min: -84.375, lat_max: 84.375 },
  { product: "ldem_875s_5m", min_level: 12, max_level: 12, lat_min: -90, lat_max: -87.5390625 }];
const FIRST_5M_UNIT = 6357;

test("one import tick takes the walk's consecutive units up to 32 files", async (t) => {
  const config = { tileset_id: WALK.tileset_id, dataset_epoch: WALK.dataset_epoch, caps: LADDER, import_base_url: "http://127.0.0.1:1", import_from_unit: FIRST_5M_UNIT };
  const importer = await createHarness(t, config);
  const walker = await createHarness(t, config);
  const clock = "2026-10-20T12:00:00Z";
  const planned = outputs(await importer.invoke({ methodId: "import_plan", inputs: [tickFrame(clock)] }));
  const named = names(planned.get("names")[0]);
  const job = decodeIrm(planned.get("job")[0]);
  assert.equal(job.firstIndex, FIRST_5M_UNIT);
  // The walk's own units over the same range, one body_plan each: the names they pack into, in order.
  const walkNames = [];
  for (let unit = job.firstIndex; unit < job.nextIndex; unit++) {
    const out = outputs(await walker.invoke({ methodId: "body_plan", inputs: [tickFrame(clock),
      ...markFrames([irmRecord({ jobId: jobIdOf("nasa-lola-gdr", WALK.tileset_id, WALK.dataset_epoch), next: unit, provider: "nasa-lola" })])] }));
    for (const sized of splitSized(out.get("plan")[0])) {
      const tile = dttOf(sized.subarray(4));
      const name = `terrain/301/${tile.LEVEL()}/${tile.X() >> 2}_${tile.Y() >> 2}.dtts.gz`;
      if (!walkNames.includes(name)) walkNames.push(name);
    }
  }
  assert.ok(job.nextIndex - job.firstIndex > 1, `a 5 m tick spans several walk units (${job.nextIndex - job.firstIndex})`);
  assert.ok(named.length <= 32 && named.length > 1);
  assert.deepEqual(named, walkNames, "the tick's files are exactly the walk's files for its units, in order");
  // With import_max_files 1, one walk unit per tick.
  const single = await createHarness(t, { ...config, import_max_files: 1 });
  const one = outputs(await single.invoke({ methodId: "import_plan", inputs: [tickFrame(clock)] }));
  assert.equal(decodeIrm(one.get("job")[0]).nextIndex, FIRST_5M_UNIT + 1);
  assert.equal(names(one.get("names")[0]).length, 1);
});
