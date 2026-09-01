// Shared bounded-build primitives for the off-fleet terrain pyramid lane.
//
// These deliberately know nothing about the terrain encoder.  Keeping retry,
// cache accounting and shard state here makes them testable without cutting a
// tile or contacting Copernicus, and keeps the runner's host boundary small.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const GLOBAL_STATE_VERSION = 1;
// The coordinator keeps one state/config entry per shard. This is a reviewed
// control-plane ceiling, not a throughput hint: it bounds state, pending-work,
// shard-config, and source/merge path collections before any allocation.
export const MAX_GLOBAL_SHARDS = 256;
export const MAX_GLOBAL_REGIONS = 256;

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// The stream order is an execution detail of independent workers.  Parity is
// the complete address-to-record-byte mapping, sorted before it is hashed.
export function recordSetDigest(entries) {
  return sha256([...entries].sort(([a], [b]) => a.localeCompare(b)).map(([key, digest]) => `${key}:${digest}`).join("\n"));
}

export function urlCacheKey(url) {
  return sha256(url).slice(0, 32);
}

// Read-only consumers (the accuracy lane) must use the same immutable
// generation selected by the bounded cache, rather than the pre-generation
// `<key>.bin` layout used by old regional runs.  This deliberately does not
// update LRU state or acquire a lease: a completed build owns the cache during
// its post-build verification and generation files are immutable.
export function readGenerationCacheEntry(cacheDir, url) {
  const key = urlCacheKey(url);
  const dir = path.join(cacheDir, "entries", key);
  let pointer;
  try { pointer = JSON.parse(fs.readFileSync(path.join(dir, "current.json"), "utf8")); } catch { return null; }
  if (!pointer?.generation || typeof pointer.generation !== "string") return null;
  const base = path.join(dir, pointer.generation);
  try {
    const status = Number(fs.readFileSync(`${base}.status`, "utf8").trim());
    if (!Number.isInteger(status)) return null;
    return { status, body: fs.readFileSync(`${base}.bin`) };
  } catch {
    return null;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Bounded external-sort primitive for global verifier facts.  The ordering is
// deliberately UTF-16 code-unit order, rather than locale order: a verifier
// report must not change when the host's locale changes.
export function compareCodeUnits(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareJsonFactKeys(left, right) {
  return compareCodeUnits(left.key, right.key);
}

function serializedFact(row, maxRowBytes) {
  const line = JSON.stringify(row);
  assert.equal(typeof line, "string", "fact row must serialize to JSON");
  assert.ok(Buffer.byteLength(line) <= maxRowBytes, `fact row exceeds ${maxRowBytes} bytes`);
  return line;
}

function writeLines(file, rows) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = fs.openSync(temporary, "wx");
    for (const row of rows) fs.writeSync(handle, `${row.line}\n`);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(temporary, file);
  } catch (error) {
    if (handle !== undefined && handle !== null) fs.closeSync(handle);
    try { fs.unlinkSync(temporary); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
    throw error;
  }
}

/**
 * Open an attempt-scoped external-sort writer.  It retains at most `maxRows`
 * serialized rows, deletes abandoned runs from an earlier attempt, and writes
 * each completed run without building a whole-run string.
 */
export function createSortedJsonRunWriter(dir, {
  maxRows = 4096,
  maxRowBytes = 64 * 1024,
  maxBufferedBytes = 8 * 1024 * 1024,
  compare = compareJsonFactKeys,
  reset = true,
  maxRuns = Number.MAX_SAFE_INTEGER,
  // Global callers must not retain one pathname per flushed run.  A manifest
  // is itself a bounded line stream, so the merge can batch it on disk.
  returnManifest = false,
} = {}) {
  assert.ok(Number.isSafeInteger(maxRows) && maxRows > 0, "maxRows must be positive");
  assert.ok(Number.isSafeInteger(maxRowBytes) && maxRowBytes > 0, "maxRowBytes must be positive");
  assert.ok(Number.isSafeInteger(maxBufferedBytes) && maxBufferedBytes >= maxRowBytes,
    "maxBufferedBytes must be at least maxRowBytes");
  assert.ok(Number.isSafeInteger(maxRuns) && maxRuns > 0, "maxRuns must be a positive safe integer");
  assert.equal(typeof compare, "function", "compare must be a function");
  // A fact-run directory is attempt-scoped.  Remove stale runs before writing
  // so a shorter retry cannot accidentally merge prior-attempt facts.
  if (reset) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  } else {
    assert.ok(fs.lstatSync(dir).isDirectory(), "owned fact-run directory is not a directory");
    assert.equal(fs.readdirSync(dir).length, 0, "owned fact-run directory is not empty");
  }
  const runs = [];
  const manifestPath = path.join(dir, "runs.manifest.ndjson");
  const manifestHandle = returnManifest ? fs.openSync(manifestPath, "wx") : null;
  let runCount = 0;
  let rows = [];
  let bufferedBytes = 0;
  let finished = false;
  const flush = () => {
    if (!rows.length) return;
    assert.ok(runCount < maxRuns, "fact spool exceeded its admitted external-sort run count");
    rows.sort((a, b) => compare(a.row, b.row));
    const file = path.join(dir, `run-${String(runCount).padStart(returnManifest ? 12 : 6, "0")}.ndjson`);
    writeLines(file, rows);
    if (returnManifest) fs.writeSync(manifestHandle, `${JSON.stringify(file)}\n`);
    else runs.push(file);
    runCount += 1;
    rows = [];
    bufferedBytes = 0;
  };
  return {
    push(row) {
      assert.ok(!finished, "cannot write a finished fact spool");
      // Validate the actual serialized bytes before retaining the row.  This
      // keeps adversarial JSON from bypassing the per-run memory bound.
      const line = serializedFact(row, maxRowBytes);
      if (rows.length && (rows.length >= maxRows || bufferedBytes + Buffer.byteLength(line) + 1 > maxBufferedBytes)) flush();
      rows.push({ row, line });
      bufferedBytes += Buffer.byteLength(line) + 1;
      if (rows.length >= maxRows || bufferedBytes >= maxBufferedBytes) flush();
    },
    finish() {
      assert.ok(!finished, "fact spool was already finished");
      flush();
      finished = true;
      if (!returnManifest) return runs;
      fs.fsyncSync(manifestHandle);
      fs.closeSync(manifestHandle);
      return {
        format: "terrain-json-run-manifest-v1",
        path: manifestPath,
        runCount,
      };
    },
  };
}

// Convenience form for small callers.  The streaming writer above is the
// form global consumers use; this never needs an input array.
export function writeSortedJsonRuns(dir, facts, options = {}) {
  const writer = createSortedJsonRunWriter(dir, options);
  for (const fact of facts) writer.push(fact);
  return writer.finish();
}

/**
 * Yield strings from one named array in a legacy JSON object without reading
 * the object into memory.  The terrain writer currently emits
 * `{ ..., "addresses": ["z/x/y", ...] }`; accepting that form here keeps old
 * cuts verifiable while bounding both the file and any individual string.
 */
export async function* iterateJsonStringArrayProperty(file, property, {
  maxFileBytes = 512 * 1024 * 1024,
  maxStringBytes = 256,
} = {}) {
  assert.equal(typeof property, "string", "JSON array property must be a string");
  assert.ok(Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0, "maxFileBytes must be positive");
  assert.ok(Number.isSafeInteger(maxStringBytes) && maxStringBytes > 0, "maxStringBytes must be positive");
  const stream = fs.createReadStream(file, { highWaterMark: 64 * 1024 });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let phase = "seek-key";
  let objectStarted = false;
  let inString = false;
  let escaped = false;
  let raw = "";
  let found = false;
  let currentKey = null;
  const whitespace = (char) => char === " " || char === "\t" || char === "\r" || char === "\n";
  const beginString = () => {
    inString = true;
    escaped = false;
    raw = "";
  };
  const finishString = () => {
    let value;
    try { value = JSON.parse(`"${raw}"`); } catch (error) {
      throw new Error(`invalid JSON string in ${file}: ${error.message}`);
    }
    inString = false;
    raw = "";
    return value;
  };
  const consume = async function* (text) {
    for (const char of text) {
      if (inString) {
        if (escaped) {
          raw += char;
          escaped = false;
        } else if (char === "\\") {
          raw += char;
          escaped = true;
        } else if (char === '"') {
          const value = finishString();
          if (phase === "seek-key") {
            currentKey = value;
            phase = "expect-colon";
          } else if (phase === "prefix-string") {
            phase = "after-prefix-value";
          } else if (phase === "array-value") {
            phase = "after-value";
            yield value;
          } else {
            throw new Error(`unexpected JSON string in ${file} while reading ${property}`);
          }
        } else {
          raw += char;
        }
        assert.ok(Buffer.byteLength(raw) <= maxStringBytes, `JSON string exceeds ${maxStringBytes} bytes in ${file}`);
        continue;
      }
      if (whitespace(char)) continue;
      if (phase === "complete") throw new Error(`trailing data after JSON object in ${file}`);
      if (phase === "seek-key") {
        if (!objectStarted) {
          assert.equal(char, "{", `legacy JSON must begin with an object in ${file}`);
          objectStarted = true;
          continue;
        }
        assert.equal(char, '"', `expected JSON object key in ${file}`);
        beginString();
        continue;
      }
      if (phase === "expect-colon") {
        assert.equal(char, ":", `expected ':' after object key in ${file}`);
        phase = currentKey === property ? "expect-array" : "prefix-value";
        continue;
      }
      if (phase === "expect-array") {
        assert.equal(char, "[", `expected array for ${property} in ${file}`);
        phase = "array-value-or-end";
        found = true;
        continue;
      }
      // Old run reports contain only scalar metadata before `addresses`
      // (generatedAt/minLevel/count).  Validate those scalars rather than
      // silently skipping arbitrary malformed JSON; `addresses` itself must
      // remain final so the streamed array can be consumed without retention.
      if (phase === "prefix-value") {
        if (char === '"') {
          phase = "prefix-string";
          beginString();
          continue;
        }
        assert.ok(/[-0-9tfn]/.test(char), `expected scalar JSON metadata before ${property} in ${file}`);
        raw = char;
        phase = "prefix-scalar";
        continue;
      }
      if (phase === "prefix-scalar") {
        if (char === "," || char === "}") {
          try { JSON.parse(raw); } catch (error) { throw new Error(`invalid JSON metadata in ${file}: ${error.message}`); }
          phase = char === "," ? "seek-key" : "complete";
          continue;
        }
        raw += char;
        assert.ok(Buffer.byteLength(raw) <= maxStringBytes, `JSON metadata exceeds ${maxStringBytes} bytes in ${file}`);
        continue;
      }
      if (phase === "after-prefix-value") {
        assert.ok(char === "," || char === "}", `expected ',' or '}' after JSON metadata in ${file}`);
        phase = char === "," ? "seek-key" : "complete";
        continue;
      }
      if (phase === "array-value-or-end") {
        if (char === "]") {
          phase = "expect-object-end";
          continue;
        }
        assert.equal(char, '"', `expected string array value for ${property} in ${file}`);
        phase = "array-value";
        beginString();
        continue;
      }
      if (phase === "after-value") {
        if (char === ",") {
          phase = "array-value-or-end";
          continue;
        }
        assert.equal(char, "]", `expected ',' or ']' in ${property} array in ${file}`);
        phase = "expect-object-end";
        continue;
      }
      if (phase === "expect-object-end") {
        assert.equal(char, "}", `legacy addresses must be the final JSON property in ${file}`);
        phase = "complete";
      }
    }
  };
  try {
    for await (const chunk of stream) {
      totalBytes += chunk.length;
      assert.ok(totalBytes <= maxFileBytes, `JSON file exceeds ${maxFileBytes} bytes: ${file}`);
      yield* consume(decoder.decode(chunk, { stream: true }));
    }
    yield* consume(decoder.decode());
    assert.ok(found && phase === "complete", `JSON property ${property} is missing or incomplete in ${file}`);
  } finally {
    stream.destroy();
  }
}

// A line cursor intentionally never calls readFile()/split().  Its carry is
// capped before a long, newline-free input can become an unbounded allocation.
export async function* iterateBoundedLines(file, { maxRowBytes = 64 * 1024 } = {}) {
  assert.ok(Number.isSafeInteger(maxRowBytes) && maxRowBytes > 0, "maxRowBytes must be positive");
  const highWaterMark = Math.max(1, Math.min(64 * 1024, maxRowBytes + 1));
  const stream = fs.createReadStream(file, { highWaterMark });
  let carry = Buffer.alloc(0);
  const emit = (line) => {
    const withoutCr = line.length && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
    assert.ok(withoutCr.length <= maxRowBytes, `fact row exceeds ${maxRowBytes} bytes in ${file}`);
    return withoutCr;
  };
  try {
    for await (const chunk of stream) {
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, start);
        if (newline < 0) break;
        const piece = chunk.subarray(start, newline);
        assert.ok(carry.length + piece.length <= maxRowBytes, `fact row exceeds ${maxRowBytes} bytes in ${file}`);
        const line = carry.length ? Buffer.concat([carry, piece]) : piece;
        carry = Buffer.alloc(0);
        // A trailing newline has no following line here.  An empty line is
        // therefore a malformed row, rather than a harmless final record.
        assert.ok(line.length, `empty fact row in ${file}`);
        yield emit(line);
        start = newline + 1;
      }
      const tail = chunk.subarray(start);
      assert.ok(carry.length + tail.length <= maxRowBytes, `fact row exceeds ${maxRowBytes} bytes in ${file}`);
      carry = carry.length ? Buffer.concat([carry, tail]) : Buffer.from(tail);
    }
    if (carry.length) yield emit(carry);
  } finally {
    stream.destroy();
  }
}

