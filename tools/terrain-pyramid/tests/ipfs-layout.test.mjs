// THE DIRECTORY A GATEWAY SERVES, held to what a browser will ask of it.
//
// OWNER 2026-08-27: terrain files are requested over IPFS, so the pyramid
// leaves this repo as a content-addressed DIRECTORY — layer.json plus one file
// per tile — instead of a record stream a module answers requests from. Every
// property the mount used to provide at request time has to be a property of
// the FILES now, and each of these tests is one of them:
//
//   * a tile file is the tile, DECODED. A gateway does no content negotiation
//     and kubo does not compress (measured: identity in, identity out), so a
//     file holding the gzipped payload would reach the browser as garbage.
//   * the water mask is IN the file. There is no serve-time step left to add
//     it, and the mask is what the reflective ocean reads.
//   * every address layer.json promises EXISTS. respond() synthesizes a miss;
//     a gateway 404s, and Atlas set the browser-4xx bound at zero.
//   * layer.json is the module's own rendering, with the tiles template a CID
//     needs.
//
// The records under test come from the module's own encoder, so what is
// published is measured against the bytes the ingest path actually stores.

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { readDtt, splitStream } from "../dtt-reader.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const SOURCE = path.join(REPO, "data-source", "terrain-source");
const { createBrowserModuleHarness } = await import(path.join(SOURCE, "node_modules", "space-data-module-sdk", "src", "testing", "index.js"));
const { decodeHttpResponse, encodeHttpRequest, HTTP_REQUEST_TYPE_REF } = await import(
  path.join(SOURCE, "node_modules", "space-data-module-sdk", "src", "http", "index.js"),
);
const { buildGeoTiff, decodeQuantizedMesh } = await import(path.join(SOURCE, "tests", "helpers.mjs"));

const encoder = new TextEncoder();
const PUBLISHER = path.join(HERE, "..", "ipfs-publish.mjs");
const ROOT_CID = "bafybeigdyrzt5n52ca7m5qz7cdqzsvdbi7lrtqhdq6k4k3v4bnva4y5m4e";
const RECEIPT_CID = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const TEST_RAW_PUBLICATION_POLICY = Object.freeze({
  version: 1,
  max_verified_store_bytes: 8 * 1024 * 1024,
  max_static_directory_bytes: 32 * 1024 * 1024,
  static_directory_basis: "bounded fixture static identity directory",
  synthesized_tile_grid_size: 2,
});
const TEST_APPROVED_CONFIG = Object.freeze({
  flow_config: {
    terrain_synth_grid_size: 2,
    regions: [{ name: "ipfs-layout-fixture", west: 7.9, east: 8.9, south: 44.5, north: 45.5 }],
  },
  publication_policy: TEST_RAW_PUBLICATION_POLICY,
});
const TEST_GLOBAL_CONFIG_DIGEST = createHash("sha256").update(canonicalJson(TEST_APPROVED_CONFIG)).digest("hex");
const TEST_PUBLICATION_POLICY = Object.freeze({
  format: "terrain-publication-policy-v1",
  globalConfigDigest: TEST_GLOBAL_CONFIG_DIGEST,
  maxVerifiedStoreBytes: 8 * 1024 * 1024,
  maxStaticDirectoryBytes: 32 * 1024 * 1024,
  synthGridSize: 2,
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runPublisher(outDir, extraArgs = [], { nodeArgs = [] } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, PUBLISHER, "--out", outDir, ...extraArgs], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const [code, signal] = await once(child, "exit");
  return { code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
}

function copyFixtureOutput() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-ipfs-publish-"));
  fs.cpSync(fixture.outDir, outDir, { recursive: true });
  return outDir;
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function lfCount(file) {
  let count = 0;
  for (const byte of fs.readFileSync(file)) if (byte === 0x0a) count += 1;
  return count;
}

function refreshPublicationReceipt(outDir, policy = TEST_PUBLICATION_POLICY) {
  const rawPolicy = {
    ...TEST_RAW_PUBLICATION_POLICY,
    max_verified_store_bytes: policy.maxVerifiedStoreBytes,
    max_static_directory_bytes: policy.maxStaticDirectoryBytes,
    synthesized_tile_grid_size: policy.synthGridSize,
  };
  const approvedConfig = {
    ...TEST_APPROVED_CONFIG,
    flow_config: { ...TEST_APPROVED_CONFIG.flow_config, terrain_synth_grid_size: policy.synthGridSize },
    publication_policy: rawPolicy,
  };
  const globalConfigDigest = createHash("sha256").update(canonicalJson(approvedConfig)).digest("hex");
  const boundPolicy = { ...policy, globalConfigDigest };
  fs.writeFileSync(path.join(outDir, "approved-run-config.json"), `${JSON.stringify(approvedConfig)}\n`);
  const input = (name, countField = null) => {
    const file = path.join(outDir, name);
    const entry = { path: name, bytes: fs.statSync(file).size, sha256: sha256File(file) };
    if (countField) entry[countField] = lfCount(file);
    return entry;
  };
  const tiles = input("tiles.dttstream");
  tiles.records = splitStream(fs.readFileSync(path.join(outDir, "tiles.dttstream"))).length;
  fs.writeFileSync(
    path.join(outDir, "global-build-state.json"),
    JSON.stringify({
      version: 1,
      completed: true,
      configDigest: globalConfigDigest,
      publicationPolicy: boundPolicy,
      merged: {
        completion: "complete",
        configDigest: globalConfigDigest,
        approvedConfigPath: "approved-run-config.json",
        records: tiles.records,
        publicationPolicy: boundPolicy,
      },
    }),
  );
  const verifyPath = path.join(outDir, "verify-report.json");
  const prior = fs.existsSync(verifyPath) ? JSON.parse(fs.readFileSync(verifyPath, "utf8")) : {};
  fs.writeFileSync(
    verifyPath,
    JSON.stringify({
      ...prior,
      format: "terrain-verification-report-v1",
      publishable: true,
      problems: prior.problems ?? [],
      tiles: tiles.records,
      publicationPolicy: boundPolicy,
      publicationInputs: {
        format: "terrain-publication-inputs-v2",
        tiles,
        availableButUnstored: input("available-but-unstored.ndjson", "addresses"),
        layerConfig: input("layer-json-config.json"),
        oceanReceipt: input("ocean-skipped.json"),
        oceanAddresses: input("ocean-skipped.lines", "addresses"),
        globalState: input("global-build-state.json"),
        approvedConfig: input("approved-run-config.json"),
        oceanLegacyUnbound: false,
      },
    }),
  );
}

function rebindPublicationInput(outDir, field, name, countField = null) {
  const reportPath = path.join(outDir, "verify-report.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const file = path.join(outDir, name);
  const entry = { path: name, bytes: fs.statSync(file).size, sha256: sha256File(file) };
  if (countField) entry[countField] = lfCount(file);
  report.publicationInputs[field] = entry;
  fs.writeFileSync(reportPath, JSON.stringify(report));
}

async function readRequest(req, slow = false) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
    if (slow) await delay(2);
  }
  return Buffer.concat(chunks);
}

async function writeFragments(res, text, bytes = 7) {
  const body = Buffer.from(text);
  for (let at = 0; at < body.length; at += bytes) {
    res.write(body.subarray(at, at + bytes));
    await delay(1);
  }
  res.end();
}

function receiptFromUpload(upload) {
  const names = [...upload.toString("utf8").matchAll(/filename="([^"]+)"/g)]
    .map((match) => decodeURIComponent(match[1]));
  const root = "ipfs-layout-test";
  const directories = [];
  let open = [];
  for (const name of names) {
    assert.ok(name.startsWith(`${root}/`));
    const parents = name.slice(root.length + 1).split("/").slice(0, -1);
    let common = 0;
    while (common < open.length && common < parents.length && open[common] === parents[common]) common += 1;
    for (let index = open.length - 1; index >= common; index -= 1) directories.push(`${root}/${open.slice(0, index + 1).join("/")}`);
    open = parents;
  }
  for (let index = open.length - 1; index >= 0; index -= 1) directories.push(`${root}/${open.slice(0, index + 1).join("/")}`);
  return {
    names,
    directories,
    text: [
      ...names.map((Name) => JSON.stringify({ Name, Hash: RECEIPT_CID })),
      ...directories.map((Name) => JSON.stringify({ Name, Hash: RECEIPT_CID })),
      JSON.stringify({ Name: root, Hash: ROOT_CID }),
    ].join("\n") + "\n",
  };
}

async function fakeKubo(outDir, mode = "valid") {
  const state = { uploadBytes: 0, contentLength: null, uploadNames: [], addPin: null, pinAdd: 0, pinRm: [], pinLsCalls: 0, pinLsAbsent500: false, requests: [], pinned: mode.startsWith("preexisting-") };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    state.requests.push(url.pathname);
    if (url.pathname === "/api/v0/version") {
      if (mode === "redirect") {
        res.writeHead(302, { location: "/api/v0/version-next" });
        res.end();
      } else if (mode !== "timeout") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ Version: "fake-kubo" }));
      }
      return;
    }
    if (url.pathname === "/api/v0/add") {
      const upload = await readRequest(req, mode === "slow-fragmented");
      state.uploadBytes = upload.length;
      state.contentLength = Number(req.headers["content-length"]);
      state.addPin = url.searchParams.get("pin");
      const receipt = receiptFromUpload(upload);
      state.uploadNames = receipt.names;
      state.uploadDirectories = receipt.directories;
      res.setHeader("content-type", "application/x-ndjson");
      if (mode === "oversized-line") {
        res.end(`{"Name":"${"x".repeat(70 * 1024)}`);
      } else if (mode === "malformed") {
        res.end('{"Name":"ipfs-layout-test/layer.json",');
      } else if (mode === "missing-root") {
        res.end(receipt.text.split("\n").slice(0, -2).join("\n") + "\n");
      } else if (mode === "extra-root") {
        const entries = receipt.text.trim().split("\n");
        res.end([entries.at(-1), ...entries].join("\n") + "\n");
      } else if (mode === "wrong-file-order") {
        const entries = receipt.text.trim().split("\n");
        const root = entries.pop();
        res.end([entries[1], entries[0], ...entries.slice(2), root].join("\n") + "\n");
      } else if (mode === "slow-fragmented") {
        await writeFragments(res, receipt.text, 5);
      } else if (mode === "bulk-timeout") {
        await delay(100);
        res.end(receipt.text);
      } else {
        res.end(receipt.text);
      }
      return;
    }
    if (url.pathname === "/api/v0/pin/ls") {
      state.pinLsCalls += 1;
      if (mode === "pin-ls-other-500" || (mode === "pin-failure" && state.pinLsCalls >= 2)) {
        res.statusCode = 500;
        res.end("pin proof failed");
      } else if (!state.pinned) {
        state.pinLsAbsent500 = true;
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ Message: `path '${ROOT_CID}' is not pinned`, Code: 0, Type: "error" }));
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ Keys: { [ROOT_CID]: { Type: "recursive" } } }));
      }
      return;
    }
    if (url.pathname === "/api/v0/pin/add") {
      state.pinAdd += 1;
      // Another owner can pin this deterministic CID after our final
      // preflight lookup. Kubo pins are not reference counted, so the only
      // safe downstream action is to retain it and leave a recovery receipt.
      if (mode === "race-after-final-lookup-gateway-404") state.racedAfterLookup = true;
      state.pinned = true;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ Pins: [url.searchParams.get("arg")] }));
      return;
    }
    if (url.pathname === "/api/v0/pin/rm") {
      state.pinRm.push(url.searchParams.get("arg"));
      state.pinned = false;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ Pins: [url.searchParams.get("arg")] }));
      return;
    }
    if (url.pathname.startsWith(`/ipfs/${ROOT_CID}/`)) {
      const rel = decodeURIComponent(url.pathname.slice(`/ipfs/${ROOT_CID}/`.length));
      const source = path.join(outDir, "ipfs", rel);
      if (mode === "gateway-404" || mode === "preexisting-gateway-404" || mode === "race-after-final-lookup-gateway-404") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const body = fs.readFileSync(source);
      if (req.headers["if-none-match"] && mode !== "gateway-conditional") {
        res.statusCode = 304;
        res.setHeader("etag", '"fake-etag"');
        res.end();
        return;
      }
      res.setHeader("content-type", rel === "layer.json" ? "application/json" : "application/octet-stream");
      res.setHeader("cache-control", "public, max-age=60, immutable");
      res.setHeader("access-control-allow-origin", "*");
      if (mode !== "gateway-header") res.setHeader("etag", '"fake-etag"');
      if (mode === "gateway-oversized-content-length") {
        res.setHeader("content-length", String(body.length + 1));
        res.end(body);
      } else if (mode === "gateway-chunked-oversize") {
        res.write(body);
        res.end(Buffer.from("x"));
      } else {
        res.end(mode === "gateway-byte" ? Buffer.concat([body, Buffer.from("x")]) : body);
      }
      return;
    }
    res.statusCode = 404;
    res.end("unexpected request");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    base: `http://127.0.0.1:${address.port}`,
    state,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

