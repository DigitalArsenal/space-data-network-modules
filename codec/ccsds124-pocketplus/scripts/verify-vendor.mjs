/*
 * Vendored-source integrity + single-TU precondition gate.
 *
 * The CCSDS 124.0-B-1 conformance claim rests on the ESA-cross-validated
 * reference C executing UNMODIFIED inside the wasm artifact. This check proves
 * that before every build:
 *
 *  1. Every vendored file hashes to the value recorded in PROVENANCE.md.
 *  2. The amalgamation preconditions still hold on those bytes:
 *     - no duplicate `static` function names across the six sources
 *     - no heap (malloc/calloc/realloc/free/alloca)
 *     - no stdio / file I/O, no setjmp, no threads, no floating point
 *
 * (2) is re-derived from the source each run rather than trusted, so an
 * upstream bump that introduces a malloc or a name collision fails the build
 * instead of silently changing the module's behaviour.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const vendorRoot = fileURLToPath(new URL("../vendor/ccsds124/", import.meta.url));

const AMALGAMATED_SOURCES = [
  "src/bitvector.c",
  "src/bitbuffer.c",
  "src/mask.c",
  "src/encode.c",
  "src/compress.c",
  "src/decompress.c",
];

const BANNED = [
  { name: "heap allocation", pattern: /\b(?:malloc|calloc|realloc|alloca)\s*\(/ },
  { name: "heap free", pattern: /(?<![A-Za-z0-9_])free\s*\(/ },
  { name: "stdio", pattern: /#\s*include\s*<stdio\.h>|\b(?:printf|fprintf|fopen|fwrite|fread)\s*\(/ },
  { name: "setjmp/longjmp", pattern: /#\s*include\s*<setjmp\.h>|\b(?:setjmp|longjmp)\s*\(/ },
  { name: "threads", pattern: /#\s*include\s*<(?:pthread|threads)\.h>|\bpthread_[a-z_]+\s*\(/ },
  { name: "floating point", pattern: /(?<![A-Za-z0-9_])(?:double|float)(?![A-Za-z0-9_])/ },
  { name: "assert", pattern: /#\s*include\s*<assert\.h>|\bassert\s*\(/ },
];

const STATIC_FN = /^\s*static\s+(?:[A-Za-z_][A-Za-z0-9_]*\s+|\*\s*)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;

async function parseProvenanceHashes() {
  const text = await fs.readFile(path.join(vendorRoot, "PROVENANCE.md"), "utf8");
  const block = text.match(/```\n([\s\S]*?)```/);
  if (!block) {
    throw new Error("PROVENANCE.md does not contain the SHA-256 block.");
  }
  const hashes = new Map();
  for (const line of block[1].split("\n")) {
    const match = line.trim().match(/^([0-9a-f]{64})\s+(\S+)$/);
    if (match) hashes.set(match[2], match[1]);
  }
  if (hashes.size === 0) {
    throw new Error("PROVENANCE.md SHA-256 block parsed to zero entries.");
  }
  return hashes;
}

export async function verifyVendor({ quiet = true } = {}) {
  const failures = [];
  const expected = await parseProvenanceHashes();

  for (const [relative, want] of expected) {
    let bytes;
    try {
      bytes = await fs.readFile(path.join(vendorRoot, relative));
    } catch {
      failures.push(`vendored file is missing: ${relative}`);
      continue;
    }
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== want) {
      failures.push(
        `vendored file was MODIFIED: ${relative}\n  expected ${want}\n  actual   ${got}\n` +
          "  Vendored sources are byte-identical to upstream by law; see PROVENANCE.md.",
      );
    }
  }

  const staticNames = new Map();
  for (const relative of AMALGAMATED_SOURCES) {
    let source;
    try {
      source = await fs.readFile(path.join(vendorRoot, relative), "utf8");
    } catch {
      continue; // already reported above
    }

    for (const { name, pattern } of BANNED) {
      const hit = source.match(pattern);
      if (hit) {
        const line = source.slice(0, hit.index).split("\n").length;
        failures.push(
          `${relative}:${line} introduces ${name} (${JSON.stringify(hit[0])}), ` +
            "which the guest module contract forbids.",
        );
      }
    }

    for (const match of source.matchAll(STATIC_FN)) {
      const name = match[1];
      if (staticNames.has(name) && staticNames.get(name) !== relative) {
        failures.push(
          `static symbol "${name}" is defined in BOTH ${staticNames.get(name)} and ${relative}; ` +
            "the single-translation-unit amalgamation would collide.",
        );
      }
      staticNames.set(name, relative);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Vendored CCSDS 124.0-B-1 sources failed verification:\n - ${failures.join("\n - ")}`,
    );
  }
  if (!quiet) {
    console.log(
      `verify:vendor OK — ${expected.size} files hash-matched, ` +
        `${staticNames.size} static symbols collision-free, no banned constructs.`,
    );
  }
  return { files: expected.size, staticSymbols: staticNames.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await verifyVendor({ quiet: false });
}
