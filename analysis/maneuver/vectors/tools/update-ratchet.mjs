#!/usr/bin/env node
/**
 * RAISE THE RATCHET — deliberately, visibly, and only upward.
 *
 * Reads the current vector set, prints the delta against the committed ratchet,
 * and writes the new floor. It REFUSES to lower any number: a count that fell
 * means a vector was deleted or demoted, and the fix for that is to restore the
 * vector, not to lower the bar that noticed.
 *
 * The one legitimate reason a count falls — an operation genuinely removed from
 * the module — takes `--allow-lower <reason>`, which is recorded in the file so
 * the next reader can see who lowered it and why.
 *
 * Usage:
 *   node vectors/tools/update-ratchet.mjs
 *   node vectors/tools/update-ratchet.mjs --allow-lower "solveLambertMinDV withdrawn in 0.3.0"
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { summariseVectors } from "./ratchet-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = path.resolve(HERE, "..", "vectors.json");
const RATCHET = path.resolve(HERE, "..", "ratchet.json");

const argv = process.argv.slice(2);
const allowLowerIndex = argv.indexOf("--allow-lower");
const allowLower = allowLowerIndex >= 0 ? argv[allowLowerIndex + 1] : null;

const vectors = JSON.parse(await readFile(VECTORS, "utf8"));
const observed = summariseVectors(vectors);
const previous = existsSync(RATCHET)
  ? JSON.parse(await readFile(RATCHET, "utf8"))
  : { byOperation: {}, byLibrary: {} };

const regressions = [];
for (const [group, key] of [
  [previous.byOperation ?? {}, "byOperation"],
  [previous.byLibrary ?? {}, "byLibrary"],
]) {
  for (const [name, recorded] of Object.entries(group)) {
    const now = observed[key][name] ?? { total: 0, green: 0 };
    if (now.total < recorded.total) {
      regressions.push(`${key}/${name}: total ${recorded.total} -> ${now.total}`);
    }
    if (now.green < recorded.green) {
      regressions.push(`${key}/${name}: GREEN ${recorded.green} -> ${now.green}`);
    }
  }
}

if (regressions.length > 0 && !allowLower) {
  process.stderr.write(
    "REFUSING to lower the ratchet:\n  " +
      regressions.join("\n  ") +
      "\n\nA count that fell means a vector was deleted or marked expected-to-fail. " +
      "Restore the vector, or — if an operation was genuinely withdrawn — re-run " +
      'with --allow-lower "<reason>", which is recorded in the file.\n',
  );
  process.exit(1);
}

const payload = {
  "//":
    "THE RATCHET. Vector counts may only grow, and the GREEN count may only " +
    "grow — a row demoted to expected-to-fail fails tests/ratchet.test.mjs even " +
    "though the total is unchanged. Raise with vectors/tools/update-ratchet.mjs.",
  updated: new Date().toISOString(),
  total: observed.total,
  green: observed.green,
  byOperation: observed.byOperation,
  byLibrary: observed.byLibrary,
  ...(allowLower
    ? {
        loweredDeliberately: {
          reason: allowLower,
          entries: regressions,
          at: new Date().toISOString(),
        },
      }
    : previous.loweredDeliberately
      ? { loweredDeliberately: previous.loweredDeliberately }
      : {}),
};

await writeFile(RATCHET, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

const before = previous.total ?? 0;
process.stderr.write(
  `ratchet: ${before} -> ${observed.total} vectors ` +
    `(${observed.green} green, ${observed.total - observed.green} known-red)\n`,
);
for (const [operation, counts] of Object.entries(observed.byOperation)) {
  const was = previous.byOperation?.[operation];
  const delta = was ? counts.total - was.total : counts.total;
  process.stderr.write(
    `  ${operation}: ${counts.total} (${counts.green} green, ${counts.knownRed} known-red)` +
      `${delta ? ` [${delta > 0 ? "+" : ""}${delta}]` : ""}\n`,
  );
}
