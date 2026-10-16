// Offline NOAA/NCEP GFS 0.5° E2E: initialization 2026-10-06 00 UTC, lead 24 h (valid 2026-10-07 00 UTC).
// Both compiled modules run in the SDK browser harness. The cassette is unmodified NOAA GRIB2; expected.json
// comes from ECMWF ecCodes via fixtures/generate-expected.py (clouds: the parser's fixture generator).
// Geographic lat/lon, rows south to north, longitude 0° eastward; units below are WXF units (clouds: fraction).
// Codes/hash/sample integers: zero tolerance. Affine parameters: 1e-15 relative for floating-point rounding;
// sampled values: 1e-9 relative, absolute 1e-9 near zero. Surface references store ecCodes' decoded values;
// cloud references store only its codes and affine parameters, already normalized from percent to fraction.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeHttpRequest, encodeHttpResponse, encodeTimerTick, identifierOf } from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const STANDARDS_ROOT = process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const WXF_LIB = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/WXF/main.js"));
const flatbuffers = createRequire(WXF_LIB)("flatbuffers");
const wxfLib = await import(WXF_LIB.href);
const SOURCE = new URL("../", import.meta.url), PARSER = new URL("../../nwp-grib2-parser/", import.meta.url);
const SET = new URL("tests/fixtures/noaa-2026100600-f024/", SOURCE);
const readJson = (url) => JSON.parse(fs.readFileSync(url, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const RUN_MS = Date.UTC(2026, 9, 6, 0);
const TICK = { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" };
const HRSP = { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" };
const CLOUD_NAMES = ["cloud_cover_total", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high"];
const FIELDS = [
  ["TCDC:entire atmosphere", "cloud_cover_total", "1"],
  ["LCDC:low cloud layer", "cloud_cover_low", "1"],
  ["MCDC:middle cloud layer", "cloud_cover_mid", "1"],
  ["HCDC:high cloud layer", "cloud_cover_high", "1"],
  ["TMP:2 m above ground", "air_temperature_2m", "K"],
  ["DPT:2 m above ground", "dew_point_temperature_2m", "K"],
  ["UGRD:10 m above ground", "wind_east_10m", "m s-1"],
  ["VGRD:10 m above ground", "wind_north_10m", "m s-1"],
  ["HPBL:surface", "boundary_layer_height_surface", "m"],
  ["CAPE:surface", "convective_available_potential_energy_surface", "J kg-1"],
  ["HGT:surface", "geopotential_height_surface", "gpm"],
];
const NAMES = FIELDS.map(([, name]) => name).sort();

async function createHarness(t, root, config = {}) {
  const harness = await createBrowserModuleHarness({
    wasmSource: new Uint8Array(fs.readFileSync(new URL("dist/isomorphic/module.wasm", root))),
    manifest: readJson(new URL("plugin-manifest.json", root)), surface: "direct", hostOptions: { config },
  });
  t.after(() => harness.destroy());
  return harness;
}
const tick = () => ({ portId: "tick", typeRef: TICK, payload: encodeTimerTick({ triggerId: "timer-nwp", firedMs: Date.UTC(2026, 9, 6, 5) }) });
const inventory = (request, body) => ({ portId: "inventories", typeRef: HRSP,
  payload: encodeHttpResponse({ url: request.url, status: 200, body, context: request.context }) });
const response = (request, body) => ({ portId: "responses", typeRef: HRSP,
  payload: encodeHttpResponse({ url: request.url, status: 206, body, context: request.context, retrievedMs: Date.UTC(2026, 9, 6, 5, 30) }) });
function ok(result) {
  assert.equal(result.statusCode, 0, `${result.errorCode}: ${result.errorMessage}`);
  return result;
}
const requestsOn = (result) => ok(result).outputs.filter((f) => f.portId === "requests").map((f) => decodeHttpRequest(f.payload));
function splitStream(payload) {
  const records = [], view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let off = 0; off < payload.byteLength;) {
    const len = view.getUint32(off, true); off += 4;
    assert.ok(len > 0 && off + len <= payload.byteLength, "complete size-prefixed record");
    records.push(payload.subarray(off, off + len)); off += len;
  }
  return records;
}
const unpackWxf = (bytes) => {
  assert.equal(identifierOf(bytes), "$WXF");
  return wxfLib.WXF.getRootAsWXF(new flatbuffers.ByteBuffer(Uint8Array.from(bytes))).unpack();
};
function recordCodes(r) {
  assert.equal(r.VALUES_ENCODING, wxfLib.wxfValuesEncoding.InlineEncodedChunk);
  assert.deepEqual(r.CHUNK_CODECS, ["delta", "zigzag", "shuffle"]);
  assert.equal(r.CHUNK_DTYPE, "uint16");
  const b = Uint8Array.from(r.QUANTIZED_U8), n = b.length / 2, c = new Uint16Array(n);
  for (let i = 0; i < n; i++) c[i] = b[i] | (b[n + i] << 8);
  for (let i = 0; i < n; i++) c[i] = ((c[i] >>> 1) ^ -(c[i] & 1)) & 0xffff;
  for (let i = 1; i < n; i++) c[i] = (c[i] + c[i - 1]) & 0xffff;
  return c;
}

test("gfs-0p50-clouds: real NOAA inventory through both WASM modules yields 4 cloud + 7 surface fields", async (t) => {
  const cassette = readJson(new URL("cassette.json", SET));
  const idx = fs.readFileSync(new URL(cassette.inventory, SET));
  const rows = idx.toString("utf8").trim().split("\n").map((line) => line.split(":"));
  const records = cassette.records.map((r) => {
    const field = FIELDS.find(([key]) => key === `${r.var}:${r.level}`);
    assert.ok(field, `unexpected cassette field ${r.var}:${r.level}`);
    const row = rows[r.line - 1];
    assert.deepEqual([Number(row[0]), Number(row[1]), row[2], row[3], row[4], row[5]],
      [r.line, r.offset, "d=2026100600", r.var, r.level, "24 hour fcst"]);
    assert.equal(Number(rows[r.line][1]) - r.offset, r.length, "cassette length matches real inventory");
    const bytes = fs.readFileSync(new URL(r.file, SET)).subarray(r.fileOffset, r.fileOffset + r.length);
    assert.equal(bytes.length, r.length);
    assert.equal(sha256(bytes), r.sha256, "unchanged NOAA record bytes");
    return { ...r, name: field[1], bytes };
  });
  assert.deepEqual(records.map((r) => r.name).sort(), NAMES, "cassette contains exactly the 11 named fields");
  const source = await createHarness(t, SOURCE, { nwp_run: "20261006T00", nwp_products: "gfs-0p50-clouds", nwp_max_lead: 24, nwp_lead_step: 24 });
  const plan = await source.invoke({ methodId: "plan", inputs: [tick()] });
  const inventories = requestsOn(plan).filter((r) => r.url === `${cassette.url}.idx`);
  assert.equal(inventories.length, 1, "one lead-24 inventory request");
  const request = inventories[0];
  assert.equal(request.url, `${cassette.url}.idx`);
  assert.equal(request.method, "GET");
  const headers = splitStream(request.context).map(unpackWxf);
  assert.equal(headers.length, 1, "CONTEXT carries one job header");
  const [job] = headers;
  assert.equal(job.FIELD_ID, "gfs:20261006T00:f024:gfs-0p50-clouds");
  assert.equal(job.VARIABLE_NAME, "gfs-0p50-clouds");
  assert.equal(job.LEAD_HOURS, 24);
  assert.equal(Number(job.INIT_TIME_MS), RUN_MS);
  assert.equal(job.SOURCE_URL, cassette.url);
  assert.deepEqual([job.GRID.DLAT, job.GRID.DLON, job.GRID.NLAT, job.TILE_COUNT], [0.5, 0.5, 0, 1]);

  const selected = await source.invoke({ methodId: "select_messages", inputs: [inventory(request, idx)] });
  const requests = requestsOn(selected);
  assert.equal(selected.outputs.filter((f) => f.portId === "status").length, 0, "no notices");
  assert.equal(selected.backlogRemaining, 0, "all ranges arrive in one batch");
  const covered = [], ranges = [];
  const responses = requests.map((r) => {
    assert.equal(r.method, "GET");
    assert.equal(r.url, cassette.url);
    assert.deepEqual(r.context, request.context, "job context is echoed verbatim");
    assert.match(r.headers.range, /^bytes=\d+-\d+$/);
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(r.headers.range);
    const start = Number(a), end = Number(b), chunks = [];
    assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start);
    for (let cursor = start; cursor <= end;) {
      const record = records.find((x) => x.offset === cursor);
      assert.ok(record && record.offset + record.length - 1 <= end, "the module asked for bytes outside the 11 records");
      chunks.push(record.bytes); covered.push(record); cursor += record.length;
    }
    ranges.push([start, end]);
    const body = Buffer.concat(chunks);
    assert.equal(body.length, end - start + 1);
    return response(r, body);
  });
  assert.deepEqual(covered.map((r) => r.name).sort(), NAMES, "requested records: exactly 4 cloud + 7 surface records");
  assert.deepEqual(covered.map((r) => [r.offset, r.length]).sort((a, b) => a[0] - b[0]),
    records.map((r) => [r.offset, r.length]).sort((a, b) => a[0] - b[0]), "range union covers every cassette byte exactly once");
  const u = records.find((r) => r.name === "wind_east_10m"), v = records.find((r) => r.name === "wind_north_10m");
  assert.ok(ranges.some(([a, b]) => a === u.offset && b === v.offset + v.length - 1), "adjacent UGRD/VGRD share a range");
  const before = covered.filter((r) => CLOUD_NAMES.includes(r.name)).reduce((n, r) => n + r.length, 0);
  const after = ranges.reduce((n, [a, b]) => n + b - a + 1, 0);
  console.log(`bytes per lead: before ${before} (4 records), after ${after} (11 records), x${(after / before).toFixed(2)}`);

  const parser = await createHarness(t, PARSER);
  const parsed = ok(await parser.invoke({ methodId: "parse", inputs: responses }));
  assert.equal(parsed.backlogRemaining, 0);
  const output = parsed.outputs.filter((f) => f.portId === "wxf_records").flatMap((f) => splitStream(f.payload)).map(unpackWxf);
  assert.deepEqual(output.map((r) => r.VARIABLE_NAME).sort(), NAMES, "exactly one whole-field WXF record per name");
  const expected = [...readJson(new URL("expected.json", SET))["gfs-0p50-surface.grib2"],
    ...readJson(new URL("tests/fixtures/noaa-2026100600-f024/expected.json", PARSER))["gfs-0p50-clouds.grib2"]];
  assert.deepEqual(expected.map((e) => e.name).sort(), NAMES);
  console.log(`${"name".padEnd(44)} grid      GRIB2 bytes  sha256 match`);
  for (const [, name, units] of FIELDS) {
    const r = output.find((r) => r.VARIABLE_NAME === name), e = expected.find((e) => e.name === name);
    assert.equal(r.FIELD_ID, `gfs:20261006T00:f24:${name}`);
    assert.deepEqual([r.TILE_COUNT, r.TILE_INDEX, r.GRID.NLON, r.GRID.NLAT], [1, 0, 720, 361]);
    assert.deepEqual([r.GRID.KIND, r.GRID.LAT0, r.GRID.LON0, r.GRID.DLAT, r.GRID.DLON, r.GRID.PERIODIC_LON],
      [wxfLib.wxfGridKind.RegularLatLon, e.lat0, e.lon0, e.dlat, e.dlon, true]);
    assert.deepEqual([e.nlon, e.nlat, e.init, e.lead], [720, 361, "20261006T00", 24]);
    assert.equal(Number(r.INIT_TIME_MS), RUN_MS);
    assert.equal(r.TIME_BASIS, wxfLib.wxfTimeBasis.Initialization);
    assert.equal(r.LEAD_HOURS, 24);
    assert.equal(Number(r.VALID_TIME_MS), Date.UTC(2026, 9, 7, 0));
    assert.equal(r.TEMPORAL_KIND, wxfLib.wxfTemporalKind.Instantaneous);
    assert.equal(r.UNITS, units);
    assert.equal(r.MISSING_COUNT, e.missing);
    assert.ok(Math.abs(r.SCALE_FACTOR - e.scale) <= Math.abs(e.scale) * 1e-15, `${name}: scale`);
    assert.ok(Math.abs(r.ADD_OFFSET - e.offset) <= Math.abs(e.offset) * 1e-15 + 1e-300, `${name}: offset`);
    const codes = recordCodes(r), littleEndian = Buffer.alloc(codes.length * 2);
    assert.equal(codes.length, 720 * 361);
    codes.forEach((code, i) => littleEndian.writeUInt16LE(code, i * 2));
    assert.equal(sha256(littleEndian), e.sha256, `${name}: every packing code equals ecCodes`);
    assert.equal(Object.keys(e.samples).length, 64);
    if (!CLOUD_NAMES.includes(name)) assert.deepEqual(Object.keys(e.values), Object.keys(e.samples));
    for (const [i, code] of Object.entries(e.samples)) {
      assert.equal(codes[Number(i)], code, `${name}: code at ${i}`);
      const value = codes[Number(i)] * r.SCALE_FACTOR + r.ADD_OFFSET;
      const reference = e.values ? e.values[i] : code * e.scale + e.offset;
      assert.ok(Math.abs(value - reference) <= Math.max(1, Math.abs(reference)) * 1e-9, `${name}: value at ${i}`);
    }
    console.log(`${name.padEnd(44)} 720x361   ${String(records.find((r) => r.name === name).length).padStart(11)}  yes`);
  }
});
