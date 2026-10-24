// Robustness: a Sentinel EOF, a CK or an SCLK kernel that has been damaged is REFUSED BY NAME or read, and the
// module never traps. Seeded, so a failure replays; 21,000 mutations of the same shape were run once at
// authoring time with two seeds and no trap (the count here is what a gauntlet can afford).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mutator } from "./lib/mutate.mjs";
import { NCD_TYPE, frame, harness, input } from "./lib/ncd_frames.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIX = path.join(root, "fixtures", "interchange");
const ready = fs.existsSync(path.join(root, "dist", "isomorphic", "module.wasm"));
const bytes = (name) => new Uint8Array(fs.readFileSync(path.join(FIX, name)));
const ITERATIONS = 300;

async function fuzz(h, label, seed, make, base) {
  const mutate = mutator(seed);
  let read = 0;
  let refused = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const data = mutate(base);
    const r = await h.invoke(make(data));
    if (r.statusCode === 0) read++;
    else {
      assert.equal(typeof r.errorCode, "string", `${label} #${i}: a failure with no name`);
      assert.ok(r.errorCode.length > 0, `${label} #${i}: a failure with no name`);
      refused++;
    }
  }
  assert.equal(read + refused, ITERATIONS);
  assert.ok(refused > ITERATIONS / 4, `${label}: the mutations should mostly be refused, not read (${refused} refused)`);
}

test("damaged Sentinel EOF files are refused by name or read, never a trap", { skip: !ready }, async () => {
  const h = await harness(root);
  const text = fs.readFileSync(path.join(FIX, "S1A_AUX_RESORB_V20240109_excerpt.EOF"), "utf8");
  let end = 0;
  for (let k = 0; k < 30; k++) end = text.indexOf("      </OSV>\n", end) + 14;
  const small = new TextEncoder().encode(`${text.slice(0, end).replace(/count="\d+"/, 'count="30"')}    </List_of_OSVs>\n  </Data_Block>\n</Earth_Explorer_File>\n`);
  await fuzz(h, "eof", 11, (d) => ({ methodId: "normalize_sentinel_eof", inputs: [input("container", NCD_TYPE, frame(d, { formatName: "sentinel-eof", declareHash: false }))] }), small);
});

test("damaged CK and SCLK kernels are refused by name or read, never a trap", { skip: !ready }, async () => {
  const h = await harness(root);
  const clock = bytes("MSL_76_SCLKSCET.00019.tsc");
  for (const [seed, ck] of [[21, "msl_ra_straight_v1.bc"], [22, "msl_surf_rover_tlm_0179_0269_v1.bc"]]) {
    await fuzz(h, `ck ${ck}`, seed, (d) => ({ methodId: "normalize_naif_ck", inputs: [
      input("container", NCD_TYPE, frame(d, { formatName: "naif-ck", declareHash: false })),
      input("sclk", NCD_TYPE, frame(clock, { formatName: "naif-sclk" }))] }), bytes(ck));
  }
  await fuzz(h, "sclk", 23, (d) => ({ methodId: "normalize_naif_ck", inputs: [
    input("container", NCD_TYPE, frame(bytes("msl_ra_straight_v1.bc"), { formatName: "naif-ck" })),
    input("sclk", NCD_TYPE, frame(d, { formatName: "naif-sclk", declareHash: false }))] }), clock);
});
