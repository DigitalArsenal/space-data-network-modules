// THE CATALOGUE: how a client learns which tileset epoch to fetch.
//
// OWNER 2026-08-27: terrain files are requested over IPFS. The pyramid is one
// content-addressed directory per epoch, and a client points a native terrain
// provider at <gateway>/ipfs/<cid>/. The CID is the one thing a client cannot
// derive, must not hardcode (a hardcoded CID is pinned to a dead epoch the day
// the dataset is recut) and must not learn from a hostname (the owner refused
// a static asset hostname on the same day).
//
// So the mount answers ONE question at its root: which directory is current.
// These tests hold that answer to the shape the clients read, and hold the
// FALLBACK honest — a node with no CID configured says so, and says the mount
// path instead, which is what makes a development node with no IPFS daemon
// work unchanged.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as sds from "spacedatastandards.org";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { decodeHttpResponse, encodeHttpRequest, HTTP_REQUEST_TYPE_REF } from "space-data-module-sdk/http";

// The SAME projector the builder writes tileset-catalogue.dttstream through.
import { buildDttRecord, writeDttRecord } from "../../../tools/terrain-pyramid/dtt-projection.mjs";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const decoder = new TextDecoder();

const CID = "bafybeifkp4sq2qcw7chfcdolv4tdyjpicfzxj6lp76dbpwuvsux43bycje";

const BASE = {
  terrain_tileset_id: "spaceaware-terrain",
  terrain_maxzoom: 13,
  terrain_available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]],
  terrain_attribution: "Copernicus DEM",
  terrain_version: "1.0.0",
};
// The four fields schema/DTT/main.fbs marks `required` on DTTProvenance. A
// mount configured with less than this cannot build a $DTT and now says so
// (503) instead of answering an unbuildable document with 200.
const REQUIRED_PROVENANCE = {
  terrain_dataset_id: "copernicus-glo30-quantized-mesh",
  terrain_dataset_epoch: "2023-04-01T00:00:00.000Z",
  terrain_dataset_retrieved_at: "2026-08-26T00:00:00.000Z",
  terrain_license: "Copernicus DEM: free, full and open licence",
};
const OVER_IPFS = {
  ...BASE,
  ...REQUIRED_PROVENANCE,
  terrain_tileset_cid: CID,
  terrain_gateway_origin: "https://sdn.spaceaware.io",
};

async function get(t, path, config, headers = {}) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return config;
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  const response = await harness.invoke({
    methodId: "route",
    inputs: [
      {
        portId: "request",
        typeRef: HTTP_REQUEST_TYPE_REF,
        payload: encodeHttpRequest({ method: "GET", path, headers }),
      },
    ],
  });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const out = response.outputs.find((o) => o.portId === "response");
  assert.ok(out, `route produced no direct response for ${path}`);
  const http = decodeHttpResponse(new Uint8Array(out.payload));
  const headerOf = (name) =>
    (http.headers ?? []).find((h) => h.name?.toLowerCase() === name)?.value ?? "";
  return { http, headerOf, body: () => JSON.parse(decoder.decode(http.body)) };
}

test("the mount root names the CID a client should fetch tiles from", async (t) => {
  const { http, headerOf, body } = await get(t, "/api/v1/terrain/", OVER_IPFS);
  assert.equal(http.status, 200);
  const doc = body();
  assert.equal(doc.delivery, "ipfs");
  assert.equal(doc.cid, CID);
  // The path is RELATIVE so a client joins it against the node origin it is
  // already talking to. Nothing here names a host a client has to trust.
  assert.equal(doc.terrainBasePath, `/ipfs/${CID}/`);
  assert.equal(doc.layerJsonPath, `/ipfs/${CID}/layer.json`);
  assert.equal(doc.terrainBaseUrl, `https://sdn.spaceaware.io/ipfs/${CID}/`);
  assert.equal(doc.tilesetId, "spaceaware-terrain");
  assert.equal(doc.datasetEpoch, "2023-04-01T00:00:00.000Z");
  assert.equal(doc.maxzoom, 13);
  assert.equal(doc.format, "quantized-mesh-1.0");
  assert.equal(doc.scheme, "tms");
  assert.deepEqual(doc.extensions, ["watermask"]);
  assert.equal(doc.attribution, "Copernicus DEM");
  assert.equal(headerOf("content-type"), "application/json");
  // A minute: everything under a CID is immutable, and this is the lane's one
  // mutable pointer.
  assert.equal(headerOf("cache-control"), "public, max-age=60");
  assert.equal(headerOf("access-control-allow-origin"), "*");
  assert.match(headerOf("etag"), /^"[0-9a-f]+"$/);
});

