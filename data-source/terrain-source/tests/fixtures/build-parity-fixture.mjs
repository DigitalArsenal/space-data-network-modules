// Regenerates tests/fixtures/parity/* and tests/fixtures/terrain-parity.json.
//
// The parity fixture is COMMITTED, not generated at test time: the whole point
// of the tri-runtime gate is that three lanes receive THE SAME BYTES, so those
// bytes are an artifact under version control, and this script exists to
// reproduce them deterministically rather than to produce them on the fly.
//
//   node tests/fixtures/build-parity-fixture.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildGeoTiff, buildWaterTiff, buildOversizedTiffHeader, rawBodyFrameBytes } from "../helpers.mjs";

const outDir = fileURLToPath(new URL("./parity/", import.meta.url));
fs.mkdirSync(outDir, { recursive: true });
const write = (name, bytes) => {
  fs.writeFileSync(path.join(outDir, name), bytes);
  return { name, byteLength: bytes.length };
};

// One 1-degree granule at 1/1200-degree posts, tiled 256x256: small enough to
// commit, real enough to have a multi-chunk internal grid (the only kind that
// can tell a windowed decoder from a whole-granule one).
const PX = 1200;
const dem = write(
  "dem-granule.hrb",
  rawBodyFrameBytes(
    buildGeoTiff({
      width: PX,
      height: PX,
      originLon: 10,
      originLat: 46,
      scaleLon: 1 / PX,
      scaleLat: 1 / PX,
      heightFn: (px, py) => 200 + 0.4 * px + 0.25 * py + 60 * Math.sin(px / 90),
      layout: "tile",
      tileWidth: 256,
      tileHeight: 256,
      predictor: 3,
    }),
  ),
);

// The water-body granule over the same square: water north of 45.6 degrees.
const water = write(
  "water-granule.hrb",
  rawBodyFrameBytes(
    buildWaterTiff({
      width: PX,
      height: PX,
      originLon: 10,
      originLat: 46,
      scaleLon: 1 / PX,
      scaleLat: 1 / PX,
      classFn: (px, py) => (46 - py / PX > 45.6 ? 1 : 0),
      layout: "tile",
      tileWidth: 256,
      tileHeight: 256,
      predictor: 2,
    }),
  ),
);

// A granule whose DECLARED geometry crosses the 256 MiB decode budget. Its
// refusal frame must be byte-identical in every lane.
const oversized = write(
  "oversized-granule.hrb",
  rawBodyFrameBytes(
    buildOversizedTiffHeader({
      width: 40000,
      height: 40000,
      originLon: 10,
      originLat: 46,
      scaleLon: 1 / 40000,
      scaleLat: 1 / 40000,
    }),
  ),
);

const PROVENANCE = {
  datasetId: "cop-dem-glo-30",
  datasetName: "Copernicus DEM GLO-30",
  datasetEpoch: "2023-04-01T00:00:00.000Z",
  retrievedAt: "2026-08-26T00:00:00.000Z",
  license: "Licence for Copernicus DEM instance COP-DEM-GLO-30-F",
};
const base = {
  tilesetId: "spaceaware-terrain",
  rowOriginNorth: false,
  scheme: "GEOGRAPHIC_WGS84",
  maxLevel: 13,
  provenance: PROVENANCE,
};

