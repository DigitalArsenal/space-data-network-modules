//
// THREAD MODEL — DECLARED, NEVER INFERRED.
//
// Graph task: modules-undeclared-threadmodel-artifacts (split out of
// modules-dist-not-reproducible-at-sdk-pin).
//
// WHY THIS FILE EXISTS
//
// A module's thread model decides its TOOLCHAIN LANE, and therefore its bytes:
//
//   single-thread        Emscripten STANDALONE_WASM, unshared linear memory.
//   wasi-sequential      clang wasm32-wasip1-threads, shared memory, but the
//                        guest provably never spawns (requires
//                        manifest.sequentialJustification).
//   emscripten-pthreads  real wasi-threads: shared memory, `wasi.thread-spawn`
//                        imported, `wasi_thread_start` exported. The
//                        isomorphic-pthreads law: anything threaded compiles
//                        wasm32-wasip1-threads, NEVER `emcc -pthread`.
//
// The SDK will INFER that lane when `compileModuleFromSource` is not given one
// (`resolveThreadModel`, src/compiler/compileModule.js). That inference is a
// property of the SDK VERSION, not of the module's source, and it has already
// moved:
//
//   era pins (<= 2026-07)  runtimeTargets [browser, wasmedge] matched `browser`
//                          FIRST and returned single-thread. Every artifact in
//                          this repo built by inference was built that way —
//                          measured, by reading the resolver at the era pin the
//                          super-repo carried the day the bytes landed.
//   current pin (0.8.11)   `browser` no longer selects a toolchain (correctly:
//                          targeting a browser is a deployment fact, not a
//                          concurrency fact), so `wasmedge` wins and returns
//                          emscripten-pthreads. `assertPthreadArtifact` then
//                          REFUSES the emitted wasm, because the guest has no
//                          wasi-threads contract and never did.
//
// So an undeclared module does not merely drift — it stops producing bytes at
// all, and leaves a truncated corpse on disk because build.mjs writes the wasm
// before the guard runs. Eleven modules were in exactly that state.
//
// WHAT A DECLARATION IS
//
// A STRING LITERAL in the module's own build.mjs. Not a computed value, not a
// helper default, not `compilation.guestLink.threadModel` echoed into
// dist/guest-link/metadata.json — that last one is a REPORT of what the SDK
// decided, and counting it as a declaration is the false negative that hid three
// modules until they failed to rebuild.
//
// Modules that do not use the SDK compiler at all (a hand-rolled `em++` line)
// still declare, via a `THREAD_MODEL` string-literal constant, and still get
// checked: `assertArtifactThreadModel` reads the EMITTED wasm and refuses a
// declaration the bytes contradict. A declaration nothing verifies is a comment.
//

import fs from "node:fs";

export const THREAD_MODELS = Object.freeze([
  "single-thread",
  "wasi-sequential",
  "emscripten-pthreads",
]);

const WASM_MAGIC = 0x6d736100;

function readVaruint(bytes, offset) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    if (offset >= bytes.length) throw new Error("truncated LEB128");
    byte = bytes[offset++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return [result >>> 0, offset];
}

function readName(bytes, offset) {
  const [length, next] = readVaruint(bytes, offset);
  return [Buffer.from(bytes.buffer, bytes.byteOffset + next, length).toString("utf8"), next + length];
}

// Skip a limits record, returning the flags byte. Bit 0 = has-max, bit 1 = SHARED.
function readLimits(bytes, offset) {
  let flags;
  [flags, offset] = readVaruint(bytes, offset);
  [, offset] = readVaruint(bytes, offset);
  if (flags & 1) [, offset] = readVaruint(bytes, offset);
  return [flags, offset];
}

/**
 * The threading facts a wasm artifact carries, read from the bytes themselves.
 *
 * Deliberately a hand-rolled section walk rather than a dependency: this runs
 * inside build.mjs files that already vendor their own emsdk and must not grow a
 * new npm edge to state a fact about their own output.
 */
