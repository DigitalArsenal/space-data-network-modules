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
//   * the record's stated VERTICAL_ACCURACY_M — the shipped mesh against the
//     lattice the plan sampled, taken during encoding;
//   * measure-accuracy.mjs's maxErrorM — the same shipped mesh against a
//     level+2 re-sample of the source (257 posts across the parent's edge),
//     taken afterwards, from the record bytes, through a separate decoder and
//     a separate triangulation evaluator.
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
      // The reference over-resolves the source at the deepest levels, which the
      // harness flags; those rows are reported and excluded from the verdict.
      referenceOutResolvesSource: level.referenceOutResolvesSource,
      recordM: +record.toFixed(3),
      referenceM: tile.maxErrorM,
      ratio: +(tile.maxErrorM / Math.max(record, 1e-9)).toFixed(3),
    });
  }
}
const judged = rows.filter((r) => !r.referenceOutResolvesSource);
const worst = judged.reduce((a, b) => (b.ratio > (a?.ratio ?? 0) ? b : a), null);
const summary = {
  outDir,
  referencePostsPerTileEdge: report.referencePostsPerTileEdge,
  tilesCompared: judged.length,
  tilesWhereReferenceExceedsRecordBy5Percent: judged.filter((r) => r.ratio > 1.05).length,
  worstRatio: worst?.ratio ?? 0,
  worstAt: worst?.address ?? null,
  rows,
};

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`reference = level+2 (${report.referencePostsPerTileEdge} posts per tile edge)\n`);
  console.log("address           record m   reference m   ratio  role");
  for (const r of rows) {
    console.log(
      `${r.address.padEnd(16)} ${r.recordM.toFixed(3).padStart(9)} ${r.referenceM
        .toFixed(3)
        .padStart(13)} ${r.ratio.toFixed(3).padStart(7)}  ${r.role}` +
        (r.referenceOutResolvesSource ? "  [reference out-resolves the source; not judged]" : ""),
    );
  }
  console.log(
    `\n${summary.tilesWhereReferenceExceedsRecordBy5Percent}/${summary.tilesCompared} judged tiles ` +
      `where the reference exceeds the record's own figure by more than 5%; worst ratio ` +
      `${summary.worstRatio} at ${summary.worstAt}`,
  );
}
fs.writeFileSync(
  path.join(outDir, "cross-check-report.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
