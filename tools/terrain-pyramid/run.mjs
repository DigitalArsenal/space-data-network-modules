// tools/terrain-pyramid — the OFF-FLEET pyramid builder.
//
// PLACEMENT IS THE POINT. The tileset is built HERE, on the build machine,
// under Docker linux/amd64 with the pinned WasmEdge — the same law binaries are
// built under — and never on host-01 or host-02, whose workload placement is
// the owner's to decide. host-01 SERVES the pyramid; it does not cut it.
//
// WHAT THIS IS. A host for the compiled flows/terrain-ingest runtime. The flow
// does all the work: it plans the granule cells, fetches, decodes, cuts tiles
// and authors the storage attribution. This script supplies exactly the four
// host operations the flow's declared capabilities name, and nothing else:
//
//   plugin.getConfig               the run config
//   http.request                   real ranged GETs to the open dataset
//   storage.flatsql_query_stream   the durable resume mark
//   storage.ingest_with_source     append this cell's records to the store
//
// It is deliberately NOT a node: a node would bring identity, peering and a
// service lifetime that a build machine has no business holding. The output is
// a store directory of $DTT records, which is what the dataset-publication lane
// takes (see PUBLISHING.md next to this file).
//
// EVERY CELL IS CUT TWICE. The flow runs in this Node process, so its wasm
// executes in V8 whatever `runtimeTarget: "wasmedge"` declares; the same cell
// is then re-cut under the PINNED NATIVE WasmEdge (AOT when the toolchain has
// the compiler) and the two record streams compared byte for byte. A pyramid
// whose bytes depend on the engine that cut them is not publishable, so a
// divergence stops the run rather than warning.
//
//   node tools/terrain-pyramid/run.mjs --config <run.json> [--out <dir>] [--max-cells N]
//   node tools/terrain-pyramid/run.mjs --config <run.json> --docker
//   ... --no-wasmedge-verify   (states in the report that nothing checked the engine)

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { BoundedGranuleCache } from "./build-support.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const RUNTIME_WASM = path.join(REPO, "flows", "terrain-ingest", "dist", "runtime.wasm");
const SDK_DIR = path.join(REPO, "flows", "terrain-ingest", "node_modules", "space-data-module-sdk");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── argv ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { maxCells: Infinity, docker: false, wasmedgeVerify: true };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--config") args.config = argv[++i];
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--max-cells") args.maxCells = Number(argv[++i]);
    else if (flag === "--cache-dir") args.cacheDir = argv[++i];
    else if (flag === "--cache-max-bytes") args.cacheMaxBytes = Number(argv[++i]);
    else if (flag === "--fetch-retries") args.fetchRetries = Number(argv[++i]);
    else if (flag === "--retry-base-ms") args.retryBaseMs = Number(argv[++i]);
    else if (flag === "--docker") args.docker = true;
    else if (flag === "--no-wasmedge-verify") args.wasmedgeVerify = false;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.config) throw new Error("--config <run.json> is required");
  for (const [name, value] of [["--cache-max-bytes", args.cacheMaxBytes], ["--fetch-retries", args.fetchRetries], ["--retry-base-ms", args.retryBaseMs]]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || !Number.isInteger(value))) {
      throw new Error(`${name} must be a non-negative integer`);
    }
  }
  return args;
}

// ── THE ENGINE THE TILES ARE SERVED UNDER, EXECUTING THE TILES ─────────────
//
// The flow runs in this process, and this process is Node — so the compiled
// runtime executes in V8 no matter what `runtimeTarget: "wasmedge"` declares
// (that is a declaration gate, src/host/runtimeTargetGate.js; there is no
// spawn in flowRuntimeHost.js). `--docker` changed the CPU target and not the
// engine: node:22-bookworm is the same V8 on linux/amd64. So every $DTT byte a
// pyramid published had been cut on ONE engine, and the engine host-01 serves
// them under had never touched them.
//
// This closes that: every cell's `tile` invocation is re-executed under the
// PINNED NATIVE WasmEdge on the parity artifact — the same module minus the
// three host imports, proven equivalent by tests/parity-artifact.test.mjs —
// and the emitted record stream is compared with the flow's, byte for byte. A
// divergence stops the run; it is not a warning, because a pyramid whose bytes
// depend on the engine that cut them is not publishable at all.
async function createWasmEdgeVerifier(repo) {
  const { spawn } = await import("node:child_process");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const os = await import("node:os");
  const sdk = path.join(REPO, "data-source", "terrain-source", "node_modules", "space-data-module-sdk");
  const { encodePluginInvokeRequest, decodePluginInvokeResponse } = await import(
    path.join(sdk, "src/invoke/index.js")
  );
  const { loadWasmEdgePin, assertWasmEdgeVersionMatchesPin } = await import(
    path.join(sdk, "src/testing/parityHarness.js")
  );
  const { resolveWasmEdgeBinary } = await import(path.join(sdk, "src/testing/parityLanes.js"));
  const { normalizeWasmEdgeOutcome } = await import(path.join(sdk, "src/testing/wasmedgeOutput.js"));

  const pin = loadWasmEdgePin();
  const binary = await resolveWasmEdgeBinary({});
  const version = (await promisify(execFile)(binary, ["--version"])).stdout;
  // Pin drift is a failure, never a warning: a pyramid verified against a
  // different runtime than the fleet runs has been verified against nothing.
  assertWasmEdgeVersionMatchesPin(version, pin, `native binary ${binary}`);

  const parityWasm = path.join(repo, "data-source", "terrain-source", "dist", "parity", "module.wasm");
  assert.ok(fs.existsSync(parityWasm), `build the parity artifact first: ${parityWasm}`);
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "terrain-wasmedge-"));
  fs.copyFileSync(parityWasm, path.join(workdir, "module.wasm"));

  // AOT, when the pinned toolchain ships the compiler. Interpreted, a real
  // granule decode costs ~60 s per cell and a regional pyramid would take
  // hours, which is the sort of cost that gets a gate switched off. AOT is also
  // CLOSER to the fleet, not further from it: host-01 prewarms its flows AOT.
  // The compiled module is the same module — same wasm in, same semantics —
  // and if the compiler is absent the interpreter is used and said so.
  let moduleFile = "module.wasm";
  let mode = "interpreted";
  const compiler = path.join(path.dirname(binary), "wasmedgec");
  if (fs.existsSync(compiler)) {
    try {
      await promisify(execFile)(compiler, ["module.wasm", "module-aot.wasm"], { cwd: workdir });
      moduleFile = "module-aot.wasm";
      mode = "AOT";
    } catch {
      // Fall through to the interpreter rather than skipping the check.
    }
  }

  const run = (stdinBytes) =>
    new Promise((resolve, reject) => {
      const child = spawn(binary, ["--enable-threads", moduleFile], {
        cwd: workdir,
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out = [];
      const err = [];
      child.stdout.on("data", (c) => out.push(Buffer.from(c)));
      child.stderr.on("data", (c) => err.push(Buffer.from(c)));
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({ code, stdout: new Uint8Array(Buffer.concat(out)), stderr: new Uint8Array(Buffer.concat(err)) }),
      );
      child.stdin.on("error", () => {});
      child.stdin.end(Buffer.from(stdinBytes));
    });

  return {
    version: `${version.trim().split("\n")[0]} (${mode})`,
    binary,
    async records(inputs) {
      const request = encodePluginInvokeRequest({ methodId: "tile", inputs });
      const outcome = await run(request);
      // WasmEdge writes its own diagnostics to STDOUT; strip them before any
      // guest byte is read.
      const normalized = normalizeWasmEdgeOutcome(outcome);
      if (outcome.code !== 0) {
        throw new Error(
          `wasmedge exited ${outcome.code} verifying a cell: ${Buffer.from(normalized.stderr).toString("utf8").slice(0, 400)}`,
        );
      }
      const response = decodePluginInvokeResponse(normalized.stdout);
      if (response.statusCode !== 0) {
        throw new Error(`wasmedge tile refused: ${response.errorCode}: ${response.errorMessage}`);
      }
      const frame = response.outputs.find((o) => o.portId === "records");
      return Buffer.from(frame ? frame.payload : new Uint8Array(0));
    },
    dispose() {
      fs.rmSync(workdir, { recursive: true, force: true });
    },
  };
}