test("/catalogue.json is the same document under an explicit name", async (t) => {
  const root = await get(t, "/api/v1/terrain/", OVER_IPFS);
  const named = await get(t, "/api/v1/terrain/catalogue.json", OVER_IPFS);
  assert.equal(named.http.status, 200);
  assert.deepEqual(named.body(), root.body());
  assert.equal(named.headerOf("etag"), root.headerOf("etag"));
});

test("a revalidation of the pointer is a 304", async (t) => {
  const first = await get(t, "/api/v1/terrain/", OVER_IPFS);
  const etag = first.headerOf("etag");
  const again = await get(t, "/api/v1/terrain/", OVER_IPFS, { "if-none-match": etag });
  assert.equal(again.http.status, 304);
  assert.equal(again.http.body.length, 0);
});

test("a node with no CID configured says so, and names its own mount", async (t) => {
  const { http, body } = await get(t, "/api/v1/terrain/", BASE);
  assert.equal(http.status, 200);
  const doc = body();
  // NOT a 404 and NOT a fabricated CID: a development node with no IPFS daemon
  // serves its own tiles, and the client reads one document either way.
  assert.equal(doc.delivery, "mount");
  assert.equal(doc.cid, null);
  assert.equal(doc.datasetEpoch, null);
  assert.equal(doc.terrainBasePath, "/api/v1/terrain/");
  assert.equal(doc.layerJsonPath, "/api/v1/terrain/layer.json");
  assert.ok(!("terrainBaseUrl" in doc), "no absolute URL without a gateway origin");
});

test("the pointer moves when the epoch does", async (t) => {
  const other = "bafybeia7a7l77nmng2zqseebbmzl6mdxprsvrgg7udsatoner6yfexwpny";
  const a = await get(t, "/api/v1/terrain/", OVER_IPFS);
  const b = await get(t, "/api/v1/terrain/", { ...OVER_IPFS, terrain_tileset_cid: other });
  assert.notEqual(a.body().cid, b.body().cid);
  // A stale ETag must not revalidate against the new epoch, or a client holding
  // the old pointer never learns the tileset was recut.
  assert.notEqual(a.headerOf("etag"), b.headerOf("etag"));
});

test("the catalogue does not shadow the tile and layer.json routes", async (t) => {
  const layer = await get(t, "/api/v1/terrain/layer.json", OVER_IPFS).catch(() => null);
  // layer.json leaves through the layer_plan port, not `response`, so the
  // helper's assertion failing IS the evidence the route still belongs to it.
  assert.equal(layer, null, "layer.json must still be planned, not answered here");
});

test("layer.json states the tiles template the mount configures", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") {
        // What the IPFS publisher configures: a CID needs no `?v=` cache-key
        // query, because the CID is already the cache key.
        return { ...BASE, terrain_tiles_template: "{z}/{x}/{y}.terrain" };
      }
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  const routed = await harness.invoke({
    methodId: "route",
    inputs: [
      {
        portId: "request",
        typeRef: HTTP_REQUEST_TYPE_REF,
        payload: encodeHttpRequest({
          method: "GET",
          path: "/api/v1/terrain/layer.json",
          headers: { "accept-encoding": "identity" },
        }),
      },
    ],
  });
  const plan = routed.outputs.find((o) => o.portId === "layer_plan");
  const rendered = await harness.invoke({
    methodId: "layer_json",
    inputs: [
      {
        portId: "plan",
        typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: plan.payload.byteLength },
        payload: plan.payload,
      },
    ],
  });
  assert.equal(rendered.statusCode, 0, `${rendered.errorCode}: ${rendered.errorMessage}`);
  const http = decodeHttpResponse(new Uint8Array(rendered.outputs[0].payload));
  const doc = JSON.parse(decoder.decode(http.body));
  assert.deepEqual(doc.tiles, ["{z}/{x}/{y}.terrain"]);
  assert.deepEqual(doc.extensions, ["watermask"]);
  assert.equal(doc.scheme, "tms");
  assert.equal(doc.format, "quantized-mesh-1.0");
});