/** Read an NDJSON run one bounded row at a time; no whole-file buffer exists. */
export async function* iterateJsonFactRows(file, { maxRowBytes = 64 * 1024 } = {}) {
  for await (const line of iterateBoundedLines(file, { maxRowBytes })) {
    try {
      yield JSON.parse(line.toString("utf8"));
    } catch (error) {
      throw new Error(`invalid JSON fact row in ${file}: ${error.message}`);
    }
  }
}

function createJsonRunCursor(file, { compare, maxRowBytes }) {
  const iterator = iterateJsonFactRows(file, { maxRowBytes })[Symbol.asyncIterator]();
  let previous = null;
  return {
    async next() {
      const next = await iterator.next();
      if (next.done) return null;
      const row = next.value;
      if (previous !== null && compare(previous, row) > 0) {
        throw new Error(`fact run is not sorted: ${file}`);
      }
      previous = row;
      return row;
    },
    async close() {
      await iterator.return?.();
    },
  };
}

async function mergeRunGroup(files, options, onRow) {
  const cursors = files.map((file) => createJsonRunCursor(file, options));
  const current = Array(cursors.length).fill(null);
  try {
    for (let index = 0; index < cursors.length; index += 1) current[index] = await cursors[index].next();
    for (;;) {
      let best = -1;
      for (let index = 0; index < current.length; index += 1) {
        if (current[index] === null) continue;
        // Input-run order breaks compare-equal ties deterministically.
        if (best < 0 || options.compare(current[index], current[best]) < 0) best = index;
      }
      if (best < 0) return;
      const row = current[best];
      current[best] = await cursors[best].next();
      await onRow(row);
    }
  } finally {
    await Promise.all(cursors.map((cursor) => cursor.close()));
  }
}

async function writeMergedRun(files, output, options) {
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = fs.openSync(temporary, "wx");
    await mergeRunGroup(files, options, async (row) => {
      fs.writeSync(handle, `${serializedFact(row, options.maxRowBytes)}\n`);
    });
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(temporary, output);
  } catch (error) {
    if (handle !== undefined && handle !== null) fs.closeSync(handle);
    try { fs.unlinkSync(temporary); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
    throw error;
  }
}

function isRunManifest(value) {
  return value && typeof value === "object" && value.format === "terrain-json-run-manifest-v1";
}

