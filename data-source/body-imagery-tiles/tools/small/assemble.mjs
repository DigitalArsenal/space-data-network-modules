// A level of an encoded pyramid back into one gray raster (PGM, north up), from the files under --dir: the check of the encode
// and the input of the registration test.   node tools/small/assemble.mjs --dir DIR --naif N --level L --out file.pgm
import fs from "node:fs";
import path from "node:path";

import jpeg from "jpeg-js";

import { readFile } from "./runner.mjs";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? undefined : process.argv[i + 1]; };
export function assemble(dir, naif, level) {
  const across = 2 << level, down = 1 << level, W = across * 256, H = down * 256, px = Buffer.alloc(W * H);
  const seen = new Set();
  const take = (file) => {
    for (const t of readFile(fs.readFileSync(file))) {
      if (t.LEVEL() !== level) continue;
      const x = t.X(), yNorth = down - 1 - t.Y();
      const img = jpeg.decode(Buffer.from(t.PAYLOAD().bytesArray()), { useTArray: true, formatAsRGBA: true });
      for (let r = 0; r < 256; r++) for (let c = 0; c < 256; c++) { const o = 4 * (r * 256 + c); px[(yNorth * 256 + r) * W + x * 256 + c] = Math.round((img.data[o] + img.data[o + 1] + img.data[o + 2]) / 3); }
      seen.add(`${x}_${t.Y()}`);
    }
  };
  if (level <= 2) take(path.join(dir, `imagery/${naif}/root.dtts`));
  else for (let y = 0; y < down; y++) for (let x16 = 0; x16 < across / 16; x16++) take(path.join(dir, `imagery/${naif}/${level}/${x16}_${y}.dtts`));
  if (seen.size !== across * down) throw new Error(`level ${level}: ${seen.size} of ${across * down} tiles`);
  return { W, H, px };
}
if (process.argv[1] && process.argv[1].endsWith("assemble.mjs")) {
  const { W, H, px } = assemble(path.resolve(arg("dir")), Number(arg("naif")), Number(arg("level")));
  fs.writeFileSync(arg("out"), Buffer.concat([Buffer.from(`P5\n${W} ${H}\n255\n`), px]));
  console.log(`${W}x${H}`);
}
