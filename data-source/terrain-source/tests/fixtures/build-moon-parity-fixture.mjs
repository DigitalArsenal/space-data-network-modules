// Regenerates the Moon cases of the tri-runtime parity fixture: tests/fixtures/parity/moon-* and the moon-* cases of
// tests/fixtures/terrain-parity.json (the Earth cases are build-parity-fixture.mjs's and are left as they are).
//
// The products are SYNTHETIC but shaped exactly like LOLA's (a PDS3 label and whole-line float32 ranges): a global
// simple-cylindrical grid at 2 pixels/degree and a south polar stereographic grid of 512 x 512 posts at 2 km, on the
// 1737.4 km sphere, heights a smooth analytic function. Small enough to commit; the real products are exercised by
// tests/moon-body.test.mjs and tests/pds-img.test.mjs. Deterministic: the same bytes every run.
//
//   node tests/fixtures/build-moon-parity-fixture.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { encodeModuleConfig } from "space-data-module-sdk/runtime-contracts";

import { granuleFrame, planInputs, typeRefOf } from "../helpers.mjs";
import { moonPlan } from "../../lola-frames.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const outDir = path.join(here, "parity");
const fixturePath = path.join(here, "terrain-parity.json");

function label({ projection, lines, samples, ppd, scaleM, centerLat, centerLon }) {
  const map = projection === "SIMPLE CYLINDRICAL"
    ? ` MAP_RESOLUTION               = ${ppd} <pix/deg>\n MAP_SCALE                    = ${(1737.4 * Math.PI) / 180 / ppd} <km/pix>\n`
    : ` MAP_RESOLUTION               = 1 <pix/deg>\n MAP_SCALE                    = ${scaleM} <m/pix>\n`;
  return `PDS_VERSION_ID            = "PDS3"
PRODUCT_ID                = "SYNTHETIC_PARITY"
DESCRIPTION               = "A synthetic product shaped like the LOLA GDR
   float images, for the tri-runtime parity fixture."
OBJECT                    = UNCOMPRESSED_FILE
FILE_RECORDS              = ${lines}
RECORD_BYTES              = ${samples * 4}
  OBJECT                  = IMAGE
    LINES                 = ${lines}
    LINE_SAMPLES          = ${samples}
    SAMPLE_TYPE           = PC_REAL
    SAMPLE_BITS           = 32
    UNIT                  = KILOMETER
    SCALING_FACTOR        = 1
    OFFSET                = 1737.4
  END_OBJECT              = IMAGE
END_OBJECT                = UNCOMPRESSED_FILE
OBJECT                    = IMAGE_MAP_PROJECTION
 MAP_PROJECTION_TYPE          = "${projection}"
${map} A_AXIS_RADIUS                = 1737.4 <km>
 B_AXIS_RADIUS                = 1737.4 <km>
 C_AXIS_RADIUS                = 1737.4 <km>
 POSITIVE_LONGITUDE_DIRECTION = "EAST"
 CENTER_LATITUDE              = ${centerLat} <deg>
 CENTER_LONGITUDE             = ${centerLon} <deg>
 LINE_PROJECTION_OFFSET       = ${lines / 2 - 0.5} <pix>
 SAMPLE_PROJECTION_OFFSET     = ${samples / 2 - 0.5} <pix>
END_OBJECT                    = IMAGE_MAP_PROJECTION
END
`;
}

// Whole lines [first, first + count) of a samples-wide float32 km image, as a 206 with its Content-Range.
function range(samples, lines, first, count, height) {
  const body = Buffer.alloc(count * samples * 4);
  for (let l = 0; l < count; l++) for (let s = 0; s < samples; s++) body.writeFloatLE(height(first + l, s), (l * samples + s) * 4);
  const start = first * samples * 4;
  return granuleFrame("dem", body, 206, { url: "https://pds.test/synthetic.img", headers: { "content-range": `bytes ${start}-${start + body.length - 1}/${lines * samples * 4}` } });
}

