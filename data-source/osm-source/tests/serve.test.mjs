// route(): the epoch record and the discovery document, the 503 without an
// epoch, the 304, the 404s and the 405 — against the compiled isomorphic
// artifact in the SDK's browser harness, config handed over the
// plugin.getConfig SDS $PIV hostcall as the Go node answers it: one
// ModuleConfig (MCFG) on raw "config", nulls left out.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { decodeHttpResponse, encodeHttpRequest, HTTP_REQUEST_TYPE_REF } from "space-data-module-sdk/http";
import { encodeModuleConfig } from "space-data-module-sdk/runtime-contracts";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const decoder = new TextDecoder();

/** A record as tools/osm-context/build-fgb.mjs writes it (trimmed). */
const RECORD = {
  FORMAT: "osm-context-fgb/1",
  TILESET_ID: "osm-context-hessen-20260902T202051Z-fgb",
  REGION: "hessen",
  CRS: "EPSG:4326",
  PAYLOAD: { CID: "", SIZE_BYTES: 1112345678, MEDIA_TYPE: "application/vnd.ipld.dag-pb" },
  FILES: [
    { NAME: "building.fgb", CATEGORY: "building", KIND: "polygon", MEDIA_TYPE: "application/x-flatgeobuf", BYTES: 797351152, SHA256: "a".repeat(64), FEATURE_COUNT: 2763936, LAYER: "multipolygons", WHERE: "building IS NOT NULL AND building <> 'no'" },
    { NAME: "road-lines.fgb", CATEGORY: "road", KIND: "line", MEDIA_TYPE: "application/x-flatgeobuf", BYTES: 281731032, SHA256: "b".repeat(64), FEATURE_COUNT: 1189806, LAYER: "lines", WHERE: "highway IS NOT NULL" },
    { NAME: "ocean.fgb", CATEGORY: "water", KIND: "polygon", MEDIA_TYPE: "application/x-flatgeobuf", BYTES: 12345, SHA256: "c".repeat(64), FEATURE_COUNT: 0, LAYER: "ocean", WHERE: null },
  ],
  DATASET_EPOCH: "2026-09-02T20:20:51Z",
  PROVENANCE: {
    SOURCE: "OpenStreetMap",
    SOURCE_URL: "https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf",
    RETRIEVED_AT: "2026-09-03T18:56:15Z",
    PROCESSOR: "osmium-tool 1.19.1 + GDAL 3.13.3 (ogr2ogr FlatGeobuf)",
    LICENSE: "ODbL-1.0",
    SHARE_ALIKE: true,
    ATTRIBUTION: "© OpenStreetMap contributors",
    OCEAN: null,
  },
};
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
/** The config as the node holds it: nulls are left out of a ModuleConfig (Go node runtimecfg.Encode). */
const withoutNulls = (v) =>
  Array.isArray(v) ? v.map(withoutNulls)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, withoutNulls(x)]))
      : v;
const CONFIG = { osm_epoch_cid: CID, osm_epoch_record: RECORD, osm_attribution: "© OpenStreetMap contributors" };

async function invoke(t, inputs, config) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostOptions: { config: withoutNulls(config) },
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId: "route", inputs });
}

const requestFrame = (path, { method = "GET", headers = {}, query = "" } = {}) => ({
  portId: "request",
  typeRef: HTTP_REQUEST_TYPE_REF,
  payload: encodeHttpRequest({ method, path, query, headers }),
});

function response(result) {
  assert.equal(result.statusCode, 0, `${result.errorCode}: ${result.errorMessage}`);
  const out = result.outputs.find((o) => o.portId === "response");
  assert.ok(out, "a response frame");
  const decoded = decodeHttpResponse(out.payload);
  const headers = {};
  for (const h of decoded.headers ?? []) headers[h.name.toLowerCase()] = h.value;
  const body = decoded.body ? decoder.decode(decoded.body) : "";
  return { status: decoded.status, headers, body };
}

const multihashEtag = (body) => `"1220${createHash("sha256").update(body).digest("hex")}"`;

test("tileset.json renders the builder's record with the pinned CID, a relative base path, a strong ETag and CORS", async (t) => {
  const r = response(await invoke(t, [requestFrame("/api/v1/osm/tileset.json")], CONFIG));
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "application/json");
  assert.equal(r.headers["cache-control"], "public, max-age=60");
  assert.equal(r.headers["access-control-allow-origin"], "*");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers.etag, multihashEtag(r.body));
  const record = JSON.parse(r.body);
  assert.deepEqual(Object.keys(record), ["FORMAT", "TILESET_ID", "REGION", "CRS", "PAYLOAD", "EPOCH_BASE_PATH", "FILES", "DATASET_EPOCH", "PROVENANCE"]);
  assert.equal(record.FORMAT, "osm-context-fgb/1");
  assert.deepEqual(record.PAYLOAD, { CID, SIZE_BYTES: 1112345678, MEDIA_TYPE: "application/vnd.ipld.dag-pb" });
  assert.equal(record.EPOCH_BASE_PATH, `/ipfs/${CID}/`);
  assert.deepEqual(record.FILES, RECORD.FILES, "FILES verbatim");
  assert.deepEqual(record.PROVENANCE, RECORD.PROVENANCE, "PROVENANCE verbatim");
  // Byte-identical to what the JSON-config build served: the builder's key order, its nulls kept.
  const { FORMAT, TILESET_ID, REGION, CRS, PAYLOAD, FILES, DATASET_EPOCH, PROVENANCE } = RECORD;
  assert.equal(r.body, JSON.stringify({ FORMAT, TILESET_ID, REGION, CRS, PAYLOAD: { ...PAYLOAD, CID }, EPOCH_BASE_PATH: `/ipfs/${CID}/`, FILES, DATASET_EPOCH, PROVENANCE }));
  assert.equal(record.DATASET_EPOCH, RECORD.DATASET_EPOCH);

  // Conditional: the same ETag answers 304 with no body; another one answers 200.
  const same = response(await invoke(t, [requestFrame("/api/v1/osm/tileset.json", { headers: { "If-None-Match": r.headers.etag } })], CONFIG));
  assert.equal(same.status, 304);
  assert.equal(same.body, "");
  const other = response(await invoke(t, [requestFrame("/api/v1/osm/tileset.json", { headers: { "if-none-match": '"nope"' } })], CONFIG));
  assert.equal(other.status, 200);
});