test("the default tiles template is unchanged for a mount-served tileset", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return BASE;
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  const routed = await harness.invoke({
    methodId: "route",
    inputs: [
      {
        portId: "request",
        typeRef: HTTP_REQUEST_TYPE_REF,
        payload: encodeHttpRequest({
          method: "GET",
          path: "/api/v1/terrain/layer.json",
          headers: { "accept-encoding": "identity" },
        }),
      },
    ],
  });
  const plan = routed.outputs.find((o) => o.portId === "layer_plan");
  const rendered = await harness.invoke({
    methodId: "layer_json",
    inputs: [
      {
        portId: "plan",
        typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: plan.payload.byteLength },
        payload: plan.payload,
      },
    ],
  });
  const http = decodeHttpResponse(new Uint8Array(rendered.outputs[0].payload));
  const doc = JSON.parse(decoder.decode(http.body));
  assert.deepEqual(doc.tiles, ["{z}/{x}/{y}.terrain?v={version}"]);
});

// ---------------------------------------------------------------------------
// /tileset.json — THE PATH AND SHAPE THE CLIENTS ACTUALLY READ.
//
// The console resolves the epoch by fetching <node>/api/v1/terrain/tileset.json
// and pulling PAYLOAD.CID from it: a $DTT field, IDL-exact, not a camelCase
// alias. Serving the discovery document only at the mount root and
// catalogue.json left that fetch falling through to the tile parser as a 404 —
// the console reports "terrain catalogue answered HTTP 404", keeps the
// ellipsoid by its never-halt rule, and renders no terrain, while every tile
// under /ipfs/ answers perfectly. Both sides were green against their own
// fixtures and incompatible only where they meet.
//
// These tests are that meeting point, written from the CLIENT's reader:
// globeSurfaces.ts pulls PAYLOAD.CID (or TILESET.PAYLOAD.CID) and refuses any
// value that is not a syntactically valid CID.
// ---------------------------------------------------------------------------

// The client's own CID grammar (globeSurfaces.ts): CIDv0 base58btc or CIDv1
// base32. A value that is not one is refused rather than pasted into a URL.
const CLIENT_CID_PATTERN = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/;

test("/tileset.json answers the $DTT catalogue record, with IDL-exact keys", async (t) => {
  const { http, headerOf, body } = await get(t, "/api/v1/terrain/tileset.json", OVER_IPFS);
  assert.equal(http.status, 200);
  assert.equal(headerOf("content-type"), "application/json");
  assert.equal(headerOf("cache-control"), "public, max-age=60");
  assert.equal(headerOf("access-control-allow-origin"), "*");

  const record = body();
  // IDL-exact keys (Themis): a $DTT rendered as JSON never takes camelCase.
  assert.equal(record.TILESET_ID, "spaceaware-terrain");
  assert.equal(record.PAYLOAD_FORMAT, "QUANTIZED_MESH");
  assert.equal(record.PAYLOAD_FORMAT_VERSION, "1.0");
  assert.equal(record.MAX_LEVEL, 13);
  // THE ADDRESS AND THE EXTENT DO NOT CONTRADICT EACH OTHER. This used to
  // state GEOGRAPHIC_WGS84 with LEVEL/X/Y 0/0/0 and WEST/EAST -180/180 — and
  // under that scheme the IDL defines level 0 as two roots covering [-180,0]
  // and [0,180], so the address named HALF the extent the record spelled out.
  // The catalogue is the DIRECTORY, not a tile: no scheme, so no address.
  assert.equal(record.TILING_SCHEME, "UNSPECIFIED");
  assert.equal(record.LEVEL, undefined);
  assert.equal(record.X, undefined);
  assert.equal(record.Y, undefined);
  assert.equal(record.WEST_DEG, undefined, "no extent is stated unless the mount is told one");
  // The discriminator against a TILE record is the payload's media type: a
  // tile is one mesh, the catalogue is the DIRECTORY the tiles live in.
  assert.equal(record.PAYLOAD.MEDIA_TYPE, "application/vnd.ipld.dag-pb");
  assert.equal(record.PROVENANCE.DATASET_EPOCH, "2023-04-01T00:00:00.000Z");
  assert.equal(record.PROVENANCE.ATTRIBUTION, "Copernicus DEM");
  // No camelCase alias leaks into the record form.
  assert.equal(record.cid, undefined);
  assert.equal(record.terrainBasePath, undefined);
});