// One granule of real relief, and a water mask with a coast through it so the
// block yields both a RASTER-mask tile and a uniform one.
// originLat is the NORTH edge and rows run south, as the source granules do.
// One degree square at 7.9E/45.5N, so the four level-9 tiles below sit wholly
// inside it — a tile the granule only partly covers would be measuring
// coverage, not layout.
const GRANULE = {
  width: 256,
  height: 256,
  originLon: 7.9,
  originLat: 45.5,
  scaleLon: 1 / 256,
  scaleLat: 1 / 256,
  layout: "tile",
  tileWidth: 64,
  tileHeight: 64,
  predictor: 1,
};
const dem = buildGeoTiff({
  ...GRANULE,
  heightFn: (px, py) => (px < 96 ? 0 : 40 + 30 * Math.sin(px / 9) + 20 * Math.cos(py / 7)),
});
const wbm = buildGeoTiff({ ...GRANULE, classFn: (px) => (px < 96 ? 1 : 0) });

const PLAN = {
  tilesetId: "ipfs-layout-test",
  gridSize: 33,
  maxGridSize: 33,
  maxLevel: 9,
  skipOceanTiles: true,
  waterMask: { kind: "RASTER", width: 256, height: 256 },
  // The plan is an intra-flow control frame, so its keys are camelCase; the
  // RECORD it produces carries them as the IDL spells them.
  provenance: {
    datasetId: "test-dataset",
    datasetName: "test",
    datasetEpoch: "2023-04-01T00:00:00.000Z",
    retrievedAt: "2026-08-27T00:00:00.000Z",
    license: "test licence",
    attribution: "test attribution",
  },
  scheme: "GEOGRAPHIC_WGS84",
  rowOriginNorth: false,
};

// hostcap/http-request responseWire "raw-body-v1": "$HRB", little-endian
// status, body verbatim — an 8-byte header, no length (the frame carries it).
const rawBodyFrame = (portId, body) => {
  const bytes = Buffer.alloc(8 + body.length);
  bytes.write("$HRB", 0, "latin1");
  bytes.writeUInt32LE(200, 4);
  Buffer.from(body).copy(bytes, 8);
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.length },
    payload: new Uint8Array(bytes),
  };
};
const jsonFrame = (portId, value) => {
  const bytes = encoder.encode(JSON.stringify(value));
  return {
    portId,
    typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
    payload: bytes,
  };
};