// z11 span = 0.087890625 degrees. x=2166 -> west 10.3711; y=1546 -> south 45.4004.
const single = write(
  "plan-single.json",
  Buffer.from(JSON.stringify({ ...base, level: 11, x: 2166, y: 1546, gridSize: 65 })),
);
// A four-tile block: ONE granule decode, four records out.
const block = write(
  "plan-block.json",
  Buffer.from(
    JSON.stringify({
      ...base,
      level: 11,
      gridSize: 65,
      tiles: [
        { x: 2166, y: 1546 },
        { x: 2167, y: 1546 },
        { x: 2166, y: 1547 },
        { x: 2167, y: 1547 },
      ],
    }),
  ),
);
// A tile that straddles the water cut, so the mask is a real RASTER.
const maskPlan = write(
  "plan-water.json",
  Buffer.from(JSON.stringify({ ...base, level: 11, x: 2166, y: 1548, gridSize: 65 })),
);
const layerPlan = write(
  "plan-layer.json",
  Buffer.from(
    JSON.stringify({
      tilesetId: "spaceaware-terrain",
      maxzoom: 13,
      version: "1.0.0",
      attribution: "Copernicus DEM",
      description: "parity fixture",
      available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]],
    }),
  ),
);
const budgetPlan = write(
  "plan-oversized.json",
  Buffer.from(JSON.stringify({ ...base, level: 8, x: 271, y: 193, gridSize: 255 })),
);

// ── THE SERVING METHOD, WHICH THE PARITY GATE DID NOT COVER ────────────────
//
// The fixture's cases were all ENCODER cases (tile, layer_json) plus two
// refusals. `respond` was absent — and it is the method that faces the
// browser: it walks the store's record stream, decides 200/304/404, and on a
// miss inside published availability RUNS THE ENCODER ITSELF
// (encode_quantized_mesh + gzip_compress + sha256_multihash) to synthesize the
// tile. That is precisely the code cross-runtime identity exists to police,
// and it touches no host bridge at all — load_config() has exactly one call
// site, inside `route` — so it can be a parity case exactly as it stands.
//
// The stored record is produced HERE, by the same encoder, so the fixture is
// self-consistent: regenerate it whenever the encoder changes.
const parityWasm = fileURLToPath(new URL("../../dist/parity/module.wasm", import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("../../plugin-manifest.json", import.meta.url)), "utf8"),
);
const { createBrowserModuleHarness } = await import("space-data-module-sdk/testing");
const harness = await createBrowserModuleHarness({
  wasmSource: fs.readFileSync(parityWasm),
  manifest,
  surface: "direct",
});
const encodedStream = await (async () => {
  const response = await harness.invoke({
    methodId: "tile",
    inputs: [
      {
        portId: "plan",
        typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: single.byteLength },
        payload: new Uint8Array(fs.readFileSync(path.join(outDir, single.name))),
      },
      {
        portId: "dem",
        typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: dem.byteLength },
        payload: new Uint8Array(fs.readFileSync(path.join(outDir, dem.name))),
      },
    ],
  });
  if (response.statusCode !== 0) {
    throw new Error(`tile refused while building the respond fixture: ${response.errorCode}: ${response.errorMessage}`);
  }
  return Buffer.from(response.outputs.find((o) => o.portId === "records").payload);
})();
harness.destroy();

const storedStream = write("stored-record.dttstream", encodedStream);
// The ETag the stored record states, so the 304 case matches a real one rather
// than a literal that drifts the moment the encoder changes a byte.
const storedEtag = (() => {
  const record = encodedStream.subarray(4, 4 + encodedStream.readUInt32LE(0));
  const pos = record.readUInt32LE(0);
  const vtable = pos - record.readInt32LE(pos);
  const fieldAt = (id) => {
    const vo = 4 + 2 * id;
    if (vo >= record.readUInt16LE(vtable)) return 0;
    const off = record.readUInt16LE(vtable + vo);
    return off === 0 ? 0 : pos + off;
  };
  const p = fieldAt(40);
  const sp = p + record.readUInt32LE(p);
  return record.subarray(sp + 4, sp + 4 + record.readUInt32LE(sp)).toString("utf8");
})();

const respondContext = (name, context) =>
  write(name, Buffer.from(JSON.stringify({ tilesetId: "spaceaware-terrain", level: 11, x: 2166, y: 1546, ...context })));