test("THE CLIENT'S READER finds the CID in it", async (t) => {
  const { body } = await get(t, "/api/v1/terrain/tileset.json", OVER_IPFS);
  const record = body();
  // Exactly what globeSurfaces.ts does, transcribed.
  const readTilesetCid = (node) => {
    const payload = node?.PAYLOAD;
    if (typeof payload?.CID === "string" && CLIENT_CID_PATTERN.test(payload.CID)) return payload.CID;
    const wrapped = node?.TILESET?.PAYLOAD;
    if (typeof wrapped?.CID === "string" && CLIENT_CID_PATTERN.test(wrapped.CID)) return wrapped.CID;
    return null;
  };
  assert.equal(readTilesetCid(record), CID, "the console must resolve the epoch from this document");
});

test("a revalidation of the record is a 304", async (t) => {
  const first = await get(t, "/api/v1/terrain/tileset.json", OVER_IPFS);
  const etag = first.headerOf("etag");
  assert.ok(etag && !etag.startsWith("W/"), `a strong ETag, got ${etag}`);
  const second = await get(t, "/api/v1/terrain/tileset.json", OVER_IPFS, {
    "if-none-match": etag,
  });
  assert.equal(second.http.status, 304);
});

test("the record moves when the epoch does", async (t) => {
  const other = "bafybeidr3l5zoi6gxui3vuuvfc5sadl3zlkotonukuxysw7fws54s2npmy";
  const a = await get(t, "/api/v1/terrain/tileset.json", OVER_IPFS);
  const b = await get(t, "/api/v1/terrain/tileset.json", {
    ...OVER_IPFS,
    terrain_tileset_cid: other,
  });
  assert.equal(a.body().PAYLOAD.CID, CID);
  assert.equal(b.body().PAYLOAD.CID, other);
  assert.notEqual(a.headerOf("etag"), b.headerOf("etag"));
});

test("a node with NO CID answers a record whose PAYLOAD is present and empty", async (t) => {
  // Not an error: this node is not serving an IPFS tileset. The client finds
  // no PAYLOAD.CID, says so, and keeps its ellipsoid — the correct outcome,
  // and never a CID invented to make a fetch succeed.
  //
  // But DTT marks PAYLOAD `required`, so OMITTING the table made this shape
  // unbuildable — and this very test asserted the omission as correct. The
  // ref is present and states nothing, which is the truthful shape for a node
  // with no content-addressed directory to name AND a record the builder can
  // serialize. The client's reader is unaffected: no CID either way.
  const { http, body } = await get(t, "/api/v1/terrain/tileset.json", {
    ...BASE,
    ...REQUIRED_PROVENANCE,
  });
  assert.equal(http.status, 200);
  const record = body();
  assert.deepEqual(record.PAYLOAD, {}, "present, and naming nothing");
  assert.equal(record.TILESET_ID, "spaceaware-terrain");
  assert.ok(writeDttRecord(sds, record).length > 0, "and it is a $DTT");
});

test("a mount that cannot state its lineage REFUSES to publish a catalogue", async (t) => {
  // The four required DTTProvenance fields are not decoration: a node that
  // cannot say which dataset edition it redistributes, when it was retrieved
  // and under what licence has no business publishing redistributed
  // elevation. An empty string would satisfy FlatBuffers and tell a consumer
  // nothing, which is worse than refusing.
  const { http, headerOf, body } = await get(t, "/api/v1/terrain/tileset.json", BASE);
  assert.equal(http.status, 503);
  assert.equal(headerOf("cache-control"), "no-store");
  assert.deepEqual(body().missingConfigKeys, [
    "terrain_dataset_id",
    "terrain_dataset_epoch",
    "terrain_dataset_retrieved_at",
    "terrain_license",
  ]);

  // One missing field is enough, and the refusal names exactly that one.
  const partial = await get(t, "/api/v1/terrain/tileset.json", {
    ...OVER_IPFS,
    terrain_dataset_retrieved_at: "",
  });
  assert.equal(partial.http.status, 503);
  assert.deepEqual(partial.body().missingConfigKeys, ["terrain_dataset_retrieved_at"]);
});