async function* iterateRunManifest(source) {
  assert.ok(isRunManifest(source), "fact source must be a terrain JSON run manifest");
  assert.equal(typeof source.path, "string", "fact run manifest path must be a string");
  assert.ok(Number.isSafeInteger(source.runCount) && source.runCount >= 0,
    "fact run manifest count must be a non-negative safe integer");
  let count = 0;
  for await (const line of iterateBoundedLines(source.path, { maxRowBytes: 16 * 1024 })) {
    let file;
    try { file = JSON.parse(line.toString("utf8")); } catch (error) {
      throw new Error(`invalid fact run manifest row in ${source.path}: ${error.message}`);
    }
    assert.equal(typeof file, "string", `fact run manifest row is not a path in ${source.path}`);
    assert.ok(path.isAbsolute(file), `fact run manifest row is not an absolute path in ${source.path}`);
    count += 1;
    yield file;
  }
  assert.equal(count, source.runCount, `fact run manifest count mismatch in ${source.path}`);
}

async function* iterateRunSources(sources) {
  assert.ok(Array.isArray(sources) && sources.length > 0, "fact manifest sources are required");
  for (const source of sources) yield* iterateRunManifest(source);
}

/**
 * Merge manifest-backed sorted runs without retaining a pathname per run.  The
 * source writer spills one path per line; each pass consumes that stream in
 * fan-in-sized batches and writes the next manifest beside the merge scratch.
 */