const ctxStored = respondContext("context-stored.json", { ifNoneMatch: "", acceptsGzip: true });
const ctxIdentity = respondContext("context-identity.json", { ifNoneMatch: "", acceptsGzip: false });
const ctxConditional = respondContext("context-conditional.json", { ifNoneMatch: storedEtag, acceptsGzip: true });
const ctxSynth = respondContext("context-synth.json", {
  x: 2170,
  y: 1550,
  ifNoneMatch: "",
  acceptsGzip: true,
  insideAvailability: true,
  synthWater: true,
  synthGridSize: 65,
});
const ctxMiss = respondContext("context-miss.json", {
  x: 3000,
  y: 1,
  ifNoneMatch: "",
  acceptsGzip: true,
  insideAvailability: false,
});
// ── route, THE OTHER SERVING METHOD THE GATE DID NOT COVER ─────────────────
//
// `route` is the method that evaluates Cesium's isTileAvailable rule and turns
// a tile path into the DTT select plus the serve context, and it is where the
// one-tile-one-URL decisions live: the mount prefix, the leading-zero refusal
// and the query-string admission. It had a single-runtime node test and no
// cross-runtime case at all, so the "tri-runtime identity for the encoder"
// claim was one exported serving method short of the exported surface.
//
// It can be a parity case exactly as it stands. Its ONE host call is
// plugin.getConfig, and the parity artifact stubs the host bridge to return
// nothing — so route runs against its own documented DEFAULTS (mount
// /api/v1/terrain/, tileset spaceaware-terrain, version 1.0.0, the two level-0
// roots) identically in every lane. That is a real configuration, not a
// degenerate one: it is what an operator gets before configuring anything.
const { encodeHttpRequest, HTTP_REQUEST_TYPE_REF } = await import("space-data-module-sdk/http");
const httpRequestBytes = (name, { method = "GET", path: reqPath, query = "", headers = {} }) =>
  write(name, Buffer.from(encodeHttpRequest({ method, path: reqPath, query, headers })));

// Inside the default availability (level 0 covers both roots), so this is the
// select-and-serve branch, availability walk included.
const reqTile = httpRequestBytes("request-tile.htq", { path: "/api/v1/terrain/0/0/0.terrain" });
// layer.json: the branch that renders the plan frame, including its content
// name (a sha2-256 multihash of the plan) — deterministic, so comparable.
const reqLayer = httpRequestBytes("request-layer.htq", { path: "/api/v1/terrain/layer.json" });
// ONE TILE, ONE URL: a query the tiles template never declares. The host
// passes PATH and QUERY separately, so this is the query half of the rule and
// it must 404 identically everywhere.
const reqQuery = httpRequestBytes("request-query.htq", {
  path: "/api/v1/terrain/0/0/0.terrain",
  query: "cachebust=1",
});
// …and the token layer.json DOES declare is admitted, in every lane.
const reqVersioned = httpRequestBytes("request-versioned.htq", {
  path: "/api/v1/terrain/0/0/0.terrain",
  query: "v=1.0.0",
});