// ── the hostcall envelope (Go-host dialect; the compiled flow speaks it) ─────
function encodeEnvelope(meta, segments = []) {
  const metaBytes = encoder.encode(JSON.stringify(meta));
  const total = 4 + metaBytes.length + 4 + segments.reduce((n, s) => n + 4 + s.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, metaBytes.length, true);
  out.set(metaBytes, 4);
  let offset = 4 + metaBytes.length;
  view.setUint32(offset, segments.length, true);
  offset += 4;
  for (const segment of segments) {
    view.setUint32(offset, segment.length, true);
    out.set(segment, offset + 4);
    offset += 4 + segment.length;
  }
  return out;
}

function decodeEnvelope(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const metaLen = view.getUint32(0, true);
  const meta = JSON.parse(decoder.decode(bytes.subarray(4, 4 + metaLen)));
  const segments = [];
  let offset = 4 + metaLen;
  if (offset + 4 <= bytes.length) {
    const count = view.getUint32(offset, true);
    offset += 4;
    for (let i = 0; i < count && offset + 4 <= bytes.length; i += 1) {
      const length = view.getUint32(offset, true);
      segments.push(bytes.subarray(offset + 4, offset + 4 + length));
      offset += 4 + length;
    }
  }
  return { meta, segments };
}

// ── the local store ─────────────────────────────────────────────────────────
//
// A directory, not a database. The build machine's job is to PRODUCE the
// records; the record store that serves them is host-01's, and it receives
// them through the dataset-publication lane. Keeping the two apart is what
// stops a build machine from quietly becoming a node.
class TileStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.recordsPath = path.join(dir, "tiles.dttstream");
    this.markPath = path.join(dir, "resume-mark.json");
    this.indexPath = path.join(dir, "tiles.index.jsonl");
    if (!fs.existsSync(this.recordsPath)) fs.writeFileSync(this.recordsPath, Buffer.alloc(0));
    if (!fs.existsSync(this.indexPath)) fs.writeFileSync(this.indexPath, "");
    this.bytes = fs.statSync(this.recordsPath).size;
    this.count = fs.readFileSync(this.indexPath, "utf8").split("\n").filter(Boolean).length;
  }
  // ── THE RESUME MARK IS THE $IRM RECORD, NOT A SIDECAR ───────────────────
  //
  // This used to keep a resume-mark.json of its own and hand it back on the
  // query op, which meant the runner SUBSTITUTED for the storage lane: the
  // flow's durable-mark path — author an $IRM record, write it through
  // storage.write, read it back through the code-named FlatSQL view — was
  // never executed here, and the fact that the flow wrote no mark at all was
  // invisible. The mark store is now the record store: `storage.write` files
  // the record bytes and `storage.flatsql_query_stream` hands them back in the
  // stream framing the connector delivers, newest first.
  writeRecord(type, bytes) {
    const file = path.join(this.dir, `${String(type).toLowerCase()}.records`);
    const framed = Buffer.alloc(4 + bytes.length);
    framed.writeUInt32LE(bytes.length, 0);
    Buffer.from(bytes).copy(framed, 4);
    fs.appendFileSync(file, framed);
  }
  // Newest first, size-prefixed — `ORDER BY _rowid DESC LIMIT n` over the
  // code-named view, in the shape hostcap/flatsql-query's stream port emits.
  readRecords(type, limit) {
    const file = path.join(this.dir, `${String(type).toLowerCase()}.records`);
    if (!fs.existsSync(file)) return Buffer.alloc(0);
    const buf = fs.readFileSync(file);
    const frames = [];
    let offset = 0;
    while (offset + 4 <= buf.length) {
      const length = buf.readUInt32LE(offset);
      if (length === 0 || offset + 4 + length > buf.length) break;
      frames.push(buf.subarray(offset, offset + 4 + length));
      offset += 4 + length;
    }
    return Buffer.concat(frames.reverse().slice(0, limit));
  }
  // The record stream arrives in the store's own framing: [u32 len][record].
  append(streamBytes) {
    const added = [];
    const buf = Buffer.from(streamBytes);
    let offset = 0;
    while (offset + 4 <= buf.length) {
      const length = buf.readUInt32LE(offset);
      offset += 4;
      if (length === 0) continue;
      assert.ok(offset + length <= buf.length, "a length prefix must not run past the stream");
      added.push(buf.subarray(offset, offset + length));
      offset += length;
    }
    if (added.length === 0) return [];
    fs.appendFileSync(this.recordsPath, buf);
    this.bytes += buf.length;
    this.count += added.length;
    return added;
  }
  appendIndex(rows) {
    if (rows.length === 0) return;
    fs.appendFileSync(this.indexPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  }
}

