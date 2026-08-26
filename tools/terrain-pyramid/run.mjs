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
//   node tools/terrain-pyramid/run.mjs --config <run.json> [--out <dir>] [--max-cells N]
//   node tools/terrain-pyramid/run.mjs --config <run.json> --docker

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const RUNTIME_WASM = path.join(REPO, "flows", "terrain-ingest", "dist", "runtime.wasm");
const SDK_DIR = path.join(REPO, "flows", "terrain-ingest", "node_modules", "space-data-module-sdk");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── argv ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { maxCells: Infinity, docker: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--config") args.config = argv[++i];
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--max-cells") args.maxCells = Number(argv[++i]);
    else if (flag === "--docker") args.docker = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!args.config) throw new Error("--config <run.json> is required");
  return args;
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
  readMark() {
    if (!fs.existsSync(this.markPath)) return null;
    return JSON.parse(fs.readFileSync(this.markPath, "utf8"));
  }
  writeMark(mark) {
    fs.writeFileSync(this.markPath, `${JSON.stringify(mark)}\n`);
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
    // The SAME law binaries are built under: linux/amd64, in the container,
    // so the artifact and the run are reproducible off this laptop.
    const image = runConfig.docker_image ?? "node:22-bookworm";
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
    fetchBytes: 0,
    tiles: 0,
    oceanSkipped: 0,
    uniformMasks: 0,
    rasterMasks: 0,
    tileBytes: [],
    errors: [],
  };

  // ── the four host operations, and only those ─────────────────────────────
  const memoryRef = { memory: null };
  let response = new Uint8Array(0);
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
  const granuleDir = path.join(outDir, "granules");
  fs.mkdirSync(granuleDir, { recursive: true });
  const cachePath = (url) => path.join(granuleDir, `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.bin`);
  const statusPath = (url) => `${cachePath(url)}.status`;

  async function prefetch(urls) {
    await Promise.all(
      urls.map(async (url) => {
        if (fs.existsSync(statusPath(url))) return;
        const res = await fetch(url, { redirect: "follow" });
        const body = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
        fs.writeFileSync(cachePath(url), body);
        fs.writeFileSync(statusPath(url), String(res.status));
        stats.fetches += 1;
        stats.fetchBytes += body.length;
        if (res.status === 404) stats.fetch404 += 1;
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
    respond: () => {
      const mark = store.readMark();
      return encodeEnvelope({ ok: true }, mark ? [encoder.encode(JSON.stringify(mark))] : []);
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
      return encodeEnvelope({ ok: true, result: { ok: true, records: added.length } });
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
      const mark = store.readMark();
      if (mark) inputs.push(alignedFrame("mark", mark));
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
    let markAdvanced = false;
    for (const text of observed) {
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        continue;
      }
      if (value.tilesEmitted !== undefined) stored += value.tilesEmitted;
      if (value.next_tile_index !== undefined) {
        // The mark is written FROM THE VERIFIED STORE RESULT, by the flow, and
        // this host only persists what the flow decided.
        store.writeMark(value);
        markAdvanced = true;
      }
    }
    return { stored, markAdvanced };
  }

  const started = Date.now();
  let backlog = Infinity;
  const report = [];

  while (stats.cells < args.maxCells && backlog > 0) {
    const planned = await planCell();
    if (!planned) break;
    await prefetch(planned.urls);
    const built = await buildCell();
    if (!built.markAdvanced) {
      // Without a mark the next tick re-plans the SAME cell forever. Stopping
      // loudly beats spinning: a build that cannot record where it got to has
      // not built anything anyone can resume.
      stats.errors.push(
        `cell ${planned.job.cell_index} stored ${built.stored} tiles but the resume mark did not advance`,
      );
      break;
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
  }

  const elapsed = Date.now() - started;
  const sorted = [...stats.tileBytes].sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    outDir,
    elapsedMs: elapsed,
    cells: stats.cells,
    fetches: stats.fetches,
    fetch404: stats.fetch404,
    fetchMiB: +(stats.fetchBytes / 1048576).toFixed(2),
    tiles: stats.tiles,
    storeBytes: store.bytes,
    storeMiB: +(store.bytes / 1048576).toFixed(2),
    tileBytesP50: pct(0.5),
    tileBytesP99: pct(0.99),
    tileBytesMax: sorted.length ? sorted[sorted.length - 1] : 0,
    uniformMasks: stats.uniformMasks,
    rasterMasks: stats.rasterMasks,
    uniformMaskRatio: stats.tiles ? +(stats.uniformMasks / stats.tiles).toFixed(4) : 0,
    errors: stats.errors,
    cellsDetail: report,
  };
  fs.writeFileSync(path.join(outDir, "run-report.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
