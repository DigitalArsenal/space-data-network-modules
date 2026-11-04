// What the dist answers on every input the module's tests feed it, written to conformance/answers.json: per
// request its status and, per output, the SHA-256 of the bytes and the record or descriptor decoded by flatc
// with the pinned SDS schema (the fields on the wire, nothing defaulted). A rebuild that changes an answer
// shows in that file's diff.
//   node tests/answers.mjs
// The inputs are those of tests/parity.mjs (the KVN of each message and its NDM/XML twin, read; the record
// each one reads to, written as KVN and as NDM/XML; the refusals) and of tests/ndm_real_data.test.mjs
// (fixtures/real and, when this tree is whole, the 42 TraCSS OCMs of analysis/conjunction-assessment).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import createFlatc from "flatc-wasm/module";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { FORMAT, PORT, read, sha256, write } from "./lib/ndm_frames.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const wasmPath = path.join(root, "dist", "isomorphic", "module.wasm");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugin-manifest.json"), "utf8"));
const provenance = JSON.parse(fs.readFileSync(path.join(root, "dist", "build-provenance.json"), "utf8"));
const FIXTURES = path.join(root, "fixtures");
const STANDARDS = path.join(root, "node_modules", "spacedatastandards.org", "schema");
const SWEEP = path.join(root, "..", "..", "analysis", "conjunction-assessment", "tests", "fixtures", "aerospace-real-window", "ocm");

const FIXTURE_MESSAGES = [
  ["OMM", "ndm/ndm-omm-sgp4-covariance.kvn", "ndm/ndm-omm-sgp4-covariance.xml"],
  ["OMM", "ndm/ndm-omm-sgp4xp.kvn", "ndm/ndm-omm-sgp4xp.xml"],
  ["OEM", "ndm/ndm-oem-two-segments.kvn", "ndm/ndm-oem-two-segments.xml"],
  ["OPM", "ndm/ndm-opm-two-maneuvers.kvn", "ndm/ndm-opm-two-maneuvers.xml"],
  ["OCM", "ndm/ndm-ocm-blocks.kvn", "ndm/ndm-ocm-blocks.xml"],
  ["CDM", "ndm/ndm-cdm-full-covariance.kvn", "ndm/ndm-cdm-full-covariance.xml"],
  ["APM", "ndm/ndm-apm-states.kvn", "ndm/ndm-apm-states.xml"],
  ["ACM", "ndm/ndm-acm-blocks.kvn", "ndm/ndm-acm-blocks.xml"],
  ["RDM", "ndm/ndm-rdm-prediction.kvn", "ndm/ndm-rdm-prediction.xml"],
  ["AEM", "ccsds-504.0-B-2-figure-G-4-aem.txt", "ccsds-504.0-B-2-figure-G-4-aem.xml"],
  ["AEM", "ccsds-504.0-B-2-figure-G-5-aem-spinner.txt", "ccsds-504.0-B-2-figure-G-5-aem-spinner.xml"],
  ["TDM", "ccsds-503.0-B-2-figure-E-16-tdm-optical.txt", null],
  ["TDM", "ccsds-503.0-B-2-figure-E-17-tdm-radar.txt", "ccsds-503.0-B-2-figure-E-17-tdm-radar.xml"],
  ["TDM", "ccsds-503.0-B-2-figure-E-18-tdm-phase.txt", "ccsds-503.0-B-2-figure-E-18-tdm-phase.xml"],
];

