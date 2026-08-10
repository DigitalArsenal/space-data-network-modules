/**
 * THE RATCHET — a vector count can only grow, and a green row can never
 * silently become a known-red one.
 *
 * The failure mode this exists to stop is not malice, it is convenience: a
 * suite goes red, and the cheapest way to make it green is to delete the row or
 * to mark it `expectedToFail`. Both leave a green run and a worse module. So
 * `vectors/ratchet.json` records, per operation and per source library, how
 * many rows existed and how many of them were GREEN at the last deliberate
 * update — and this file refuses any state that is worse.
 *
 * The three rules, and what each one catches:
 *
 *   1. TOTAL COUNT PER OPERATION MAY NOT FALL. Catches a deleted row.
 *   2. GREEN COUNT PER OPERATION MAY NOT FALL. Catches a row demoted to
 *      `expectedToFail` to make a red suite green — the ONE way a defect gets
 *      hidden while every count still looks fine.
 *   3. EVERY KNOWN-RED ROW NAMES A DEFECT. Catches a marker with no owner,
 *      which is how "we know about it" turns into "nobody is fixing it".
 *
 * Raising the ratchet is deliberate and visible: run
 * `node vectors/tools/update-ratchet.mjs`, which rewrites the file from the
 * current vector set and prints the delta. It never lowers a number.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { loadVectors } from "../vectors/index.mjs";
import { summariseVectors } from "../vectors/tools/ratchet-lib.mjs";

const RATCHET_PATH = new URL("../vectors/ratchet.json", import.meta.url);

const vectors = await loadVectors();
const ratchet = JSON.parse(await readFile(RATCHET_PATH, "utf8"));
const observed = summariseVectors(vectors);

test("no operation lost a vector", () => {
  for (const [operation, recorded] of Object.entries(ratchet.byOperation)) {
    const now = observed.byOperation[operation];
    assert.ok(
      now,
      `operation ${operation} had ${recorded.total} vectors and now has none. ` +
        "A vector once earned is not deleted; if the operation is gone, lower the " +
        "ratchet deliberately in the same commit that removes it.",
    );
    assert.ok(
      now.total >= recorded.total,
      `${operation}: ${now.total} vectors, ratchet says ${recorded.total}. ` +
        "Vectors are a ratchet — the count only grows.",
    );
    assert.ok(
      now.green >= recorded.green,
      `${operation}: ${now.green} GREEN vectors, ratchet says ${recorded.green}. ` +
        "A row was demoted to expected-to-fail, or a green row was deleted. " +
        "Either way a defect just became invisible while the total stayed put.",
    );
  }
});

test("no source library lost a vector", () => {
  for (const [library, recorded] of Object.entries(ratchet.byLibrary)) {
    const now = observed.byLibrary[library] ?? { total: 0, green: 0 };
    assert.ok(
      now.total >= recorded.total,
      `${library}: ${now.total} vectors, ratchet says ${recorded.total}`,
    );
    assert.ok(
      now.green >= recorded.green,
      `${library}: ${now.green} green vectors, ratchet says ${recorded.green}`,
    );
  }
});

test("every known-red row names the defect that owns it", () => {
  for (const testCase of vectors.cases) {
    if (!testCase.expectedToFail) continue;
    const defect = testCase.expectedToFail.defect;
    assert.ok(
      typeof defect === "string" && defect.length > 20,
      `${testCase.id}: expected-to-fail with no defect description`,
    );
    assert.ok(
      /modules-|the plane-change split/.test(defect),
      `${testCase.id}: the defect description names no graph task. A known-red row ` +
        "whose defect nobody owns is a disabled test with extra steps.",
    );
  }
});

test("the ratchet file is not stale in the direction that hides a regression", () => {
  // The ratchet may lag BEHIND reality (more vectors than recorded is fine and
  // is the normal state between updates). It may never lead it, which would
  // mean somebody raised the numbers without the rows to back them — checked by
  // the two tests above — and it must always account for every operation that
  // currently carries rows, so that a NEW operation cannot arrive unratcheted.
  for (const operation of Object.keys(observed.byOperation)) {
    assert.ok(
      ratchet.byOperation[operation],
      `operation ${operation} carries vectors but is absent from the ratchet. ` +
        "Run `node vectors/tools/update-ratchet.mjs` so the new rows are protected.",
    );
  }
});
