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
import { MAX_TERRAIN_RECORD_BYTES } from "./dtt-reader.mjs";
import {
  cellAttemptAppendBound,
  FixedHistogram,
  SourceRequestObserver,
  canonicalJson,
  commitCellAttempt,
  ensureSourceEpoch,
  observationForRequest,
  publicationPolicyContract,
  recoverCellAttempt,
  sha256,
  sourceObservationLine,
  sourcePolicyAllowsUrl,
  sourcePolicyContract,
  validateCachedSource,
} from "./source-provenance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const RUNTIME_WASM = path.join(REPO, "flows", "terrain-ingest", "dist", "runtime.wasm");
const SDK_DIR = path.join(REPO, "flows", "terrain-ingest", "node_modules", "space-data-module-sdk");

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_CELL_DETAIL_LINE_BYTES = 4096;
const MAX_CELL_DETAIL_SAMPLE = 128;
const MAX_RESUME_MARK_BYTES = 256 * 1024;

function sameStableFile(left, right, label) {
  assert.equal(right.dev, left.dev, `${label} inode changed`);
  assert.equal(right.ino, left.ino, `${label} inode changed`);
  assert.equal(right.size, left.size, `${label} size changed`);
  assert.equal(right.mtimeNs, left.mtimeNs, `${label} mtime changed`);
  assert.equal(right.ctimeNs, left.ctimeNs, `${label} ctime changed`);
}

// A cell journal can survive after its terminal $IRM append but before the
// operator-readable sidecar advances. Recovery must plan against that older
// sidecar state: reading `$IRM` here would select the *next* cell and could
// apply a valid derived cap to the wrong journal. Hold one no-follow regular
// file descriptor through the bounded read, then prove the name still denotes
// that same stable inode before handing its bytes to the planner.
function readPriorResumeMark(outDir) {
  const root = path.resolve(outDir);
  const file = path.join(root, "resume-mark.json");
  const rootStat = fs.lstatSync(root);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(),
    "resume mark output directory is not a real directory");
  let named;
  try {
    named = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
  assert.ok(named.isFile() && !named.isSymbolicLink(), "resume mark is not a regular file");
  assert.ok(named.size <= BigInt(MAX_RESUME_MARK_BYTES), "resume mark exceeds bounded planner input");
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(handle, { bigint: true });
    assert.ok(before.isFile(), "resume mark is not a regular file");
    sameStableFile(named, before, "resume mark changed before open");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
      assert.ok(read > 0, "resume mark ended while reading");
      offset += read;
    }
    sameStableFile(before, fs.fstatSync(handle, { bigint: true }), "resume mark changed while reading");
    const after = fs.lstatSync(file, { bigint: true });
    sameStableFile(before, after, "resume mark path changed while reading");
    const mark = JSON.parse(decoder.decode(bytes));
    assert.ok(mark && typeof mark === "object" && !Array.isArray(mark),
      "resume mark must be a JSON object");
    return bytes;
  } finally {
    fs.closeSync(handle);
  }
}

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
    else if (flag === "--fault-cell-phase") args.faultCellPhase = argv[++i];
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
    // Do not turn a long-resumed global run's complete $IRM history into one
    // buffer just to answer `LIMIT 32`. The storage relation is append-only;
    // scan it in fixed blocks and retain only the bounded newest window.
    const maximum = Math.min(Math.max(1, Number(limit) || 1), 64);
    const frameLimit = 256 * 1024;
    const handle = fs.openSync(file, "r");
    const chunk = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    const frames = [];
    try {
      let position = 0;
      while (true) {
        const read = fs.readSync(handle, chunk, 0, chunk.length, position);
        if (!read) break;
        position += read;
        pending = pending.length ? Buffer.concat([pending, chunk.subarray(0, read)]) : Buffer.from(chunk.subarray(0, read));
        let offset = 0;
        while (offset + 4 <= pending.length) {
          const length = pending.readUInt32LE(offset);
          assert.ok(length > 0 && length <= frameLimit, "durable $IRM frame has an invalid bounded length");
          if (offset + 4 + length > pending.length) break;
          frames.push(Buffer.from(pending.subarray(offset, offset + 4 + length)));
          if (frames.length > maximum) frames.shift();
          offset += 4 + length;
        }
        pending = pending.subarray(offset);
        assert.ok(pending.length <= frameLimit + 4, "durable $IRM carry exceeds bounded frame length");
      }
    } finally {
      fs.closeSync(handle);
    }
    assert.equal(pending.length, 0, "durable $IRM record stream ends inside a frame");
    return Buffer.concat(frames.reverse().slice(0, maximum));
  }
  // The record stream arrives in the store's own framing: [u32 len][record].
  prepareAppend(streamBytes) {
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
    return { bytes: buf, records: added };
  }
  appendPrepared(prepared) {
    if (prepared.records.length === 0) return [];
    fs.appendFileSync(this.recordsPath, prepared.bytes);
    this.bytes += prepared.bytes.length;
    return prepared.records;
  }
  append(streamBytes) {
    const prepared = this.prepareAppend(streamBytes);
    return this.appendPrepared(prepared);
  }
  appendIndex(rows) {
    if (rows.length === 0) return;
    fs.appendFileSync(this.indexPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  }
}