// flatc and the pinned schema: the decoder, and the builder of the two records no message reads to.
const flatc = await createFlatc();
{
  const closure = [];
  const visit = (family) => {
    if (closure.includes(family)) return;
    closure.push(family);
    const text = fs.readFileSync(path.join(STANDARDS, family, "main.fbs"), "utf8");
    for (const m of text.matchAll(/^\s*include\s+"\.\.\/([A-Z0-9_]+)\/main\.fbs"/gm)) visit(m[1]);
  };
  for (const family of ["NCD", ...Object.keys(PORT)]) visit(family);
  for (const dir of ["/schemas", "/in", "/out"]) { try { flatc.FS.mkdir(dir); } catch { /* present */ } }
  for (const f of closure) {
    try { flatc.FS.mkdir(`/schemas/${f}`); } catch { /* present */ }
    flatc.FS.writeFile(`/schemas/${f}/main.fbs`, fs.readFileSync(path.join(STANDARDS, f, "main.fbs"), "utf8"));
  }
}
const plain = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return bytes.length >= 8 && view.getUint32(0, true) === bytes.length - 4 ? bytes.subarray(4) : bytes;
};
function json(type, bytes, defaults) {
  flatc.FS.writeFile("/in/record.bin", plain(bytes));
  const args = ["--no-warnings", "--json", "--strict-json", "--raw-binary", ...(defaults ? ["--defaults-json"] : []), "-o", "/out", "-I", "/schemas", `/schemas/${type}/main.fbs`, "--", "/in/record.bin"];
  if (flatc.callMain(args) !== 0) throw new Error(`flatc could not decode the ${type}`);
  return flatc.FS.readFile("/out/record.json", { encoding: "utf8" });
}
// The fields on the wire; a NaN or an infinity is kept as its name.
const decode = (type, bytes) => JSON.parse(json(type, bytes, false).replace(/(?<=[:\[,]\s*)(-?)(nan|inf)\b/g, '"$1$2"'));
// As tests/parity.mjs decodes a record to build another from it: every field, a NaN or an infinity as null.
const decodeAll = (type, bytes) => JSON.parse(json(type, bytes, true).replace(/\bnan\b/g, "null").replace(/\binf\b/g, "null"));
function build(type, json) {
  flatc.FS.writeFile("/in/build.json", JSON.stringify(json));
  if (flatc.callMain(["--no-warnings", "--binary", "-o", "/out", "-I", "/schemas", `/schemas/${type}/main.fbs`, "/in/build.json"]) !== 0) throw new Error("flatc build");
  return flatc.FS.readFile("/out/build.bin");
}

const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(wasmPath), manifest, surface: "direct" });
const records = {};
const cases = [];
const keep = (type, bytes) => {
  const key = sha256(bytes);
  records[key] ??= decode(type, bytes);
  return key;
};
async function answer(id, input, request) {
  const r = await h.invoke(request);
  const entry = { id, method: request.methodId, input, statusCode: r.statusCode };
  if (r.statusCode !== 0) Object.assign(entry, { errorCode: r.errorCode, errorMessage: r.errorMessage });
  entry.outputs = r.outputs.map((o) => {
    const bytes = new Uint8Array(o.payload);
    const type = o.typeRef.fileIdentifier.slice(1);
    const output = { port: o.portId, type: o.typeRef.fileIdentifier, wireFormat: o.typeRef.wireFormat ?? "flatbuffer", bytes: bytes.length, sha256: sha256(bytes) };
    if (type === "NCD") {
      const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
      output.descriptor = keep("NCD", bytes.subarray(0, 4 + n));
      if (bytes.length > 4 + n) output.body = { bytes: bytes.length - 4 - n, sha256: sha256(bytes.subarray(4 + n)) };
    } else {
      output.record = keep(type, bytes);
    }
    return output;
  });
  cases.push(entry);
  return r;
}
const recordOf = (r, type) => new Uint8Array(r.outputs.find((o) => o.portId === PORT[type]).payload);

