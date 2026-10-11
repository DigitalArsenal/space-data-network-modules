// ndm_real_data.test.mjs — messages that producers actually wrote.
//
// fixtures/real/ holds byte-for-byte copies of three of the OCMs of the TraCSS conjunction assessment
// verification dataset (CC0) and NASA's public ISS OEM (public domain); fixtures/PROVENANCE.md says where
// they came from. When this module sits in the whole repository, every one of the 42 OCMs the conjunction
// assessment module keeps from that dataset is read and written the same way.
//
// For each: the module reads it; the descriptor says what the file said (TraCSS spells its version
// `502.0-B-3`, the standard `3.0`); the record written as KVN and as NDM/XML reads back as the very same
// record, and writing that again changes nothing. The NDM/XML is validated against the schemas when they
// are at hand: TraCSS states `TRAJ_BASIS = OPERATIONAL`, which the standard's enumeration does not have,
// so the XML the module writes for those OCMs fails on that element and on no other.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { privatePath, privateSkip } from "../../../tests/lib/privateFixtures.mjs";
import { KVN_FORMAT, PORT, XML_FORMAT, descriptorOf, ncdInput, ok, out, read, sha256, split, write } from "./lib/ndm_frames.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");
const WASM_PATH = path.join(packageRoot, "dist", "isomorphic", "module.wasm");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(packageRoot, "plugin-manifest.json"), "utf8"));
const REAL = path.join(packageRoot, "fixtures", "real");
const SWEEP = path.join(packageRoot, "..", "..", "analysis", "conjunction-assessment", "tests", "fixtures", "aerospace-real-window", "ocm");
const MASTER = "files/ccsds-messages/fixtures/xsd/ndmxml-4.0.0-master-4.0.xsd";

const skip = !fs.existsSync(WASM_PATH) && "run `npm run build` first";
const hasXmllint = spawnSync("xmllint", ["--version"], { stdio: "ignore" }).status === 0;
const xsdSkip = (!hasXmllint && "xmllint is not installed") || privateSkip(MASTER);

const typeOf = (text) => /CCSDS_(\w+)_VERS/.exec(text)[1];
async function harness(t) {
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM_PATH), manifest: MANIFEST, surface: "direct" });
  t.after(() => h.destroy());
  return h;
}

// What the module does with one real message; returns the text it wrote in each syntax.
async function throughTheModule(h, bytes) {
  const type = typeOf(Buffer.from(bytes).toString("utf8"));
  const first = ok(await h.invoke(read(type, bytes, undefined)));
  const record = out(first, PORT[type]);
  const d = descriptorOf(out(first, "descriptor"));
  assert.equal(d.FORMAT(), KVN_FORMAT(type));
  assert.equal(d.SOURCE_SHA256(), sha256(bytes));

  const asKvn = ok(await h.invoke(write(type, record)));
  const kvnFrame = out(asKvn, "message");
  const again = ok(await h.invoke({ methodId: `read_${type.toLowerCase()}`, inputs: [ncdInput("message", kvnFrame)] }));
  assert.deepEqual(Buffer.from(out(again, PORT[type])), Buffer.from(record), "the KVN it wrote is another record");
  const rewritten = ok(await h.invoke(write(type, out(again, PORT[type]))));
  assert.deepEqual(Buffer.from(out(rewritten, "message")), Buffer.from(kvnFrame), "writing it again changed it");

  const asXml = ok(await h.invoke(write(type, record, XML_FORMAT(type))));
  const xmlFrame = out(asXml, "message");
  const back = ok(await h.invoke({ methodId: `read_${type.toLowerCase()}`, inputs: [ncdInput("message", xmlFrame)] }));
  assert.deepEqual(Buffer.from(out(back, PORT[type])), Buffer.from(record), "the XML it wrote is another record");
  return { type, descriptor: d, kvn: Buffer.from(split(kvnFrame).body).toString("utf8"), xml: Buffer.from(split(xmlFrame).body).toString("utf8") };
}

function validate(xml) {
  const dir = mkdtempSync(path.join(tmpdir(), "ndm-real-"));
  try {
    const file = path.join(dir, "message.xml");
    writeFileSync(file, xml);
    const r = spawnSync("xmllint", ["--noout", "--schema", privatePath(MASTER), file], { encoding: "utf8" });
    return { ok: r.status === 0, errors: `${r.stdout}${r.stderr}`.split("\n").filter((l) => /Schemas validity error/.test(l)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const name of fs.readdirSync(REAL).sort()) {
  test(`${name}: read, written as KVN and as NDM/XML, and read back as the very same record`, { skip }, async (t) => {
    const h = await harness(t);
    const bytes = fs.readFileSync(path.join(REAL, name));
    const { type, descriptor, kvn } = await throughTheModule(h, bytes);
    if (type === "OCM") {
      assert.equal(descriptor.FORMAT_VERSION(), "502.0-B-3", "the descriptor says what the file said");
      assert.match(kvn, /^CCSDS_OCM_VERS = 3\.0\n/, "what is written is the standard's version");
      assert.match(kvn, /^TRAJ_BASIS = OPERATIONAL$/m, "a value outside the enumeration is kept as the file wrote it");
    } else {
      assert.equal(type, "OEM");
      assert.equal(descriptor.FORMAT_VERSION(), "2.0");
      assert.equal(descriptor.NATIVE_FRAME_NAME(), "EME2000");
      assert.equal(descriptor.NATIVE_TIME_SYSTEM(), "UTC");
    }
  });

  test(`${name}: the NDM/XML written for it is valid against the NDM/XML 4.0.0 schemas, but for the value the standard does not have`, { skip: skip || xsdSkip || undefined }, async (t) => {
    const h = await harness(t);
    const { type, xml } = await throughTheModule(h, fs.readFileSync(path.join(REAL, name)));
    const result = validate(xml);
    if (type === "OEM") {
      assert.ok(result.ok, result.errors.join("\n"));
      return;
    }
    assert.ok(!result.ok);
    assert.ok(result.errors.length > 0 && result.errors.every((e) => /Element 'TRAJ_BASIS': .*'OPERATIONAL'/.test(e)), result.errors.join("\n"));
    assert.ok(validate(xml.replaceAll("OPERATIONAL", "PREDICTED")).ok, "with that one value corrected the XML is valid");
  });
}

test("every OCM the conjunction assessment module keeps from the TraCSS dataset is read and written the same way", { skip: skip || (!fs.existsSync(SWEEP) && "the conjunction assessment fixtures are not in this tree") || undefined }, async (t) => {
  const h = await harness(t);
  const files = fs.readdirSync(SWEEP).filter((f) => f.endsWith(".ocm")).sort();
  assert.ok(files.length >= 40, `${files.length} files`);
  for (const f of files) {
    const { kvn } = await throughTheModule(h, fs.readFileSync(path.join(SWEEP, f)));
    assert.match(kvn, /^CCSDS_OCM_VERS = 3\.0\n/, f);
  }
});
