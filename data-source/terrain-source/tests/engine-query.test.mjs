// THE SERVING QUERY, EXECUTED.
//
// route() emits one SQL string and every existing test asserted that string
// against a stub. That is not the same thing as executing it, and the
// difference was a blocker: the query said `ORDER BY rowid`, which parses
// against the base virtual table but is `no such column: rowid` on a node,
// where sdn-server registers a source for every ingested record and
// flatsqlrt.CreateUnifiedViews replaces each base table with a UNION ALL VIEW
// over its per-source shadow tables — and a SQLite view has no implicit rowid.
// Off-node the defect is invisible, because off-node nobody registers a source.
//
// So this suite reproduces the NODE's sequence — registerSource, ingest with a
// source, createUnifiedViews — against the same engine the serving flow bundles
// (flatsql 2.0.0), ingests records the module's own `tile` produced, and runs
// the module's own SQL. It also asserts the OLD spelling still fails, so a
// regression cannot pass by accident.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { encodeHttpRequest, HTTP_REQUEST_TYPE_REF } from "space-data-module-sdk/http";

import { buildGeoTiff, decodeDtt, splitStream } from "./helpers.mjs";

const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ??
  fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const DTT_SCHEMA = path.join(STANDARDS_ROOT, "schema", "DTT", "main.fbs");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CONFIG = {
  terrain_tileset_id: "spaceaware-terrain",
  terrain_maxzoom: 8,
  terrain_available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }]],
};

const frame = (portId, bytes) => ({
  portId,
  typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
  payload: bytes,
});
const jsonFrame = (portId, value) => frame(portId, encoder.encode(JSON.stringify(value)));

async function invoke(t, methodId, inputs) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(fileURLToPath(ISOMORPHIC_WASM_PATH)),
    manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return CONFIG;
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  t.after(() => harness.destroy());
  return harness.invoke({ methodId, inputs });
}

// Two real records at two addresses, from the module's own encoder.
async function encodeRecords(t) {
  const tiff = buildGeoTiff({
    width: 64,
    height: 64,
    originLon: 10.5,
    originLat: 45.8,
    scaleLon: 0.8 / 63,
    scaleLat: 0.9 / 63,
    heightFn: (px, py) => 100 + px + 2 * py,
  });
  const response = await invoke(t, "tile", [
    jsonFrame("plan", {
      tilesetId: "spaceaware-terrain",
      level: 8,
      gridSize: 33,
      maxLevel: 8,
      tiles: [
        { x: 271, y: 192, childAvailability: 0 },
        { x: 272, y: 192, childAvailability: 0 },
      ],
      provenance: {
        datasetId: "cop-dem-glo-30",
        datasetEpoch: "2023-04-01T00:00:00.000Z",
        retrievedAt: "2026-08-15T12:00:00.000Z",
        license: "Licence for Copernicus DEM instance COP-DEM-GLO-30-F",
      },
    }),
    jsonFrame("dem", { status: 200, headers: {}, bodyB64: Buffer.from(tiff).toString("base64") }),
  ]);
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const records = response.outputs.find((o) => o.portId === "records").payload;
  return splitStream(records);
}

// The SQL route() actually emits, for a given address.
async function routedQuery(t, level, x, y) {
  const response = await invoke(t, "route", [
    {
      portId: "request",
      typeRef: HTTP_REQUEST_TYPE_REF,
      payload: encodeHttpRequest({
        method: "GET",
        path: `/api/v1/terrain/${level}/${x}/${y}.terrain`,
        headers: {},
      }),
    },
  ]);
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const query = response.outputs.find((o) => o.portId === "query");
  assert.ok(query, "route must emit the store query for a real address");
  return JSON.parse(decoder.decode(query.payload));
}

// SCHEMA TEXT, COMMENTS REMOVED — and that is not tidying.
//
// FlatSQL's schema reader takes any `IDENT:...` line as a field declaration,
// INCLUDING inside a `///` doc comment. $DTT's own comment on WATER_MASK_WIDTH
// reads "Independent of GRID_WIDTH/GRID_HEIGHT: a mask is commonly ...", which
// the reader takes as a second GRID_HEIGHT column; the vtab declaration then
// fails "duplicate column name: GRID_HEIGHT", and in the EH-free engine build
// that failure is an `unreachable` trap that POISONS the runtime. The node
// never meets it — sdn-server creates its engine database from a GENERATED,
// comment-free projection of every standard (engineStandardCatalogGraph), not
// from the .fbs — so this strips comments for the same reason, and the trap is
// recorded for the schema lane rather than worked around silently.
function engineSchemaText() {
  return fs
    .readFileSync(DTT_SCHEMA, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

// The node's own shape: a registered source, ingest attributed to it, and the
// unified views rebuilt over the per-source shadow tables — which is what turns
// the base table into a VIEW, and a view has no implicit rowid.
async function nodeShapedDatabase(records) {
  const { initFlatSQL } = await import("flatsql/wasm");
  const flatsql = await initFlatSQL();
  const db = flatsql.createDatabase(engineSchemaText(), "terrain");
  db.registerFileId("$DTT", "DTT");
  db.registerSource("local");
  for (const record of records) db.ingestOne(new Uint8Array(record), "local");
  db.createUnifiedViews();
  return db;
}

test("the serving SQL runs on a node-shaped engine and returns the addressed record", async (t) => {
  const records = await encodeRecords(t);
  assert.equal(records.length, 2);
  const db = await nodeShapedDatabase(records);

  const { sql, params } = await routedQuery(t, 8, 271, 192);
  const bound = params.map((p) => (p.t === "str" ? p.v : Number(p.v)));
  const result = db.query(sql, bound);
  assert.equal(result.rows.length, 1, "exactly the addressed tile");

  const returned = Buffer.from(result.rows[0][0]);
  const expected = decodeDtt(records[0]);
  const got = decodeDtt(returned);
  assert.equal(got.level, expected.level);
  assert.equal(got.x, 271);
  assert.equal(got.y, 192);
  assert.equal(got.payload.digest, expected.payload.digest, "the served bytes are the stored bytes");

  // The other address is reachable too, and is a different record.
  const second = await routedQuery(t, 8, 272, 192);
  const other = db.query(
    second.sql,
    second.params.map((p) => (p.t === "str" ? p.v : Number(p.v))),
  );
  assert.equal(other.rows.length, 1);
  assert.equal(decodeDtt(Buffer.from(other.rows[0][0])).x, 272);
});

test("the spelling this replaced is the one a node refuses", async (t) => {
  // `rowid` on a unified VIEW. This is the exact failure a real node produced
  // and no off-node test could see, so it is asserted rather than described.
  const records = await encodeRecords(t);
  const db = await nodeShapedDatabase(records);
  const { sql, params } = await routedQuery(t, 8, 271, 192);
  assert.ok(sql.includes("ORDER BY _rowid DESC"), "the shipped query orders by _rowid");
  const bound = params.map((p) => (p.t === "str" ? p.v : Number(p.v)));
  assert.throws(
    () => db.query(sql.replace("ORDER BY _rowid", "ORDER BY rowid"), bound),
    /rowid/,
    "a view has no implicit rowid; the old query could not run on a node",
  );
});