const write = (name, bytes) => { fs.writeFileSync(path.join(outDir, name), bytes); return `parity/${name}`; };
const input = (portId, file) => ({ portId, payloadFile: file, typeRef: typeRefOf(fs.readFileSync(path.join(here, file))) });

const cases = [];
const files = {};
// 1. Global simple cylindrical, 2 pixels/degree: level-4 tile 4/10/7 (latitudes -11.25..0) needs lines ~176-205.
{
  const [lines, samples] = [360, 720];
  const lbl = granuleFrame("dem", Buffer.from(label({ projection: "SIMPLE CYLINDRICAL", lines, samples, ppd: 2, centerLat: 0, centerLon: 180 })), 200);
  const dem = range(samples, lines, 170, 42, (l, s) => 0.8 * Math.sin(s / 17) + 0.5 * Math.cos(l / 9));
  const [plan, options] = planInputs(moonPlan([{ level: 4, x: 10, y: 7 }, { level: 4, x: 11, y: 7 }], { maxLevel: 4 }));
  files.cyl = [input("plan", write("moon-cyl-plan.dtt", plan.payload)), input("options", write("moon-cyl-options.mcfg", options.payload)),
    input("dem", write("moon-cyl-label.hrsp", lbl.payload)), input("dem", write("moon-cyl-range.hrsp", dem.payload))];
  cases.push({ id: "moon-tile-cylindrical", expect: "ok", request: { methodId: "tile", inputs: files.cyl } });
}
// 2. South polar stereographic, 512 posts at 2 km (to about 73 S): level-6 tile 6/64/0 at the pole.
{
  const [n, scale] = [512, 2000];
  const lbl = granuleFrame("dem", Buffer.from(label({ projection: "POLAR STEREOGRAPHIC", lines: n, samples: n, scaleM: scale, centerLat: -90, centerLon: 0 })), 200);
  const dem = range(n, n, 200, 112, (l, s) => 1.2 * Math.sin(s / 23) * Math.cos(l / 31));
  const [plan, options] = planInputs(moonPlan([{ level: 6, x: 64, y: 0 }], { maxLevel: 6 }));
  const inputs = [input("plan", write("moon-polar-plan.dtt", plan.payload)), input("options", write("moon-polar-options.mcfg", options.payload)),
    input("dem", write("moon-polar-label.hrsp", lbl.payload)), input("dem", write("moon-polar-range.hrsp", dem.payload))];
  cases.push({ id: "moon-tile-polar", expect: "ok", request: { methodId: "tile", inputs } });
}
// 3. pack over the cylindrical case's records, as the shipped artifact encodes them.
{
  const root = path.join(here, "..", "..");
  const harness = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(path.join(root, "dist/isomorphic/module.wasm")),
    manifest: JSON.parse(fs.readFileSync(path.join(root, "plugin-manifest.json"), "utf8")),
    surface: "direct",
  });
  const inputs = files.cyl.map((i) => ({ portId: i.portId, typeRef: i.typeRef, payload: new Uint8Array(fs.readFileSync(path.join(here, i.payloadFile))) }));
  const response = await harness.invoke({ methodId: "tile", inputs });
  if (response.statusCode !== 0) throw new Error(`${response.errorCode}: ${response.errorMessage}`);
  const records = response.outputs.find((o) => o.portId === "records").payload;
  harness.destroy();
  cases.push({ id: "moon-pack", expect: "ok", request: { methodId: "pack", inputs: [
    input("records", write("moon-records.dtt", Buffer.from(records))),
    input("options", write("moon-pack-options.mcfg", encodeModuleConfig({ pathPrefix: "terrain/301", rootMaxLevel: 2 }))),
  ] } });
}

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
fixture.cases = [...fixture.cases.filter((c) => !c.id.startsWith("moon-")), ...cases];
fs.writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`moon parity cases: ${cases.map((c) => c.id).join(", ")}`);
