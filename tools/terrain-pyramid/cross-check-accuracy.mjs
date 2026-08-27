// DOES THE RECORD'S OWN ACCURACY FIGURE SURVIVE A SECOND OPINION?
//
// $DTT.VERTICAL_ACCURACY_M is written by the encoder, from a probe inside the
// encoder, using the encoder's own sampler — and the density ladder is selected
// by that same number. So it marks its own homework twice over, and when the
// probe was wrong the record and the gate that read it were wrong TOGETHER and
// agreed with each other perfectly. (They were: the probe evaluated three
// positions per cell at du == dv, all three on the split diagonal, and stated
// 4.496 m on a tile whose true worst departure is 290.5 m.)
//
// This joins the two things in the store that were produced by DIFFERENT
// measurements of the same tile:
//
//   * the record's stated VERTICAL_ACCURACY_M — the shipped mesh against every
//     SOURCE POST inside the tile, taken during encoding (coordinator
//     resolution 2026-08-27 (1));
//   * measure-accuracy.mjs's maxErrorM — the same shipped mesh against a
//     level+2 re-sample of the source, taken afterwards, from the record bytes,
//     through a separate decoder and a separate triangulation evaluator.
//
// WHAT THIS IS NOT, stated here and in the report it writes, because the
// headline number is what a reviewer reads. It is a SAMPLE — the highest-relief
// tiles per level plus one flat control, not the store — so its worst ratio is
// a sample maximum and never a bound on the field. And it is only a second
// opinion at all on levels where measure-accuracy.mjs's reference actually
// RESOLVES the 1-arcsecond source; the levels where it is coarser (z9 and
// shallower, where a child tile spans hundreds of arcseconds) are reported and
// excluded from the verdict rather than averaged in.
//
// They are not independent of the DECODER (both read the source through the
// same module) and this cannot see a decode, georeference or clamp error — the
// checks for those live in verify.mjs and in the module's granule-seam and
// band-boundary tests. What it CAN see is a probe that is blind to relief its
// own lattice does not carry, which is the failure this lane shipped.
//
// A ratio near 1.0 on the flat controls AND on the high-relief tiles is the
// result to want. A high-relief ratio far above 1 while the controls sit at 1
// is the signature of a probe that only looks where the terrain is smooth.
//
//   node tools/terrain-pyramid/cross-check-accuracy.mjs --out <store dir> [--json]
//
// Requires measure-accuracy.mjs to have been run against the same store.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (process.argv[i] === "--out") args.out = process.argv[++i];
  else if (process.argv[i] === "--json") args.json = true;
  else throw new Error(`unknown argument ${process.argv[i]}`);
}
if (!args.out) throw new Error("--out <store dir> is required");
const outDir = path.resolve(args.out);

// The record's own figure, read straight off the FlatBuffer.
function statedAccuracyByAddress(streamPath) {
  const buf = fs.readFileSync(streamPath);
  const out = new Map();
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    if (!length || offset + 4 + length > buf.length) break;
    const b = buf.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
    assert.equal(b.subarray(4, 8).toString("latin1"), "$DTT", "every record is a $DTT");
    const pos = b.readUInt32LE(0);
    const vtable = pos - b.readInt32LE(pos);
    const at = (id) => {
      const vo = 4 + 2 * id;
      if (vo >= b.readUInt16LE(vtable)) return 0;
      const o = b.readUInt16LE(vtable + vo);
      return o === 0 ? 0 : pos + o;
    };
    const u32 = (id) => { const p = at(id); return p ? b.readUInt32LE(p) : 0; };
    const f64 = (id) => { const p = at(id); return p ? b.readDoubleLE(p) : 0; };
    out.set(`${u32(3)}/${u32(4)}/${u32(5)}`, f64(23));
  }
  return out;
}

const stated = statedAccuracyByAddress(path.join(outDir, "tiles.dttstream"));
const accuracyPath = path.join(outDir, "accuracy-report.json");
if (!fs.existsSync(accuracyPath)) {
  throw new Error(`no accuracy-report.json in ${outDir}: run measure-accuracy.mjs against it first`);
}
const report = JSON.parse(fs.readFileSync(accuracyPath, "utf8"));

