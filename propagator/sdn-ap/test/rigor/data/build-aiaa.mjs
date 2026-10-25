#!/usr/bin/env node
// Builds data/aiaa-2006-6753.json from the two published files of Vallado, Crawford, Hujsak and Kelso (2006),
// "Revisiting Spacetrack Report #3", AIAA 2006-6753: SGP4-VER.TLE (the 33 verification sets, with each set's
// requested start, stop and step in minutes after column 69 of line 2) and tcppver.out (the published TEME
// states at every time the reference answered). Data only: no program of theirs is read or run.
//   node test/rigor/data/build-aiaa.mjs <SGP4-VER.TLE> <tcppver.out> > test/rigor/data/aiaa-2006-6753.json
import { createHash } from "node:crypto";
import fs from "node:fs";

const [tlePath, outPath] = process.argv.slice(2);
if (!tlePath || !outPath) { console.error("usage: build-aiaa.mjs <SGP4-VER.TLE> <tcppver.out>"); process.exit(2); }
const tleText = fs.readFileSync(tlePath, "utf8");
const outText = fs.readFileSync(outPath, "utf8");
const sha = (t) => createHash("sha256").update(t).digest("hex");

const sets = [];
const lines = tleText.split(/\r?\n/);
for (let i = 0; i < lines.length; i += 1) {
  if (!lines[i].startsWith("1 ") || !lines[i + 1]?.startsWith("2 ")) continue;
  const l1 = lines[i].slice(0, 69), l2full = lines[i + 1];
  const [start, stop, step] = l2full.slice(69).trim().split(/\s+/).map(Number);
  sets.push({ satnum: Number(l1.slice(2, 7)), lines: [l1, l2full.slice(0, 69)], request: { start, stop, step }, states: [] });
  i += 1;
}
let k = -1;
for (const row of outText.split(/\r?\n/)) {
  const words = row.trim().split(/\s+/);
  if (words[1] === "xx") { k += 1; if (sets[k].satnum !== Number(words[0])) throw new Error(`block ${k}: ${words[0]} is not ${sets[k].satnum}`); continue; }
  if (words.length < 7 || k < 0) continue;
  const [t, x, y, z, vx, vy, vz] = words.slice(0, 7).map(Number);
  sets[k].states.push({ t, r: [x, y, z], v: [vx, vy, vz] });
}
if (k + 1 !== sets.length) throw new Error(`${k + 1} output blocks for ${sets.length} sets`);
process.stdout.write(`${JSON.stringify({
  source: "Vallado, Crawford, Hujsak, Kelso (2006), Revisiting Spacetrack Report #3, AIAA 2006-6753: SGP4-VER.TLE and tcppver.out, the published verification inputs and outputs (data only; free use with citation, NOTICE.md)",
  inputs: { "SGP4-VER.TLE": sha(tleText), "tcppver.out": sha(outText) },
  units: "TEME km and km/s, minutes from each set's epoch",
  sets,
}, null, 1)}\n`);