// Cut a small block of real tiles, then lay the run out on disk exactly as the
// builder does, so ipfs-publish.mjs runs against it unchanged.
async function buildFixture() {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(path.join(SOURCE, "dist", "isomorphic", "module.wasm")),
    manifest: JSON.parse(fs.readFileSync(path.join(SOURCE, "plugin-manifest.json"), "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return {};
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  // A 2x2 block at level 9 inside the granule's own extent. The coast at
  // px 96 (lon 8.275) runs through x=535 and misses x=536, so the block yields
  // a RASTER-mask tile and a uniform one — both file shapes in one fixture.
  const tiles = [];
  for (let x = 535; x <= 536; x += 1) for (let y = 383; y <= 384; y += 1) tiles.push({ level: 9, x, y });
  const response = await harness.invoke({
    methodId: "tile",
    inputs: [jsonFrame("plan", { ...PLAN, tiles }), rawBodyFrame("dem", dem), rawBodyFrame("water", wbm)],
  });
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const stream = Buffer.from(response.outputs.find((o) => o.portId === "records").payload);
  await harness.destroy();

  const records = splitStream(stream);
  assert.ok(records.length > 0, "the fixture block yielded no records");
  const addresses = records.map((r) => {
    const d = readDtt(r);
    return { level: d.level, x: d.x, y: d.y };
  });

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-ipfs-"));
  fs.writeFileSync(path.join(outDir, "tiles.dttstream"), stream);
  const available = [];
  for (let level = 0; level <= 9; level += 1) available.push([]);
  for (const a of addresses) available[9].push({ startX: a.x, startY: a.y, endX: a.x, endY: a.y });
  // The ancestor closure the client walks down: one rectangle per level above,
  // which makes those addresses promised-but-unstored — the case that has to
  // become a FILE.
  for (let level = 8; level >= 0; level -= 1) {
    const shift = 9 - level;
    const xs = addresses.map((a) => a.x >> shift);
    const ys = addresses.map((a) => a.y >> shift);
    available[level].push({
      startX: Math.min(...xs), startY: Math.min(...ys),
      endX: Math.max(...xs), endY: Math.max(...ys),
    });
  }
  // A declared level-9 miss to the west of the coast is the representative
  // uniform-water response.  It exercises static bytes against the actual
  // mounted module, rather than a second synthesizer in this test.
  const oceanAddress = { level: 9, x: 534, y: 383 };
  available[9].push({ startX: oceanAddress.x, startY: oceanAddress.y, endX: oceanAddress.x, endY: oceanAddress.y });
  const layerConfig = {
    terrain_maxzoom: 9,
    terrain_ocean_synth_min_level: 9,
    terrain_synth_grid_size: TEST_PUBLICATION_POLICY.synthGridSize,
    terrain_mount_path: "/api/v1/terrain/",
    terrain_available: available,
  };
  fs.writeFileSync(path.join(outDir, "layer-json-config.json"), JSON.stringify(layerConfig));
  fs.writeFileSync(path.join(outDir, "run-report.json"), JSON.stringify({ tiles: records.length }));
  const promised = [];
  const stored = new Set(addresses.map((a) => `${a.level}/${a.x}/${a.y}`));
  for (let level = 0; level <= 9; level += 1) {
    for (const r of available[level]) {
      for (let y = r.startY; y <= r.endY; y += 1) {
        for (let x = r.startX; x <= r.endX; x += 1) {
          const key = `${level}/${x}/${y}`;
          if (!stored.has(key)) promised.push(key);
        }
      }
    }
  }
  promised.sort((left, right) => {
    const [lz, lx, ly] = left.split("/").map(Number);
    const [rz, rx, ry] = right.split("/").map(Number);
    return lz - rz || ly - ry || lx - rx;
  });
  fs.writeFileSync(path.join(outDir, "available-but-unstored.ndjson"), `${promised.join("\n")}\n`);
  const oceanKey = `${oceanAddress.level}/${oceanAddress.x}/${oceanAddress.y}`;
  const oceanLines = `${oceanKey}\n`;
  fs.writeFileSync(path.join(outDir, "ocean-skipped.lines"), oceanLines);
  fs.writeFileSync(
    path.join(outDir, "ocean-skipped.json"),
    JSON.stringify({
      generatedAt: "2026-09-01T00:00:00.000Z",
      format: "terrain-ocean-skips-lines-v1",
      addressesPath: "ocean-skipped.lines",
      count: 1,
      digest: createHash("sha256").update(oceanLines).digest("hex"),
    }),
  );
  refreshPublicationReceipt(outDir);
  return { outDir, records, addresses, promised, oceanAddress: oceanKey };
}

const fixture = await buildFixture();
execFileSync(
  process.execPath,
  [path.join(HERE, "..", "ipfs-publish.mjs"), "--out", fixture.outDir, "--no-add"],
  { stdio: "pipe" },
);
const ipfsDir = path.join(fixture.outDir, "ipfs");
const layerJson = JSON.parse(fs.readFileSync(path.join(ipfsDir, "layer.json"), "utf8"));

async function synthesizeFromShippingMount(config, address) {
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(path.join(SOURCE, "dist", "isomorphic", "module.wasm")),
    manifest: JSON.parse(fs.readFileSync(path.join(SOURCE, "plugin-manifest.json"), "utf8")),
    surface: "direct",
    hostcallDispatch: (operation) => {
      if (operation === "plugin.getConfig") return config;
      throw new Error(`unexpected hostcall operation: ${operation}`);
    },
  });
  try {
    const route = await harness.invoke({
      methodId: "route",
      inputs: [{
        portId: "request",
        typeRef: HTTP_REQUEST_TYPE_REF,
        payload: encodeHttpRequest({
          method: "GET",
          path: `/api/v1/terrain/${address}.terrain`,
          headers: { "accept-encoding": "identity" },
        }),
      }],
    });
    assert.equal(route.statusCode, 0, `${route.errorCode}: ${route.errorMessage}`);
    const context = route.outputs.find((output) => output.portId === "context");
    assert.ok(context, `route did not produce context for ${address}`);
    const response = await harness.invoke({
      methodId: "respond",
      inputs: [
        {
          portId: "stream",
          typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: 4 },
          payload: new Uint8Array(4),
        },
        { portId: "context", typeRef: context.typeRef, payload: context.payload },
      ],
    });
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
    const http = decodeHttpResponse(new Uint8Array(response.outputs[0].payload));
    assert.equal(http.status, 200, `mount did not synthesize ${address}`);
    const encoding = (http.headers ?? []).find((header) => header.name?.toLowerCase() === "content-encoding")?.value?.toLowerCase();
    return encoding === "gzip" ? zlib.gunzipSync(Buffer.from(http.body)) : Buffer.from(http.body);
  } finally {
    await harness.destroy();
  }
}

test("layer.json declares the tiles template a CID needs, and the watermask extension", () => {
  // No `?v=` query: the CID is the cache key and it is already in the path.
  assert.deepEqual(layerJson.tiles, ["{z}/{x}/{y}.terrain"]);
  assert.deepEqual(layerJson.extensions, ["watermask"]);
  assert.equal(layerJson.format, "quantized-mesh-1.0");
  assert.equal(layerJson.scheme, "tms");
  assert.equal(layerJson.projection, "EPSG:4326");
  assert.ok(Array.isArray(layerJson.available), "available must be an array");
  assert.ok(layerJson.available[0].length > 0, "level 0 must be covered or the client never asks");
});

test("every tile file is the identity mesh the record carries, not the stored gzip", () => {
  for (const record of fixture.records) {
    const dtt = readDtt(record);
    const file = fs.readFileSync(path.join(ipfsDir, `${dtt.level}/${dtt.x}/${dtt.y}.terrain`));
    assert.equal(dtt.payload.contentEncoding, "gzip", "the record stores gzip");
    assert.ok(
      file.equals(zlib.gunzipSync(Buffer.from(dtt.payload.bytes))),
      `${dtt.level}/${dtt.x}/${dtt.y}: the file is not the decoded payload`,
    );
    // The gzip magic in a file a gateway serves identity would reach the
    // browser as an unparseable tile.
    assert.notEqual(file.readUInt16BE(0), 0x1f8b, "a tile file must not be gzip");
  }
});

test("every tile file carries its water mask, uniform or raster", () => {
  const kinds = { 1: 0, 65536: 0 };
  for (const rel of fs.readdirSync(ipfsDir, { recursive: true })) {
    if (!String(rel).endsWith(".terrain")) continue;
    const bytes = fs.readFileSync(path.join(ipfsDir, String(rel)));
    const mesh = decodeQuantizedMesh(bytes);
    assert.equal(mesh.bytesRead, bytes.length, `${rel}: the file does not parse to its own end`);
    const mask = mesh.extensions.find((e) => e.id === 2);
    assert.ok(mask, `${rel}: no water-mask extension`);
    if (mask.bytes.length === 1) {
      assert.ok(mask.bytes[0] === 0 || mask.bytes[0] === 0xff, `${rel}: uniform mask is not 0/255`);
    } else {
      const side = Math.round(Math.sqrt(mask.bytes.length));
      assert.equal(side * side, mask.bytes.length, `${rel}: raster mask is not square`);
    }
    kinds[mask.bytes.length] = (kinds[mask.bytes.length] ?? 0) + 1;
  }
  assert.ok(kinds[65536] > 0, "the coastal fixture must yield at least one raster mask");
});

test("every address layer.json promises exists as a file", () => {
  assert.ok(fixture.promised.length > 0, "the fixture must exercise the promised-but-unstored case");
  for (const address of fixture.promised) {
    const file = path.join(ipfsDir, `${address}.terrain`);
    assert.ok(fs.existsSync(file), `${address} is promised and missing: a gateway would 404`);
    // A synthesized tile is flat and states a mask; it is a real tile, not a
    // placeholder the client has to tolerate.
    const mesh = decodeQuantizedMesh(fs.readFileSync(file));
    assert.ok(mesh.extensions.some((e) => e.id === 2), `${address}: synthesized without a mask`);
  }
});

