// Native terrain reduction. The host handles bounded records, addresses and
// receipts only. Heights, triangles, masks and error bounds belong to the
// terrain-source reduce_parent method.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson, createSortedJsonRunWriter, mergeSortedJsonRuns, sha256 } from "./build-support.mjs";
import { iterateStreamFd, MAX_TERRAIN_RECORD_BYTES, readDtt, readDttProvenance, splitStream } from "./dtt-reader.mjs";

export const REDUCER_PROCESSOR = "com.digitalarsenal.data-source.terrain-source/reduce_parent@0.1.1";
export const DTT_STREAM_TYPE = Object.freeze({ schemaName: "DTT.fbs", fileIdentifier: "$DTT", rootTypeName: "DTT", wireFormat: "flatbuffer" });
const MAX_LEVEL = 8;
const MAX_STORE_BYTES = 12 * 1024 ** 3;
const MAX_METADATA_BYTES = 4 * 1024 ** 2;
const addressKey = (z, x, y) => `${String(z).padStart(2, "0")}/${String(y).padStart(10, "0")}/${String(x).padStart(10, "0")}`;
const recordDigest = (record) => `1220${sha256(record)}`;
function levelNumber(level) { assert.ok(Number.isSafeInteger(level) && level >= 0 && level <= MAX_LEVEL, "level must be an integer in [0, 8]"); }
function address(dtt) {
  levelNumber(dtt.level);
  assert.ok(Number.isSafeInteger(dtt.x) && dtt.x >= 0 && dtt.x < 2 ** (dtt.level + 1), "invalid geographic tile x");
  assert.ok(Number.isSafeInteger(dtt.y) && dtt.y >= 0 && dtt.y < 2 ** dtt.level, "invalid geographic tile y");
  return addressKey(dtt.level, dtt.x, dtt.y);
}
function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has unexpected fields`);
}

/** Read native-derived lineage, never infer it from a prose accuracy claim. */
export function reductionLineage(record, dtt = readDtt(record)) {
  const provenance = readDttProvenance(record).raw;
  const processor = provenance.PROCESSOR;
  const query = provenance.SOURCE_QUERY;
  let parsed;
  if (typeof query === "string" && query.startsWith("{")) {
    try { parsed = JSON.parse(query); } catch { /* Other source queries are opaque. */ }
  }
  if (processor !== REDUCER_PROCESSOR && parsed?.method !== "reduce_parent") return null;
  assert.equal(processor, REDUCER_PROCESSOR, "derived tile lacks the native reducer processor");
  exactKeys(parsed, ["method", "version", "children", "heightBound", "waterReduction", "meshDifferenceBoundM", "inheritedAccuracyComplete"], "native reduction lineage");
  assert.equal(parsed.method, "reduce_parent");
  assert.equal(parsed.version, 1);
  assert.equal(parsed.heightBound, "child-cell-parent-cell-envelope-v1");
  assert.equal(parsed.waterReduction, "coverage-2x2-round-half-up-v1");
  assert.ok(Number.isFinite(parsed.meshDifferenceBoundM) && parsed.meshDifferenceBoundM >= 0, "invalid derived mesh difference bound");
  assert.equal(typeof parsed.inheritedAccuracyComplete, "boolean");
  assert.ok(Array.isArray(parsed.children) && parsed.children.length === 4, "derived tile requires exactly four child digests");
  parsed.children.forEach((child, quadrant) => {
    exactKeys(child, ["level", "x", "y", "digest"], "native child lineage");
    assert.equal(child.level, dtt.level + 1, "lineage child level differs");
    assert.equal(child.x, 2 * dtt.x + quadrant % 2, "lineage child x/order differs");
    assert.equal(child.y, 2 * dtt.y + Math.floor(quadrant / 2), "lineage child y/order differs");
    assert.match(child.digest, /^1220[0-9a-f]{64}$/, "invalid child record digest");
  });
  assert.equal(dtt.accuracyConfidence, parsed.inheritedAccuracyComplete ? 1 : 0, "derived confidence disagrees with inherited accuracy availability");
  if (parsed.inheritedAccuracyComplete) assert.ok(dtt.verticalAccuracyM >= parsed.meshDifferenceBoundM, "derived bound omits its mesh difference");
  return parsed;
}

/** Counts prove coverage only after address uniqueness and scheme bounds. */
export function assertGlobalCoverage(counts, baseLevel, minimumLevel = 0) {
  levelNumber(baseLevel); levelNumber(minimumLevel);
  assert.ok(minimumLevel <= baseLevel);
  for (let z = minimumLevel; z <= baseLevel; z += 1) {
    assert.equal(counts[z] ?? 0, 2 * 4 ** z, `global coverage is incomplete at z${z}`);
  }
}

function snapshot(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String); }
function unchanged(file, fd, before) {
  assert.deepEqual(snapshot(fs.fstatSync(fd, { bigint: true })), before, `${file} changed while coarsening`);
  const current = fs.lstatSync(file, { bigint: true });
  assert.ok(current.isFile(), `${file} is no longer a regular file`);
  assert.deepEqual(snapshot(current), before, `${file} pathname changed while coarsening`);
}
function openInput(file, maxBytes) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    assert.ok(stat.isFile() && stat.size <= BigInt(maxBytes), `${file} is not a bounded regular file`);
    const before = snapshot(stat);
    unchanged(file, fd, before);
    return { fd, before, bytes: Number(stat.size) };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    assert.ok(count > 0, "output write made no progress");
    offset += count;
  }
}
function frame(record) {
  assert.ok(record.length > 0 && record.length <= MAX_TERRAIN_RECORD_BYTES, "native record exceeds the bounded DTT size");
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(record.length);
  return Buffer.concat([prefix, record]);
}
function syncDirectory(dir) { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function writeJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try { writeAll(fd, Buffer.from(`${JSON.stringify(value, null, 2)}\n`)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.linkSync(temp, file); } finally { fs.unlinkSync(temp); }
  syncDirectory(path.dirname(file));
}
function smallJson(file) {
  const input = openInput(file, MAX_METADATA_BYTES);
  try {
    const bytes = fs.readFileSync(input.fd);
    unchanged(file, input.fd, input.before);
    return { value: JSON.parse(bytes), sha256: sha256(bytes), bytes, file, before: input.before };
  } finally { fs.closeSync(input.fd); }
}
function unchangedMetadata(input) {
  const stat = fs.lstatSync(input.file, { bigint: true });
  assert.ok(stat.isFile(), "source metadata is no longer a regular file");
  assert.deepEqual(snapshot(stat), input.before, "source metadata changed during coarsening");
}
function copyStableFile(source, destination, maxBytes, expectedDigest = null) {
  const input = openInput(source, maxBytes);
  let fd;
  try {
    fd = fs.openSync(destination, "wx", 0o600);
    const hash = createHash("sha256"); const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < input.bytes) {
      const count = fs.readSync(input.fd, buffer, 0, Math.min(buffer.length, input.bytes - position), position);
      assert.ok(count > 0, "source metadata ended while copying");
      const chunk = buffer.subarray(0, count); writeAll(fd, chunk); hash.update(chunk); position += count;
    }
    unchanged(source, input.fd, input.before);
    const digest = hash.digest("hex");
    if (expectedDigest) assert.equal(digest, expectedDigest, "source metadata digest differs from its terminal receipt");
    fs.fsyncSync(fd);
    return { path: path.basename(destination), bytes: input.bytes, sha256: digest };
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); } finally { fs.closeSync(input.fd); }
  }
}
function factWriter(dir) {
  return createSortedJsonRunWriter(dir, { maxRows: 512, maxRowBytes: 2048, maxBufferedBytes: 1024 * 1024, maxRuns: 2048, returnManifest: true });
}

/**
 * Create a new output directory; never modify the leaf store or resume a
 * partial output as completed. A failure leaves diagnostic work with no final
 * coarsen receipt. Native output is checked before committing each quartet.
 * `reduce` is the existing SDK invocation boundary, injectable for I/O tests.
 */
export async function coarsen({ inputFile, outDir, baseLevel = 8, minimumLevel = 0, global = true, maxOutputBytes, reduce, runtime = null, finalize = null }) {
  levelNumber(baseLevel); levelNumber(minimumLevel);
  assert.ok(baseLevel > minimumLevel, "coarsening needs at least one parent level");
  assert.ok(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= MAX_STORE_BYTES, "maxOutputBytes must be a positive byte budget no larger than 12 GiB");
  assert.equal(typeof reduce, "function", "native reduce_parent invoker is required");
  inputFile = path.resolve(inputFile); outDir = path.resolve(outDir);
  assert.ok(outDir !== path.dirname(inputFile), "coarsening must use a new output directory");
  const input = openInput(inputFile, maxOutputBytes);
  let outputFd;
  let created = false;
  try {
    fs.mkdirSync(outDir); created = true; // Exclusive: do not adopt existing work.
    const outputIdentity = fs.lstatSync(outDir, { bigint: true });
    const assertOutputIdentity = () => {
      const current = fs.lstatSync(outDir, { bigint: true });
      assert.ok(current.isDirectory() && current.dev === outputIdentity.dev && current.ino === outputIdentity.ino,
        "owned coarsening output directory was replaced");
    };
    const work = path.join(outDir, `.coarsen-${randomUUID()}`);
    fs.mkdirSync(work);
    const staged = path.join(work, "tiles.dttstream");
    outputFd = fs.openSync(staged, "wx+", 0o600);
    const outputHash = createHash("sha256");
    const inputHash = createHash("sha256");
    const counts = {};
    let outputBytes = 0;
    let leaves = 0;
    let parents = 0;
    let writer = factWriter(path.join(work, `facts-${baseLevel}`));
    const append = (record, dtt, targetWriter) => {
      const framed = frame(record);
      assert.ok(outputBytes + framed.length <= maxOutputBytes, "coarsened store exceeds its approved output byte budget");
      const offset = outputBytes + 4;
      writeAll(outputFd, framed); outputHash.update(framed); outputBytes += framed.length;
      counts[dtt.level] = (counts[dtt.level] ?? 0) + 1;
      if (targetWriter) targetWriter.push({
        key: `${addressKey(dtt.level - 1, Math.floor(dtt.x / 2), Math.floor(dtt.y / 2))}|${dtt.y % 2 * 2 + dtt.x % 2}`,
        level: dtt.level, x: dtt.x, y: dtt.y, offset, bytes: record.length, digest: recordDigest(record),
      });
    };
    for await (const record of iterateStreamFd(input.fd, { onChunk: (chunk) => inputHash.update(chunk) })) {
      const dtt = readDtt(record); address(dtt);
      assert.equal(dtt.level, baseLevel, "input must contain only the requested leaf level");
      assert.equal(reductionLineage(record, dtt), null, "leaf input unexpectedly contains a derived record");
      append(record, dtt, writer); leaves += 1;
    }
    unchanged(inputFile, input.fd, input.before);
    assert.ok(leaves > 0, "leaf stream is empty");
    const inputDigest = inputHash.digest("hex");
    assert.equal(outputHash.copy().digest("hex"), inputDigest, "leaf stream must use canonical size-prefix framing without padding");
    if (global) assertGlobalCoverage(counts, baseLevel, baseLevel);
    for (let z = baseLevel; z > minimumLevel; z -= 1) {
      const runs = writer.finish();
      const next = z - 1 > minimumLevel ? factWriter(path.join(work, `facts-${z - 1}`)) : null;
      let group = [];
      let groupKey;
      const flush = async () => {
        if (!group.length) return;
        assert.equal(group.length, 4, `incomplete native child quartet ${groupKey}`);
        const children = group.map((fact, quadrant) => {
          assert.equal(fact.y % 2 * 2 + fact.x % 2, quadrant, `duplicate or missing child ${groupKey}`);
          const bytes = Buffer.alloc(fact.bytes);
          let read = 0;
          while (read < bytes.length) {
            const n = fs.readSync(outputFd, bytes, read, bytes.length - read, fact.offset + read);
            assert.ok(n > 0, "staged child record ended early"); read += n;
          }
          assert.equal(recordDigest(bytes), fact.digest, "staged child record changed");
          return bytes;
        });
        const result = await reduce(Buffer.concat(children.map(frame)));
        assertOutputIdentity();
        assert.ok(result instanceof Uint8Array && result.byteLength <= MAX_TERRAIN_RECORD_BYTES + 4, "native reducer returned an invalid/big frame");
        const records = [...splitStream(result)];
        assert.equal(records.length, 1, "native reducer must return exactly one parent");
        assert.equal(result.byteLength, records[0].length + 4, "native reducer returned padding/trailing frames");
        const parent = readDtt(records[0]); address(parent);
        assert.equal(address(parent), groupKey, "native reducer returned the wrong parent address");
        const lineage = reductionLineage(records[0], parent);
        assert.ok(lineage, "native parent has no derived lineage");
        assert.deepEqual(lineage.children.map((child) => child.digest), group.map((child) => child.digest), "native parent lineage does not bind its exact children");
        append(records[0], parent, next); parents += 1; group = [];
      };
      await mergeSortedJsonRuns(runs, {
        scratchDir: path.join(work, `merge-${z}`), maxOpenRuns: 16, maxRowBytes: 2048, dedupe: false,
        onRow: async (fact) => {
          const parentKey = fact.key.slice(0, -2);
          if (groupKey !== parentKey) { await flush(); groupKey = parentKey; }
          assert.ok(group.length < 4, `duplicate child in ${parentKey}`);
          group.push(fact);
        },
      });
      await flush();
      writer = next;
      if (global) assertGlobalCoverage(counts, z - 1, z - 1);
    }
    unchanged(inputFile, input.fd, input.before);
    assertOutputIdentity();
    fs.fsyncSync(outputFd); fs.closeSync(outputFd); outputFd = undefined;
    const report = {
      format: "terrain-native-coarsening-v1", completed: true, processor: REDUCER_PROCESSOR,
      baseLevel, minimumLevel, global, counts, leaves, parents,
      input: { bytes: input.bytes, sha256: inputDigest, records: leaves },
      output: { path: "tiles.dttstream", bytes: outputBytes, sha256: outputHash.digest("hex"), records: leaves + parents },
      maxOutputBytes, runtime,
      accuracy: "Leaf source-post measurements remain intact; parents state native conservative mesh bounds and whether inherited source accuracy exists.",
    };
    fs.renameSync(staged, path.join(outDir, "tiles.dttstream")); syncDirectory(outDir);
    if (finalize) await finalize(report);
    unchanged(inputFile, input.fd, input.before);
    assertOutputIdentity();
    writeJson(path.join(outDir, "coarsen-report.json"), report);
    fs.rmSync(work, { recursive: true });
    return report;
  } catch (error) {
    if (created) error.message += ` (incomplete output retained at ${outDir}; no successful coarsen receipt)`;
    throw error;
  } finally {
    if (outputFd !== undefined) fs.closeSync(outputFd);
    fs.closeSync(input.fd);
  }
}

async function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    assert.ok(["--input", "--out"].includes(argv[i]), `unknown argument ${argv[i]}`);
    assert.ok(argv[i + 1] && !argv[i + 1].startsWith("--"), `${argv[i]} needs a value`);
    const key = argv[i].slice(2); assert.ok(args[key] === undefined, `duplicate --${key}`); args[key] = argv[++i];
  }
  assert.ok(args.input && args.out, "usage: coarsen.mjs --input <completed-global-z8-dir> --out <new-dir>");
  const inputDir = path.resolve(args.input);
  const sourceState = smallJson(path.join(inputDir, "global-build-state.json"));
  const config = smallJson(path.join(inputDir, "approved-run-config.json"));
  const verification = smallJson(path.join(inputDir, "verify-report.json"));
  const state = sourceState.value;
  assert.equal(state.completed, true, "leaf global build is incomplete");
  assert.equal(state.merged?.completion, "complete", "leaf merge is incomplete");
  assert.equal(state.merged.coarsening, undefined, "input must be the original leaf output");
  assert.equal(verification.value.validated, true, "leaf output has no successful verification receipt");
  assert.equal(verification.value.coarseCoverage?.phase, "leaves");
  assert.equal(verification.value.coarseCoverage?.complete, false);
  assert.equal(verification.value.publicationInputs?.globalState?.sha256, sourceState.sha256);
  assert.equal(verification.value.publicationInputs?.approvedConfig?.sha256, config.sha256);
  assert.equal(state.configDigest, sha256(canonicalJson(config.value)), "leaf approved config digest differs");
  assert.equal(config.value.flow_config?.skipOceanTiles, false, "leaf planner must retain observed ocean records");
  assert.equal(config.value.flow_config?.min_level, 8); assert.equal(config.value.flow_config?.max_level, 8);
  assert.equal(config.value.coarsening?.method, "reduce_parent", "approved config lacks native coarsening target");
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const moduleDir = path.join(repository, "data-source/terrain-source");
  const wasm = openInput(path.join(moduleDir, "dist/isomorphic/module.wasm"), 128 * 1024 ** 2);
  let harness;
  try {
    const bytes = fs.readFileSync(wasm.fd);
    const manifest = smallJson(path.join(moduleDir, "plugin-manifest.json"));
    const { createBrowserModuleHarness } = await import(pathToFileURL(path.join(moduleDir, "node_modules/space-data-module-sdk/src/testing/index.js")));
    harness = await createBrowserModuleHarness({ wasmSource: bytes, manifest: manifest.value, surface: "direct" });
    const report = await coarsen({
      inputFile: path.join(inputDir, "tiles.dttstream"), outDir: args.out,
      maxOutputBytes: config.value.publication_policy?.max_verified_store_bytes,
      runtime: { wasmSha256: sha256(bytes), manifestSha256: manifest.sha256 },
      reduce: async (children) => {
        const result = await harness.invoke({ methodId: "reduce_parent", inputs: [{ portId: "children", typeRef: DTT_STREAM_TYPE, payload: children }] });
        assert.equal(result.statusCode, 0, `native reduce_parent refused: ${result.errorCode}: ${result.errorMessage}`);
        assert.equal(result.outputs?.length, 1, "native reducer returned unexpected output ports");
        assert.equal(result.outputs[0].portId, "records");
        return result.outputs[0].payload;
      },
      finalize: async (result) => {
        assert.equal(result.leaves, state.merged.records, "leaf state count differs from actual input");
        assert.equal(result.input.sha256, verification.value.publicationInputs.tiles.sha256, "leaf store differs from its verification receipt");
        assert.equal(result.input.bytes, verification.value.publicationInputs.tiles.bytes);
        unchanged(path.join(moduleDir, "dist/isomorphic/module.wasm"), wasm.fd, wasm.before);
        for (const item of [sourceState, config, verification, manifest]) unchangedMetadata(item);
        for (const [name, source] of [["source-global-build-state.json", sourceState], ["approved-run-config.json", config], ["source-verify-report.json", verification]]) {
          const fd = fs.openSync(path.join(args.out, name), "wx");
          try { writeAll(fd, source.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        }
        result.sourceStateSha256 = sourceState.sha256;
        result.configSha256 = config.sha256;
        result.sourceVerificationSha256 = verification.sha256;
        result.sourceArtifacts = [];
        if (state.merged.sourceManifest) {
          assert.equal(state.merged.sourceManifest.path, "source-manifest.ndjson");
          result.sourceArtifacts.push(copyStableFile(path.join(inputDir, "source-manifest.ndjson"), path.join(args.out, "source-manifest.ndjson"), 256 * 1024 ** 2, state.merged.sourceManifest.digest));
        }
        if (state.merged.sourceEpochReceipt) {
          assert.equal(path.basename(state.merged.sourceEpochReceipt), "source-epoch.json");
          result.sourceArtifacts.push(copyStableFile(path.resolve(inputDir, state.merged.sourceEpochReceipt), path.join(args.out, "source-epoch.json"), MAX_METADATA_BYTES));
        }
        if (fs.existsSync(path.join(inputDir, "run-report.json"))) {
          result.sourceArtifacts.push(copyStableFile(path.join(inputDir, "run-report.json"), path.join(args.out, "run-report.json"), MAX_METADATA_BYTES));
        }
        // Preserve the original completed leaf receipt verbatim. This new
        // merged receipt describes the newly produced record store only.
        const nextState = structuredClone(state);
        nextState.merged = { ...state.merged, ...result.output, digest: result.output.sha256, coarsening: "coarsen-report.json" };
        delete nextState.merged.recordSetDigest; // The original sorted-leaf digest remains in source-global-build-state.json.
        nextState.merged.oceanSkips = { count: 0, duplicates: 0, digest: sha256(""), path: "ocean-skipped.lines" };
        if (state.merged.sourceEpochReceipt) nextState.merged.sourceEpochReceipt = "source-epoch.json";
        writeJson(path.join(args.out, "global-build-state.json"), nextState);
        writeJson(path.join(args.out, "global-merge-report.json"), nextState.merged);
        fs.writeFileSync(path.join(args.out, "ocean-skipped.lines"), "", { flag: "wx" });
        writeJson(path.join(args.out, "ocean-skipped.json"), { format: "terrain-ocean-skips-lines-v1", addressesPath: "ocean-skipped.lines", count: 0, digest: sha256("") });
      },
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally { harness?.destroy(); fs.closeSync(wasm.fd); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
