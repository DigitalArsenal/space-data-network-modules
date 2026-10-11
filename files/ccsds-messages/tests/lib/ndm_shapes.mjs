// Records of shapes no fixture has, written as NDM/XML by the built module, for ndm_xsd.test.mjs.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import createFlatc from "flatc-wasm/module";
import { NCD } from "spacedatastandards.org/lib/js/NCD/NCD.js";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const STANDARDS = path.join(root, "node_modules", "spacedatastandards.org", "schema");

function descriptor(format) {
  const b = new flatbuffers.Builder(128);
  NCD.startNCD(b);
  NCD.addFormat(b, format);
  NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  return b.asUint8Array();
}
const ncd = (f) => ({ portId: "descriptor", typeRef: { schemaName: "NCD.fbs", fileIdentifier: "$NCD", rootTypeName: "NCD", wireFormat: "aligned-binary", requiredAlignment: 8, byteLength: f.byteLength }, payload: f });

export async function writeShapes() {
  const flatc = await createFlatc();
  const closure = [];
  const visit = (family) => {
    if (closure.includes(family)) return;
    closure.push(family);
    const text = fs.readFileSync(path.join(STANDARDS, family, "main.fbs"), "utf8");
    for (const m of text.matchAll(/^\s*include\s+"\.\.\/([A-Z0-9_]+)\/main\.fbs"/gm)) visit(m[1]);
  };
  visit("OCM");
  for (const dir of ["/schemas", "/in", "/out"]) { try { flatc.FS.mkdir(dir); } catch { /* present */ } }
  for (const f of closure) {
    try { flatc.FS.mkdir(`/schemas/${f}`); } catch { /* present */ }
    flatc.FS.writeFile(`/schemas/${f}/main.fbs`, fs.readFileSync(path.join(STANDARDS, f, "main.fbs"), "utf8"));
  }
  const build = (json) => {
    flatc.FS.writeFile("/in/r.json", JSON.stringify(json));
    if (flatc.callMain(["--no-warnings", "--binary", "-o", "/out", "-I", "/schemas", "/schemas/OCM/main.fbs", "/in/r.json"]) !== 0) throw new Error("flatc");
    return flatc.FS.readFile("/out/r.bin");
  };
  const h = await createBrowserModuleHarness({
    wasmSource: fs.readFileSync(path.join(root, "dist", "isomorphic", "module.wasm")),
    manifest: JSON.parse(fs.readFileSync(path.join(root, "plugin-manifest.json"), "utf8")),
    surface: "direct",
  });
  try {
    const frame = (bytes) => ({ portId: "orbit", typeRef: { schemaName: "OCM.fbs", fileIdentifier: "$OCM", rootTypeName: "OCM", wireFormat: "aligned-binary", requiredAlignment: 8, byteLength: bytes.byteLength }, payload: bytes });
    const shapes = [];
    const states = build({
      HEADER: { CCSDS_OCM_VERS: "3.0", CREATION_DATE: "2026-10-11T00:00:00", ORIGINATOR: "TEST" },
      METADATA: { OBJECT_NAME: "SEVERAL", TIME_SYSTEM: "UTC", EPOCH_TZERO: "2026-10-11T12:00:00" },
      TRAJ_TYPE: "CARTESIAN_PV", STATE_VECTOR_SIZE: 6, STATE_STEP_SIZE: 60,
      STATE_DATA: [7000, 0, 0, 0, 7.5, 1, 7001, 450, 60, -0.1, 7.49, 1.01, 7003, 900, 120, -0.2, 7.47, 1.02],
      CENTER_NAME: "EARTH", TRAJ_REF_FRAME: { NAME: "GCRF" },
    });
    const r = await h.invoke({ methodId: "write_ocm", inputs: [frame(states), ncd(descriptor(18))] });
    if (r.statusCode !== 0) throw new Error(`${r.errorCode}: ${r.errorMessage}`);
    const f = r.outputs[0].payload;
    const n = new DataView(f.buffer, f.byteOffset).getUint32(0, true);
    shapes.push(["ocm-several-states-by-step", Buffer.from(f.subarray(4 + n)).toString("utf8")]);
    return shapes;
  } finally {
    await h.destroy();
  }
}