test("THE DOCUMENT IS A RECORD: it round-trips through the published SDS builder", async (t) => {
  // The gap that let an invalid record pass 100 tests: every assertion above
  // reads KEYS, and none of them ever built the thing. schema/DTT/main.fbs
  // marks TILESET_ID, PAYLOAD and PROVENANCE required on DTT and DATASET_ID,
  // DATASET_EPOCH, RETRIEVED_AT and LICENSE required on DTTProvenance, and
  // writeFB is the only thing that enforces them.
  const { body } = await get(t, "/api/v1/terrain/tileset.json", {
    ...OVER_IPFS,
    terrain_dataset_name: "copernicus-glo30",
    terrain_license_url: "https://spacedata.copernicus.eu/",
    terrain_tileset_size_bytes: 375_000_000,
    terrain_west_deg: 7.734375,
    terrain_south_deg: 42.890625,
    terrain_east_deg: 12.65625,
    terrain_north_deg: 47.109375,
  });
  const projection = body();

  // buildDttRecord refuses any key the IDL does not define, so this is also
  // the assertion that "IDL-exact keys" holds for EVERY key, not the six the
  // tests above happen to name.
  const bytes = writeDttRecord(sds, projection);
  assert.ok(bytes.length > 0);

  // And it reads back as the same record.
  const [read] = sds.readFB(bytes);
  assert.equal(read.TILESET_ID, "spaceaware-terrain");
  assert.equal(read.PAYLOAD.CID, CID);
  assert.equal(read.PAYLOAD.MEDIA_TYPE, "application/vnd.ipld.dag-pb");
  assert.equal(read.PAYLOAD.SIZE_BYTES, 375_000_000n);
  assert.equal(read.PROVENANCE.RETRIEVED_AT, "2026-08-26T00:00:00.000Z");
  assert.equal(read.PROVENANCE.LICENSE, "Copernicus DEM: free, full and open licence");
  assert.equal(read.MAX_LEVEL, 13);
  assert.equal(read.WEST_DEG, 7.734375);
  assert.equal(read.EAST_DEG, 12.65625);
  // UNSPECIFIED is ordinal 0 — "an unset field can never be read as a real
  // scheme" — which is what a record with no address is entitled to say.
  assert.equal(read.TILING_SCHEME, sds.standards.DTT.dttTilingScheme.UNSPECIFIED);

  // A key the IDL does not define is a defect, not a passthrough.
  assert.throws(
    () => buildDttRecord(sds, { ...projection, TILESET_CID: CID }),
    /TILESET_CID is not a field of the standard/,
  );
});