export async function mergeSortedJsonRunSources(sources, {
  compare = compareJsonFactKeys,
  onRow = async () => {},
  onDuplicate = async () => {},
  dedupe = true,
  maxOpenRuns = 32,
  maxRowBytes = 64 * 1024,
  scratchDir,
  resetScratch = true,
} = {}) {
  assert.ok(Array.isArray(sources) && sources.length > 0, "fact manifest sources are required");
  assert.equal(typeof compare, "function", "compare must be a function");
  assert.equal(typeof onRow, "function", "onRow must be a function");
  assert.equal(typeof onDuplicate, "function", "onDuplicate must be a function");
  assert.ok(Number.isSafeInteger(maxOpenRuns) && maxOpenRuns >= 2, "maxOpenRuns must be at least two");
  assert.ok(Number.isSafeInteger(maxRowBytes) && maxRowBytes > 0, "maxRowBytes must be positive");
  assert.ok(scratchDir, "scratchDir is required for a bounded fact merge");
  for (const source of sources) {
    assert.ok(isRunManifest(source), "fact source must be a terrain JSON run manifest");
  }
  const options = { compare, maxRowBytes };
  const totalSourceRuns = sources.reduce((total, source) => total + source.runCount, 0);
  if (resetScratch) {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    fs.mkdirSync(scratchDir, { recursive: true });
  } else {
    assert.ok(fs.lstatSync(scratchDir).isDirectory(), "owned fact merge directory is not a directory");
    assert.equal(fs.readdirSync(scratchDir).length, 0, "owned fact merge directory is not empty");
  }
  try {
    let currentSources = sources;
    let currentRunCount = totalSourceRuns;
    let pass = 0;
    while (currentRunCount > maxOpenRuns) {
      const nextManifestPath = path.join(scratchDir, `pass-${String(pass).padStart(4, "0")}.manifest.ndjson`);
      const nextManifest = fs.openSync(nextManifestPath, "wx");
      let nextRunCount = 0;
      let batch = [];
      try {
        for await (const file of iterateRunSources(currentSources)) {
          batch.push(file);
          if (batch.length < maxOpenRuns) continue;
          const output = path.join(scratchDir, `pass-${String(pass).padStart(4, "0")}-run-${String(nextRunCount).padStart(12, "0")}.ndjson`);
          await writeMergedRun(batch, output, options);
          fs.writeSync(nextManifest, `${JSON.stringify(output)}\n`);
          nextRunCount += 1;
          batch = [];
        }
        if (batch.length) {
          const output = path.join(scratchDir, `pass-${String(pass).padStart(4, "0")}-run-${String(nextRunCount).padStart(12, "0")}.ndjson`);
          await writeMergedRun(batch, output, options);
          fs.writeSync(nextManifest, `${JSON.stringify(output)}\n`);
          nextRunCount += 1;
        }
        fs.fsyncSync(nextManifest);
      } finally {
        fs.closeSync(nextManifest);
      }
      assert.equal(nextRunCount, Math.ceil(currentRunCount / maxOpenRuns), "fact manifest pass lost a run");
      currentSources = [{ format: "terrain-json-run-manifest-v1", path: nextManifestPath, runCount: nextRunCount }];
      currentRunCount = nextRunCount;
      pass += 1;
    }
    const files = [];
    for await (const file of iterateRunSources(currentSources)) files.push(file);
    assert.equal(files.length, currentRunCount, "fact manifest final count mismatch");
    if (!files.length) return;
    let previous = null;
    await mergeRunGroup(files, options, async (row) => {
      if (dedupe && previous !== null && compare(previous, row) === 0) {
        await onDuplicate(previous, row);
        return;
      }
      await onRow(row);
      previous = row;
    });
  } finally {
    // A verifier lease can provide an identity-bound scratch directory.  It
    // owns reclamation in that mode, so this generic helper must not perform
    // an unqualified recursive reset of a path it did not create.
    if (resetScratch) fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

/**
 * Stream a globally sorted collection of JSON fact runs to `onRow`.
 *
 * No output array is returned.  At most `maxOpenRuns` cursors are open at a
 * time; additional runs are merged in deterministic capped passes into an
 * attempt-scoped scratch directory.  Intermediate passes preserve equal rows,
 * so the final pass sees duplicates even when their original runs were in
 * different batches.
 */
export async function mergeSortedJsonRuns(runs, {
  compare = compareJsonFactKeys,
  onRow = async () => {},
  onDuplicate = async () => {},
  dedupe = true,
  maxOpenRuns = 32,
  maxRowBytes = 64 * 1024,
  scratchDir,
  resetScratch = true,
} = {}) {
  if (!Array.isArray(runs)) {
    return mergeSortedJsonRunSources([runs], {
      compare, onRow, onDuplicate, dedupe, maxOpenRuns, maxRowBytes, scratchDir, resetScratch,
    });
  }
  assert.ok(Array.isArray(runs), "runs must be an array");
  assert.equal(typeof compare, "function", "compare must be a function");
  assert.equal(typeof onRow, "function", "onRow must be a function");
  assert.equal(typeof onDuplicate, "function", "onDuplicate must be a function");
  assert.ok(Number.isSafeInteger(maxOpenRuns) && maxOpenRuns >= 2, "maxOpenRuns must be at least two");
  assert.ok(Number.isSafeInteger(maxRowBytes) && maxRowBytes > 0, "maxRowBytes must be positive");
  assert.ok(scratchDir, "scratchDir is required for a bounded fact merge");
  const resolvedScratch = path.resolve(scratchDir);
  for (const run of runs) {
    assert.notEqual(path.resolve(path.dirname(run)), resolvedScratch, "scratchDir must not be a source run directory");
  }
  // The scratch directory is attempt-scoped too.  A killed merge leaves only
  // disposable intermediate runs, which the next attempt removes here.
  if (resetScratch) {
    fs.rmSync(resolvedScratch, { recursive: true, force: true });
    fs.mkdirSync(resolvedScratch, { recursive: true });
  } else {
    assert.ok(fs.lstatSync(resolvedScratch).isDirectory(), "owned fact merge directory is not a directory");
    assert.equal(fs.readdirSync(resolvedScratch).length, 0, "owned fact merge directory is not empty");
  }
  const options = { compare, maxRowBytes };
  try {
    if (!runs.length) return;
    let working = [...runs];
    let pass = 0;
    while (working.length > maxOpenRuns) {
      const next = [];
      for (let start = 0; start < working.length; start += maxOpenRuns) {
        const batch = working.slice(start, start + maxOpenRuns);
        const output = path.join(
          resolvedScratch,
          `pass-${String(pass).padStart(4, "0")}-run-${String(next.length).padStart(6, "0")}.ndjson`,
        );
        await writeMergedRun(batch, output, options);
        next.push(output);
        // These are disposable prior-pass outputs, not caller-owned source
        // runs.  Reclaim each completed batch so multi-pass fan-in remains
        // bounded in disk as well as descriptors and heap.
        if (pass > 0) for (const input of batch) fs.unlinkSync(input);
      }
      working = next;
      pass += 1;
    }
    let previous = null;
    await mergeRunGroup(working, options, async (row) => {
      if (dedupe && previous !== null && compare(previous, row) === 0) {
        await onDuplicate(previous, row);
        return;
      }
      await onRow(row);
      previous = row;
    });
  } finally {
    if (resetScratch) fs.rmSync(resolvedScratch, { recursive: true, force: true });
  }
}

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const EDGE_PROBLEM_EXAMPLE_LIMIT = 64;

function factOrder(fact) {
  const ordinal = Number(fact.ownerOrdinal);
  const side = fact.side === "east" ? 0 : fact.side === "north" ? 1 : 2;
  return Number.isSafeInteger(ordinal) && ordinal >= 0 ? ordinal * 3 + side : Number.MAX_SAFE_INTEGER;
}

function ownerOrder(left, right) {
  const address = compareCodeUnits(left.ownerAddress, right.ownerAddress);
  if (address) return address;
  const ordinal = Number(left.ownerOrdinal) - Number(right.ownerOrdinal);
  if (Number.isFinite(ordinal) && ordinal) return ordinal;
  return compareCodeUnits(left.side, right.side);
}

function primaryFact(facts) {
  const preferredSide = facts[0].orientation === "V" ? "east" : "north";
  const preferred = facts.filter((fact) => fact.side === preferredSide);
  if (preferred.length === 1) return [preferred[0], facts.find((fact) => fact !== preferred[0])];
  const ordered = [...facts].sort(ownerOrder);
  return [ordered[0], ordered[1]];
}

function decodeMeshEdge(fact) {
  assert.ok(Number.isSafeInteger(fact.grid) && fact.grid >= 2, `invalid mesh edge grid for ${fact.key}`);
  const bytes = Buffer.from(fact.edgeBytes, "base64");
  assert.equal(bytes.length, fact.grid * 8, `invalid mesh edge byte length for ${fact.key}`);
  const edge = new Float64Array(fact.grid);
  for (let index = 0; index < edge.length; index += 1) edge[index] = bytes.readDoubleLE(index * 8);
  return edge;
}

function decodeMaskEdge(fact) {
  const bytes = Buffer.from(fact.edgeBytes, "base64");
  assert.equal(bytes.length, 256, `invalid mask edge byte length for ${fact.key}`);
  return bytes;
}

function keepFirstOrdered(items, candidate, limit) {
  items.push(candidate);
  items.sort(
    (left, right) => left.order - right.order || left.suborder - right.suborder || compareCodeUnits(left.text, right.text),
  );
  if (items.length > limit) items.length = limit;
}

/**
 * Consume globally sorted physical-edge facts without retaining an address
 * index.  A group is at most the two tiles meeting on one physical boundary;
 * an excess is rejected while retaining only three rows to diagnose it.
 *
 * The returned metrics and wording mirror the former in-memory edge maps.
 */
export async function evaluateTerrainEdgeFacts(runs, {
  maxOpenRuns = 32,
  maxRowBytes = 64 * 1024,
  scratchDir,
  resetScratch = true,
} = {}) {
  let adjacencies = 0;
  let worstSeam = 0;
  let worstSeamAt = null;
  let worstSeamOrder = Number.MAX_SAFE_INTEGER;
  let mixedDensityAdjacencies = 0;
  const crackByLevel = new Map();
  let maskAdjacencies = 0;
  let maskByteDisagreements = 0;
  const maskSeamExamples = [];
  let seamProblemCount = 0;
  let edgeGroupOverflowCount = 0;
  const problemExamples = [];

  const consumePair = (facts) => {
    const [here, other] = primaryFact(facts);
    const order = factOrder(here);
    if (here.kind === "mesh") {
      const first = decodeMeshEdge(here);
      const second = decodeMeshEdge(other);
      const level = Number(here.level);
      assert.ok(Number.isSafeInteger(level) && level >= 0, `invalid mesh edge level for ${here.key}`);
      adjacencies += 1;
      const tolerance = Math.max(Number(here.step), Number(other.step)) + 1e-6;
      const spansA = here.grid - 1;
      const spansB = other.grid - 1;
      const common = gcd(spansA, spansB);
      if (here.grid !== other.grid) mixedDensityAdjacencies += 1;
      for (let j = 0; j <= common; j += 1) {
        const a = first[(j * spansA) / common];
        const b = second[(j * spansB) / common];
        if (Number.isNaN(a) || Number.isNaN(b)) continue;
        const delta = Math.abs(a - b);
        if (delta > worstSeam || (delta === worstSeam && order < worstSeamOrder)) {
          worstSeam = delta;
          worstSeamOrder = order;
          worstSeamAt = `${here.ownerAddress} ${here.side} vs ${other.ownerAddress} ${other.side} shared post ${j}/${common}`;
        }
        if (delta > tolerance) {
          seamProblemCount += 1;
          keepFirstOrdered(problemExamples, {
            order,
            suborder: j,
            text: `seam at ${here.ownerAddress} ${here.side} vs ${other.ownerAddress} ${other.side} shared post ${j} of ${common}: ` +
              `${a.toFixed(3)} m vs ${b.toFixed(3)} m (tolerance ${tolerance.toFixed(3)} m)`,
          }, EDGE_PROBLEM_EXAMPLE_LIMIT);
        }
      }
      if (here.grid === other.grid) return;
      const at = (edge, grid, u) => {
        const t = u * (grid - 1);
        const index = Math.min(grid - 2, Math.floor(t));
        const fraction = t - index;
        const v0 = edge[index];
        const v1 = edge[index + 1];
        return Number.isNaN(v0) || Number.isNaN(v1) ? NaN : v0 + (v1 - v0) * fraction;
      };
      const previous = crackByLevel.get(level) ?? { m: 0, at: null, order: Number.MAX_SAFE_INTEGER };
      let worstCrack = previous.m;
      let worstAt = previous.at;
      let worstOrder = previous.order;
      const fineGrid = Math.max(here.grid, other.grid);
      for (let index = 0; index < fineGrid; index += 1) {
        const u = index / (fineGrid - 1);
        const a = at(first, here.grid, u);
        const b = at(second, other.grid, u);
        const delta = Math.abs(a - b);
        if (Number.isNaN(a) || Number.isNaN(b)) continue;
        if (delta > worstCrack || (delta === worstCrack && order < worstOrder)) {
          worstCrack = delta;
          worstOrder = order;
          worstAt = `${here.ownerAddress} ${here.side} (grid ${here.grid}) vs ${other.ownerAddress} ${other.side} (grid ${other.grid})`;
        }
      }
      crackByLevel.set(level, { m: worstCrack, at: worstAt, order: worstOrder });
      return;
    }
    assert.equal(here.kind, "mask", `unknown edge fact kind for ${here.key}`);
    const first = decodeMaskEdge(here);
    const second = decodeMaskEdge(other);
    maskAdjacencies += 1;
    for (let index = 0; index < 256; index += 1) {
      if (first[index] === second[index]) continue;
      maskByteDisagreements += 1;
      keepFirstOrdered(maskSeamExamples, {
        order,
        suborder: index,
        text: `${here.ownerAddress} ${here.side}[${index}] = 0x${first[index].toString(16).padStart(2, "0")} but ` +
          `${other.ownerAddress} ${other.side}[${index}] = 0x${second[index].toString(16).padStart(2, "0")}`,
      }, 8);
    }
  };

  let groupKey = null;
  let group = [];
  let groupCount = 0;
  let groupMinOrder = Number.MAX_SAFE_INTEGER;
  const finishGroup = () => {
    if (groupKey === null) return;
    if (groupCount > 2) {
      edgeGroupOverflowCount += 1;
      keepFirstOrdered(problemExamples, {
        order: groupMinOrder,
        suborder: 2,
        text: `edge fact group ${groupKey} has ${groupCount} rows; expected at most two`,
      }, EDGE_PROBLEM_EXAMPLE_LIMIT);
    } else if (groupCount === 2) {
      consumePair(group);
    }
    groupKey = null;
    group = [];
    groupCount = 0;
    groupMinOrder = Number.MAX_SAFE_INTEGER;
  };

  await mergeSortedJsonRuns(runs, {
    compare: compareJsonFactKeys,
    dedupe: false,
    maxOpenRuns,
    maxRowBytes,
    scratchDir,
    resetScratch,
    onRow: async (fact) => {
      assert.equal(typeof fact?.key, "string", "edge fact needs a string key");
      if (groupKey !== null && fact.key !== groupKey) finishGroup();
      if (groupKey === null) groupKey = fact.key;
      groupCount += 1;
      groupMinOrder = Math.min(groupMinOrder, factOrder(fact));
      if (group.length < 3) group.push(fact);
    },
  });
  finishGroup();
  return {
    adjacencies,
    worstSeam,
    worstSeamAt,
    mixedDensityAdjacencies,
    crackByLevel,
    maskAdjacencies,
    maskByteDisagreements,
    maskSeamExamples: maskSeamExamples.map((entry) => entry.text),
    seamProblemCount,
    edgeGroupOverflowCount,
    problemCount: seamProblemCount + edgeGroupOverflowCount,
    problemExamples: problemExamples.map((entry) => entry.text),
  };
}

export function retryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * Fetch with deterministic exponential backoff.  A retry records neither a
 * cache success nor a source result; callers only persist the final response.
 * That prevents a partial or transient response becoming a durable resume
 * input.
 */
export async function fetchWithRetry(url, {
  fetchImpl = fetch,
  retries = 4,
  retryBaseMs = 250,
  sleepImpl = sleep,
  onRetry = () => {},
  onDiscardResponse = () => {},
} = {}) {
  assert.ok(Number.isInteger(retries) && retries >= 0, "retries must be a non-negative integer");
  assert.ok(Number.isFinite(retryBaseMs) && retryBaseMs >= 0, "retryBaseMs must be non-negative");
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, { redirect: "follow" });
      if (!retryableStatus(response.status) || attempt === retries) return response;
      lastError = new Error(`transient HTTP ${response.status}`);
      // A source observer owns a live timer/metadata slot for every response.
      // Dispose the rejected attempt before retrying the same URL, otherwise
      // its next fetch is (correctly) seen as a duplicate in-flight request.
      try {
        if (response.body?.cancel) await response.body.cancel();
        else if (response.body?.getReader) {
          const reader = response.body.getReader();
          try { await reader.cancel(); } finally { reader.releaseLock?.(); }
        } else if (typeof response.arrayBuffer === "function") {
          await response.arrayBuffer();
        }
      } finally {
        await onDiscardResponse({ url, response, attempt });
      }
    } catch (error) {
      lastError = error;
      if (attempt === retries) throw error;
    }
    const delayMs = retryBaseMs * 2 ** attempt;
    onRetry({ url, attempt: attempt + 1, delayMs, error: lastError });
    await sleepImpl(delayMs);
  }
  throw lastError ?? new Error(`fetch retry loop ended unexpectedly for ${url}`);
}

