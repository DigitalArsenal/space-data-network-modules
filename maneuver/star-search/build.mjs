/*
 * Build the Star interplanetary broad-search module.
 *
 * Toolchain is the SDK's enforced clang wasm32-wasip1-threads path, selected by
 * threadModel "emscripten-pthreads" (the SDK's name for wasi-threads). emcc
 * -pthread is a browser-only trap and is never used here.
 *
 * THREADED, deliberately — unlike codec/ccsds124-pocketplus, which is
 * inherently sequential. The Lambert batch row solves and the leg/flyby
 * database construction are row-independent; the upstream Python reference
 * already marks the same kernels @njit(parallel=True). See the family README
 * and graph task mod-maneuver-star-search for the justification.
 *
 * SINGLE TRANSLATION UNIT: compileModuleFromSource() compiles exactly ONE guest
 * TU from a source STRING, so the core is amalgamated here by concatenation
 * rather than by -I include paths. Order is declared explicitly in
 * src/amalgamation.json (headers before sources, dependency order within each);
 * local quoted #includes are stripped because the text is prepended instead.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileModuleFromSource } from "space-data-module-sdk/compiler";

import { verifyVendor } from "./scripts/verify-vendor.mjs";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
const srcRoot = path.join(packageRoot, "src");
const distRoot = path.join(packageRoot, "dist");
const outputPath = path.join(distRoot, "isomorphic", "module.wasm");
const standardsRoot = fileURLToPath(
  new URL("../../../spacedatastandards.org/", import.meta.url),
);

process.env.SPACE_DATA_STANDARDS_ROOT ??= standardsRoot;

// Guest stack. The SDK default is 64 KiB, which is not enough for the Lambert
// batch solver's frames; must be a multiple of 16 and within 64 KiB..1 GiB.
const STACK_SIZE_BYTES = 4 * 1024 * 1024;

// Strip only local quoted self-includes; angle-bracket system includes stay.
const LOCAL_INCLUDE = /^\s*#\s*include\s+"[^"]+"\s*$/gm;

function stripLocalInclude(source, label) {
  return [
    `/* ==== BEGIN ${label} ==== */`,
    source.replace(LOCAL_INCLUDE, `/* (local include inlined by build.mjs) */`),
    `/* ==== END ${label} ==== */`,
  ].join("\n");
}

/**
 * Amalgamation order. An explicit src/amalgamation.json is authoritative:
 *   { "order": ["core/vec3.hpp", "core/lambert.hpp", "core/lambert.cpp", ...] }
 * Without it, fall back to every .hpp/.h (sorted) then every .cpp/.cc (sorted),
 * which is only correct for order-independent sources — the explicit list is
 * what a real build should carry.
 */
async function resolveAmalgamationOrder() {
  const explicitPath = path.join(srcRoot, "amalgamation.json");
  try {
    const raw = JSON.parse(await fs.readFile(explicitPath, "utf8"));
    if (Array.isArray(raw?.order) && raw.order.length > 0) {
      return { order: raw.order, explicit: true };
    }
  } catch {
    /* fall through to discovery */
  }

  const found = [];
  async function walk(dir, prefix = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
      } else {
        found.push(rel);
      }
    }
  }
  await walk(srcRoot);

  const isHeader = (f) => /\.(hpp|h|inc)$/.test(f);
  const isSource = (f) => /\.(cpp|cc|cxx)$/.test(f);
  return {
    order: [...found.filter(isHeader), ...found.filter(isSource)],
    explicit: false,
  };
}

await verifyVendor({ quiet: false });

const manifestPath = path.join(packageRoot, "plugin-manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

const { order, explicit } = await resolveAmalgamationOrder();
if (order.length === 0) {
  throw new Error(
    `No sources found under ${srcRoot}. The C++ core must land before build.mjs can run.`,
  );
}
if (!explicit) {
  console.warn(
    "WARNING: src/amalgamation.json is missing — falling back to " +
      "headers-then-sources discovery order. Declare the order explicitly.",
  );
}

const parts = [];
for (const rel of order) {
  const abs = path.join(srcRoot, rel);
  parts.push(stripLocalInclude(await fs.readFile(abs, "utf8"), `src/${rel}`));
}
const sourceCode = parts.join("\n\n");

await fs.rm(distRoot, { recursive: true, force: true });
await fs.mkdir(path.dirname(outputPath), { recursive: true });

const compilation = await compileModuleFromSource({
  manifest,
  sourceCode,
  language: "cpp",
  threadModel: "emscripten-pthreads",
  stackSize: STACK_SIZE_BYTES,
  outputPath,
});

await fs.copyFile(manifestPath, path.join(distRoot, "plugin-manifest.json"));

if (!compilation.report?.ok) {
  const issues = JSON.stringify(compilation.report?.issues ?? [], null, 2);
  throw new Error(`Compiled artifact failed SDK validation:\n${issues}`);
}

console.log(
  `Built ${path.relative(packageRoot, outputPath)} via ${compilation.compiler} ` +
    `(threadModel=${compilation.threadModel}, shared-memory=${Boolean(
      compilation.threadFeatures?.sharedMemory,
    )}, stack=${STACK_SIZE_BYTES}B, units=${order.length})`,
);