test("shipping terrain-source synth at approved grid size equals published water, land, and ancestor bytes", async () => {
  const config = JSON.parse(fs.readFileSync(path.join(fixture.outDir, "layer-json-config.json"), "utf8"));
  assert.equal(config.terrain_synth_grid_size, TEST_PUBLICATION_POLICY.synthGridSize);
  const land = fixture.promised.find((address) => address.startsWith("8/"));
  const ancestor = fixture.promised.find((address) => address.startsWith("0/"));
  assert.ok(land && ancestor && fixture.promised.includes(fixture.oceanAddress));
  for (const [kind, address] of [["water", fixture.oceanAddress], ["land", land], ["ancestor", ancestor]]) {
    const direct = await synthesizeFromShippingMount(config, address);
    const published = fs.readFileSync(path.join(ipfsDir, `${address}.terrain`));
    assert.deepEqual(published, direct, `${kind} ${address} differs from direct mount synthesis`);
    const mesh = decodeQuantizedMesh(published);
    const mask = mesh.extensions.find((extension) => extension.id === 2);
    assert.ok(mask, `${kind} ${address} lacks a water mask`);
    if (kind === "water") assert.deepEqual(Buffer.from(mask.bytes), Buffer.from([0xff]));
    else assert.deepEqual(Buffer.from(mask.bytes), Buffer.from([0x00]));
  }
});

test("the publication report and the directory agree on what was published", () => {
  const report = JSON.parse(fs.readFileSync(path.join(fixture.outDir, "ipfs-publication.json"), "utf8"));
  let files = 0;
  for (const rel of fs.readdirSync(ipfsDir, { recursive: true })) {
    if (fs.statSync(path.join(ipfsDir, String(rel))).isFile()) files += 1;
  }
  assert.equal(report.files, files);
  assert.equal(report.storedTiles, fixture.records.length);
  assert.equal(report.synthesizedTiles, fixture.promised.length);
  assert.equal(files, report.storedTiles + report.synthesizedTiles + 1, "tiles plus layer.json");
  assert.ok(BigInt(report.materializationPlan.reservedStaticPhysicalBytes) >= BigInt(report.materializationPlan.approvedStaticLogicalBytes));
  assert.ok(BigInt(report.materializationPlan.reservedStaticPhysicalBytes) >= BigInt(report.materializationPlan.actualStaticPhysicalUpperBytes));
  assert.ok(BigInt(report.materializationPlan.reservedUploadManifestPhysicalBytes) > 0n);
  assert.ok(BigInt(report.materializationPlan.plannedDirectoryRows) >= 1n);
  assert.ok(BigInt(report.materializationPlan.reservedUploadManifestRows) >= BigInt(report.materializationPlan.files));
  assert.ok(BigInt(report.materializationPlan.stagingRequiredBytes) > BigInt(report.materializationPlan.approvedStaticLogicalBytes));
});

test("an unverified run is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-ipfs-unverified-"));
  fs.copyFileSync(path.join(fixture.outDir, "tiles.dttstream"), path.join(dir, "tiles.dttstream"));
  fs.copyFileSync(path.join(fixture.outDir, "layer-json-config.json"), path.join(dir, "layer-json-config.json"));
  fs.copyFileSync(path.join(fixture.outDir, "run-report.json"), path.join(dir, "run-report.json"));
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [path.join(HERE, "..", "ipfs-publish.mjs"), "--out", dir, "--no-add"],
        { stdio: "pipe" },
      ),
    /run verify\.mjs first/,
    "a CID is permanent; an unverified pyramid must not get one",
  );
});

test("a run verify.mjs failed is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-ipfs-failed-"));
  for (const name of ["tiles.dttstream", "layer-json-config.json", "run-report.json"]) {
    fs.copyFileSync(path.join(fixture.outDir, name), path.join(dir, name));
  }
  fs.writeFileSync(
    path.join(dir, "verify-report.json"),
    JSON.stringify({
      format: "terrain-verification-report-v1",
      publishable: true,
      problems: ["p99 over the byte bound"],
      availableButUnstoredAddresses: [],
    }),
  );
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [path.join(HERE, "..", "ipfs-publish.mjs"), "--out", dir, "--no-add"],
        { stdio: "pipe" },
      ),
    /unmet bounds/,
  );
});