function responseHeader(response, name) {
  try {
    if (typeof response.headers?.get === "function") return response.headers.get(name) ?? undefined;
    if (response.headers && typeof response.headers === "object") return response.headers[name] ?? response.headers[name.toLowerCase()];
  } catch {}
  return undefined;
}

async function readResponseBodyBounded(response, {
  maxBytes = Infinity,
  requireStreaming = false,
  onLimit = undefined,
} = {}) {
  assert.ok(maxBytes === Infinity || (Number.isSafeInteger(maxBytes) && maxBytes >= 0),
    "response maxBytes must be a non-negative safe integer");
  const contentLength = responseHeader(response, "content-length");
  if (contentLength !== undefined) {
    assert.match(String(contentLength).trim(), /^\d+$/, "response Content-Length must be a decimal byte count");
    const announced = Number(contentLength);
    assert.ok(Number.isSafeInteger(announced), "response Content-Length exceeds safe integer range");
    if (announced > maxBytes) {
      await onLimit?.({ announced, maxBytes });
      try { await response.body?.cancel?.(); } catch {}
      throw new Error(`source response Content-Length ${announced} exceeds approved ${maxBytes}-byte object cap`);
    }
  }
  const chunks = [];
  let total = 0;
  const append = async (chunk) => {
    const bytes = Buffer.from(chunk);
    if (bytes.length > maxBytes - total) {
      await onLimit?.({ announced: total + bytes.length, maxBytes });
      throw new Error(`source response body exceeds approved ${maxBytes}-byte object cap`);
    }
    chunks.push(bytes);
    total += bytes.length;
  };
  const stream = response.body;
  if (stream?.getReader) {
    const reader = stream.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        await append(next.value);
      }
    } catch (error) {
      try { await reader.cancel(error); } catch {}
      throw error;
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total);
  }
  if (stream && typeof stream[Symbol.asyncIterator] === "function") {
    try {
      for await (const chunk of stream) await append(chunk);
    } catch (error) {
      stream.destroy?.(error);
      throw error;
    }
    return Buffer.concat(chunks, total);
  }
  // A no-content response is a valid streamed zero-byte object. Any body we
  // need to consume for a source-policy cut must expose a stream; arrayBuffer
  // would allocate it before the cap could be enforced.
  if (requireStreaming) {
    if (stream == null && (String(contentLength).trim() === "0" || response.status === 204)) return Buffer.alloc(0);
    throw new Error("source response has no readable streaming body");
  }
  const fallback = Buffer.from(await response.arrayBuffer());
  await append(fallback);
  return Buffer.concat(chunks, total);
}

function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally { fs.closeSync(handle); }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function readJson(file, fallback = null) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback;
  } catch {
    // Lock/lease metadata is advisory only when it can be authenticated below.
    // A torn or corrupt JSON file must never make every future process throw
    // forever; callers treat this as unknown ownership and reclaim after TTL.
    return fallback;
  }
}

