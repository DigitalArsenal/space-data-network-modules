// Writes the NDM/XML twin of every KVN fixture in fixtures/ndm and of the AEM and TDM
// fixtures, with the module itself (write_<m> with an $NCD naming the XML format):
//
//   node fixtures/make-ndm-xml.mjs           (after `npm run build`)
//
// The twins are committed only after every one validates against the NDM/XML 4.0.0
// schemas (tests/ndm_xsd.test.mjs does that when the schemas are at hand), so a twin is
// a document an independent validator accepts, not just what the writer happened to say.
// The messages are synthetic (see PROVENANCE.md); the twins are as synthetic as their KVN.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as flatbuffers from "flatbuffers";
import { NCD } from "spacedatastandards.org/lib/js/NCD/NCD.js";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

// ncdContainerFormat (NCD.fbs): the CCSDS_<M>_XML members.
const XML_FORMAT = { OEM: 8, AEM: 10, TDM: 12, OMM: 14, OPM: 16, OCM: 18, CDM: 20, APM: 22, ACM: 24, RDM: 26 };
const PORT = { OMM: "elements", OEM: "ephemeris", OPM: "state", OCM: "orbit", CDM: "conjunction", APM: "attitude_state", ACM: "attitude_data", RDM: "reentry", AEM: "attitude", TDM: "tracking" };

const FILES = [
  ...fs.readdirSync(path.join(here, "ndm")).filter((f) => f.endsWith(".kvn")).map((f) => [path.join("ndm", f), f.split("-")[1].toUpperCase()]),
  ["ccsds-504.0-B-2-figure-G-4-aem.txt", "AEM"],
  ["ccsds-504.0-B-2-figure-G-5-aem-spinner.txt", "AEM"],
  // Figure E-16 has no twin: its CREATION_DATE has no seconds, which the NDM/XML schema's
  // time pattern does not accept, and the engine states epochs exactly as the file wrote them.
  ["ccsds-503.0-B-2-figure-E-17-tdm-radar.txt", "TDM"],
  ["ccsds-503.0-B-2-figure-E-18-tdm-phase.txt", "TDM"],
];

function ncdFrame(bytes, format) {
  const b = new flatbuffers.Builder(512);
  const sha = bytes ? b.createString(createHash("sha256").update(bytes).digest("hex")) : 0;
  NCD.startNCD(b);
  if (format !== undefined) NCD.addFormat(b, format);
  if (bytes) { NCD.addSourceByteLength(b, BigInt(bytes.length)); NCD.addSourceSha256(b, sha); }
  NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  const d = b.asUint8Array();
  if (!bytes) return d;
  const f = new Uint8Array(d.length + bytes.length);
  f.set(d); f.set(bytes, d.length);
  return f;
}
const ncdInput = (portId, f) => ({ portId, typeRef: { schemaName: "NCD.fbs", fileIdentifier: "$NCD", rootTypeName: "NCD", wireFormat: "aligned-binary", requiredAlignment: 8, byteLength: f.byteLength }, payload: f });
const recordInput = (portId, family, p) => ({ portId, typeRef: { schemaName: `${family}.fbs`, fileIdentifier: `$${family}`, rootTypeName: family, wireFormat: "aligned-binary", requiredAlignment: 8, byteLength: p.byteLength }, payload: p });

const h = await createBrowserModuleHarness({
  wasmSource: fs.readFileSync(path.join(root, "dist", "isomorphic", "module.wasm")),
  manifest: JSON.parse(fs.readFileSync(path.join(root, "plugin-manifest.json"), "utf8")),
  surface: "direct",
});
for (const [file, type] of FILES) {
  const kvn = fs.readFileSync(path.join(here, file));
  const method = type.toLowerCase();
  const read = await h.invoke({ methodId: `read_${method}`, inputs: [ncdInput("message", ncdFrame(kvn))] });
  if (read.statusCode !== 0) throw new Error(`${file}: read_${method}: ${read.errorCode}: ${read.errorMessage}`);
  const record = read.outputs.find((o) => o.portId === PORT[type]).payload;
  const written = await h.invoke({ methodId: `write_${method}`, inputs: [recordInput(PORT[type], type, record), ncdInput("descriptor", ncdFrame(undefined, XML_FORMAT[type]))] });
  if (written.statusCode !== 0) throw new Error(`${file}: write_${method}: ${written.errorCode}: ${written.errorMessage}`);
  const frame = written.outputs[0].payload;
  const n = new DataView(frame.buffer, frame.byteOffset).getUint32(0, true);
  const out = path.join(here, file.replace(/\.(kvn|txt)$/, ".xml"));
  fs.writeFileSync(out, Buffer.from(frame.subarray(4 + n)));
  console.log("wrote", path.relative(root, out));
}
await h.destroy();
