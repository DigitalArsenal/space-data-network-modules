// lola_plan / announce_files / publish_request on the Moon's walk (moon-terrain-lane-20261013).
//
// Properties of the SCHEDULE, all computable from the planner's own outputs:
//   * PARTITION: the whole walk plans every tile of the caps exactly once - 42 root tiles (levels 0-2), every tile of
//     levels 3-7, and at levels 8-10 exactly the tiles whose extent lies inside the cap's band (the counts below are
//     2^(2L+1) for a global level and rows x columns for a cap: L8 21 rows of 512 a hemisphere, L9 28 rows of 1024,
//     L10 28 rows of 2048, south only).
//   * WHOLE FILES: no 4x4 block of tiles (the unit pack writes a file for) is split across two units.
//   * RANGES: every unit asks for the product's label and three contiguous whole-line ranges, If-Match on the
//     product's ETag, within 72 MiB for a polar unit.
//   * RESUMABILITY: the mark is one integer; re-planning from it reproduces the unit.
//   * ANNOUNCE + MARK: added files become $PNM records with their IngestRequest; the walk:lola mark completes at the
//     end of the walk.

import assert from "node:assert/strict";
import test from "node:test";

import {
  createHarness,
  decodeHttpRequest,
  decodeIngestRequest,
  decodeIrm,
  decodeModuleConfig,
  decodePlan,
  encodeIngestResult,
  irmFrame,
  irmRecord,
  jobIdOf,
  markFrames,
  outputs,
  tickFrame,
  TYPE,
} from "./typed.mjs";
import { flatbuffers, STANDARDS_ROOT } from "../../terrain-source/typed-frames.mjs";

const PNM_LIB = await import(new URL(`file://${STANDARDS_ROOT}/lib/js/PNM/main.js`).href);

const CONFIG = { tileset_id: "nasa-lola-moon", dataset_epoch: "2019-03-15T00:00:00.000Z", retrieved_at: "2026-10-16T00:00:00.000Z" };
const JOB = jobIdOf("nasa-lola-gdr", CONFIG.tileset_id, CONFIG.dataset_epoch);
const EXPECTED = { 0: 2, 1: 8, 2: 32, 3: 128, 4: 512, 5: 2048, 6: 8192, 7: 32768, 8: 2 * 21 * 512, 9: 2 * 28 * 1024, 10: 28 * 2048 };

async function planAt(harness, index) {
  const inputs = [tickFrame("2026-10-16T00:00:00Z")];
  if (index > 0) inputs.push(...markFrames([irmRecord({ jobId: JOB, next: index, provider: "nasa-lola" })]));
  const out = outputs(await harness.invoke({ methodId: "lola_plan", inputs }));
  if (!out.has("plan")) return null;
  return {
    tiles: decodePlan(out.get("plan")[0]),
    requests: [0, 1, 2, 3].map((k) => decodeHttpRequest(out.get(`dem_${k}`)[0])),
    options: decodeModuleConfig(out.get("options")[0]),
    pack: decodeModuleConfig(out.get("pack")[0]),
    job: decodeIrm(out.get("job")[0]),
    jobBytes: out.get("job")[0],
  };
}

test("the Moon's walk plans every capped tile exactly once, in whole block files, by whole-line ranges", async (t) => {
  const harness = await createHarness(t, CONFIG);
  const seen = new Set(), perLevel = {}, blockUnit = new Map();
  let units = 0;
  for (let i = 0; ; i++) {
    const unit = await planAt(harness, i);
    if (!unit) break;
    units++;
    const h = unit.tiles[0];
    assert.equal(h.tilingScheme, 5, "GEOGRAPHIC_TWO_ROOT_BODY");
    assert.equal(h.sourceClass, 3, "SPACEBORNE_ALTIMETRIC");
    assert.equal(h.gridSize, 65);
    assert.match(h.provenance.NATIVE_ID, /^urn:nasa:pds:lro_lola_rdr:data_gridded:ldem_[0-9a-z_]+_float::1\.0$/);
    assert.equal(h.provenance.LICENSE, "Public domain (NASA)");
    assert.deepEqual(unit.options, { maxGridSize: 321, levelZeroErrorM: 1920, errorMetric: "rms" });
    assert.deepEqual(unit.pack, { pathPrefix: "terrain/301", rootMaxLevel: 2 });
    assert.equal(unit.job.nextIndex, i + 1);
    assert.ok(unit.job.tags.includes("walk:lola"));
    for (const tile of unit.tiles) {
      const key = `${tile.level}/${tile.x}/${tile.y}`;
      assert.ok(!seen.has(key), `${key} planned twice`);
      seen.add(key);
      perLevel[tile.level] = (perLevel[tile.level] ?? 0) + 1;
      if (tile.level > 2) {
        const block = `${tile.level}/${tile.x >> 2}/${tile.y >> 2}`;
        assert.ok(!blockUnit.has(block) || blockUnit.get(block) === i, `block ${block} split across units`);
        blockUnit.set(block, i);
      }
    }
    // The label, then three contiguous whole-line ranges of the same product.
    const [label, ...ranges] = unit.requests;
    assert.match(label.url, /\/data\/lola_gdr\/(cylindrical|polar)\/float_img\/ldem_[0-9a-z_]+_float\.lbl$/);
    assert.equal(h.provenance.SOURCE_URL, label.url.replace(/\.lbl$/, ".img"));
    let end = null, bytes = 0;
    const product = label.url.match(/(ldem_[0-9a-z_]+)_float\.lbl$/)[1];
    const recordBytes = { ldem_4: 5760, ldem_16: 23040, ldem_64: 92160 }[product] ?? { "240m": 15248, "120m": 30496, "60m": 60992 }[product.split("_").at(-1)];
    for (const r of ranges) {
      assert.equal(r.url, h.provenance.SOURCE_URL);
      const [, a, b] = r.headers.range.match(/^bytes=(\d+)-(\d+)$/).map(Number);
      assert.equal(a % recordBytes, 0, "a range starts on a line");
      assert.equal((b + 1) % recordBytes, 0, "and ends on one");
      if (end !== null) assert.equal(a, end + 1, "the three ranges are contiguous");
      end = b;
      bytes += b - a + 1;
      assert.match(r.headers["if-match"], /^"[0-9a-f]+:0"$/);
    }
    if (label.url.includes("polar")) assert.ok(bytes <= 72 * 2 ** 20, `unit ${i}: ${bytes} bytes of lines`);
  }
  assert.deepEqual(Object.fromEntries(Object.entries(perLevel).map(([k, v]) => [k, v])), Object.fromEntries(Object.entries(EXPECTED).map(([k, v]) => [k, v])));
  console.log(`moon walk: ${units} units, ${seen.size} tiles`);
});