function safeUnlink(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function defaultPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function defaultProcessIdentity(pid) {
  try {
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const afterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    // /proc/pid/stat field 22 is starttime; afterCommand starts at field 3.
    const start = afterCommand[19];
    return start ? { pid, startToken: `${boot}:${start}` } : { pid, startToken: null };
  } catch {
    return { pid, startToken: null };
  }
}

/**
 * A process-safe, bounded cache.  The global cache lock serializes capacity
 * reservation, eviction and publication. A per-URL producer lock serializes
 * a miss all the way through network fetch, so two workers cannot race a 200
 * and a 404 into different body/status generations. A published entry is one
 * immutable generation selected by an atomically renamed `current.json`.
 */
export class BoundedGranuleCache {
  constructor({
    dir,
    maxBytes,
    owner = `${process.pid}-${randomUUID()}`,
    pid = process.pid,
    now = () => Date.now(),
    isPidAlive = defaultPidAlive,
    processIdentity = defaultProcessIdentity,
    leaseTtlMs = 30 * 60_000,
    // On platforms without a process start token (notably macOS), a live PID
    // alone cannot prove ownership because PIDs can be reused. Holders write a
    // heartbeat every 20 s; five minutes without one is a bounded crash/stall
    // recovery window, deliberately separate from the 30-minute cache lease.
    identitylessHeartbeatTtlMs = 5 * 60_000,
    heartbeatIntervalMs = 20_000,
    // Test-only interleave hook for the stale-owner/recovery race.
    onHeartbeatBeforeWrite = () => {},
    lockWaitMs = 60_000,
  }) {
    assert.ok(dir, "cache dir is required");
    assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0, "cache maxBytes must be a positive safe integer");
    this.dir = path.resolve(dir);
    this.maxBytes = maxBytes;
    this.owner = owner;
    this.pid = pid;
    this.now = now;
    this.isPidAlive = isPidAlive;
    this.processIdentity = processIdentity;
    this.identity = processIdentity(pid);
    this.leaseTtlMs = leaseTtlMs;
    assert.ok(Number.isSafeInteger(identitylessHeartbeatTtlMs) && identitylessHeartbeatTtlMs > 0, "identitylessHeartbeatTtlMs must be a positive safe integer");
    assert.ok(Number.isSafeInteger(heartbeatIntervalMs) && heartbeatIntervalMs > 0 && heartbeatIntervalMs < identitylessHeartbeatTtlMs, "heartbeatIntervalMs must be positive and shorter than identitylessHeartbeatTtlMs");
    this.identitylessHeartbeatTtlMs = identitylessHeartbeatTtlMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.onHeartbeatBeforeWrite = onHeartbeatBeforeWrite;
    this.lockWaitMs = lockWaitMs;
    this.retries = 0;
    this.evictions = 0;
    this.leaseHeartbeats = new Map();
    for (const name of ["entries", "leases", "lease-heartbeats", "locks", "producer-locks"]) {
      fs.mkdirSync(path.join(this.dir, name), { recursive: true });
    }
  }

  key(url) { return urlCacheKey(url); }
  entryDir(key) { return path.join(this.dir, "entries", key); }
  pointerPath(key) { return path.join(this.entryDir(key), "current.json"); }
  leasePath(key) { return path.join(this.dir, "leases", `${key}.${this.owner}.json`); }
  heartbeatPath(ownerFile, token) {
    if (ownerFile.startsWith(path.join(this.dir, "leases") + path.sep)) {
      return path.join(this.dir, "lease-heartbeats", `${path.basename(ownerFile)}.${token}.heartbeat`);
    }
    return path.join(path.dirname(ownerFile), `.heartbeat-${token}`);
  }

  ownerRecord(token = undefined) {
    return { ...(token ? { token } : {}), owner: this.owner, pid: this.pid, identity: this.identity, acquiredAt: this.now() };
  }

  heartbeatAge(ownerFile, owner, fallbackAge) {
    if (!owner?.token) return fallbackAge;
    try {
      const heartbeat = Number(fs.readFileSync(this.heartbeatPath(ownerFile, owner.token), "utf8"));
      return Number.isFinite(heartbeat) ? Math.max(0, this.now() - heartbeat) : fallbackAge;
    } catch {
      return fallbackAge;
    }
  }

  // Returns true only for a live owner that either has a matching durable
  // process identity or, where that cannot be observed, a recent heartbeat.
  // A reused PID with no start token is conservatively protected for the short
  // heartbeat crash bound, never for the ordinary (30-minute) lease TTL.
  ownerStillMatches(owner, ownerFile, age) {
    if (!owner || !this.isPidAlive(Number(owner.pid))) return false;
    const recorded = owner.identity?.startToken;
    const observed = this.processIdentity(Number(owner.pid))?.startToken;
    if (recorded && observed) return recorded === observed;
    return this.heartbeatAge(ownerFile, owner, age) <= this.identitylessHeartbeatTtlMs;
  }

  refreshHeartbeat(file, token) {
    const owner = readJson(file);
    // Never write a successor's metadata. Heartbeats are token-named sidecars:
    // an old owner that resumes after its directory was reclaimed can at worst
    // leave an ignored old-token pulse, never replace the new owner's record.
    if (!owner || owner.token !== token) return false;
    this.onHeartbeatBeforeWrite({ file, token });
    try {
      // Deliberately NOT atomicWrite: that helper mkdirs its parent. A stale
      // timer after recovery must get ENOENT, not recreate an owner directory
      // containing only a heartbeat. If a successor raced in, the post-write
      // token check removes this old token's otherwise harmless sidecar.
      fs.writeFileSync(this.heartbeatPath(file, token), `${this.now()}\n`);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    const after = readJson(file);
    if (!after || after.token !== token) {
      safeUnlink(this.heartbeatPath(file, token));
      return false;
    }
    return true;
  }

  startHeartbeat(file, token) {
    this.refreshHeartbeat(file, token);
    const timer = setInterval(() => {
      try { this.refreshHeartbeat(file, token); } catch {}
    }, this.heartbeatIntervalMs);
    timer.unref?.();
    return timer;
  }

  stopLeaseHeartbeat(file) {
    const heartbeat = this.leaseHeartbeats.get(file);
    if (heartbeat) {
      clearInterval(heartbeat.timer);
      safeUnlink(this.heartbeatPath(file, heartbeat.token));
    }
    this.leaseHeartbeats.delete(file);
  }

  removeLeaseHeartbeats(file, token = null) {
    const root = path.join(this.dir, "lease-heartbeats");
    const prefix = `${path.basename(file)}.`;
    for (const name of fs.readdirSync(root)) {
      if (name.startsWith(prefix) && (!token || name === `${path.basename(file)}.${token}.heartbeat`)) {
        safeUnlink(path.join(root, name));
      }
    }
  }

  paths(url) {
    const key = this.key(url);
    const current = readJson(this.pointerPath(key));
    const generation = current?.generation ?? "missing";
    const dir = this.entryDir(key);
    return {
      key,
      generation,
      body: path.join(dir, `${generation}.bin`),
      status: path.join(dir, `${generation}.status`),
      meta: path.join(dir, `${generation}.meta.json`),
      pointer: this.pointerPath(key),
      lease: this.leasePath(key),
    };
  }

  async withDirectoryLock(lockDir, action) {
    const ownerFile = path.join(lockDir, "owner.json");
    const token = randomUUID();
    const deadline = Date.now() + this.lockWaitMs;
    while (true) {
      try {
        fs.mkdirSync(lockDir);
        atomicWrite(ownerFile, `${JSON.stringify(this.ownerRecord(token))}\n`);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const owner = readJson(ownerFile);
        const age = (() => { try { return this.now() - fs.statSync(lockDir).mtimeMs; } catch { return 0; } })();
        const ownerValid = owner && Number.isInteger(Number(owner.pid));
        const dead = ownerValid && !this.isPidAlive(Number(owner.pid));
        const staleOwner = ownerValid && !this.ownerStillMatches(owner, ownerFile, age);
        // A lock with no owner file can only be reclaimed after its bounded
        // grace period; otherwise another process between mkdir and write
        // could have its live lock stolen.
        // A matching process identity is the only unbounded lock owner. An
        // identity-less live owner remains safe while its holder heartbeat is
        // fresh; a missing/corrupt owner receives the longer mkdir/write grace.
        if (dead || staleOwner || (!ownerValid && age > this.leaseTtlMs)) {
          try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
          continue;
        }
        if (Date.now() >= deadline) throw new Error(`timed out waiting for cache lock ${path.basename(lockDir)}`);
        await sleep(10);
      }
    }
    const heartbeat = this.startHeartbeat(ownerFile, token);
    try {
      return await action();
    } finally {
      clearInterval(heartbeat);
      safeUnlink(this.heartbeatPath(ownerFile, token));
      const owner = readJson(ownerFile);
      if (owner?.token === token) fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  withGlobalLock(action) { return this.withDirectoryLock(path.join(this.dir, "locks", "cache.lock"), action); }
  withProducerLock(key, action) { return this.withDirectoryLock(path.join(this.dir, "producer-locks", `${key}.lock`), action); }

  reclaimStaleLeasesUnlocked() {
    const leaseDir = path.join(this.dir, "leases");
    for (const name of fs.readdirSync(leaseDir)) {
      const file = path.join(leaseDir, name);
      const lease = readJson(file);
      const age = (() => { try { return this.now() - fs.statSync(file).mtimeMs; } catch { return 0; } })();
      const valid = lease && Number.isInteger(Number(lease.pid));
      const dead = valid && !this.isPidAlive(Number(lease.pid));
      const staleOwner = valid && !this.ownerStillMatches(lease, file, age);
      // A dead/reused identity or an identity-less owner with no fresh holder
      // heartbeat is stale. Corrupt metadata gets the longer mkdir/write grace.
      if (dead || staleOwner || (!valid && age > this.leaseTtlMs)) {
        safeUnlink(file);
        this.removeLeaseHeartbeats(file, lease?.token);
      }
    }
  }

  hasLeaseUnlocked(key) {
    const prefix = `${key}.`;
    return fs.readdirSync(path.join(this.dir, "leases")).some((name) => name.startsWith(prefix));
  }

  readEntryUnlocked(url) {
    const entry = this.paths(url);
    if (!fs.existsSync(entry.body) || !fs.existsSync(entry.status) || !fs.existsSync(entry.meta)) return null;
    const status = Number(fs.readFileSync(entry.status, "utf8"));
    if (!Number.isInteger(status)) return null;
    return { status, body: fs.readFileSync(entry.body), hit: true, entry };
  }

  cleanupEntryUnlocked(key) {
    const dir = this.entryDir(key);
    const pointer = readJson(this.pointerPath(key));
    if (!fs.existsSync(dir)) return false;
    if (!pointer?.generation) {
      fs.rmSync(dir, { recursive: true, force: true });
      return false;
    }
    const keep = new Set(["current.json", `${pointer.generation}.bin`, `${pointer.generation}.status`, `${pointer.generation}.meta.json`]);
    if (![...keep].every((name) => fs.existsSync(path.join(dir, name)))) {
      fs.rmSync(dir, { recursive: true, force: true });
      return false;
    }
    for (const name of fs.readdirSync(dir)) {
      if (!keep.has(name)) safeUnlink(path.join(dir, name));
    }
    return true;
  }

  entriesUnlocked({ reclaimOrphans = false } = {}) {
    const root = path.join(this.dir, "entries");
    const rows = [];
    for (const key of fs.readdirSync(root)) {
      if (reclaimOrphans && !this.cleanupEntryUnlocked(key)) continue;
      const pointer = readJson(this.pointerPath(key));
      if (!pointer?.generation) continue;
      const dir = this.entryDir(key);
      const files = fs.readdirSync(dir).map((name) => path.join(dir, name));
      if (!files.every((file) => fs.existsSync(file))) continue;
      rows.push({
        key,
        dir,
        bytes: files.reduce((total, file) => total + fs.statSync(file).size, 0),
        lastUsed: Number(pointer.lastUsed ?? 0),
      });
    }
    return rows;
  }

  usageBytes() { return this.entriesUnlocked().reduce((total, entry) => total + entry.bytes, 0); }

  async usageBytesLocked() {
    return this.withGlobalLock(async () => {
      this.reclaimStaleLeasesUnlocked();
      return this.entriesUnlocked({ reclaimOrphans: true }).reduce((total, entry) => total + entry.bytes, 0);
    });
  }

  evictForUnlocked(requiredBytes) {
    assert.ok(requiredBytes <= this.maxBytes, `one granule (${requiredBytes} B) exceeds cache cap ${this.maxBytes} B`);
    let used = this.entriesUnlocked({ reclaimOrphans: true }).reduce((total, entry) => total + entry.bytes, 0);
    if (used + requiredBytes <= this.maxBytes) return used;
    const candidates = this.entriesUnlocked({ reclaimOrphans: true })
      .filter((entry) => !this.hasLeaseUnlocked(entry.key))
      .sort((a, b) => a.lastUsed - b.lastUsed || a.key.localeCompare(b.key));
    for (const entry of candidates) {
      if (used + requiredBytes <= this.maxBytes) break;
      fs.rmSync(entry.dir, { recursive: true, force: true });
      used -= entry.bytes;
      this.evictions += 1;
    }
    assert.ok(used + requiredBytes <= this.maxBytes, `cache cap ${this.maxBytes} B is exhausted by leased granules; release completed cells or raise cache_max_bytes`);
    return used;
  }

  publishUnlocked(url, status, body) {
    const key = this.key(url);
    const generation = randomUUID();
    const bytes = Buffer.from(body);
    const metadata = `${JSON.stringify({ url, status, bytes: bytes.length, generation })}\n`;
    const pointer = `${JSON.stringify({ generation, lastUsed: this.now() })}\n`;
    const requiredBytes = bytes.length + Buffer.byteLength(`${status}\n`) + Buffer.byteLength(metadata) + Buffer.byteLength(pointer);
    this.evictForUnlocked(requiredBytes);
    const dir = this.entryDir(key);
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(path.join(dir, `${generation}.bin`), bytes);
    atomicWrite(path.join(dir, `${generation}.status`), `${status}\n`);
    atomicWrite(path.join(dir, `${generation}.meta.json`), metadata);
    atomicWrite(this.pointerPath(key), pointer);
    return this.readEntryUnlocked(url);
  }

  async acquire(url) {
    const key = this.key(url);
    await this.withGlobalLock(async () => {
      this.reclaimStaleLeasesUnlocked();
      this.entriesUnlocked({ reclaimOrphans: true });
      const lease = this.leasePath(key);
      const token = randomUUID();
      atomicWrite(lease, `${JSON.stringify(this.ownerRecord(token))}\n`);
      this.stopLeaseHeartbeat(lease);
      this.leaseHeartbeats.set(lease, { timer: this.startHeartbeat(lease, token), token });
    });
    return this.paths(url);
  }

  async release(url) {
    const lease = this.leasePath(this.key(url));
    this.stopLeaseHeartbeat(lease);
    await this.withGlobalLock(async () => {
      safeUnlink(lease);
      this.removeLeaseHeartbeats(lease);
    });
  }

  async releaseAll() {
    await this.withGlobalLock(async () => {
      const suffix = `.${this.owner}.json`;
      for (const name of fs.readdirSync(path.join(this.dir, "leases"))) {
        if (name.endsWith(suffix)) {
          const lease = path.join(this.dir, "leases", name);
          this.stopLeaseHeartbeat(lease);
          safeUnlink(lease);
          this.removeLeaseHeartbeats(lease);
        }
      }
    });
  }

  // Synchronous read for the runner's synchronous hostcall bridge.  Callers
  // must already hold their URL lease, which prevents eviction of its current
  // immutable generation while the flow consumes it.
  read(url) { return this.readEntryUnlocked(url); }

  async get(url, { beforeUse = undefined } = {}) {
    return this.withGlobalLock(async () => {
      this.reclaimStaleLeasesUnlocked();
      this.entriesUnlocked({ reclaimOrphans: true });
      const cached = this.readEntryUnlocked(url);
      if (!cached) return null;
      // A source-backed caller may make cache visibility contingent on a
      // receipt.  Run this while the current pointer is still protected by
      // the cache lock so an unattributed generation is never returned.
      await beforeUse?.({ url, status: cached.status, body: cached.body });
      const pointer = readJson(cached.entry.pointer);
      atomicWrite(cached.entry.pointer, `${JSON.stringify({ ...pointer, lastUsed: this.now() })}\n`);
      return { status: cached.status, body: cached.body, hit: true };
    });
  }

  async put(url, status, body, { beforePublish = undefined } = {}) {
    return this.withGlobalLock(async () => {
      this.reclaimStaleLeasesUnlocked();
      this.entriesUnlocked({ reclaimOrphans: true });
      // The immutable body is complete, but current.json has not been made
      // visible yet.  Provenance receipts belong in this exact window: a
      // callback failure leaves no cache generation for another worker to use.
      await beforePublish?.({ url, status, body: Buffer.from(body) });
      return { ...this.publishUnlocked(url, status, body), hit: false };
    });
  }

  async fetch(url, options = {}) {
    await this.acquire(url);
    const cached = await this.get(url, { beforeUse: options.beforeUse });
    if (cached) return cached;
    const key = this.key(url);
    return this.withProducerLock(key, async () => {
      const appeared = await this.get(url, { beforeUse: options.beforeUse });
      if (appeared) return appeared;
      let retries = 0;
      const response = await fetchWithRetry(url, {
        ...options,
        onRetry: (event) => { retries += 1; options.onRetry?.(event); },
      });
      this.retries += retries;
      // Consume every terminal response before provenance is allowed to
      // publish it. A 404 is evidence too: leaving its body unread would let
      // the request timeout stop at headers and would record a fabricated
      // zero-length response digest rather than what the provider returned.
      // Source-policy callers require a stream so the cap is checked before
      // a hostile response can allocate an arbitrary arrayBuffer.
      const body = await readResponseBodyBounded(response, {
        maxBytes: options.maxResponseBytes,
        requireStreaming: options.requireStreamingBody,
        onLimit: options.onBodyLimit,
      });
      return this.put(url, response.status, body, { beforePublish: options.beforePublish });
    });
  }
}

function sourceMinLevel(flow) {
  // terrain-ingest refuses levels below 8 because a tile is wider than one
  // source granule there. Use that same floor here: a shard boundary aligned
  // to a tile column at this level remains a boundary for every deeper level.
  const minLevel = Number(flow.min_level ?? 8);
  assert.ok(Number.isInteger(minLevel) && minLevel >= 8,
    "flow_config.min_level must be an integer at or above the source granule floor (8)");
  const columns = 2 ** (minLevel + 1);
  assert.ok(Number.isSafeInteger(columns), "flow_config.min_level exceeds the coordinator's exact tile-column range");
  return { minLevel, columns, width: 360 / columns };
}

function sourceRegionColumns(region, { columns, width }) {
  const west = Number(region.west);
  const east = Number(region.east);
  const south = Number(region.south);
  const north = Number(region.north);
  // Match terrain-ingest's region_block() calculation exactly. In particular,
  // its east edge is half-open, but a tile that straddles an inner degree cut
  // belongs to both degree slices; only a tile-column cut is safe to shard.
  assert.ok(Number.isFinite(west) && Number.isFinite(east) &&
    west >= -180 && west < east && east <= 180,
  `region ${region.name ?? "(unnamed)"} needs canonical longitude bounds -180 <= west < east <= 180`);
  assert.ok(Number.isFinite(south) && Number.isFinite(north) &&
    south >= -90 && south < north && north <= 90,
  `region ${region.name ?? "(unnamed)"} needs canonical latitude bounds -90 <= south < north <= 90`);
  const clampColumn = (column) => Math.max(0, Math.min(columns - 1, column));
  const x0 = clampColumn(Math.floor((west + 180) / width));
  const x1 = clampColumn(Math.floor((east + 180) / width - 1e-9));
  return { west, east, x0, x1: Math.max(x0, x1) };
}

function mergeColumnCoverage(ranges) {
  const merged = [];
  for (const range of [...ranges].sort((left, right) => left.x0 - right.x0 || left.x1 - right.x1)) {
    const previous = merged[merged.length - 1];
    if (previous && range.x0 <= previous.x1 + 1) previous.x1 = Math.max(previous.x1, range.x1);
    else merged.push({ x0: range.x0, x1: range.x1 });
  }
  return merged;
}

// Spread the union of source-owned minimum-level columns across workers
// without materialising a column-sized array. Every shard receives at least
// one column, and all regions touching a column are sent to the same worker so
// terrain-ingest's priority ownership rule still applies before global merge.
function partitionColumnCoverage(coverage, shardCount) {
  const total = coverage.reduce((sum, range) => sum + range.x1 - range.x0 + 1, 0);
  assert.ok(total >= shardCount,
    `--shards ${shardCount} exceeds the ${total} source-covered minimum-level tile columns`);
  const output = Array.from({ length: shardCount }, () => []);
  let shard = 0;
  let remaining = Math.floor((shard + 1) * total / shardCount) - Math.floor(shard * total / shardCount);
  for (const range of coverage) {
    let next = range.x0;
    while (next <= range.x1) {
      const take = Math.min(remaining, range.x1 - next + 1);
      output[shard].push({ x0: next, x1: next + take - 1 });
      next += take;
      remaining -= take;
      if (remaining === 0 && shard + 1 < shardCount) {
        shard += 1;
        remaining = Math.floor((shard + 1) * total / shardCount) - Math.floor(shard * total / shardCount);
      }
    }
  }
  assert.ok(output.every((ranges) => ranges.length > 0), "every global shard must own at least one tile-column range");
  return output;
}

function splitRegionsAtTileColumns(flow, shardCount) {
  const grid = sourceMinLevel(flow);
  const indexed = flow.regions.map((region) => ({ region, columns: sourceRegionColumns(region, grid) }));
  const assignments = partitionColumnCoverage(
    mergeColumnCoverage(indexed.map(({ columns }) => columns)),
    shardCount,
  );
  const output = Array.from({ length: shardCount }, () => []);
  for (const { region, columns } of indexed) {
    for (let shard = 0; shard < assignments.length; shard += 1) {
      for (const assignment of assignments[shard]) {
        const x0 = Math.max(columns.x0, assignment.x0);
        const x1 = Math.min(columns.x1, assignment.x1);
        if (x1 < x0) continue;
        const west = Math.max(columns.west, -180 + x0 * grid.width);
        const east = Math.min(columns.east, -180 + (x1 + 1) * grid.width);
        assert.ok(east > west, `tile-column shard split is empty for region ${region.name ?? "(unnamed)"}`);
        output[shard].push({
          ...region,
          name: `${region.name ?? "region"}--shard-${String(shard).padStart(3, "0")}-columns-${x0}-${x1}`,
          west,
          east,
        });
      }
    }
  }
  assert.ok(output.every((regions) => regions.length > 0), "every global shard must receive at least one source region");
  return output;
}

/** Build deterministic, non-overlapping longitude slices for independent runs. */
export function makeShardConfigs(runConfig, shardCount, { outDir, cacheDir, cacheMaxBytes } = {}) {
  assert.ok(Number.isInteger(shardCount) && shardCount > 0 && shardCount <= MAX_GLOBAL_SHARDS,
    `shardCount must be in [1, ${MAX_GLOBAL_SHARDS}]`);
  const flow = runConfig.flow_config ?? {};
  assert.ok(Array.isArray(flow.regions) && flow.regions.length > 0 && flow.regions.length <= MAX_GLOBAL_REGIONS,
    `flow_config.regions must contain [1, ${MAX_GLOBAL_REGIONS}] regions`);
  const regions = splitRegionsAtTileColumns(flow, shardCount);
  return regions.map((shardRegions, shard) => ({
    ...runConfig,
    out: undefined,
    cache_dir: cacheDir,
    cache_max_bytes: cacheMaxBytes,
    global_shard: { index: shard, count: shardCount, config_digest: sha256(canonicalJson(runConfig)) },
    flow_config: { ...flow, regions: shardRegions },
    shard_out: outDir ? path.join(outDir, "shards", `shard-${String(shard).padStart(3, "0")}`) : undefined,
  }));
}

export function statePath(outDir) {
  return path.join(outDir, "global-build-state.json");
}

export function initializeGlobalState(outDir, runConfig, shardCount) {
  // This public entry point can be called without makeShardConfigs. Check
  // before state.shards allocates one object per claimed coordinator shard.
  assert.ok(Number.isInteger(shardCount) && shardCount > 0 && shardCount <= MAX_GLOBAL_SHARDS,
    `shardCount must be in [1, ${MAX_GLOBAL_SHARDS}]`);
  const file = statePath(outDir);
  const digest = sha256(canonicalJson(runConfig));
  const existing = readJson(file);
  if (existing) {
    assert.equal(existing.version, GLOBAL_STATE_VERSION, "unsupported global build state version");
    assert.equal(existing.configDigest, digest, "refusing to resume a state written for different config bytes");
    assert.equal(existing.shards.length, shardCount, "refusing to resume with a different shard count");
    return existing;
  }
  const state = {
    version: GLOBAL_STATE_VERSION,
    configDigest: digest,
    createdAt: new Date().toISOString(),
    shards: Array.from({ length: shardCount }, (_, index) => ({ index, status: "pending", attempts: 0 })),
  };
  atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export function saveGlobalState(outDir, state) {
  atomicWrite(statePath(outDir), `${JSON.stringify(state, null, 2)}\n`);
}

export function markShard(state, index, status, detail = {}) {
  const shard = state.shards[index];
  assert.ok(shard, `unknown shard ${index}`);
  if (status === "running") shard.attempts += 1;
  Object.assign(shard, detail, { status, updatedAt: new Date().toISOString() });
  return shard;
}