test("PROVENANCE carries only what the mount was TOLD", async (t) => {
  // A lineage field invented by the mount would be a claim about a dataset
  // this module never read.
  const { body } = await get(t, "/api/v1/terrain/tileset.json", {
    ...OVER_IPFS,
    terrain_dataset_name: "copernicus-glo30",
    terrain_license_url: "https://spacedata.copernicus.eu/",
  });
  const prov = body().PROVENANCE;
  assert.equal(prov.DATASET_ID, "copernicus-glo30-quantized-mesh");
  assert.equal(prov.DATASET_NAME, "copernicus-glo30");
  assert.equal(prov.RETRIEVED_AT, "2026-08-26T00:00:00.000Z");
  assert.equal(prov.LICENSE, "Copernicus DEM: free, full and open licence");
  assert.equal(prov.LICENSE_URL, "https://spacedata.copernicus.eu/");
  // ── DATASET_CID IS NOT THE TILESET DIRECTORY ────────────────────────────
  //
  // It used to be a copy of terrain_tileset_cid, and that copy is what made
  // two clients reading two different fields agree by coincidence. The IDL
  // defines DATASET_CID as "the exact dataset artifact" the publisher
  // distributes — the SOURCE DEM — and the tileset directory is PAYLOAD.CID.
  // Nothing may be read as the tileset except PAYLOAD.CID.
  assert.equal(
    prov.DATASET_CID,
    undefined,
    "the tileset CID must NOT be copied into the source dataset's provenance field",
  );

  // The OPTIONAL fields are still never invented — only the four the IDL
  // requires are demanded, and nothing beyond them is filled in.
  // …and DATASET_CID is stated only when an operator names a SOURCE artifact,
  // under its own key, which is a different value from the tileset CID.
  const sourced = (
    await get(t, "/api/v1/terrain/tileset.json", {
      ...OVER_IPFS,
      terrain_source_dataset_cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    })
  ).body();
  assert.equal(sourced.PAYLOAD.CID, CID, "the tileset directory is still PAYLOAD.CID");
  assert.equal(
    sourced.PROVENANCE.DATASET_CID,
    "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
    "and DATASET_CID names the source artifact, which is a different CID",
  );

  const bare = (await get(t, "/api/v1/terrain/tileset.json", OVER_IPFS)).body().PROVENANCE;
  assert.equal(bare.DATASET_NAME, undefined);
  assert.equal(bare.LICENSE_URL, undefined, "no licence URL is invented when none is configured");
  assert.equal(bare.SOURCE_URL, undefined);
  assert.equal(bare.GENERATED_AT, undefined, "the mount states no production timestamp of its own");
});

test("tileset.json does not shadow layer.json or the camelCase catalogue", async (t) => {
  // layer.json leaves through the layer_plan port, not `response`, so the
  // helper failing to find a direct response IS the evidence the route still
  // belongs to it and tileset.json did not swallow it.
  const layer = await get(t, "/api/v1/terrain/layer.json", OVER_IPFS).catch(() => null);
  assert.equal(layer, null, "layer.json must still be planned, not answered here");
  const cat = await get(t, "/api/v1/terrain/catalogue.json", OVER_IPFS);
  assert.equal(cat.http.status, 200);
  assert.equal(cat.body().cid, CID, "the camelCase document is unchanged");
  assert.equal(cat.body().delivery, "ipfs");
});

// ── THE DATUM TRAVELS WITH THE TILESET ──────────────────────────────────────
//
// Every per-tile $DTT states VERTICAL_DATUM GEOID and VERTICAL_DATUM_NAME
// EGM2008. The IPFS delivery path publishes layer.json and the .terrain bytes
// and NOT the per-tile records, so the catalogue record and layer.json are the
// only two documents a client on that path reads — and both used to drop the
// datum, leaving it wire-defaulted to UNSPECIFIED, which the IDL defines as
// "the datum is not stated; heights are not comparable across tiles". A
// consumer then renders these orthometric heights as WGS84 ellipsoidal ones
// and sits low by the local undulation (~48 m in Liguria). This stack feeds
// those heights to sensor viewshed and RF terrain analysis.
test("the catalogue record STATES the vertical datum, and its name", async (t) => {
  const record = (await get(t, "/api/v1/terrain/tileset.json", OVER_IPFS)).body();
  assert.equal(record.VERTICAL_DATUM, "GEOID");
  assert.equal(record.VERTICAL_DATUM_NAME, "EGM2008");
  assert.match(
    record.REMARKS,
    /no geoid-to-ellipsoid conversion is applied/,
    "the encoder's own bounded-offset warning reaches a reader of the catalogue alone",
  );
  // And it is a record with those fields on it, not a JSON object that merely
  // spells them: the enum name has to map to an ordinal the IDL defines.
  const bytes = writeDttRecord(sds, record);
  const [read] = sds.readFB(bytes);
  assert.equal(read.VERTICAL_DATUM, sds.standards.DTT.dttVerticalDatum.GEOID);
  assert.equal(read.VERTICAL_DATUM_NAME, "EGM2008");
});

test("the datum name an operator configures is the one the record states", async (t) => {
  const record = (
    await get(t, "/api/v1/terrain/tileset.json", {
      ...OVER_IPFS,
      terrain_vertical_datum_name: "EGM96",
    })
  ).body();
  assert.equal(record.VERTICAL_DATUM_NAME, "EGM96");
});

