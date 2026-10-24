// Robustness: a damaged RINEX observation file is REFUSED BY NAME or read, and the module never traps. Seeded.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mutator } from "../../orbit-products/tests/lib/mutate.mjs";
import { NCD_TYPE, frame, harness, input } from "../../orbit-products/tests/lib/ncd_frames.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ready = fs.existsSync(path.join(root, "dist", "isomorphic", "module.wasm"));

test("damaged RINEX observation files are refused by name or read, never a trap", { skip: !ready }, async () => {
  const h = await harness(root);
  const text = fs.readFileSync(path.join(root, "fixtures", "WTZR00DEU_R_20250190000_01D_30S_MO.first20.rnx"), "latin1");
  let pos = 0;
  for (let k = 0; k < 3; k++) pos = text.indexOf("\n>", pos + 1);
  const base = Uint8Array.from(Buffer.from(text.slice(0, pos + 1), "latin1"));
  const mutate = mutator(31);
  let read = 0;
  let refused = 0;
  for (let i = 0; i < 600; i++) {
    const r = await h.invoke({ methodId: "read_observations", inputs: [input("container", NCD_TYPE, frame(mutate(base), { formatName: "rinex-obs", declareHash: false }))] });
    if (r.statusCode === 0) read++;
    else {
      assert.ok(typeof r.errorCode === "string" && r.errorCode.length > 0, `#${i}: a failure with no name`);
      refused++;
    }
  }
  assert.equal(read + refused, 600);
  assert.ok(refused > 300, `${refused} refused`);
});