// ── a minimal $DTT reader, for the run report only ──────────────────────────
// The records are the flow's; this reads back just enough to state what was
// built. It is deliberately independent of the encoder.
function readDtt(record) {
  const buf = Buffer.from(record);
  if (buf.subarray(4, 8).toString("latin1") !== "$DTT") return null;
  const pos = buf.readUInt32LE(0);
  const fieldPos = (id) => {
    const vtable = pos - buf.readInt32LE(pos);
    const vo = 4 + 2 * id;
    if (vo >= buf.readUInt16LE(vtable)) return 0;
    const off = buf.readUInt16LE(vtable + vo);
    return off === 0 ? 0 : pos + off;
  };
  const u32 = (id) => { const p = fieldPos(id); return p ? buf.readUInt32LE(p) : 0; };
  const f64 = (id) => { const p = fieldPos(id); return p ? buf.readDoubleLE(p) : 0; };
  const i8 = (id) => { const p = fieldPos(id); return p ? buf.readInt8(p) : 0; };
  const payloadRef = () => {
    const p0 = fieldPos(15);
    if (!p0) return null;
    const p = p0 + buf.readUInt32LE(p0);
    const vtable = p - buf.readInt32LE(p);
    const at = (id) => {
      const vo = 4 + 2 * id;
      if (vo >= buf.readUInt16LE(vtable)) return 0;
      const off = buf.readUInt16LE(vtable + vo);
      return off === 0 ? 0 : p + off;
    };
    const bytesAt = at(1);
    let byteLength = 0;
    if (bytesAt) {
      const vp = bytesAt + buf.readUInt32LE(bytesAt);
      byteLength = buf.readUInt32LE(vp);
    }
    return { byteLength };
  };
  return {
    level: u32(3),
    x: u32(4),
    y: u32(5),
    minHeightM: f64(11),
    maxHeightM: f64(12),
    waterMaskKind: i8(28),
    payloadBytes: payloadRef()?.byteLength ?? 0,
  };
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runConfig = JSON.parse(fs.readFileSync(path.resolve(args.config), "utf8"));
  const outDir = path.resolve(args.out ?? runConfig.out ?? path.join(HERE, "out"));

  if (args.docker) {
    const { spawnSync } = await import("node:child_process");
    // The SAME law binaries are built under: linux/amd64, in the container, so
    // the artifact and the run are reproducible off this laptop — AND with the
    // pinned WasmEdge inside it, so the containerized run is authoritative for
    // the ENGINE as well as the CPU target. `node:22-bookworm` alone was not:
    // it is the same V8, and the engine host-01 serves these tiles under had
    // never executed them.
    const sdk = path.join(REPO, "data-source", "terrain-source", "node_modules", "space-data-module-sdk");
    const { loadWasmEdgePin } = await import(path.join(sdk, "src/testing/parityHarness.js"));
    const pin = loadWasmEdgePin();
    const image = runConfig.docker_image ?? `spacedatanetwork/terrain-pyramid-builder:${pin.wasmedgeVersion}`;
    const exists = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" });
    if (exists.status !== 0) {
      process.stdout.write(`building ${image} (WasmEdge ${pin.wasmedgeVersion})\n`);
      const built = spawnSync(
        "docker",
        [
          "build", "--platform", "linux/amd64",
          "--build-arg", `WASMEDGE_VERSION=${pin.wasmedgeVersion}`,
          "-t", image,
          "-f", path.join(HERE, "Dockerfile"),
          HERE,
        ],
        { stdio: "inherit" },
      );
      if (built.status !== 0) process.exit(built.status ?? 1);
    }
    const result = spawnSync(
      "docker",
      [
        "run", "--rm", "--platform", "linux/amd64",
        "-v", `${REPO}:/work`,
        "-v", `${outDir}:/out`,
        "-w", "/work",
        image,
        "node", "tools/terrain-pyramid/run.mjs",
        "--config", path.relative(REPO, path.resolve(args.config)),
        "--out", "/out",
        ...(args.wasmedgeVerify ? [] : ["--no-wasmedge-verify"]),
        ...(Number.isFinite(args.maxCells) ? ["--max-cells", String(args.maxCells)] : []),
      ],
      { stdio: "inherit" },
    );
    process.exit(result.status ?? 1);
  }

  assert.ok(fs.existsSync(RUNTIME_WASM), `build the flow first: ${RUNTIME_WASM}`);
  const { createFlowRuntimeHost } = await import(path.join(SDK_DIR, "src/flow/index.js"));

  const store = new TileStore(outDir);
  const flowConfig = runConfig.flow_config ?? {};
  const stats = {
    cells: 0,
    fetches: 0,
    fetch404: 0,
    fetchRetries: 0,
    fetchBytes: 0,
    tiles: 0,
    marksWritten: 0,
    wasmedgeVerifiedCells: 0,
    oceanSkipped: 0,
    uniformMasks: 0,
    rasterMasks: 0,
    tileBytes: [],
    // ── WHAT THE SOURCE ACTUALLY CARRIES, PER LEVEL ─────────────────────────
    //
    // The encoder reports `sourcePostsPerTileEdge` on every block frame, and
    // the escalation that asked the coordinator to rule 217 vs 361 turned on
    // exactly this ratio — yet the runner dropped the field before writing the
    // summary, so the number the ruling depended on appeared in NO committed
    // run report, only in a `//` comment in a region file. It is carried now
    // (coordinator resolution 2026-08-27 (7)), with the lattice the ladder was
    // allowed to climb to beside it, because "316 source posts" only means
    // something next to "a 361-post lattice".
    sourcePostsPerTileEdgeByLevel: {},
    latticeMaxGridSize: 0,
    // Every address the ocean test skipped, not just how many. See the note at
    // the collection site: the count alone cannot be declared, and an address
    // that is not declared is one a client falls off the bottom of.
    oceanSkippedAddresses: [],
    // ── THE ENCODER'S OWN COUNTERS, CARRIED OUT OF THE RUN ──────────────────
    //
    // The `tile` node emits these per block and the flow lands them on egress,
    // and until now the runner read `tilesEmitted` off that frame and threw
    // the rest away — so `edgeClampedPosts` was emitted by the encoder,
    // reported by the flow, and read by NOBODY. A clamped post is a displaced
    // sample, it is invisible to the record's own accuracy probe (that probe
    // uses the same sampler) and invisible to the adjacent-tile seam check
    // (a clamped grid-interior row is not a tile edge), so nothing else in
    // this lane can see it. verify.mjs gates on it.
    edgeClampedPosts: 0,
    // Posts whose stencil crossed a Copernicus latitude-band boundary and was
    // interpolated on the other granule's lattice. NOT a defect — it is what
    // the band fix does — and counted separately from a clamp precisely so the
    // two stay distinguishable.
    bandBridgedPosts: 0,
    // Tiles that shipped as dense as they were allowed and still did not meet
    // the error target. The encoder's word for it; verify.mjs re-derives the
    // same figure from the records and the two are compared.
    tilesAtCeiling: 0,
    // Tiles the ocean test skipped, and how many of those the SOURCE arm
    // decided rather than the interpolated lattice. The split is the point: an
    // all-water tile whose boundary grazes a coast has a lifted corner VERTEX
    // and cannot be recognised from the mesh, so the lattice arm alone silently
    // stores it. Carried out of the run so the arm's firing is a measured
    // number rather than a claim about what would happen at global scale.
    tilesSkippedOcean: 0,
    tilesSkippedOceanFromSource: 0,
    // Water-mask samples inferred from an ABSENT DEM granule — WATER, and by
    // design: Copernicus publishes no object at all over open ocean, so
    // "nothing covers this" is the dataset's own way of saying sea. Reported,
    // never gated.
    maskFromAbsenceSamples: 0,
    // Samples the DEM DOES cover but no water granule classifies. These fall
    // back to LAND, and that is the fabricated-land shape: this lane shipped
    // 40,527 invented LAND samples in the open Ligurian Sea when the fallback
    // was block-wide, and a non-zero count now means the plan did not fetch a
    // WBM auxfile for ground it did fetch elevation for. verify.mjs refuses it.
    maskUnclassifiedSamples: 0,
    errors: [],
  };

  // ── the four host operations, and only those ─────────────────────────────
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);
  let lastCellRecords = Buffer.alloc(0);
  const pending = [];

  const imports = {
    space_data_module_host: {
      call(opPtr, opLen, payloadPtr, payloadLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const operation = decoder.decode(heap.subarray(opPtr, opPtr + opLen));
        const payload = Uint8Array.from(heap.subarray(payloadPtr, payloadPtr + payloadLen));
        const { meta, segments } = decodeEnvelope(payload);
        const handler = pending.find((p) => p.operation === operation && p.matches(meta));
        if (!handler) {
          response = encodeEnvelope({ ok: false, message: `unexpected op ${operation}` });
          return 1;
        }
        response = handler.respond(meta, segments);
        return 0;
      },
      response_len() {
        return response.length;
      },
      read_response(dstPtr, dstLen) {
        const heap = new Uint8Array(memoryRef.memory.buffer);
        const length = Math.min(dstLen, response.length);
        heap.set(response.subarray(0, length), dstPtr);
        return length;
      },
    },
  };

  // http.request is asynchronous and the hostcall bridge is synchronous, so
  // every granule for a cell is PREFETCHED before the tick runs. The flow's
  // request descriptors are deterministic for a given mark, which is what
  // makes prefetching sound rather than a guess: the same enumeration that
  // decides the cell decides its eight URLs.
  // The granule cache is ON DISK, not in memory, and that is not an
  // optimisation. A region's granules are tens of gigabytes and the SAME
  // granule is needed again at every level of the pyramid, so an in-memory
  // cache either exhausts the machine or re-downloads the dataset once per
  // level. On disk, each granule is fetched ONCE for the whole run and only
  // the granule being decoded is resident.
  // Global source coverage is 529 GiB if every granule is retained.  The
  // default is deliberately below the measured 382 GiB host free space; a
  // global config may choose a lower cap, but it may not opt back into an
  // unbounded cache.  Leases preserve the eight files needed by an active cell
  // across concurrent shard workers while LRU evicts completed cells.
  const cacheMaxBytes = args.cacheMaxBytes ?? runConfig.cache_max_bytes ?? 128 * 1024 ** 3;
  const granuleCache = new BoundedGranuleCache({
    dir: args.cacheDir ?? runConfig.cache_dir ?? path.join(outDir, "granules"),
    maxBytes: cacheMaxBytes,
  });
  const cachePath = (url) => granuleCache.paths(url).body;
  const statusPath = (url) => granuleCache.paths(url).status;

  async function prefetch(urls) {
    await Promise.all(
      urls.map(async (url) => {
        const fetched = await granuleCache.fetch(url, {
          retries: args.fetchRetries ?? runConfig.fetch_retries ?? 4,
          retryBaseMs: args.retryBaseMs ?? runConfig.retry_base_ms ?? 250,
          onRetry: () => { stats.fetchRetries += 1; },
        });
        if (!fetched.hit) {
          stats.fetches += 1;
          stats.fetchBytes += fetched.body.length;
          if (fetched.status === 404) stats.fetch404 += 1;
        }
      }),
    );
  }

  pending.push({
    operation: "plugin.getConfig",
    matches: () => true,
    respond: () => encodeEnvelope(flowConfig),
  });
  pending.push({
    operation: "storage.flatsql_query_stream",
    matches: () => true,
    respond: (meta) => {
      // The flow asks for `SELECT _data FROM IRM ORDER BY _rowid DESC LIMIT ?`.
      // This host is not an engine, but it answers the SAME question over the
      // same relation, in the same framing, newest first — so the read side
      // under test here is the read side that runs on a node.
      const limit = Number(meta?.params?.[0]?.v ?? meta?.params?.[0] ?? 32) || 32;
      const stream = store.readRecords("IRM", limit);
      return encodeEnvelope({ ok: true }, stream.length ? [new Uint8Array(stream)] : []);
    },
  });
  pending.push({
    operation: "storage.write",
    matches: () => true,
    respond: (meta) => {
      // The hostcall contract is {schema, source?, data:base64} — `schema`, not
      // `type`; a host that reads the wrong key refuses every write and the
      // durable mark is never persisted even once.
      const schema = String(meta?.schema ?? "");
      if (!schema) return encodeEnvelope({ ok: false, message: "missing schema" });
      const bytes = Buffer.from(String(meta?.data ?? ""), "base64");
      if (bytes.length === 0) return encodeEnvelope({ ok: false, message: "empty record" });
      store.writeRecord(schema, bytes);
      stats.marksWritten += 1;
      return encodeEnvelope({ ok: true, result: { ok: true, schema, bytes: bytes.length } });
    },
  });
  pending.push({
    operation: "http.request",
    matches: () => true,
    respond: (meta) => {
      if (!fs.existsSync(statusPath(meta.url))) {
        // A cache miss means the URL the flow asked for is not the URL the
        // planner derived, which would mean the enumeration is not the pure
        // function of config-and-mark this runner rests on. Fail loudly.
        return encodeEnvelope({ ok: false, message: `not prefetched: ${meta.url}` });
      }
      const status = Number(fs.readFileSync(statusPath(meta.url), "utf8"));
      const body = new Uint8Array(fs.readFileSync(cachePath(meta.url)));
      return encodeEnvelope({ ok: true, status, result: { status, headers: {} } }, [body]);
    },
  });
  pending.push({
    operation: "storage.ingest_with_source",
    matches: () => true,
    respond: (meta, segments) => {
      // Kept verbatim so the WasmEdge cross-check compares the bytes the flow
      // ACTUALLY stored, not a re-encode of them.
      lastCellRecords = Buffer.from(segments[0] ?? new Uint8Array(0));
      const added = store.append(segments[0] ?? new Uint8Array(0));
      const rows = [];
      for (const record of added) {
        const dtt = readDtt(record);
        if (!dtt) continue;
        stats.tiles += 1;
        stats.tileBytes.push(dtt.payloadBytes);
        if (dtt.waterMaskKind === 3) stats.rasterMasks += 1;
        else stats.uniformMasks += 1;
        rows.push(dtt);
      }
      store.appendIndex(rows);
      // `inserted`, NOT `records` — the connector's own key. hostcap/storage-
      // ingest documents its host result as {"schema","inserted","batch_id",…}
      // and publish_request reads `inserted` for two things: the silent-nop
      // guard (ok:true with inserted=0 for a batch that carried tiles must NOT
      // advance the mark) and the mark's cumulative RECORDS_COMMITTED. Under
      // the wrong key both were dead: `inserted` parsed as absent (-1), so the
      // guard could never fire in the only host that drives this flow, and
      // every $IRM mark this runner wrote claimed 0 records committed no
      // matter how many tiles it stored. Found by
      // flows/terrain-ingest/tests/flow.test.mjs, which is why that package
      // now has tests.
      return encodeEnvelope({
        ok: true,
        result: { ok: true, schema: meta?.schema, batch_id: meta?.batch_id, inserted: added.length },
      });
    },
  });

  // ── the tick loop ───────────────────────────────────────────────────────
  //
  // TWO PASSES PER CELL, and the reason is mechanical rather than a hedge: the
  // guest's hostcall bridge is SYNCHRONOUS and a network fetch is not, so every
  // granule a cell needs must already be in hand before the flow runs.
  //
  //   PASS 1 invokes terrain-ingest's granule_plan ALONE, against the same
  //     config and the same durable mark the flow will see. The enumeration is
  //     a pure function of those two, so the eight URLs it names are exactly
  //     the eight the flow will ask for — this is a derivation, not a guess.
  //   PASS 2 runs the WHOLE compiled flow with every response cached, so the
  //     flow does the planning, decoding, tiling and storing itself. Nothing
  //     here reimplements any of it.
  const { createBrowserModuleHarness } = await import(path.join(SDK_DIR, "src/testing/index.js"));
  const INGEST_WASM = path.join(REPO, "data-source", "terrain-ingest", "dist", "isomorphic", "module.wasm");
  const INGEST_MANIFEST = JSON.parse(
    fs.readFileSync(path.join(REPO, "data-source", "terrain-ingest", "plugin-manifest.json"), "utf8"),
  );

  const alignedFrame = (portId, value) => {
    const bytes = encoder.encode(JSON.stringify(value));
    return {
      portId,
      typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: bytes.byteLength },
      payload: bytes,
    };
  };

  // THE FLOW AND THE PLANNER MUST BE THE SAME BUILD.
  //
  // Pass 1 plans with the standalone terrain-ingest artifact; pass 2 runs a
  // compiled flow that STATICALLY LINKED its own copy. Rebuild one without the
  // other and the two disagree silently — which is not hypothetical: a flow
  // built before the resume mark's stride was corrected advanced the mark by
  // the tile count instead of by one cell, skipped most of the enumeration,
  // and reported a clean drained run with a quarter of the pyramid built. The
  // compiled flow records the SHA-256 of every dependency it linked, so the
  // disagreement is checkable before a single granule is fetched.
  {
    const probe = await createFlowRuntimeHost({
      wasmSource: new Uint8Array(fs.readFileSync(RUNTIME_WASM)),
      extraImports: imports,
      runtimeTarget: "wasmedge",
    });
    memoryRef.memory = probe.memory;
    const linked = new Map();
    for (let i = 0; i < probe.dependencyCount; i += 1) {
      const descriptor = probe.getDependencyDescriptor(i);
      linked.set(descriptor.pluginId, descriptor.sha256);
    }
    for (const [pluginId, artifact] of [
      ["com.digitalarsenal.data-source.terrain-ingest", INGEST_WASM],
      ["com.digitalarsenal.data-source.terrain-source", path.join(REPO, "data-source", "terrain-source", "dist", "isomorphic", "module.wasm")],
    ]) {
      const onDisk = createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
      const inFlow = linked.get(pluginId);
      if (inFlow && inFlow !== onDisk) {
        throw new Error(
          `${pluginId} in ${path.basename(RUNTIME_WASM)} is ${inFlow} but the built artifact is ` +
            `${onDisk}. Rebuild the flow (flows/terrain-ingest: npm run build) before building a ` +
            "pyramid: a flow and a planner from different builds disagree silently.",
        );
      }
    }
  }

  async function planCell() {
    const harness = await createBrowserModuleHarness({
      wasmSource: fs.readFileSync(INGEST_WASM),
      manifest: INGEST_MANIFEST,
      surface: "direct",
      hostcallDispatch: (operation) => {
        if (operation === "plugin.getConfig") return flowConfig;
        throw new Error(`unexpected hostcall operation: ${operation}`);
      },
    });
    try {
      const inputs = [alignedFrame("tick", { firedAt: new Date().toISOString() })];
      // The SAME durable mark the flow will read on its own pass — the $IRM
      // record out of the store, in the stream framing the query connector
      // delivers. Pass 1 and pass 2 must see one mark or the enumeration stops
      // being the pure function of config-and-mark this runner rests on.
      const mark = store.readRecords("IRM", 32);
      if (mark.length) {
        inputs.push({
          portId: "mark",
          typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: mark.length },
          payload: new Uint8Array(mark),
        });
      }
      const result = await harness.invoke({ methodId: "granule_plan", inputs });
      if (result.statusCode !== 0) {
        throw new Error(`granule_plan refused: ${result.errorCode}: ${result.errorMessage}`);
      }
      const byPort = new Map();
      for (const out of result.outputs) byPort.set(out.portId, JSON.parse(decoder.decode(out.payload)));
      if (!byPort.has("plan")) return null; // drained
      const urls = [];
      for (let slot = 0; slot < 4; slot += 1) {
        urls.push(byPort.get(`dem_${slot}`).url, byPort.get(`wbm_${slot}`).url);
      }
      return { job: byPort.get("job"), plan: byPort.get("plan"), urls, backlog: result.backlogRemaining ?? 0 };
    } finally {
      harness.destroy();
    }
  }

  async function buildCell() {
    const host = await createFlowRuntimeHost({
      wasmSource: new Uint8Array(fs.readFileSync(RUNTIME_WASM)),
      extraImports: imports,
      runtimeTarget: "wasmedge",
    });
    memoryRef.memory = host.memory;
    const observed = [];
    host.enqueueTriggerFrame(0, {
      portId: "tick",
      bytes: encoder.encode(JSON.stringify({ firedAt: new Date().toISOString() })),
    });
    await host.drain(
      {
        "sdn.flow.egress:emit": ({ frames }) => {
          for (const frame of frames) observed.push(decoder.decode(frame.bytes));
          return { statusCode: 0 };
        },
      },
      { maxIterations: 400 },
    );
    let stored = 0;
    let markJson = null;
    for (const text of observed) {
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        continue;
      }
      if (value.tilesEmitted !== undefined) {
        stored += value.tilesEmitted;
        stats.edgeClampedPosts += value.edgeClampedPosts ?? 0;
        stats.bandBridgedPosts += value.bandBridgedPosts ?? 0;
        stats.tilesAtCeiling += value.tilesAtCeiling ?? 0;
        stats.tilesSkippedOcean += value.tilesSkippedOcean ?? 0;
        stats.tilesSkippedOceanFromSource += value.tilesSkippedOceanFromSource ?? 0;
        if (Number.isFinite(value.sourcePostsPerTileEdge) && value.sourcePostsPerTileEdge > 0) {
          stats.sourcePostsPerTileEdgeByLevel[value.level] = +value.sourcePostsPerTileEdge.toFixed(1);
        }
        if (Number.isFinite(value.maxGridSize)) {
          stats.latticeMaxGridSize = Math.max(stats.latticeMaxGridSize, value.maxGridSize);
        }
        for (const tile of value.tiles ?? []) {
          stats.maskFromAbsenceSamples += tile.maskFromAbsenceSamples ?? 0;
          stats.maskUnclassifiedSamples += tile.maskUnclassifiedSamples ?? 0;
          // ── THE ADDRESSES THE OCEAN TEST DROPPED ────────────────────────
          //
          // The encoder has always reported them, and this runner has always
          // thrown them away and kept the COUNT. That loss is what made
          // `terrain_ocean_synth_min_level` a dead lever: verify.mjs derives
          // `available` from STORED tiles, so a tile the ocean test skipped
          // vanished from the published availability entirely, and a client
          // over open water refined until availability ran out and then
          // rendered the shallowest ANCESTOR — a flat height-0 tile with a
          // UNIFORM LAND mask, because an ancestor sits below the level where
          // the store is authoritative and fails safe to land. Measured on the
          // regional pyramid: 24.3% of the ocean inside the tileset's own
          // extent came back as land, on the one lane whose whole reason for
          // choosing a coastal region was to exercise the water mask.
          //
          // A skipped tile is not an absence of knowledge — it is the
          // encoder's MEASUREMENT that the address is all water. Carried out
          // of the run so it can be DECLARED, and answered by the module's
          // synthesized UNIFORM_WATER path, which is exactly what that path
          // was built for.
          if (tile.skippedOcean) {
            stats.oceanSkippedAddresses.push(`${tile.level}/${tile.x}/${tile.y}`);
          }
        }
      }
      // The operator-readable JSON mark, which the flow still lands on egress.
      // It is NOT the durable one and it is not what advances the walk: the
      // durable mark is the $IRM record the flow wrote through storage.write,
      // and `marksWritten` below is the only evidence that happened.
      if (value.next_tile_index !== undefined) markJson = value;
    }
    if (markJson) fs.writeFileSync(store.markPath, `${JSON.stringify(markJson)}\n`);
    return { stored, markJson };
  }

  // The same `tile` invocation the flow performs, reassembled from the plan
  // and the granule cache — the flow's own inputs, not a paraphrase of them.
  function tileInputsFor(planned) {
    const inputs = [
      {
        portId: "plan",
        typeRef: {
          wireFormat: "aligned-binary",
          requiredAlignment: 1,
          byteLength: encoder.encode(JSON.stringify(planned.plan)).length,
        },
        payload: encoder.encode(JSON.stringify(planned.plan)),
      },
    ];
    for (let slot = 0; slot < 4; slot += 1) {
      for (const [port, url] of [["dem", planned.urls[slot * 2]], ["water", planned.urls[slot * 2 + 1]]]) {
        if (!fs.existsSync(statusPath(url))) continue;
        const status = Number(fs.readFileSync(statusPath(url), "utf8"));
        const body = fs.readFileSync(cachePath(url));
        // hostcap/http-request responseWire "raw-body-v1": "$HRB", LE status,
        // body verbatim — the frame the flow's http node hands the encoder.
        const hrb = Buffer.alloc(8 + body.length);
        hrb.write("$HRB", 0, "latin1");
        hrb.writeUInt32LE(status, 4);
        body.copy(hrb, 8);
        inputs.push({
          portId: port,
          typeRef: { wireFormat: "aligned-binary", requiredAlignment: 1, byteLength: hrb.length },
          payload: new Uint8Array(hrb),
        });
      }
    }
    return inputs;
  }

  let wasmedge = null;
  if (args.wasmedgeVerify) {
    wasmedge = await createWasmEdgeVerifier(REPO);
    process.stdout.write(`wasmedge cross-check: ${wasmedge.version} (${wasmedge.binary})\n`);
  } else {
    process.stdout.write(
      "wasmedge cross-check DISABLED: these tiles were cut on one engine and nothing has " +
        "checked them against the one that serves them\n",
    );
  }

  const started = Date.now();
  let backlog = Infinity;
  const report = [];

  while (stats.cells < args.maxCells && backlog > 0) {
    const planned = await planCell();
    if (!planned) {
      backlog = 0;
      break;
    }
    try {
      await prefetch(planned.urls);
    const marksBefore = stats.marksWritten;
    const built = await buildCell();
    // THE DURABLE MARK IS THE TEST, not the egress frame. Without a mark IN THE
    // STORE the next tick re-plans the SAME cell forever, and that is exactly
    // the failure this runner used to hide by keeping its own resume-mark.json:
    // the flow wrote no mark at all, and nothing said so.
    if (stats.marksWritten === marksBefore) {
      stats.errors.push(
        `cell ${planned.job.cell_index} stored ${built.stored} tiles but wrote NO durable $IRM ` +
          "mark; the next tick would replan the same cell forever",
      );
      break;
    }
    if (!built.markJson) {
      stats.errors.push(
        `cell ${planned.job.cell_index} wrote a durable mark but no operator-readable mark on egress`,
      );
      break;
    }
    if (wasmedge) {
      const underWasmEdge = await wasmedge.records(tileInputsFor(planned));
      if (!underWasmEdge.equals(lastCellRecords)) {
        stats.errors.push(
          `cell ${planned.job.cell_index}: the record stream differs between engines — ` +
            `V8 produced ${lastCellRecords.length} B (sha256 ` +
            `${createHash("sha256").update(lastCellRecords).digest("hex").slice(0, 16)}), ` +
            `WasmEdge produced ${underWasmEdge.length} B (sha256 ` +
            `${createHash("sha256").update(underWasmEdge).digest("hex").slice(0, 16)}). ` +
            "A pyramid whose bytes depend on the engine that cut them is not publishable.",
        );
        break;
      }
      stats.wasmedgeVerifiedCells += 1;
    }
    backlog = planned.backlog;
    stats.cells += 1;
    report.push({
      cell: planned.job.cell_index,
      level: planned.job.level,
      lon: planned.job.cell_lon,
      lat: planned.job.cell_lat,
      region: planned.job.region,
      tilesInCell: planned.job.cell_tiles,
      tilesStored: built.stored,
      backlog,
    });
    process.stdout.write(
      `cell ${planned.job.cell_index} z${planned.job.level} ` +
        `(${planned.job.cell_lon},${planned.job.cell_lat}) tiles ${planned.job.cell_tiles} ` +
        `stored ${built.stored} backlog ${backlog}\n`,
    );
    } finally {
      // The cell's flow and parity pass have consumed these exact bytes, or
      // have failed. Either way this worker must not leave a permanent lease
      // that makes a resumed global build falsely report the cache exhausted.
      for (const url of planned.urls) granuleCache.release(url);
    }
  }

  const elapsed = Date.now() - started;
  const sorted = [...stats.tileBytes].sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    outDir,
    elapsedMs: elapsed,
    cells: stats.cells,
    // A bounded rehearsal can intentionally stop at --max-cells.  It is a
    // valid resume point, but never a completed shard: global-build.mjs only
    // accepts a report as terminal when this is true.
    drained: backlog <= 0,
    fetches: stats.fetches,
    fetch404: stats.fetch404,
    fetchRetries: stats.fetchRetries,
    granuleCache: {
      dir: granuleCache.dir,
      maxBytes: granuleCache.maxBytes,
      usedBytes: granuleCache.usageBytes(),
      evictions: granuleCache.evictions,
    },
    fetchMiB: +(stats.fetchBytes / 1048576).toFixed(2),
    tiles: stats.tiles,
    // Durable $IRM marks actually written through storage.write. One per cell
    // is the contract; anything else means the resume lane is not closing.
    durableMarksWritten: stats.marksWritten,
    // Cells whose $DTT record stream was re-cut under the PINNED NATIVE
    // WasmEdge and compared byte for byte with the V8 run. Equal to `cells`
    // means every published byte is engine-independent; 0 means nothing checked
    // the engine the fleet actually serves under.
    wasmedgeVerifiedCells: stats.wasmedgeVerifiedCells,
    wasmedgeRuntime: wasmedge ? wasmedge.version : null,
    storeBytes: store.bytes,
    storeMiB: +(store.bytes / 1048576).toFixed(2),
    tileBytesP50: pct(0.5),
    tileBytesP99: pct(0.99),
    tileBytesMax: sorted.length ? sorted[sorted.length - 1] : 0,
    uniformMasks: stats.uniformMasks,
    rasterMasks: stats.rasterMasks,
    uniformMaskRatio: stats.tiles ? +(stats.uniformMasks / stats.tiles).toFixed(4) : 0,
    // The two numbers that say what the accuracy figures in this store are a
    // statement ABOUT: how many source posts a tile edge carries at each level
    // built, and the densest lattice the density ladder could climb to. The
    // record's VERTICAL_ACCURACY_M is measured at the SOURCE POSTS whatever
    // these say (coordinator resolution 1), so they no longer bound what the
    // measurement can SEE — they bound what the ladder can BUY.
    sourcePostsPerTileEdgeByLevel: stats.sourcePostsPerTileEdgeByLevel,
    latticeMaxGridSize: stats.latticeMaxGridSize,
    // What the ENCODER said about its own work, carried out of the run so a
    // gate can read it. verify.mjs re-derives tilesAtCeiling from the records
    // independently and refuses a pyramid with any clamped post at all.
    encoderCounters: {
      edgeClampedPosts: stats.edgeClampedPosts,
      bandBridgedPosts: stats.bandBridgedPosts,
      tilesAtCeiling: stats.tilesAtCeiling,
      tilesSkippedOcean: stats.tilesSkippedOcean,
      tilesSkippedOceanFromSource: stats.tilesSkippedOceanFromSource,
      maskFromAbsenceSamples: stats.maskFromAbsenceSamples,
      maskUnclassifiedSamples: stats.maskUnclassifiedSamples,
    },
    errors: stats.errors,
    cellsDetail: report,
  };
  if (wasmedge) wasmedge.dispose();
  // The skipped-ocean addresses ride in their own file rather than in the run
  // report: there are hundreds to thousands of them on a real region (989 on
  // the regional proof), they are consumed by exactly one reader, and burying
  // a machine-read list inside an operator-read summary is how the count came
  // to be kept while the addresses were dropped.
  const oceanSkipped = {
    generatedAt: summary.generatedAt,
    // The level at and below which "declared but not stored" means "the
    // encoder measured it all-ocean and skipped it". Below it no level is
    // authoritative and a synthesized tile must fail safe to LAND.
    minLevel: Math.min(...stats.oceanSkippedAddresses.map((a) => Number(a.split("/")[0])), Infinity),
    count: stats.oceanSkippedAddresses.length,
    addresses: [...stats.oceanSkippedAddresses].sort(),
  };
  if (!Number.isFinite(oceanSkipped.minLevel)) oceanSkipped.minLevel = null;
  fs.writeFileSync(
    path.join(outDir, "ocean-skipped.json"),
    `${JSON.stringify(oceanSkipped, null, 2)}\n`,
  );
  if (oceanSkipped.count !== stats.tilesSkippedOcean) {
    stats.errors.push(
      `the encoder counted ${stats.tilesSkippedOcean} ocean skips and named ` +
        `${oceanSkipped.count} addresses; a skip that is not named cannot be declared, and an ` +
        "address that is not declared is one a client falls off the bottom of into a land tile",
    );
    summary.errors = stats.errors;
  }
  fs.writeFileSync(path.join(outDir, "run-report.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