// ── THE $DTT CATALOGUE SURFACE, IN ALL THREE RUNTIMES ──────────────────────
//
// It had NO tri-runtime coverage at all. The parity artifact has no host
// bridge, so plugin.getConfig answers nothing there and /tileset.json answered
// 503 "terrain catalogue not configured" in every configuration — the record
// builder, the PAYLOAD-always-present shape and the lineage refusal were
// structurally unreachable in the artifact the three lanes measure. The whole
// surface that this round was convened to fix was measured in exactly ONE
// runtime, by one harness, against an artifact parity never touches.
//
// route() now accepts the mount config ON A FRAME (optional input port
// "config"), compiled into BOTH artifacts, so the three lanes execute the same
// record path over the same bytes.
//
// The config is the COMMITTED DEPLOY CONFIG, trimmed to the keys that decide
// this route (a 9 KB availability index would be committed twice for nothing),
// plus the two keys the publish step adds. Its lineage values are the real
// ones from evidence/liguria-z11/layer-json-config.json.
const catalogueConfig = {
  terrain_tileset_id: "spaceaware-terrain",
  terrain_mount_path: "/api/v1/terrain/",
  terrain_maxzoom: 13,
  terrain_dataset_id: "copernicus-glo30-quantized-mesh",
  terrain_dataset_name: "copernicus-glo30",
  terrain_dataset_epoch: "2023-04-01T00:00:00.000Z",
  terrain_dataset_retrieved_at: "2026-08-26T00:00:00.000Z",
  terrain_license: "Copernicus DEM: ESA / Airbus Defence and Space (free licence)",
  terrain_license_url:
    "https://spacedata.copernicus.eu/documents/20123/121286/CSCDA_ESA_Mission-specific+Annex_31_Oct_22.pdf",
  terrain_attribution:
    "Produced using Copernicus WorldDEM-30 (c) DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved",
  terrain_vertical_datum_name: "EGM2008",
  terrain_west_deg: 7.734375,
  terrain_south_deg: 42.890625,
  terrain_east_deg: 12.65625,
  terrain_north_deg: 47.109375,
  terrain_tileset_cid: "bafybeidr3l5zoi6gxui3vuuvfc5sadl3zlkotonukuxysw7fws54s2npmy",
  terrain_tileset_size_bytes: 12345678,
};
const jsonFrame = (name, value) =>
  write(name, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
// The shipped shape: a node serving a published directory.
const cfgCatalogue = jsonFrame("config-catalogue.json", catalogueConfig);
// A node serving no IPFS tileset. PAYLOAD is `required`, so the record is
// still built — present and EMPTY — rather than omitted, which is the case
// that used to make the document unserializable ("field 34 must be set").
const cfgCatalogueNoCid = jsonFrame("config-catalogue-no-cid.json", {
  ...catalogueConfig,
  terrain_tileset_cid: undefined,
  terrain_tileset_size_bytes: undefined,
});
// One required lineage field short: 503, no-store, naming the key. The
// refusal is a behaviour of the record contract and has to be identical in
// every runtime, not just in the one harness that could reach it.
const cfgCatalogueNoLineage = jsonFrame("config-catalogue-no-lineage.json", {
  ...catalogueConfig,
  terrain_dataset_retrieved_at: undefined,
});
// The catalogue route both clients fetch.
const reqTileset = httpRequestBytes("request-tileset.htq", {
  path: "/api/v1/terrain/tileset.json",
});

const htqInput = (file) => ({
  portId: "request",
  payloadFile: `parity/${file.name}`,
  typeRef: HTTP_REQUEST_TYPE_REF,
});

// A stream that is not a record stream at all: the refusal must be the same
// named error, byte for byte, in every lane.
const badStream = write("stream-malformed.bin", Buffer.from("not a size-prefixed $DTT stream", "utf8"));
// The flatsql stream for zero rows: nothing but alignment padding.
const emptyStream = write("stream-empty.bin", Buffer.alloc(4));

const alignedInput = (portId, file) => ({
  portId,
  payloadFile: `parity/${file.name}`,
  typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: file.byteLength },
});