for (const [type, kvnFile, xmlFile] of FIXTURE_MESSAGES) {
  const stem = path.basename(kvnFile).replace(/\.(kvn|txt)$/, "");
  const r = await answer(`read-${stem}-kvn`, kvnFile, read(type, fs.readFileSync(path.join(FIXTURES, kvnFile)), FORMAT[type][0]));
  const record = recordOf(r, type);
  await answer(`write-${stem}-kvn`, kvnFile, write(type, record));
  if (xmlFile) {
    await answer(`read-${stem}-xml`, xmlFile, read(type, fs.readFileSync(path.join(FIXTURES, xmlFile)), FORMAT[type][1]));
    await answer(`write-${stem}-xml`, kvnFile, write(type, record, FORMAT[type][1]));
  }
}
const real = [
  ...fs.readdirSync(path.join(FIXTURES, "real")).sort().map((f) => [`fixtures/real/${f}`, path.join(FIXTURES, "real", f)]),
  ...(fs.existsSync(SWEEP) ? fs.readdirSync(SWEEP).filter((f) => f.endsWith(".ocm")).sort().map((f) => [`analysis/conjunction-assessment/tests/fixtures/aerospace-real-window/ocm/${f}`, path.join(SWEEP, f)]) : []),
];
for (const [name, file] of real) {
  const bytes = fs.readFileSync(file);
  const type = /CCSDS_(\w+)_VERS/.exec(bytes.toString("utf8"))[1];
  const r = await answer(`read-${name}`, name, read(type, bytes, undefined));
  if (r.statusCode !== 0) continue;
  const record = recordOf(r, type);
  await answer(`write-${name}-kvn`, name, write(type, record));
  await answer(`write-${name}-xml`, name, write(type, record, FORMAT[type][1]));
}
{
  const ommFile = "ndm/ndm-omm-sgp4-covariance.kvn";
  const ommKvn = fs.readFileSync(path.join(FIXTURES, ommFile), "utf8");
  const ommXml = fs.readFileSync(path.join(FIXTURES, "ndm/ndm-omm-sgp4-covariance.xml"), "utf8");
  const ommRecord = recordOf(await h.invoke(read("OMM", Buffer.from(ommKvn), undefined)), "OMM");
  const refused = (id, request) => answer(`refused-${id}`, ommFile, request);
  await refused("read-wrong-message-kvn", read("OEM", Buffer.from(ommKvn), undefined));
  await refused("read-wrong-message-xml", read("OEM", Buffer.from(ommXml), undefined));
  await refused("read-malformed-xml", read("OMM", Buffer.from(ommXml.replace("</header>", "</heder>")), undefined));
  await refused("read-bad-number", read("OMM", Buffer.from(ommKvn.replace("ECCENTRICITY = 0.0003416", "ECCENTRICITY = O.0003416")), undefined));
  await refused("read-unknown-keyword", read("OMM", Buffer.from(ommKvn.replace("OBJECT_ID", "UNHEARD_OF = 1\nOBJECT_ID")), undefined));
  await refused("read-duplicate-keyword", read("OMM", Buffer.from(ommKvn.replace("CENTER_NAME = EARTH", "CENTER_NAME = EARTH\nCENTER_NAME = MOON")), undefined));
  await refused("read-missing-mandatory-keyword", read("OMM", Buffer.from(ommKvn.replace(/^REF_FRAME = .*\n/m, "")), undefined));
  await refused("read-two-messages", read("OMM", Buffer.from(`${ommKvn}\n${ommKvn}`), undefined));
  await refused("read-lone-stop-marker", read("OMM", Buffer.from(ommKvn.replace("MEAN_ELEMENT_THEORY = SGP/SGP4\n", "MEAN_ELEMENT_THEORY = SGP/SGP4\nMETA_STOP\n")), undefined));
  await refused("read-descriptor-for-another-format", read("OMM", Buffer.from(ommKvn), FORMAT.OEM[0]));
  await refused("write-record-without-object-name", write("OMM", build("OMM", { ...decodeAll("OMM", ommRecord), OBJECT_NAME: "" })));
  await refused("write-compact-oem", write("OEM", build("OEM", {
    CCSDS_OEM_VERS: 3.0, CREATION_DATE: "2026-10-11T00:00:00", ORIGINATOR: "TEST",
    EPHEMERIS_DATA_BLOCK: [{ CENTER_NAME: "EARTH", START_TIME: "2026-10-11T00:00:00", STOP_TIME: "2026-10-11T00:02:00", STEP_SIZE: 60, STATE_VECTOR_SIZE: 6,
      EPHEMERIS_DATA: [1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6] }],
  })));
  await refused("write-descriptor-for-another-message", write("OMM", ommRecord, FORMAT.OEM[1]));
}
await h.destroy();

const out = path.join(root, "conformance", "answers.json");
fs.writeFileSync(out, `${JSON.stringify({
  module: "files/ccsds-messages",
  version: manifest.version,
  spacedatastandards: provenance.spacedatastandards,
  artifactSha256: sha256(fs.readFileSync(wasmPath)),
  cases,
  records,
}, null, 1)}\n`);
console.log(`${path.relative(root, out)}: ${cases.length} requests, ${Object.keys(records).length} distinct records and descriptors`);
