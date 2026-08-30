#!/usr/bin/env node
/**
 * Amalgamate the vendored ERFA into ONE translation unit.
 *
 * WHY THIS EXISTS. The acceptance for gmat-08 is that there is exactly ONE
 * IAU-2006/2000A chain in the tree and that the shipped frames module agrees
 * with `higherpop/frames.hpp` to 1e-14. That is only true by construction if
 * both reach the SAME series evaluation. The SDK compiles a module from a
 * single source string, so the alternative would have been to re-derive or
 * truncate the series inside the module — which is precisely the "undocumented
 * second answer" the acceptance forbids. Amalgamating the vendored sources
 * keeps one implementation and makes the WASM module and the native parity
 * harness provably the same arithmetic.
 *
 * WHAT IS EXCLUDED, and why:
 *   t_erfa_c.c, t_erfa_c_extra.c  ERFA's own test drivers; they define main().
 *   erfaversion.c                 reads PACKAGE_VERSION from the autotools
 *                                 build config, which we do not run.
 *
 * ERFA is BSD-3 (higherpop/third_party/erfa), derived with permission from
 * IAU SOFA. Nothing here modifies the numerics: the only edits are dropping
 * the per-file `#include "erfa*.h"` lines, because the headers are emitted
 * once ahead of the bodies in the same unit.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL(".", import.meta.url));
export const ERFA_ROOT = path.resolve(
  packageRoot,
  "..",
  "..",
  "higherpop",
  "third_party",
  "erfa",
);

const EXCLUDED = new Set(["t_erfa_c.c", "t_erfa_c_extra.c", "erfaversion.c"]);
const LOCAL_ERFA_INCLUDE = /^#include\s+"erfa[a-z]*\.h"\s*$/gm;

export async function composeErfaTranslationUnit(erfaRoot = ERFA_ROOT) {
  const entries = (await fs.readdir(erfaRoot))
    .filter((name) => name.endsWith(".c") && !EXCLUDED.has(name))
    .sort();
  if (entries.length < 100) {
    throw new Error(
      `vendored ERFA looks incomplete at ${erfaRoot}: ${entries.length} sources`,
    );
  }

  const headerNames = ["erfa.h", "erfam.h", "erfaextra.h", "erfadatextra.h"];
  const headers = await Promise.all(
    headerNames.map((name) => fs.readFile(path.join(erfaRoot, name), "utf8")),
  );

  const bodies = [];
  for (const name of entries) {
    const body = (await fs.readFile(path.join(erfaRoot, name), "utf8")).replace(
      LOCAL_ERFA_INCLUDE,
      "",
    );
    bodies.push(`/* ===== vendored ERFA: ${name} ===== */\n${body}`);
  }

  const source = [
    "// Vendored ERFA (BSD-3, derived with permission from IAU SOFA), amalgamated",
    "// by foundation/frames/erfa-amalgamation.mjs. Numerics unmodified.",
    'extern "C" {',
    ...headers.map((header) => header.replace(LOCAL_ERFA_INCLUDE, "")),
    ...bodies,
    "}  // extern \"C\"",
  ].join("\n");

  return {
    source,
    fileCount: entries.length,
    relativeRoot: path.relative(packageRoot, erfaRoot),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { fileCount, source } = await composeErfaTranslationUnit();
  console.error(`${fileCount} ERFA sources, ${source.length} bytes`);
}