test("a forged non-terminal verification report with problems=[] is refused", async () => {
  const outDir = copyFixtureOutput();
  const reportPath = path.join(outDir, "verify-report.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  report.publishable = false;
  report.problems = [];
  fs.writeFileSync(reportPath, JSON.stringify(report));
  const result = await runPublisher(outDir, ["--no-add"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not marked publishable/);
});

test("publicationInputs accepts only the exact bound compact-ocean receipt schema", async () => {
  const mutations = {
    legacyV1: (receipt) => { receipt.format = "terrain-publication-inputs-v1"; },
    missing: (receipt) => { delete receipt.oceanLegacyUnbound; },
    extra: (receipt) => { receipt.unexpected = true; },
    nullOcean: (receipt) => { receipt.oceanReceipt = null; },
    legacy: (receipt) => { receipt.oceanLegacyUnbound = true; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const outDir = copyFixtureOutput();
    const reportPath = path.join(outDir, "verify-report.json");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    mutate(report.publicationInputs);
    fs.writeFileSync(reportPath, JSON.stringify(report));
    const result = await runPublisher(outDir, ["--no-add"]);
    assert.notEqual(result.code, 0, `${name} publicationInputs receipt must be refused`);
  }
});

test("bound inputs reject symlinks and same-count mutation after preflight", async () => {
  for (const name of ["verify-report.json", "tiles.dttstream", "layer-json-config.json", "available-but-unstored.ndjson", "global-build-state.json", "approved-run-config.json"]) {
    const outDir = copyFixtureOutput();
    const file = path.join(outDir, name);
    const target = path.join(outDir, `${name}.regular-target`);
    fs.renameSync(file, target);
    fs.symlinkSync(target, file);
    const result = await runPublisher(outDir, ["--no-add"]);
    assert.notEqual(result.code, 0, `${name} symlink must be refused`);
  }
  const outDir = copyFixtureOutput();
  const mutation = await runPublisher(outDir, ["--no-add", "--test-mutate-layer-config-after-preflight"]);
  assert.notEqual(mutation.code, 0);
  assert.match(mutation.stderr, /changed since publication preflight/);

  const realOut = copyFixtureOutput();
  const symlinkOut = `${realOut}-symlink`;
  fs.symlinkSync(realOut, symlinkOut);
  const parent = await runPublisher(symlinkOut, ["--no-add"]);
  assert.notEqual(parent.code, 0, "a symlinked output parent must be refused");
});

test("global completion state and canonical approved config must authorize the verify policy", async () => {
  for (const mutate of [
    (state) => { state.completed = false; },
    (state) => { state.merged.completion = "incomplete"; },
    (state) => { state.configDigest = "0".repeat(64); },
    (state) => { state.merged.records += 1; },
    (state) => { state.merged.approvedConfigPath = "other.json"; },
    (state) => { state.publicationPolicy.maxStaticDirectoryBytes += 1; },
  ]) {
    const outDir = copyFixtureOutput();
    const statePath = path.join(outDir, "global-build-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    mutate(state);
    fs.writeFileSync(statePath, JSON.stringify(state));
    rebindPublicationInput(outDir, "globalState", "global-build-state.json");
    const result = await runPublisher(outDir, ["--no-add"]);
    assert.notEqual(result.code, 0, "authoritative global-state fault must be refused");
  }
  const outDir = copyFixtureOutput();
  const configPath = path.join(outDir, "approved-run-config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.flow_config.regions[0].name = "forged";
  fs.writeFileSync(configPath, JSON.stringify(config));
  rebindPublicationInput(outDir, "approvedConfig", "approved-run-config.json");
  const result = await runPublisher(outDir, ["--no-add"]);
  assert.notEqual(result.code, 0, "canonical approved config digest mismatch must be refused");
});

test("publication policy independently caps store and static-directory materialization", async () => {
  const tooSmallStore = copyFixtureOutput();
  refreshPublicationReceipt(tooSmallStore, { ...TEST_PUBLICATION_POLICY, maxVerifiedStoreBytes: 1 });
  const store = await runPublisher(tooSmallStore, ["--no-add"]);
  assert.notEqual(store.code, 0);
  assert.match(store.stderr, /exceeds approved/);

  const wrongGrid = copyFixtureOutput();
  refreshPublicationReceipt(wrongGrid, { ...TEST_PUBLICATION_POLICY, synthGridSize: 3 });
  const grid = await runPublisher(wrongGrid, ["--no-add"]);
  assert.notEqual(grid.code, 0);
  assert.match(grid.stderr, /terrain_synth_grid_size disagrees/);

  const tooSmallStatic = copyFixtureOutput();
  const storedBytes = fs.statSync(path.join(tooSmallStatic, "tiles.dttstream")).size;
  refreshPublicationReceipt(tooSmallStatic, {
    ...TEST_PUBLICATION_POLICY,
    maxVerifiedStoreBytes: storedBytes,
    maxStaticDirectoryBytes: storedBytes,
  });
  const staticResult = await runPublisher(tooSmallStatic, ["--no-add"]);
  assert.notEqual(staticResult.code, 0);
  assert.match(staticResult.stderr, /static directory would exceed approved/);

  const noSpace = copyFixtureOutput();
  const capacity = await runPublisher(noSpace, ["--no-add", "--reserve-free-bytes", "999999999999999999"]);
  assert.notEqual(capacity.code, 0);
  assert.match(capacity.stderr, /insufficient free space for staged IPFS directory/);

  const caps = [
    { ...TEST_PUBLICATION_POLICY, maxVerifiedStoreBytes: 12 * 1024 ** 3 + 1 },
    { ...TEST_PUBLICATION_POLICY, maxStaticDirectoryBytes: 128 * 1024 ** 3 + 1 },
    { ...TEST_PUBLICATION_POLICY, maxVerifiedStoreBytes: 9, maxStaticDirectoryBytes: 8 },
  ];
  for (const policy of caps) {
    const outDir = copyFixtureOutput();
    refreshPublicationReceipt(outDir, policy);
    const result = await runPublisher(outDir, ["--no-add"]);
    assert.notEqual(result.code, 0, "a self-consistent but unapproved publication policy must be refused");
    assert.match(result.stderr, /publicationPolicy\.max(?:VerifiedStore|StaticDirectory)Bytes/);
  }
});

test("bounded publisher inflate refuses a gzip bomb", async () => {
  const outDir = copyFixtureOutput();
  const result = await runPublisher(outDir, ["--no-add", "--test-gzip-bomb"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /test gzip bomb cannot be safely inflated/);
});

// This host's WASM/SDK initialization OOMs before publisher code at
// 32/48/64/96 MiB; 128 MiB is the lowest measured isolated V8 heap that
// starts and completes.
test("publisher materialization completes in its lowest measured isolated 128 MiB V8 heap", async () => {
  const outDir = copyFixtureOutput();
  const result = await runPublisher(outDir, ["--no-add"], { nodeArgs: ["--max-old-space-size=128"] });
  assert.equal(result.code, 0, result.stderr);
});

test("journal recovery restores every persisted backup/install boundary, including rename-before-progress", async () => {
  const phases = [];
  for (let index = 1; index <= 4; index += 1) phases.push(`backup-renamed-${index}`, `backup-${index}`, `install-renamed-${index}`, `install-${index}`);
  for (const phase of phases) {
    const outDir = copyFixtureOutput();
    const priorLayer = fs.readFileSync(path.join(outDir, "ipfs", "layer.json"));
    const interrupted = await runPublisher(outDir, ["--no-add", "--test-crash-at", phase]);
    assert.equal(interrupted.code, 86, `${phase} must inject an abrupt transaction crash`);
    const recovered = await runPublisher(outDir, ["--no-add"]);
    assert.equal(recovered.code, 0, `${phase} recovery failed: ${recovered.stderr}`);
    assert.ok(fs.existsSync(path.join(outDir, "ipfs", "layer.json")));
    assert.deepEqual(fs.readFileSync(path.join(outDir, "ipfs", "layer.json")), priorLayer, `${phase} changed identical fixture bytes`);
    assert.equal(fs.existsSync(path.join(outDir, ".ipfs-publication-transaction.json")), false, `${phase} journal was not consumed`);
    assert.equal(fs.readdirSync(outDir).some((name) => name.includes("-previous-")), false, `${phase} left a prior artifact backup`);
  }
});

function attemptResidue(outDir) {
  return fs.readdirSync(outDir).filter((name) =>
    name === ".ipfs-publication-transaction.json" ||
    /^\.ipfs-(?:staging|attempt|upload-manifest|upload-directories|publication-transaction)-/.test(name) ||
    /^\.(?:tileset-catalogue\.(?:json|dttstream)|ipfs-publication\.json|serving-config-ipfs\.json|pending-ipfs-pin\.json)-(?:staging|previous)-/.test(name),
  );
}

test("attempt journal reclaims abrupt precommit crashes without accumulating staging", async () => {
  for (const phase of [
    "journal-temp-written-prelink",
    "journal-temp-midwrite-prelink",
    "journal-linked",
    "attempt-journal",
    "staging-directory-created-unrecorded",
    "staging-created",
    "journal-temp-written-before-update-rename",
    "journal-temp-midwrite-update",
    "control-directory-created-unrecorded",
    "materialize-1",
    "artifact-written-1",
    "artifact-1",
  ]) {
    const outDir = copyFixtureOutput();
    const interrupted = await runPublisher(outDir, ["--no-add", "--test-crash-at", phase]);
    assert.equal(interrupted.code, 86, `${phase} must be an abrupt child crash`);
    const recovered = await runPublisher(outDir, ["--no-add"]);
    assert.equal(recovered.code, 0, `${phase} recovery failed: ${recovered.stderr}`);
    if (phase.includes("midwrite")) {
      const repeated = await runPublisher(outDir, ["--no-add"]);
      assert.equal(repeated.code, 0, `${phase} repeat recovery failed: ${repeated.stderr}`);
    }
    if (phase === "journal-temp-midwrite-prelink") {
      // Before its hard-link establishes the fixed lease, a torn temporary is
      // indistinguishable from a foreign dead-PID-shaped regular file. It is
      // intentionally retained, bounded, and ignored rather than deleted.
      const retained = attemptResidue(outDir);
      assert.equal(retained.length, 1, `${phase} must retain only its unauthenticated temporary`);
      assert.match(retained[0], /^\.ipfs-publication-transaction-\d+-[0-9a-f-]+\.tmp$/);
    } else {
      assert.deepEqual(attemptResidue(outDir), [], `${phase} leaked an attempt-owned path after recovery`);
    }
  }
});

test("attempt journal refuses active/PID-reused leases and preserves forged/unrelated paths", async () => {
  const outDir = copyFixtureOutput();
  const first = spawn(process.execPath, [PUBLISHER, "--out", outDir, "--no-add", "--test-hold-after-journal-ms", "700"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Root-confined preflight now performs bounded helper RPC before the journal
  // lease exists; allow the same five-second process-start budget as the
  // initial-temp barrier below rather than assuming path-based startup speed.
  for (let tries = 0; tries < 200 && !fs.existsSync(path.join(outDir, ".ipfs-publication-transaction.json")); tries += 1) await delay(25);
  assert.ok(fs.existsSync(path.join(outDir, ".ipfs-publication-transaction.json")), "first publisher did not establish its journal lease");
  const second = await runPublisher(outDir, ["--no-add"]);
  assert.notEqual(second.code, 0);
  assert.match(second.stderr, /still owned by a live process/);
  const [firstCode] = await once(first, "exit");
  assert.equal(firstCode, 0);

  const preLink = spawn(process.execPath, [PUBLISHER, "--out", outDir, "--no-add", "--test-hold-after-initial-journal-temp-ms", "700"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const preLinkExit = once(preLink, "exit");
  const preLinkReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("initial journal temporary writer did not reach its barrier")), 5_000);
    preLink.stderr.on("data", (chunk) => {
      if (Buffer.from(chunk).toString("utf8").includes("test initial journal temporary written")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  await preLinkReady;
  const competingInitial = await runPublisher(outDir, ["--no-add"]);
  assert.notEqual(competingInitial.code, 0);
  assert.match(competingInitial.stderr, /still owned by a live process/);
  const [preLinkCode] = await preLinkExit;
  assert.equal(preLinkCode, 0);

  const pidReuse = copyFixtureOutput();
  const stat = fs.lstatSync(pidReuse, { bigint: true });
  const attempt = `${process.pid}-00000000-0000-4000-8000-000000000000`;
  const names = ["ipfs", "tileset-catalogue.json", "tileset-catalogue.dttstream", "ipfs-publication.json", "serving-config-ipfs.json", "pending-ipfs-pin.json"];
  const forged = {
    format: "terrain-ipfs-publication-attempt-v2",
    attempt,
    root: { dev: stat.dev.toString(), ino: stat.ino.toString() },
    phase: "allocated",
    owned: {
      staging: `.ipfs-staging-${attempt}`,
      control: `.ipfs-attempt-${attempt}`,
      scratch: [`.ipfs-upload-manifest-${attempt}.ndjson`, `.ipfs-upload-directories-${attempt}.ndjson`],
      staged: names.map((name) => `.${name}-staging-${attempt}`),
      backups: names.map((name) => `.${name}-previous-${attempt}`),
      pendingTemporary: `.pending-ipfs-pin-${attempt}.tmp`,
      journalTemporary: `.ipfs-publication-transaction-${attempt}.tmp`,
    },
    stagingIdentity: null,
    controlIdentity: null,
    transients: { scratch: [null, null], staged: names.map(() => null), pendingTemporary: null },
    transaction: null,
  };
  const journal = path.join(pidReuse, ".ipfs-publication-transaction.json");
  fs.writeFileSync(journal, JSON.stringify(forged));
  const reused = await runPublisher(pidReuse, ["--no-add"]);
  assert.notEqual(reused.code, 0);
  assert.match(reused.stderr, /still owned by a live process/);
  fs.unlinkSync(journal);

  const selfOwned = copyFixtureOutput();
  const selfResult = await runPublisher(selfOwned, ["--no-add", "--test-forge-self-owned-journal"]);
  assert.notEqual(selfResult.code, 0);
  assert.match(selfResult.stderr, /still owned by a live process/);
  fs.unlinkSync(path.join(selfOwned, ".ipfs-publication-transaction.json"));

  const unrelated = path.join(pidReuse, ".unrelated-dot-sentinel");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-ipfs-outside-"));
  const sentinel = path.join(outside, "sentinel");
  fs.writeFileSync(unrelated, "keep");
  fs.writeFileSync(sentinel, "keep");
  fs.writeFileSync(journal, JSON.stringify({ forged: true }));
  const bad = await runPublisher(pidReuse, ["--no-add"]);
  assert.notEqual(bad.code, 0);
  assert.equal(fs.readFileSync(unrelated, "utf8"), "keep");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
  fs.unlinkSync(journal);
  const candidateName = ".ipfs-publication-transaction-999999-00000000-0000-4000-8000-000000000000.tmp";
  fs.symlinkSync(sentinel, path.join(pidReuse, candidateName));
  const candidateSymlink = await runPublisher(pidReuse, ["--no-add"]);
  assert.notEqual(candidateSymlink.code, 0);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
  fs.unlinkSync(path.join(pidReuse, candidateName));
  fs.rmSync(outside, { recursive: true, force: true });
});

test("dead-PID-shaped foreign regular journal candidates are retained byte-identically", async () => {
  const outDir = copyFixtureOutput();
  const candidate = path.join(outDir, ".ipfs-publication-transaction-999999-00000000-0000-4000-8000-000000000000.tmp");
  const foreign = Buffer.from("foreign journal-looking regular file\n\u0000unaltered", "utf8");
  fs.writeFileSync(candidate, foreign, { flag: "wx" });
  const result = await runPublisher(outDir, ["--no-add"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(candidate), foreign, "foreign regular candidate must not be reclaimed or rewritten");
  fs.unlinkSync(candidate);
});

test("a stale-recovery loser cannot remove a winner's newly-acquired journal lease", async () => {
  const outDir = copyFixtureOutput();
  const crashed = await runPublisher(outDir, ["--no-add", "--test-crash-at", "attempt-journal"]);
  assert.equal(crashed.code, 86);

  const reader = spawn(process.execPath, [PUBLISHER, "--out", outDir, "--no-add", "--test-hold-after-recovery-read-ms", "900"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const readerExit = once(reader, "exit");
  const readerReady = new Promise((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => reject(new Error("stale recovery reader did not bind the old journal")), 5_000);
    reader.stderr.on("data", (chunk) => {
      stderr += Buffer.from(chunk).toString("utf8");
      if (stderr.includes("test recovery journal read")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    reader.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`stale recovery reader exited before the barrier: ${code}`));
    });
  });
  await readerReady;
  const winner = await runPublisher(outDir, ["--no-add"]);
  assert.equal(winner.code, 0, winner.stderr);
  const [readerCode] = await readerExit;
  assert.notEqual(readerCode, 0, "the stale reader must fail closed once its bound lease is replaced");
  const next = await runPublisher(outDir, ["--no-add"]);
  assert.equal(next.code, 0, next.stderr);
  assert.deepEqual(attemptResidue(outDir), []);
});

test("output-root replacement fails closed without touching the outside target", async () => {
  const outDir = copyFixtureOutput();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-ipfs-root-swap-"));
  const sentinel = path.join(outside, "sentinel");
  fs.writeFileSync(sentinel, "outside remains untouched");
  const replaced = await runPublisher(outDir, ["--no-add", "--test-replace-output-root-with", outside]);
  assert.notEqual(replaced.code, 0);
  assert.match(replaced.stderr, /builder output is no longer a real directory/);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "outside remains untouched");
  const held = `${outDir}.attempt-root-held`;
  assert.ok(fs.lstatSync(outDir).isSymbolicLink());
  fs.unlinkSync(outDir);
  fs.renameSync(held, outDir);
  const recovered = await runPublisher(outDir, ["--no-add"]);
  assert.equal(recovered.code, 0, recovered.stderr);
  fs.rmSync(outside, { recursive: true, force: true });
});

test("descriptor-rooted control and staging exchanges cannot write, read, upload, or delete outside trees", async () => {
  for (const boundary of ["control", "staging"]) {
    const outDir = copyFixtureOutput();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), `terrain-ipfs-${boundary}-exchange-`));
    const foreignTree = path.join(outside, "foreign-tree");
    fs.mkdirSync(foreignTree);
    const sentinel = path.join(foreignTree, "sentinel");
    const decoy = path.join(outside, "layer.json");
    fs.writeFileSync(sentinel, `foreign ${boundary} sentinel`);
    fs.writeFileSync(decoy, `foreign ${boundary} layer`);
    const beforeSentinel = fs.readFileSync(sentinel);
    const beforeDecoy = fs.readFileSync(decoy);
    const fake = boundary === "staging" ? await fakeKubo(outDir) : null;
    try {
      const args = boundary === "control"
        ? ["--no-add", "--test-exchange-control-with", outside]
        : ["--api", fake.base, "--gateway", fake.base, "--test-exchange-staging-with", outside];
      const result = await runPublisher(outDir, args);
      assert.notEqual(result.code, 0, `${boundary} parent exchange must fail closed`);
      assert.deepEqual(fs.readFileSync(sentinel), beforeSentinel, `${boundary} exchange deleted or rewrote foreign sentinel`);
      assert.deepEqual(fs.readFileSync(decoy), beforeDecoy, `${boundary} exchange read/upload source was not confined`);
      if (fake) assert.equal(fake.state.requests.includes("/api/v0/add"), false, "swapped staging must never reach Kubo upload");

      const swapped = fs.readdirSync(outDir).find((name) =>
        name.startsWith(`.ipfs-${boundary === "control" ? "attempt" : "staging"}-`) && fs.lstatSync(path.join(outDir, name)).isSymbolicLink(),
      );
      assert.ok(swapped, `${boundary} exchange did not leave its test symlink`);
      const held = `${swapped}.test-held`;
      fs.unlinkSync(path.join(outDir, swapped));
      fs.renameSync(path.join(outDir, held), path.join(outDir, swapped));
      const recovered = await runPublisher(outDir, ["--no-add"]);
      assert.equal(recovered.code, 0, `${boundary} exchange recovery failed: ${recovered.stderr}`);
      assert.deepEqual(fs.readFileSync(sentinel), beforeSentinel, `${boundary} recovery touched foreign sentinel`);
      assert.deepEqual(fs.readFileSync(decoy), beforeDecoy, `${boundary} recovery touched foreign tree`);
    } finally {
      if (fake) await fake.close();
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});

test("no-clobber activation preserves a foreign live-leaf exchange", async () => {
  const outDir = copyFixtureOutput();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-ipfs-live-leaf-"));
  const sentinel = path.join(outside, "sentinel");
  fs.writeFileSync(sentinel, "foreign live leaf remains untouched");
  const before = fs.readFileSync(sentinel);
  try {
    const result = await runPublisher(outDir, ["--no-add", "--test-exchange-install-leaf-with", sentinel]);
    assert.notEqual(result.code, 0, "foreign live-leaf exchange must stop no-clobber activation");
    assert.ok(fs.lstatSync(path.join(outDir, "ipfs")).isSymbolicLink(), "test must leave the exchanged live leaf in place");
    assert.deepEqual(fs.readFileSync(sentinel), before, "activation overwrote or deleted the foreign live leaf");
    fs.unlinkSync(path.join(outDir, "ipfs"));
    const recovered = await runPublisher(outDir, ["--no-add"]);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.deepEqual(fs.readFileSync(sentinel), before, "recovery touched the foreign live leaf");
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("Kubo upload is sorted, exact-length, backpressured, and accepts fragmented NDJSON", async () => {
  const outDir = copyFixtureOutput();
  const fake = await fakeKubo(outDir, "slow-fragmented");
  try {
    const result = await runPublisher(outDir, ["--api", fake.base, "--gateway", fake.base]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.state.contentLength, fake.state.uploadBytes, "multipart Content-Length must include every boundary and CRLF");
    assert.equal(fake.state.addPin, "false", "receipt validation must happen before this invocation creates a pin");
    assert.equal(fake.state.pinLsAbsent500, true, "Kubo 0.39's exact unpinned HTTP 500 must be treated as ordinary absence");
    assert.deepEqual(fake.state.uploadNames, [...fake.state.uploadNames].sort(), "multipart file plan must be deterministic and sorted");
    assert.ok(fake.state.uploadNames.includes("ipfs-layout-test/layer.json"));
    assert.ok(fake.state.uploadDirectories.includes("ipfs-layout-test/0"), "faithful Kubo receipt must include intermediate directories");
    const report = JSON.parse(fs.readFileSync(path.join(outDir, "ipfs-publication.json"), "utf8"));
    assert.equal(report.cid, ROOT_CID);
    assert.equal(report.pinProof.type, "recursive");
    assert.ok(report.gatewayProof.every((probe) => probe.status >= 200 && probe.status < 300 && probe.matchesLocal));
    assert.equal(fs.existsSync(path.join(outDir, "pending-ipfs-pin.json")), false, "a completed artifact transaction consumes its pin recovery receipt");
  } finally {
    await fake.close();
  }
});

test("journal-owned control storage reclaims manifests killed before their individual records", async () => {
  for (const phase of ["upload-manifest-written", "directory-manifest-written"]) {
    const outDir = copyFixtureOutput();
    const fake = await fakeKubo(outDir);
    try {
      const interrupted = await runPublisher(outDir, ["--api", fake.base, "--gateway", fake.base, "--test-crash-at", phase]);
      assert.equal(interrupted.code, 86, `${phase} must kill after the manifest is durable but before its journal identity`);
    } finally {
      await fake.close();
    }
    const recovered = await runPublisher(outDir, ["--no-add"]);
    assert.equal(recovered.code, 0, `${phase} recovery failed: ${recovered.stderr}`);
    assert.deepEqual(attemptResidue(outDir), [], `${phase} left an attempt control residue`);
  }
});

test("add-mode transaction recovery covers the fifth serving artifact and sixth pending-pin removal", async () => {
  const phases = [];
  for (const index of [5, 6]) phases.push(`backup-renamed-${index}`, `backup-${index}`, `install-renamed-${index}`, `install-${index}`);
  for (const phase of phases) {
    const outDir = copyFixtureOutput();
    const fake = await fakeKubo(outDir);
    try {
      const interrupted = await runPublisher(outDir, ["--api", fake.base, "--gateway", fake.base, "--test-crash-at", phase]);
      assert.equal(interrupted.code, 86, `${phase} must interrupt the add-mode artifact transaction`);
    } finally {
      await fake.close();
    }
    const recovered = await runPublisher(outDir, ["--no-add"]);
    assert.equal(recovered.code, 0, `${phase} recovery failed: ${recovered.stderr}`);
    assert.deepEqual(attemptResidue(outDir), [], `${phase} left add-mode transaction residue`);
  }
});

test("bulk upload has its own explicit finite timeout, separate from control/gateway RPCs", async () => {
  const outDir = copyFixtureOutput();
  const fake = await fakeKubo(outDir, "bulk-timeout");
  try {
    const result = await runPublisher(outDir, ["--api", fake.base, "--gateway", fake.base, "--bulk-upload-timeout-ms", "20"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /kubo add timed out after 20 ms/);
  } finally {
    await fake.close();
  }
});

test("Kubo receipt parser rejects oversized, malformed, missing, reordered, and duplicate root receipts", async () => {
  for (const mode of ["oversized-line", "malformed", "missing-root", "wrong-file-order", "extra-root"]) {
    const outDir = copyFixtureOutput();
    const fake = await fakeKubo(outDir, mode);
    try {
      const result = await runPublisher(outDir, ["--api", fake.base, "--gateway", fake.base]);
      assert.notEqual(result.code, 0, `${mode} receipt must fail`);
      assert.deepEqual(fake.state.pinRm, [], `${mode} must not pin before the complete receipt validates`);
    } finally {
      await fake.close();
    }
  }
});

test("Kubo redirects and stalled requests are fatal", async () => {
  for (const mode of ["redirect", "timeout"]) {
    const outDir = copyFixtureOutput();
    const fake = await fakeKubo(outDir, mode);
    try {
      const result = await runPublisher(outDir, ["--api", fake.base, "--gateway", fake.base, "--timeout-ms", "40"]);
      assert.notEqual(result.code, 0, `${mode} must fail`);
      if (mode === "timeout") assert.match(result.stderr, /timed out after 40 ms/);
    } finally {
      await fake.close();
    }
  }
});

test("a pin-proof failure retains the unknown-owner root and preserves the previous directory", async () => {
  const outDir = copyFixtureOutput();
  const before = fs.readFileSync(path.join(outDir, "ipfs", "layer.json"));
  const fake = await fakeKubo(outDir, "pin-failure");
  try {
    const result = await runPublisher(outDir, ["--api", fake.base, "--gateway", fake.base]);
    assert.notEqual(result.code, 0);
    assert.deepEqual(fake.state.pinRm, [], "a failed pin proof must never call pin/rm");
    assert.equal(fake.state.pinned, true, "an acknowledged pin/add is retained when proof fails");
    const intent = JSON.parse(fs.readFileSync(path.join(outDir, "pending-ipfs-pin.json"), "utf8"));
    assert.equal(intent.state, "intent", "an unproved pin must remain an intent, not a recursive proof");
    assert.deepEqual(fs.readFileSync(path.join(outDir, "ipfs", "layer.json")), before, "failed staging must not replace a completed directory");
    assert.equal(fs.readdirSync(outDir).some((name) => name.startsWith(".ipfs-staging-")), false, "failed staging is removed");
  } finally {
    await fake.close();
  }
});

test("only Kubo 0.39's exact unpinned 500 is absence; every other pin/ls 500 is fatal", async () => {
  const outDir = copyFixtureOutput();
  const fake = await fakeKubo(outDir, "pin-ls-other-500");
  try {
    const result = await runPublisher(outDir, ["--api", fake.base, "--gateway", fake.base]);
    assert.notEqual(result.code, 0);
    assert.equal(fake.state.pinAdd, 0);
    assert.deepEqual(fake.state.pinRm, []);
  } finally {
    await fake.close();
  }
});

test("a proven recursive pin survives gateway failure with a durable retry receipt", async () => {
  for (const mode of ["preexisting-gateway-404", "gateway-404", "race-after-final-lookup-gateway-404"]) {
    const outDir = copyFixtureOutput();
    const fake = await fakeKubo(outDir, mode);
    try {
      const result = await runPublisher(outDir, ["--api", fake.base, "--gateway", fake.base]);
      assert.notEqual(result.code, 0);
      assert.deepEqual(fake.state.pinRm, [], "no failure path may call pin/rm for a shared recursive pin");
      assert.equal(fake.state.pinned, true);
      const pending = JSON.parse(fs.readFileSync(path.join(outDir, "pending-ipfs-pin.json"), "utf8"));
      assert.equal(pending.cid, ROOT_CID);
      assert.equal(pending.pinProof.type, "recursive");
      if (mode === "race-after-final-lookup-gateway-404") {
        assert.equal(fake.state.racedAfterLookup, true, "the fake must pin after the final lookup");
        assert.equal(fake.state.pinAdd, 1);
      }
    } finally {
      await fake.close();
    }
  }
});

test("gateway validation rejects status, bytes, bounded bodies, required headers, and missing conditional 304 without unpinning", async () => {
  for (const mode of ["gateway-404", "gateway-byte", "gateway-oversized-content-length", "gateway-chunked-oversize", "gateway-header", "gateway-conditional"]) {
    const outDir = copyFixtureOutput();
    const fake = await fakeKubo(outDir, mode);
    try {
      const result = await runPublisher(outDir, ["--api", fake.base, "--gateway", fake.base]);
      assert.notEqual(result.code, 0, `${mode} must fail the gateway gate`);
      assert.deepEqual(fake.state.pinRm, [], `${mode} must never issue pin/rm`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, "pending-ipfs-pin.json"), "utf8")).cid, ROOT_CID);
    } finally {
      await fake.close();
    }
  }
});

test("a matching pending pin receipt retries and clears only after successful publication", async () => {
  const outDir = copyFixtureOutput();
  const failed = await fakeKubo(outDir, "gateway-404");
  try {
    const result = await runPublisher(outDir, ["--api", failed.base, "--gateway", failed.base]);
    assert.notEqual(result.code, 0);
  } finally {
    await failed.close();
  }
  assert.ok(fs.existsSync(path.join(outDir, "pending-ipfs-pin.json")));
  const recovered = await fakeKubo(outDir, "valid");
  try {
    const result = await runPublisher(outDir, ["--api", recovered.base, "--gateway", recovered.base]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(recovered.state.pinRm, []);
    assert.equal(fs.existsSync(path.join(outDir, "pending-ipfs-pin.json")), false);
  } finally {
    await recovered.close();
  }
});

test("a conflicting pending pin receipt is retained and blocks a different CID", async () => {
  const outDir = copyFixtureOutput();
  fs.writeFileSync(
    path.join(outDir, "pending-ipfs-pin.json"),
    JSON.stringify({
      format: "terrain-ipfs-pin-intent-v1",
      state: "intent",
      cid: RECEIPT_CID,
      attempt: "prior-attempt",
      recordedAt: "2026-09-01T00:00:00.000Z",
    }),
  );
  const before = fs.readFileSync(path.join(outDir, "pending-ipfs-pin.json"));
  const fake = await fakeKubo(outDir, "valid");
  try {
    const result = await runPublisher(outDir, ["--api", fake.base, "--gateway", fake.base]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /refusing to replace recovery evidence/);
    assert.equal(fake.state.pinAdd, 0, "a conflicting recovery CID must block pin/add");
    assert.deepEqual(fake.state.pinRm, []);
    assert.deepEqual(fs.readFileSync(path.join(outDir, "pending-ipfs-pin.json")), before);
  } finally {
    await fake.close();
  }
});

test("insufficient statfs reservation and unproved --cid preserve the completed directory", async () => {
  const outDir = copyFixtureOutput();
  const before = fs.readFileSync(path.join(outDir, "ipfs", "layer.json"));
  const reservation = await runPublisher(outDir, ["--no-add", "--reserve-free-bytes", "999999999999999999999"]);
  assert.notEqual(reservation.code, 0);
  assert.match(reservation.stderr, /insufficient free space for staged IPFS directory/);
  assert.deepEqual(fs.readFileSync(path.join(outDir, "ipfs", "layer.json")), before);
  assert.equal(fs.readdirSync(outDir).some((name) => name.startsWith(".ipfs-staging-")), false);
  const cid = await runPublisher(outDir, ["--no-add", "--cid", ROOT_CID]);
  assert.notEqual(cid.code, 0);
  assert.match(cid.stderr, /--cid is refused/);
  assert.equal(fs.existsSync(path.join(outDir, "serving-config-ipfs.json")), false);
  const noVerify = await runPublisher(outDir, ["--no-verify"]);
  assert.notEqual(noVerify.code, 0);
  assert.match(noVerify.stderr, /--no-verify is refused with --add/);
});

test("successful --no-add transaction removes a stale serving CID configuration", async () => {
  const outDir = copyFixtureOutput();
  fs.writeFileSync(path.join(outDir, "serving-config-ipfs.json"), JSON.stringify({ terrain_tileset_cid: ROOT_CID }));
  const result = await runPublisher(outDir, ["--no-add"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(outDir, "serving-config-ipfs.json")), false);
  const report = JSON.parse(fs.readFileSync(path.join(outDir, "ipfs-publication.json"), "utf8"));
  const catalogue = JSON.parse(fs.readFileSync(path.join(outDir, "tileset-catalogue.json"), "utf8"));
  assert.equal(report.cid, null);
  assert.deepEqual(report.mountConfig, null);
  assert.equal(catalogue.PAYLOAD.CID, undefined);
});

test("streamed worklists reject an oversized unterminated line before staging", async () => {
  const outDir = copyFixtureOutput();
  const before = fs.readFileSync(path.join(outDir, "ipfs", "layer.json"));
  fs.writeFileSync(path.join(outDir, "available-but-unstored.ndjson"), "9/1/" + "9".repeat(2048) + "\n");
  refreshPublicationReceipt(outDir);
  const result = await runPublisher(outDir, ["--no-add"]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /available-but-unstored worklist line exceeds/);
  assert.deepEqual(fs.readFileSync(path.join(outDir, "ipfs", "layer.json")), before);
  assert.equal(fs.readdirSync(outDir).some((name) => name.startsWith(".ipfs-staging-")), false);
});

test("the produced compact ocean receipt joins a large raw ASCII worklist without a retained set", async () => {
  const outDir = copyFixtureOutput();
  const ocean = [];
  for (let y = 380; y < 396; y += 1) for (let x = 500; x < 516; x += 1) ocean.push(`9/${x}/${y}`);
  const layerConfig = JSON.parse(fs.readFileSync(path.join(outDir, "layer-json-config.json"), "utf8"));
  layerConfig.terrain_ocean_synth_min_level = 0;
  layerConfig.terrain_available[9] = [{ startX: 500, startY: 380, endX: 515, endY: 395 }];
  fs.writeFileSync(path.join(outDir, "layer-json-config.json"), JSON.stringify(layerConfig));
  fs.writeFileSync(path.join(outDir, "available-but-unstored.ndjson"), `${ocean.join("\n")}\n`);
  const oceanLines = `${ocean.join("\n")}\n`;
  fs.writeFileSync(path.join(outDir, "ocean-skipped.lines"), oceanLines);
  fs.writeFileSync(
    path.join(outDir, "ocean-skipped.json"),
    JSON.stringify({
      generatedAt: "2026-09-01T00:00:00.000Z",
      format: "terrain-ocean-skips-lines-v1",
      addressesPath: "ocean-skipped.lines",
      count: ocean.length,
      digest: createHash("sha256").update(oceanLines).digest("hex"),
    }),
  );
  refreshPublicationReceipt(outDir);
  const result = await runPublisher(outDir, ["--no-add"]);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(outDir, "ipfs-publication.json"), "utf8"));
  assert.equal(report.oceanSkipsDeclared, ocean.length);
  assert.equal(report.synthesizedUniformWater, ocean.length);
});

test("compact ocean receipts reject a bad digest, escaped target, and duplicate numeric order", async () => {
  for (const fault of ["digest", "escape", "duplicate"]) {
    const outDir = copyFixtureOutput();
    const address = fixture.promised[0];
    const lines = fault === "duplicate" ? `${address}\n${address}\n` : `${address}\n`;
    fs.writeFileSync(path.join(outDir, "ocean-skipped.lines"), lines);
    fs.writeFileSync(
      path.join(outDir, "ocean-skipped.json"),
      JSON.stringify({
        generatedAt: "2026-09-01T00:00:00.000Z",
        format: "terrain-ocean-skips-lines-v1",
        addressesPath: fault === "escape" ? "../ocean-skipped.lines" : "ocean-skipped.lines",
        count: fault === "duplicate" ? 2 : 1,
        digest: fault === "digest" ? "0".repeat(64) : createHash("sha256").update(lines).digest("hex"),
      }),
    );
    refreshPublicationReceipt(outDir);
    const result = await runPublisher(outDir, ["--no-add"]);
    assert.notEqual(result.code, 0, `${fault} compact ocean receipt must fail`);
  }
});

test("compact ocean ordering is padded numeric level/y/x, not raw lexical address order", async () => {
  const outDir = copyFixtureOutput();
  const addresses = ["8/0/0", "9/0/0", "10/0/0"];
  const configPath = path.join(outDir, "layer-json-config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.terrain_maxzoom = 10;
  config.terrain_ocean_synth_min_level = 0;
  config.terrain_available[8].push({ startX: 0, startY: 0, endX: 0, endY: 0 });
  config.terrain_available[9].push({ startX: 0, startY: 0, endX: 0, endY: 0 });
  config.terrain_available[10] = [{ startX: 0, startY: 0, endX: 0, endY: 0 }];
  fs.writeFileSync(configPath, JSON.stringify(config));
  const lines = `${addresses.join("\n")}\n`;
  fs.writeFileSync(path.join(outDir, "available-but-unstored.ndjson"), lines);
  fs.writeFileSync(path.join(outDir, "ocean-skipped.lines"), lines);
  fs.writeFileSync(
    path.join(outDir, "ocean-skipped.json"),
    JSON.stringify({
      generatedAt: "2026-09-01T00:00:00.000Z",
      format: "terrain-ocean-skips-lines-v1",
      addressesPath: "ocean-skipped.lines",
      count: addresses.length,
      digest: createHash("sha256").update(lines).digest("hex"),
    }),
  );
  refreshPublicationReceipt(outDir);
  const result = await runPublisher(outDir, ["--no-add"]);
  assert.equal(result.code, 0, result.stderr);
});