const fixture = {
  name: "terrain-source-parity",
  threadEnvVar: "SDM_PARITY_THREADS",
  threadCounts: [1, 2, 4, 8],
  cases: [
    {
      id: "tile-single",
      expect: "ok",
      request: { methodId: "tile", inputs: [alignedInput("plan", single), alignedInput("dem", dem)] },
    },
    {
      id: "tile-block-amortized",
      expect: "ok",
      request: { methodId: "tile", inputs: [alignedInput("plan", block), alignedInput("dem", dem)] },
    },
    {
      id: "tile-water-raster",
      expect: "ok",
      request: {
        methodId: "tile",
        inputs: [alignedInput("plan", maskPlan), alignedInput("dem", dem), alignedInput("water", water)],
      },
    },
    {
      id: "layer-json",
      expect: "ok",
      request: { methodId: "layer_json", inputs: [alignedInput("plan", layerPlan)] },
    },
    {
      // THE REFUSAL. Same bytes in, same named error out, in every lane.
      // The exit CLASS is "ok": on the command surface a guest refusal rides
      // inside the response frame and the process exits 0. What proves the
      // refusal is byte-identical is the OUTPUT comparison across lanes, and
      // tests/parity-artifact.test.mjs asserts those bytes really do carry
      // decode-budget-exceeded rather than a silent success.
      id: "tile-over-decode-budget",
      expect: "ok",
      request: {
        methodId: "tile",
        inputs: [alignedInput("plan", budgetPlan), alignedInput("dem", oversized)],
      },
    },
    {
      id: "respond-stored-gzip",
      expect: "ok",
      request: {
        methodId: "respond",
        inputs: [alignedInput("stream", storedStream), alignedInput("context", ctxStored)],
      },
    },
    {
      // The client refused gzip, so the guest DECODES the stored bytes and
      // serves identity under its own strong ETag. In-guest inflate, in three
      // runtimes, byte for byte.
      id: "respond-stored-identity",
      expect: "ok",
      request: {
        methodId: "respond",
        inputs: [alignedInput("stream", storedStream), alignedInput("context", ctxIdentity)],
      },
    },
    {
      id: "respond-not-modified",
      expect: "ok",
      request: {
        methodId: "respond",
        inputs: [alignedInput("stream", storedStream), alignedInput("context", ctxConditional)],
      },
    },
    {
      // THE SYNTHESIZED MISS: the encoder runs inside `respond` here —
      // encode_quantized_mesh, gzip_compress, sha256_multihash — so every byte
      // the client renders on this path is covered by the same gate as the
      // stored path.
      id: "respond-synthesized-miss",
      expect: "ok",
      request: {
        methodId: "respond",
        inputs: [alignedInput("stream", emptyStream), alignedInput("context", ctxSynth)],
      },
    },
    {
      id: "respond-miss-outside-availability",
      expect: "ok",
      request: {
        methodId: "respond",
        inputs: [alignedInput("stream", emptyStream), alignedInput("context", ctxMiss)],
      },
    },
    {
      id: "respond-malformed-stream",
      expect: "ok",
      request: {
        methodId: "respond",
        inputs: [alignedInput("stream", badStream), alignedInput("context", ctxStored)],
      },
    },
    {
      id: "route-tile-address",
      expect: "ok",
      request: { methodId: "route", inputs: [htqInput(reqTile)] },
    },
    {
      id: "route-layer-json",
      expect: "ok",
      request: { methodId: "route", inputs: [htqInput(reqLayer)] },
    },
    {
      id: "route-undeclared-query",
      expect: "ok",
      request: { methodId: "route", inputs: [htqInput(reqQuery)] },
    },
    {
      id: "route-declared-version-token",
      expect: "ok",
      request: { methodId: "route", inputs: [htqInput(reqVersioned)] },
    },
    {
      id: "route-catalogue-record",
      expect: "ok",
      request: {
        methodId: "route",
        inputs: [htqInput(reqTileset), alignedInput("config", cfgCatalogue)],
      },
    },
    {
      id: "route-catalogue-no-cid",
      expect: "ok",
      request: {
        methodId: "route",
        inputs: [htqInput(reqTileset), alignedInput("config", cfgCatalogueNoCid)],
      },
    },
    {
      id: "route-catalogue-lineage-refused",
      expect: "ok",
      request: {
        methodId: "route",
        inputs: [htqInput(reqTileset), alignedInput("config", cfgCatalogueNoLineage)],
      },
    },
    {
      id: "malformed-stdin",
      stdinUtf8: "this is not a PIV invoke frame — the trap/error class must match across every lane",
    },
  ],
};

const fixturePath = fileURLToPath(new URL("./terrain-parity.json", import.meta.url));
fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${fixturePath} and ${fs.readdirSync(outDir).length} payload files`);