// ── layer.json CARRIES IT TOO ───────────────────────────────────────────────
//
// layer.json is what a native terrain provider reads out of the published
// directory. It is rendered by the module's own layer_json method from the
// plan route() composes, so this is the same document that ends up inside the
// CID (ipfs-publish.mjs renders it through the shipped module, deliberately,
// so there is only ever ONE authority for it).
test("layer.json states the datum the tiles were encoded against", async (t) => {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return OVER_IPFS;
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  const routed = await harness.invoke({
    methodId: "route",
    inputs: [
      {
        portId: "request",
        typeRef: HTTP_REQUEST_TYPE_REF,
        payload: encodeHttpRequest({
          method: "GET",
          path: "/api/v1/terrain/layer.json",
          headers: { "accept-encoding": "identity" },
        }),
      },
    ],
  });
  const plan = routed.outputs.find((o) => o.portId === "layer_plan");
  assert.ok(plan, "layer.json is planned, not answered directly");
  const rendered = await harness.invoke({
    methodId: "layer_json",
    inputs: [
      {
        portId: "plan",
        typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: plan.payload.byteLength },
        payload: plan.payload,
      },
    ],
  });
  const http = decodeHttpResponse(new Uint8Array(rendered.outputs[0].payload));
  const layer = JSON.parse(decoder.decode(http.body));
  assert.equal(layer.verticalDatum, "GEOID");
  assert.equal(layer.verticalDatumName, "EGM2008");
  // The record and the directory's own index must not disagree about it.
  const record = (await get(t, "/api/v1/terrain/tileset.json", OVER_IPFS)).body();
  assert.equal(layer.verticalDatumName, record.VERTICAL_DATUM_NAME);
});

// ── THE COMMITTED DEPLOY CONFIG BOOTS A MOUNT THAT ANSWERS THE CATALOGUE ────
//
// tools/terrain-pyramid/evidence/liguria-z11/mount-entry.json names
// layer-json-config.json as THE source of "the module config keys ... INSIDE
// `config:`". That file used to carry eight keys and NONE of the four
// DTTProvenance fields the module requires, so an operator who did exactly
// what the ship step said installed a mount that answered
// /api/v1/terrain/tileset.json with 503 — measured, not inferred — and no
// client ever got a CID. The ship step turned a 401 into a 503.
//
// This boots the mount from that EXACT committed file (plus only the two keys
// the publish step adds, which name a directory that does not exist until the
// add has run) and fetches the route both clients fetch.
test("the COMMITTED deploy config boots a mount that answers /tileset.json 200", async (t) => {
  const committed = JSON.parse(
    fs.readFileSync(
      fileURLToPath(new URL("../../../tools/terrain-pyramid/evidence/liguria-z11/layer-json-config.json", import.meta.url)),
      "utf8",
    ),
  );
  const config = {
    ...committed,
    terrain_tileset_cid: CID,
    terrain_tileset_size_bytes: 41_000_000,
  };
  const { http, body, headerOf } = await get(t, "/api/v1/terrain/tileset.json", config);
  assert.equal(http.status, 200, "the committed config must not produce a 503");
  assert.equal(headerOf("content-type"), "application/json");
  const record = body();
  assert.equal(record.PAYLOAD.CID, CID, "and the record names the directory in PAYLOAD.CID");
  assert.equal(record.PROVENANCE.DATASET_CID, undefined);
  assert.equal(record.VERTICAL_DATUM_NAME, committed.terrain_vertical_datum_name);
  // Not just 200: a $DTT. writeFB is what enforces `required`.
  assert.ok(writeDttRecord(sds, record).length > 0, "and the answer is a record");

  // The four keys, named, so a future edit that drops one fails HERE rather
  // than on a host at deploy time.
  for (const key of [
    "terrain_dataset_id",
    "terrain_dataset_epoch",
    "terrain_dataset_retrieved_at",
    "terrain_license",
  ]) {
    assert.ok(
      typeof committed[key] === "string" && committed[key].length > 0,
      `the committed deploy config must carry ${key}; the module refuses the catalogue without it`,
    );
  }
});