test("without a pinned epoch the record route answers 503 naming the missing keys; the discovery document says delivery none", async (t) => {
  const r = response(await invoke(t, [requestFrame("/api/v1/osm/tileset.json")], {}));
  assert.equal(r.status, 503);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.deepEqual(JSON.parse(r.body).missingConfigKeys, ["osm_epoch_record", "osm_epoch_cid"]);
  const partial = response(await invoke(t, [requestFrame("/api/v1/osm/tileset.json")], { osm_epoch_record: RECORD, osm_epoch_cid: "not-a-cid" }));
  assert.equal(partial.status, 503);
  assert.deepEqual(JSON.parse(partial.body).missingConfigKeys, ["osm_epoch_cid"]);
  const c = response(await invoke(t, [requestFrame("/api/v1/osm/")], {}));
  assert.equal(c.status, 200);
  assert.deepEqual(JSON.parse(c.body), {
    epochId: null, delivery: "none", cid: null, datasetEpoch: null, epochBasePath: null,
    recordPath: "/api/v1/osm/tileset.json", format: "osm-context-fgb/1", attribution: "© OpenStreetMap contributors",
  });
});

test("the discovery document names the epoch, and the config can arrive on a frame", async (t) => {
  const configFrame = {
    portId: "config",
    typeRef: { schemaName: "ModuleConfig.fbs", fileIdentifier: "MCFG", rootTypeName: "ModuleConfig", wireFormat: "flatbuffer" },
    payload: encodeModuleConfig(withoutNulls({ ...CONFIG, osm_mount_path: "/osm", osm_gateway_path: "/gw" })),
  };
  const r = response(await invoke(t, [requestFrame("/osm/catalogue.json"), configFrame], {}));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), {
    epochId: "osm-context-hessen-20260902T202051Z-fgb", delivery: "ipfs", cid: CID, datasetEpoch: "2026-09-02T20:20:51Z",
    epochBasePath: `/gw/${CID}/`, recordPath: "/osm/tileset.json", format: "osm-context-fgb/1", attribution: "© OpenStreetMap contributors",
  });
  assert.equal(r.headers.etag, multihashEtag(r.body));
  const record = response(await invoke(t, [requestFrame("/osm/tileset.json"), configFrame], {}));
  assert.equal(JSON.parse(record.body).EPOCH_BASE_PATH, `/gw/${CID}/`);
  const junk = await invoke(t, [requestFrame("/osm/tileset.json"), { ...configFrame, payload: new TextEncoder().encode("{\"osm_mount_path\":\"/osm\"}") }], {});
  assert.equal(junk.errorCode, "invalid-config-frame");
});

test("an OCEAN table renders as an object in the builder's key order, and keys the builder does not write follow sorted", async (t) => {
  const ocean = { SOURCE_URL: "https://osmdata.openstreetmap.de/download/water-polygons-split-3857.zip", SHA256: "d".repeat(64), FILES_DATED: "2026-08-30", LICENSE: "ODbL-1.0" };
  const record = { ...RECORD, PROVENANCE: { ...RECORD.PROVENANCE, OCEAN: ocean, ZETA: [1.5, 2], ALPHA: ["x", "y"] } };
  const r = response(await invoke(t, [requestFrame("/api/v1/osm/tileset.json")], { ...CONFIG, osm_epoch_record: record }));
  assert.equal(r.status, 200);
  assert.ok(r.body.includes(`"OCEAN":${JSON.stringify(ocean)},"ALPHA":["x","y"],"ZETA":[1.5,2]}`), r.body);
});

test("outside the mount and unknown routes are no-store 404s; non-GET is 405", async (t) => {
  const outside = response(await invoke(t, [requestFrame("/api/v1/terrain/tileset.json")], CONFIG));
  assert.equal(outside.status, 404);
  assert.equal(outside.headers["cache-control"], "no-store");
  const unknown = response(await invoke(t, [requestFrame("/api/v1/osm/building.fgb")], CONFIG));
  assert.equal(unknown.status, 404);
  assert.match(unknown.body, /not an OSM context route/);
  const post = response(await invoke(t, [requestFrame("/api/v1/osm/tileset.json", { method: "POST" })], CONFIG));
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
  const head = response(await invoke(t, [requestFrame("/api/v1/osm/tileset.json", { method: "HEAD" })], CONFIG));
  assert.equal(head.status, 200);
});