test("the cap list is validated: an unknown product and a cap past a polar product's edge are refused", async (t) => {
  for (const caps of [
    [{ product: "ldem_9999", min_level: 0, max_level: 5 }],
    [{ product: "ldem_16", min_level: 0, max_level: 5, lat_min: -90, lat_max: 90 }, { product: "ldem_75s_60m", min_level: 10, max_level: 10, lat_min: -90, lat_max: -70 }],
    [{ product: "ldem_75s_60m", min_level: 0, max_level: 10, lat_min: -90, lat_max: -85 }],
  ]) {
    const harness = await createHarness(t, { ...CONFIG, lola_caps: caps });
    const response = await harness.invoke({ methodId: "lola_plan", inputs: [tickFrame("2026-10-16T00:00:00Z")] });
    assert.equal(response.errorCode, "invalid-lola-caps", JSON.stringify(caps));
  }
});

function pnmAdded(cid, name) {
  const b = new flatbuffers.Builder(256);
  const c = b.createString(cid), n = b.createString(name);
  PNM_LIB.PNM.startPNM(b);
  PNM_LIB.PNM.addCid(b, c);
  PNM_LIB.PNM.addFileName(b, n);
  PNM_LIB.PNM.finishSizePrefixedPNMBuffer(b, PNM_LIB.PNM.endPNM(b));
  return { portId: "added", typeRef: { schemaName: "PNM.fbs", fileIdentifier: "$PNM", rootTypeName: "PNM", wireFormat: "flatbuffer" }, payload: b.asUint8Array().slice() };
}

test("announce_files publishes one $PNM per added file and publish_request completes the walk at its end", async (t) => {
  const harness = await createHarness(t, CONFIG);
  const first = await harness.invoke({ methodId: "lola_plan", inputs: [tickFrame("2026-10-16T00:00:00Z")] });
  const total = first.backlogRemaining + 1;
  const last = await planAt(harness, total - 1);
  const cid = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
  const announced = await harness.invoke({ methodId: "announce_files", inputs: [irmFrame("job", last.jobBytes), pnmAdded(cid, "terrain/301/10/1_0.dtts")] });
  const out = outputs(announced);
  const pnm = PNM_LIB.PNM.getSizePrefixedRootAsPNM(new flatbuffers.ByteBuffer(out.get("records")[0])).unpack();
  assert.equal(pnm.CID, cid);
  assert.equal(pnm.MULTIFORMAT_ADDRESS, `/ipfs/${cid}`);
  assert.equal(pnm.FILE_NAME, "terrain/301/10/1_0.dtts");
  assert.equal(pnm.FILE_ID, `nasa-lola:moon-terrain:terrain/301/10/1_0.dtts:${cid}`);
  assert.equal(pnm.PUBLISH_TIMESTAMP, CONFIG.retrieved_at);
  const meta = decodeIngestRequest(out.get("meta")[0]);
  assert.equal(meta.schema, "PNM");
  assert.equal(meta.tags.providerId, "nasa-lola");
  assert.equal(meta.tags.sourceName, "moon-terrain");
  assert.equal(meta.tags.batchId, `${CONFIG.tileset_id}@${CONFIG.dataset_epoch}#${total - 1}`);
  const result = { portId: "result", typeRef: TYPE.INGR, payload: encodeIngestResult({ schema: "PNM", providerId: "nasa-lola", sourceName: "moon-terrain", batchId: meta.tags.batchId, inserted: 1 }) };
  const marked = outputs(await harness.invoke({ methodId: "publish_request", inputs: [result, { portId: "meta", typeRef: TYPE.INGQ, payload: out.get("meta")[0] }, irmFrame("job", last.jobBytes)] }));
  const mark = decodeIrm(marked.get("mark")[0]);
  assert.equal(mark.nextIndex, total);
  assert.equal(mark.state, 2, "COMPLETE at the end of the walk");
});
