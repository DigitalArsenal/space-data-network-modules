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
const { buildGeoTiff, decodeQuantizedMesh } = await import(path.join(SOURCE, "tests", "helpers.mjs"));

const encoder = new TextEncoder();
const PUBLISHER = path.join(HERE, "..", "ipfs-publish.mjs");
const ROOT_CID = "bafybeigdyrzt5n52ca7m5qz7cdqzsvdbi7lrtqhdq6k4k3v4bnva4y5m4e";
const RECEIPT_CID = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runPublisher(outDir, extraArgs = []) {
  const child = spawn(process.execPath, [PUBLISHER, "--out", outDir, ...extraArgs], {
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
  return {
    names,
    text: [...names.map((Name) => JSON.stringify({ Name, Hash: RECEIPT_CID })), JSON.stringify({ Name: "ipfs-layout-test", Hash: ROOT_CID })].join("\n") + "\n",
  };
}

async function fakeKubo(outDir, mode = "valid") {
  const state = { uploadBytes: 0, contentLength: null, uploadNames: [], addPin: null, pinRm: [], requests: [] };
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
      } else if (mode === "slow-fragmented") {
        await writeFragments(res, receipt.text, 5);
      } else {
        res.end(receipt.text);
      }
      return;
    }
    if (url.pathname === "/api/v0/pin/ls") {
      if (mode === "pin-failure") {
        res.statusCode = 500;
        res.end("pin proof failed");
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ Keys: { [ROOT_CID]: { Type: "recursive" } } }));
      }
      return;
    }
    if (url.pathname === "/api/v0/pin/add") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ Pins: [url.searchParams.get("arg")] }));
      return;
    }
    if (url.pathname === "/api/v0/pin/rm") {
      state.pinRm.push(url.searchParams.get("arg"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ Pins: [url.searchParams.get("arg")] }));
      return;
    }
    if (url.pathname.startsWith(`/ipfs/${ROOT_CID}/`)) {
      const rel = decodeURIComponent(url.pathname.slice(`/ipfs/${ROOT_CID}/`.length));
      const source = path.join(outDir, "ipfs", rel);
      if (mode === "gateway-404") {
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
  const layerConfig = {
    terrain_maxzoom: 9,
    terrain_ocean_synth_min_level: 9,
    terrain_mount_path: "/api/v1/terrain/",
    terrain_available: available,
  };
  fs.writeFileSync(path.join(outDir, "layer-json-config.json"), JSON.stringify(layerConfig));
  fs.writeFileSync(path.join(outDir, "run-report.json"), JSON.stringify({ tiles: records.length }));
  const promised = [];
  const stored = new Set(addresses.map((a) => `${a.level}/${a.x}/${a.y}`));
  for (let level = 0; level <= 8; level += 1) {
    const r = available[level][0];
    for (let y = r.startY; y <= r.endY; y += 1) {
      for (let x = r.startX; x <= r.endX; x += 1) {
        const key = `${level}/${x}/${y}`;
        if (!stored.has(key)) promised.push(key);
      }
    }
  }
  fs.writeFileSync(
    path.join(outDir, "verify-report.json"),
    JSON.stringify({ problems: [], availableButUnstoredAddresses: promised }),
  );
  return { outDir, records, addresses, promised };
}

const fixture = await buildFixture();
execFileSync(
  process.execPath,
  [path.join(HERE, "..", "ipfs-publish.mjs"), "--out", fixture.outDir, "--no-add"],
  { stdio: "pipe" },
);
const ipfsDir = path.join(fixture.outDir, "ipfs");
const layerJson = JSON.parse(fs.readFileSync(path.join(ipfsDir, "layer.json"), "utf8"));

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
    JSON.stringify({ problems: ["p99 over the byte bound"], availableButUnstoredAddresses: [] }),
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

test("Kubo upload is sorted, exact-length, backpressured, and accepts fragmented NDJSON", async () => {
  const outDir = copyFixtureOutput();
  const fake = await fakeKubo(outDir, "slow-fragmented");
  try {
    const result = await runPublisher(outDir, ["--api", fake.base, "--gateway", fake.base]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fake.state.contentLength, fake.state.uploadBytes, "multipart Content-Length must include every boundary and CRLF");
    assert.equal(fake.state.addPin, "false", "receipt validation must happen before this invocation creates a pin");
    assert.deepEqual(fake.state.uploadNames, [...fake.state.uploadNames].sort(), "multipart file plan must be deterministic and sorted");
    assert.ok(fake.state.uploadNames.includes("ipfs-layout-test/layer.json"));
    const report = JSON.parse(fs.readFileSync(path.join(outDir, "ipfs-publication.json"), "utf8"));
    assert.equal(report.cid, ROOT_CID);
    assert.equal(report.pinProof.type, "recursive");
    assert.ok(report.gatewayProof.every((probe) => probe.status >= 200 && probe.status < 300 && probe.matchesLocal));
  } finally {
    await fake.close();
  }
});

test("Kubo receipt parser rejects oversized, malformed, missing, and duplicate root receipts", async () => {
  for (const mode of ["oversized-line", "malformed", "missing-root", "extra-root"]) {
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

test("a pin-proof failure removes exactly the new root and preserves the previous directory", async () => {
  const outDir = copyFixtureOutput();
  const before = fs.readFileSync(path.join(outDir, "ipfs", "layer.json"));
  const fake = await fakeKubo(outDir, "pin-failure");
  try {
    const result = await runPublisher(outDir, ["--api", fake.base, "--gateway", fake.base]);
    assert.notEqual(result.code, 0);
    assert.deepEqual(fake.state.pinRm, [ROOT_CID], "pin/rm must target only the new root, exactly once");
    assert.deepEqual(fs.readFileSync(path.join(outDir, "ipfs", "layer.json")), before, "failed staging must not replace a completed directory");
    assert.equal(fs.readdirSync(outDir).some((name) => name.startsWith(".ipfs-staging-")), false, "failed staging is removed");
  } finally {
    await fake.close();
  }
});

test("gateway validation rejects status, bytes, bounded bodies, required headers, and missing conditional 304", async () => {
  for (const mode of ["gateway-404", "gateway-byte", "gateway-oversized-content-length", "gateway-chunked-oversize", "gateway-header", "gateway-conditional"]) {
    const outDir = copyFixtureOutput();
    const fake = await fakeKubo(outDir, mode);
    try {
      const result = await runPublisher(outDir, ["--api", fake.base, "--gateway", fake.base]);
      assert.notEqual(result.code, 0, `${mode} must fail the gateway gate`);
      assert.deepEqual(fake.state.pinRm, [ROOT_CID], `${mode} must clean up exactly the new root`);
    } finally {
      await fake.close();
    }
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