export function inspectWasmThreading(input) {
  const bytes = typeof input === "string" ? fs.readFileSync(input) : Buffer.from(input);
  if (bytes.length < 8 || bytes.readUInt32LE(0) !== WASM_MAGIC) {
    throw new Error("not a WebAssembly binary (bad magic)");
  }
  let offset = 8;
  let sharedMemory = false;
  let threadSpawnImport = null;
  let threadStartExport = false;
  let trailingBytes = 0;
  const importModules = new Set();

  // The walk stops at the end of the WASM MODULE PROPER, which is not always the
  // end of the file. `signModuleArtifact` produces artifacts that APPEND a
  // signature envelope after the last section — measured: catalog-synthesis.wasm
  // is 163,884 B, of which the module is the first 162,920 (byte-identical to the
  // unsigned dist/isomorphic/module.wasm) and the rest is a detached payload that
  // is not wasm at all. Walking into it yields garbage section ids and eventually
  // an out-of-bounds name read. Section ids above 13 (tag) do not exist, so the
  // first one is where the module ends. Nothing is lost: every threading fact
  // lives in the import, memory and export sections, all of which precede code.
  const MAX_SECTION_ID = 13;

  while (offset < bytes.length) {
    const id = bytes[offset];
    if (id > MAX_SECTION_ID) {
      trailingBytes = bytes.length - offset;
      break;
    }
    offset += 1;
    let size;
    [size, offset] = readVaruint(bytes, offset);
    const end = offset + size;
    if (end > bytes.length) {
      trailingBytes = bytes.length - (offset - 1);
      break;
    }
    if (id === 2) {
      // import
      let cursor = offset;
      let count;
      [count, cursor] = readVaruint(bytes, cursor);
      for (let index = 0; index < count; index += 1) {
        let moduleName;
        let fieldName;
        [moduleName, cursor] = readName(bytes, cursor);
        [fieldName, cursor] = readName(bytes, cursor);
        importModules.add(moduleName);
        const kind = bytes[cursor++];
        if (kind === 0) [, cursor] = readVaruint(bytes, cursor);
        else if (kind === 1) {
          cursor += 1;
          [, cursor] = readLimits(bytes, cursor);
        } else if (kind === 2) {
          let flags;
          [flags, cursor] = readLimits(bytes, cursor);
          if (flags & 2) sharedMemory = true;
        } else if (kind === 3) cursor += 2;
        else if (kind === 4) [, cursor] = readVaruint(bytes, cursor);
        else throw new Error(`unknown import kind ${kind}`);
        if (/thread[-_]spawn/i.test(fieldName)) threadSpawnImport = `${moduleName}.${fieldName}`;
      }
    } else if (id === 5) {
      // memory
      let cursor = offset;
      let count;
      [count, cursor] = readVaruint(bytes, cursor);
      for (let index = 0; index < count; index += 1) {
        let flags;
        [flags, cursor] = readLimits(bytes, cursor);
        if (flags & 2) sharedMemory = true;
      }
    } else if (id === 7) {
      // export
      let cursor = offset;
      let count;
      [count, cursor] = readVaruint(bytes, cursor);
      for (let index = 0; index < count; index += 1) {
        let name;
        [name, cursor] = readName(bytes, cursor);
        cursor += 1;
        [, cursor] = readVaruint(bytes, cursor);
        if (name === "wasi_thread_start") threadStartExport = true;
      }
    }
    offset = end;
  }

  return {
    sharedMemory,
    threadSpawnImport,
    threadStartExport,
    // Non-zero on a signed artifact: the detached signature envelope. Reported
    // rather than hidden, so a caller can tell "signed" from "corrupt".
    trailingBytes,
    importModules: [...importModules].sort(),
  };
}

/**
 * Refuse a declaration the emitted bytes contradict.
 *
 * This is the repo-side twin of the SDK's `assertPthreadArtifact`, and it exists
 * for the same reason: a module that CLAIMS the pthreads contract without the
 * wasi-threads shape cannot run threads under WasmEdge, and one that claims
 * single-thread while carrying `wasi.thread-spawn` is shipping a threading
 * contract nobody declared. Both are silent today and loud here.
 *
 * The asymmetry is deliberate. `wasi-sequential` PERMITS shared memory (it is
 * the clang wasm32-wasip1-threads lane, which emits a shared memory even though
 * the guest never spawns), so only the spawn import discriminates it from
 * pthreads. `single-thread` is the Emscripten lane and permits neither.
 */
export function assertArtifactThreadModel(input, threadModel, label = "artifact") {
  if (!THREAD_MODELS.includes(threadModel)) {
    throw new Error(
      `${label}: threadModel ${JSON.stringify(threadModel)} is not one of ${JSON.stringify(THREAD_MODELS)}. ` +
        "It must be a string literal declared in this module's build.mjs, never inferred.",
    );
  }
  const facts = inspectWasmThreading(input);
  const shape =
    `shared memory ${facts.sharedMemory ? "yes" : "no"}, ` +
    `thread-spawn import ${facts.threadSpawnImport ?? "none"}, ` +
    `wasi_thread_start export ${facts.threadStartExport ? "yes" : "no"}`;

  if (threadModel === "emscripten-pthreads") {
    if (!facts.threadSpawnImport || !facts.sharedMemory || !facts.threadStartExport) {
      throw new Error(
        `${label} declares threadModel "emscripten-pthreads" but the emitted wasm carries no wasi-threads ` +
          `contract (${shape}). WasmEdge cannot spawn guest threads without it; this build must not ship.`,
      );
    }
    return facts;
  }

  if (facts.threadSpawnImport) {
    throw new Error(
      `${label} declares threadModel ${JSON.stringify(threadModel)} but the emitted wasm IMPORTS ` +
        `${facts.threadSpawnImport} (${shape}). It is a threaded guest; declare "emscripten-pthreads".`,
    );
  }
  if (threadModel === "single-thread" && facts.sharedMemory) {
    throw new Error(
      `${label} declares threadModel "single-thread" but the emitted wasm has a SHARED memory (${shape}). ` +
        'That is the wasm32-wasip1-threads lane — declare "wasi-sequential" (with a ' +
        "manifest.sequentialJustification) or \"emscripten-pthreads\".",
    );
  }
  return facts;
}