async function summarizeOceanLines(file) {
  const hash = createHash("sha256");
  let pending = Buffer.alloc(0);
  let count = 0;
  let minLevel = Infinity;
  if (!fs.existsSync(file)) return { count, minLevel: null, digest: hash.digest("hex") };
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4096 })) {
    hash.update(chunk);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline < 0 ? chunk.length : newline;
      const piece = chunk.subarray(start, end);
      assert.ok(pending.length + piece.length <= 128, "ocean address line exceeds 128 bytes");
      if (newline < 0) {
        pending = pending.length ? Buffer.concat([pending, piece]) : Buffer.from(piece);
        break;
      }
      const line = pending.length ? Buffer.concat([pending, piece]).toString("utf8") : piece.toString("utf8");
      pending = Buffer.alloc(0);
      assert.match(line, /^\d+\/\d+\/\d+$/, "invalid ocean address line");
      count += 1;
      minLevel = Math.min(minLevel, Number(line.split("/", 1)[0]));
      start = newline + 1;
    }
  }
  assert.equal(pending.length, 0, "ocean address file ends without a newline");
  return { count, minLevel: Number.isFinite(minLevel) ? minLevel : null, digest: hash.digest("hex") };
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

  fs.mkdirSync(outDir, { recursive: true });
  const outStat = fs.lstatSync(outDir);
  assert.ok(outStat.isDirectory() && !outStat.isSymbolicLink(), "run output must be a real directory");
  const configuredFlowConfig = runConfig.flow_config ?? {};
  const sourceContract = sourcePolicyContract(runConfig);
  const publicationContract = publicationPolicyContract(runConfig);
  const sourceObservationLog = sourceContract
    ? path.resolve(outDir, sourceContract.policy.manifest.shard_log)
    : null;
  if (sourceObservationLog) {
    assert.ok(sourceObservationLog.startsWith(`${outDir}${path.sep}`),
      "source_policy.manifest.shard_log must stay inside the run output");
  }
  const store = new TileStore(outDir);
  // A region config is policy, not evidence.  In particular it must not claim
  // an observation date before a request has happened.  The terrain module
  // requires a retrieved_at lineage field, so the runner derives it from the
  // actual per-cell source observations; it is never supplied by checked
  // config or replaced with a build-start timestamp.
  if (sourceContract) {
    assert.equal(Object.hasOwn(configuredFlowConfig, "retrieved_at"), false,
      "a source_policy run must not prefill flow_config.retrieved_at; run.mjs records observations at request time");
    if (args.fetchRetries !== undefined) assert.equal(args.fetchRetries, sourceContract.policy.request.retries,
      "a source-policy run may not override its approved retry count");
    if (args.retryBaseMs !== undefined) assert.equal(args.retryBaseMs, sourceContract.policy.request.retry_base_ms,
      "a source-policy run may not override its approved retry base delay");
  }
  const sourceRunStartedAt = runConfig.source_run_started_at ?? new Date().toISOString();
  let activeRetrievedAt = null;
  const flowConfig = sourceContract
    ? { ...configuredFlowConfig, retrieved_at: sourceRunStartedAt }
    : configuredFlowConfig;
  const flowConfigForCurrentCell = () => sourceContract
    ? { ...flowConfig, retrieved_at: activeRetrievedAt ?? sourceRunStartedAt }
    : flowConfig;
  const configDigest = sha256(canonicalJson(runConfig));
  const globalConfigDigest = runConfig.global_config_digest ?? configDigest;
  if (sourceContract) assert.match(globalConfigDigest, /^[0-9a-f]{64}$/,
    "a source-policy shard requires an immutable global_config_digest");
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
    tileByteHistogram: new FixedHistogram(MAX_TERRAIN_RECORD_BYTES),
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
    // Ocean skips are appended to an on-disk JSONL stream as they are emitted.
    // A global cut can name millions of addresses; keeping them in this stats
    // object would turn a source run into an O(N) heap allocation.
    oceanSkippedLogged: 0,
    oceanSkippedMinLevel: Infinity,
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
    sourceObservationRequests: 0,
    cellDetailsWritten: 0,
    cellDetailSample: [],
    errors: [],
  };
  const cellDetailLog = path.join(outDir, "cells-detail.ndjson");
  if (!fs.existsSync(cellDetailLog)) fs.writeFileSync(cellDetailLog, "");
  function appendCellDetail(detail) {
    const line = JSON.stringify(detail);
    assert.ok(Buffer.byteLength(line) <= MAX_CELL_DETAIL_LINE_BYTES,
      `cell detail exceeds ${MAX_CELL_DETAIL_LINE_BYTES} byte bound`);
    fs.appendFileSync(cellDetailLog, `${line}\n`);
    stats.cellDetailsWritten += 1;
    if (stats.cellDetailSample.length < MAX_CELL_DETAIL_SAMPLE) stats.cellDetailSample.push(detail);
  }

  // ── the four host operations, and only those ─────────────────────────────
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);
  let lastCellRecords = Buffer.alloc(0);
  let cellStage = null;
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
  if (sourceContract) {
    assert.equal(cacheMaxBytes, sourceContract.cacheMaxBytes,
      "a source-policy run may not override its approved cache bound");
  }
  const granuleCache = new BoundedGranuleCache({
    dir: args.cacheDir ?? runConfig.cache_dir ?? path.join(outDir, "granules"),
    maxBytes: cacheMaxBytes,
  });
  const oceanSkipLog = path.join(outDir, "ocean-skipped.lines");
  const sourceEpoch = ensureSourceEpoch(granuleCache.dir, sourceContract);
  if (sourceObservationLog) {
    fs.mkdirSync(path.dirname(sourceObservationLog), { recursive: true });
  }
  const sourceRequestObserver = sourceContract
    ? new SourceRequestObserver({
        timeoutMs: sourceContract.policy.request.timeout_ms,
        maxOutstanding: sourceContract.policy.request.max_outstanding,
        allowUrl: (url) => sourcePolicyAllowsUrl(sourceContract, url),
      })
    : null;
  function recordSourceObservation(url, fetched, requestedAt, persisted = undefined) {
    if (!sourceObservationLog) return;
    const observation = persisted ?? observationForRequest({
      cacheDir: granuleCache.dir,
      url,
      fetched,
      networkObservation: sourceRequestObserver?.take(url),
    });
    // This is a request log, not a global map.  It deliberately retains cache
    // hits as requests while preserving the immutable response observation
    // which populated that cache generation.  global-build.mjs external-sorts
    // and deduplicates it after every shard has completed.
    // This line is staged with the cell and committed before its $IRM mark.
    // A resume can therefore never advance past a cell whose request evidence
    // was merely in the page cache at the time of a power loss.
    stats.sourceObservationRequests += 1;
    return sourceObservationLine(observation, { requestedAt, cacheHit: fetched.hit });
  }
  async function prefetch(urls) {
    if (sourceContract) {
      assert.ok(urls.length <= sourceContract.policy.request.max_outstanding,
        "cell planner exceeds the approved bounded source-request set");
    }
    return Promise.all(
      urls.map(async (url) => {
        const requestedAt = new Date().toISOString();
        let sourceObservation;
        try {
          const fetched = await granuleCache.fetch(url, {
            retries: args.fetchRetries ?? sourceContract?.policy.request.retries ?? runConfig.fetch_retries ?? 4,
            retryBaseMs: args.retryBaseMs ?? sourceContract?.policy.request.retry_base_ms ?? runConfig.retry_base_ms ?? 250,
            ...(sourceRequestObserver ? { fetchImpl: sourceRequestObserver.fetch.bind(sourceRequestObserver) } : {}),
            ...(sourceContract ? {
              maxResponseBytes: sourceContract.policy.request.max_response_bytes,
              requireStreamingBody: true,
              onBodyLimit: () => sourceRequestObserver?.abort(url),
              onDiscardResponse: () => sourceRequestObserver?.discard(url),
              beforeUse: ({ status, body }) => {
                sourceObservation = validateCachedSource({ cacheDir: granuleCache.dir, url, status, body });
              },
              beforePublish: ({ status, body }) => {
                // The request timer stays active through body consumption and
                // this receipt write. Only after the receipt is durable may
                // current.json publish the cache generation.
                const networkObservation = sourceRequestObserver?.peek(url);
                assert.ok(networkObservation, `source response lost its observation before publication: ${url}`);
                sourceObservation = observationForRequest({
                  cacheDir: granuleCache.dir,
                  url,
                  fetched: { status, body, hit: false },
                  networkObservation,
                });
                sourceRequestObserver?.take(url);
              },
            } : {}),
            onRetry: () => { stats.fetchRetries += 1; },
          });
          const line = recordSourceObservation(url, fetched, requestedAt, sourceObservation);
          if (!fetched.hit) {
            stats.fetches += 1;
            stats.fetchBytes += fetched.body.length;
            if (fetched.status === 404) stats.fetch404 += 1;
          }
          return { observation: sourceObservation, line };
        } finally {
          // fetchWithRetry can fail while reading a successful response body,
          // after the observer retained headers.  Do not let that failed
          // request consume one of the bounded observer slots forever.
          sourceRequestObserver?.discard(url);
        }
      }),
    );
  }

  pending.push({
    operation: "plugin.getConfig",
    matches: () => true,
    respond: () => encodeEnvelope(flowConfigForCurrentCell()),
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
      assert.ok(cellStage, "durable storage.write occurred outside a staged cell");
      assert.equal(schema, "IRM", "terrain runner stages only the durable $IRM resume mark");
      assert.equal(cellStage.markBytes, null, "cell wrote more than one durable $IRM mark");
      cellStage.markBytes = bytes;
      return encodeEnvelope({ ok: true, result: { ok: true, schema, bytes: bytes.length } });
    },
  });
  pending.push({
    operation: "http.request",
    matches: () => true,
    respond: (meta) => {
      const cached = granuleCache.read(meta.url);
      if (!cached) {
        // A cache miss means the URL the flow asked for is not the URL the
        // planner derived, which would mean the enumeration is not the pure
        // function of config-and-mark this runner rests on. Fail loudly.
        return encodeEnvelope({ ok: false, message: `not prefetched: ${meta.url}` });
      }
      const status = cached.status;
      const body = new Uint8Array(cached.body);
      return encodeEnvelope({ ok: true, status, result: { status, headers: {} } }, [body]);
    },
  });
  pending.push({
    operation: "storage.ingest_with_source",
    matches: () => true,
    respond: (meta, segments) => {
      // Kept verbatim so the WasmEdge cross-check compares the bytes the flow
      // ACTUALLY stored, not a re-encode of them.
      assert.ok(cellStage, "storage.ingest_with_source occurred outside a staged cell");
      assert.equal(cellStage.recordStream, null, "cell emitted more than one terrain record stream");
      lastCellRecords = Buffer.from(segments[0] ?? new Uint8Array(0));
      const prepared = store.prepareAppend(segments[0] ?? new Uint8Array(0));
      cellStage.recordStream = prepared.bytes;
      cellStage.records = prepared.records;
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
        result: { ok: true, schema: meta?.schema, batch_id: meta?.batch_id, inserted: prepared.records.length },
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

  async function planCell({ markBytes = undefined } = {}) {
    const harness = await createBrowserModuleHarness({
      wasmSource: fs.readFileSync(INGEST_WASM),
      manifest: INGEST_MANIFEST,
      surface: "direct",
      hostcallDispatch: (operation) => {
        if (operation === "plugin.getConfig") return flowConfigForCurrentCell();
        throw new Error(`unexpected hostcall operation: ${operation}`);
      },
    });
    try {
      const inputs = [alignedFrame("tick", { firedAt: new Date().toISOString() })];
      // The SAME durable mark the flow will read on its own pass — the $IRM
      // record out of the store, in the stream framing the query connector
      // delivers. Pass 1 and pass 2 must see one mark or the enumeration stops
      // being the pure function of config-and-mark this runner rests on.
      const mark = markBytes ?? store.readRecords("IRM", 32);
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
    cellStage = { recordStream: null, records: [], markBytes: null, oceanAddresses: [] };
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
            const address = `${tile.level}/${tile.x}/${tile.y}`;
            cellStage.oceanAddresses.push(address);
          }
        }
      }
      // The operator-readable JSON mark, which the flow still lands on egress.
      // It is NOT the durable one and it is not what advances the walk: the
      // durable mark is the $IRM record the flow wrote through storage.write,
      // and `marksWritten` below is the only evidence that happened.
      if (value.next_tile_index !== undefined) markJson = value;
    }
    return { stored, markJson, stage: cellStage };
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
        const cached = granuleCache.read(url);
        if (!cached) continue;
        const status = cached.status;
        const body = cached.body;
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

  // A journal can persist after the terminal $IRM append but before its
  // sidecar, so select its live cell from the PRE-attempt sidecar state rather
  // than the possibly already-advanced record stream. Its tile count is
  // current approved-run data; do not recover with a size recorded by the
  // journal itself. This makes the staged-byte ceiling both resumable and
  // resistant to forged oversized journal fields.
  const cellAttemptJournal = path.join(outDir, "cell-attempt.json");
  let hasCellAttempt = false;
  try { hasCellAttempt = Boolean(fs.lstatSync(cellAttemptJournal)); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const recoveryPlan = hasCellAttempt ? await planCell({ markBytes: readPriorResumeMark(outDir) }) : null;
  assert.ok(!hasCellAttempt || recoveryPlan,
    "interrupted cell attempt exists but the live planner is already drained");
  // Recovery derives every artifact location and its exact payload bound from
  // the current approved run, not from path strings or byte limits persisted
  // in the interrupted cell journal.
  recoverCellAttempt({
    outDir,
    markPath: path.join(outDir, "resume-mark.json"),
    artifactPaths: sourceObservationLog ? { "source-observations": sourceObservationLog } : undefined,
    ...(recoveryPlan ? {
      maxAppendBytes: cellAttemptAppendBound(recoveryPlan.job.cell_tiles),
      expectedCell: recoveryPlan.job.cell_index,
    } : {}),
  });
  store.bytes = fs.statSync(store.recordsPath).size;

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
  while (stats.cells < args.maxCells && backlog > 0) {
    const planned = await planCell();
    if (!planned) {
      backlog = 0;
      break;
    }
    try {
      const prefetched = await prefetch(planned.urls);
      const observations = prefetched.map(({ observation }) => observation);
      const sourceObservationBytes = Buffer.concat(
        prefetched.flatMap(({ line }) => Buffer.isBuffer(line) ? [line] : []),
      );
      if (sourceContract) {
        assert.equal(observations.length, planned.urls.length, "every planned source URL needs one immutable observation");
        activeRetrievedAt = observations.reduce((latest, observation) =>
          observation.observed_at > latest ? observation.observed_at : latest, "");
        assert.ok(activeRetrievedAt, "source-backed cell has no observed_at evidence for retrieved_at lineage");
      }
    const built = await buildCell();
    // THE DURABLE MARK IS THE TEST, not the egress frame. Without a mark IN THE
    // STORE the next tick re-plans the SAME cell forever, and that is exactly
    // the failure this runner used to hide by keeping its own resume-mark.json:
    // the flow wrote no mark at all, and nothing said so.
    if (!built.stage.markBytes) {
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
    const indexRows = built.stage.records.map(readDtt).filter(Boolean);
    const markFrame = Buffer.alloc(4 + built.stage.markBytes.length);
    markFrame.writeUInt32LE(built.stage.markBytes.length, 0);
    Buffer.from(built.stage.markBytes).copy(markFrame, 4);
    commitCellAttempt({
      outDir,
      cell: planned.job.cell_index,
      markJson: built.markJson,
      markPath: store.markPath,
      artifactPaths: sourceObservationLog ? { "source-observations": sourceObservationLog } : undefined,
      maxAppendBytes: cellAttemptAppendBound(planned.job.cell_tiles),
      faultPhase: args.faultCellPhase,
      operations: [
        ...(built.stage.recordStream?.length ? [{ name: "tiles", target: store.recordsPath, bytes: built.stage.recordStream }] : []),
        ...(indexRows.length ? [{
          name: "index", target: store.indexPath,
          bytes: Buffer.from(`${indexRows.map((row) => JSON.stringify(row)).join("\n")}\n`),
        }] : []),
        ...(built.stage.oceanAddresses.length ? [{
          name: "ocean", target: oceanSkipLog,
          bytes: Buffer.from(built.stage.oceanAddresses.map((address) => `${address}\n`).join("")),
        }] : []),
        ...(sourceObservationBytes.length ? [{ name: "source-observations", target: sourceObservationLog, bytes: sourceObservationBytes }] : []),
        { name: "mark", target: path.join(outDir, "irm.records"), bytes: markFrame },
      ],
    });
    // The journal commits byte streams, so update the local accounting only
    // after its terminal receipt exists. A crash before this point is recovered
    // from durable artifacts rather than invocation-local counters.
    store.bytes = fs.statSync(store.recordsPath).size;
    stats.marksWritten += 1;
    for (const dtt of indexRows) {
      stats.tiles += 1;
      stats.tileByteHistogram.add(dtt.payloadBytes);
      if (dtt.waterMaskKind === 3) stats.rasterMasks += 1;
      else stats.uniformMasks += 1;
    }
    for (const address of built.stage.oceanAddresses) {
      stats.oceanSkippedLogged += 1;
      stats.oceanSkippedMinLevel = Math.min(stats.oceanSkippedMinLevel, Number(address.split("/", 1)[0]));
    }
    backlog = planned.backlog;
    stats.cells += 1;
    appendCellDetail({
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
      await Promise.all(planned.urls.map((url) => granuleCache.release(url)));
    }
  }

  const elapsed = Date.now() - started;
  const summary = {
    generatedAt: new Date().toISOString(),
    outDir,
    configDigest,
    elapsedMs: elapsed,
    cells: stats.cells,
    // A bounded rehearsal can intentionally stop at --max-cells.  It is a
    // valid resume point, but never a completed shard: global-build.mjs only
    // accepts a report as terminal when this is true.
    drained: backlog <= 0,
    fetches: stats.fetches,
    fetch404: stats.fetch404,
    fetchRetries: stats.fetchRetries,
    sourceProvenance: sourceContract
      ? {
          sourcePolicyDigest: sourceContract.digest,
          datasetEpoch: sourceContract.datasetEpoch,
          globalConfigDigest,
          executionConfigDigest: configDigest,
          sourceRunStartedAt,
          sourceEpochReceipt: path.relative(outDir, sourceEpoch.file),
          observationLog: path.relative(outDir, sourceObservationLog),
          observationRequests: stats.sourceObservationRequests,
          manifestContract: sourceContract.policy.manifest,
        }
      : null,
    publicationPolicy: publicationContract
      ? {
          policy: publicationContract.policy,
          digest: publicationContract.digest,
          globalConfigDigest,
        }
      : null,
    granuleCache: {
      dir: granuleCache.dir,
      maxBytes: granuleCache.maxBytes,
      // Take the final accounting snapshot under the inter-process cache
      // lock: interrupted publications with no valid current generation are
      // reclaimed before reporting capacity, not silently omitted.
      usedBytes: await granuleCache.usageBytesLocked(),
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
    tileBytesP50: stats.tileByteHistogram.percentile(0.5),
    tileBytesP99: stats.tileByteHistogram.percentile(0.99),
    tileBytesMax: stats.tileByteHistogram.max,
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
    cellDetailLog: path.basename(cellDetailLog),
    cellDetailCount: stats.cellDetailsWritten,
    cellDetailSample: stats.cellDetailSample,
  };
  if (wasmedge) wasmedge.dispose();
  // The skipped-ocean addresses ride in their own file rather than in the run
  // report: there are hundreds to thousands of them on a real region (989 on
  // the regional proof), they are consumed by exactly one reader, and burying
  // a machine-read list inside an operator-read summary is how the count came
  // to be kept while the addresses were dropped.
  const oceanArtifact = await summarizeOceanLines(oceanSkipLog);
  const oceanSkipped = {
    generatedAt: summary.generatedAt,
    // The level at and below which "declared but not stored" means "the
    // encoder measured it all-ocean and skipped it". Below it no level is
    // authoritative and a synthesized tile must fail safe to LAND.
    // This is raw ASCII address-lines, not JSONL: each line is one canonical
    // `level/x/y` value so the global external sorter can consume it directly.
    format: "terrain-ocean-skips-lines-v1",
    addressesPath: path.basename(oceanSkipLog),
    minLevel: oceanArtifact.minLevel,
    count: oceanArtifact.count,
    digest: oceanArtifact.digest,
  };
  fs.writeFileSync(
    path.join(outDir, "ocean-skipped.json"),
    `${JSON.stringify(oceanSkipped, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(outDir, "run-report.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