const rows = [];
for (const level of report.levels) {
  for (const tile of level.tiles) {
    const record = stated.get(tile.address);
    if (record === undefined) continue;
    rows.push({
      level: level.level,
      address: tile.address,
      role: tile.role,
      // Both directions in which the reference stops being a reference. Rows
      // carrying either flag are reported and excluded from the verdict.
      referenceOutResolvesSource: level.referenceOutResolvesSource,
      referenceUnderResolvesSource: level.referenceUnderResolvesSource,
      referencePostsPerTileEdge: level.referencePostsPerTileEdge,
      sourcePostsPerTileEdge: level.sourcePostsPerTileEdge,
      recordM: +record.toFixed(3),
      referenceM: tile.maxErrorM,
      ratio: +(tile.maxErrorM / Math.max(record, 1e-9)).toFixed(3),
    });
  }
}
const judged = rows.filter(
  (r) => !r.referenceOutResolvesSource && !r.referenceUnderResolvesSource,
);
const worst = judged.reduce((a, b) => (b.ratio > (a?.ratio ?? 0) ? b : a), null);
const summary = {
  outDir,
  recordAccuracyBasis: "source-posts",
  referencePostsPerTileEdgeByLevel: report.referencePostsPerTileEdgeByLevel ?? null,
  sourcePostsPerTileEdgeByLevel: report.sourcePostsPerTileEdgeByLevel ?? null,
  tilesInStore: rows.length,
  tilesCompared: judged.length,
  levelsExcluded: [...new Set(rows.filter((r) => !judged.includes(r)).map((r) => r.level))].sort(
    (a, b) => a - b,
  ),
  tilesWhereReferenceExceedsRecordBy5Percent: judged.filter((r) => r.ratio > 1.05).length,
  // NAMED so it cannot be read as a bound. It is the largest ratio among the
  // judged SAMPLE, and the sample is the highest-relief tiles per level plus a
  // flat control.
  worstRatioInSample: worst?.ratio ?? 0,
  worstRatio: worst?.ratio ?? 0,
  worstAt: worst?.address ?? null,
  limits: [
    "SAMPLE, NOT A BOUND: the tiles compared are measure-accuracy.mjs's highest-relief selection per level plus one flat control, so worstRatioInSample is the largest ratio observed on that sample and says nothing about the tiles outside it",
    "levels listed in levelsExcluded have a reference that does not resolve the 1-arcsecond source (too coarse) or over-resolves it (too fine); their rows are reported and not judged",
    "NOT INDEPENDENT OF THE DECODER: both sides read the source through the same module.wasm, so this cannot see a decode, georeference or clamp error — verify.mjs's shared-edge, missing-row, digest and clamp-counter checks are the structural evidence for those",
    "the record's own figure is measured at every source post inside the tile, so a ratio at or below 1.0 is the expected result and a ratio above 1.0 is the finding",
  ],
  rows,
};

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    `reference posts per tile edge by level ${JSON.stringify(summary.referencePostsPerTileEdgeByLevel)}\n`,
  );
  console.log("address           record m   reference m   ratio  role");
  for (const r of rows) {
    console.log(
      `${r.address.padEnd(16)} ${r.recordM.toFixed(3).padStart(9)} ${r.referenceM
        .toFixed(3)
        .padStart(13)} ${r.ratio.toFixed(3).padStart(7)}  ${r.role}` +
        (r.referenceOutResolvesSource
          ? "  [reference out-resolves the source; not judged]"
          : r.referenceUnderResolvesSource
            ? "  [reference under-resolves the source; not judged]"
            : ""),
    );
  }
  console.log(
    `\n${summary.tilesWhereReferenceExceedsRecordBy5Percent}/${summary.tilesCompared} judged tiles ` +
      `where the reference exceeds the record's own figure by more than 5%; worst ratio IN THIS ` +
      `SAMPLE ${summary.worstRatioInSample} at ${summary.worstAt}` +
      (summary.levelsExcluded.length
        ? ` (levels ${summary.levelsExcluded.join(", ")} not judged: the reference does not resolve the source there)`
        : ""),
  );
  for (const limit of summary.limits) console.log(`  limit: ${limit}`);
}
fs.writeFileSync(
  path.join(outDir, "cross-check-report.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
