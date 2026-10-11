// ndm_module.test.mjs — the compiled module, INVOKED, on the ten CCSDS messages.
//
// Each of the module's twenty methods is called through the SDK browser harness the
// way a flow calls it: the frame is a size-prefixed $NCD followed by the message's
// exact bytes, the record is the SDS record of the message, and nothing the test
// checks is a function of the guest's own bookkeeping.
//
// The measurements, per message:
//   - read_<m> of the KVN fixture and of its NDM/XML twin give the SAME record, and the
//     descriptor states what the file said (syntax, version, originator, creation date,
//     the SHA-256 of the bytes read, which node:crypto computes independently);
//   - write_<m> as KVN and as XML emits a frame read_<m> accepts and reads back to that
//     record; the XML is the committed twin byte for byte;
//   - the record, decoded with flatc and the pinned SDS schema (a decoder the module does
//     not share a line with), states what the message stated: the numbers, the lists, the
//     units the record keeps, the explicit zeros.
// And the refusals: a message that is not the one asked for, a descriptor that does not
// describe its bytes, XML that is not XML, a number that is not a number, two messages in
// one file, a record that cannot be written without time arithmetic.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as flatbuffers from "flatbuffers";
import createFlatc from "flatc-wasm/module";
import { NCD } from "spacedatastandards.org/lib/js/NCD/NCD.js";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");
const WASM_PATH = path.join(packageRoot, "dist", "isomorphic", "module.wasm");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(packageRoot, "plugin-manifest.json"), "utf8"));
const STANDARDS = path.join(packageRoot, "node_modules", "spacedatastandards.org", "schema");
const FIXTURES = path.join(packageRoot, "fixtures");
const built = fs.existsSync(WASM_PATH);
const skip = !built && "run `npm run build` first";

// ncdContainerFormat (NCD.fbs): the CCSDS_<M>_KVN and CCSDS_<M>_XML members.
const FORMAT = {
  OEM: [7, 8], AEM: [9, 10], TDM: [11, 12], OMM: [13, 14], OPM: [15, 16],
  OCM: [17, 18], CDM: [19, 20], APM: [21, 22], ACM: [23, 24], RDM: [25, 26],
};
const PORT = {
  OMM: "elements", OEM: "ephemeris", OPM: "state", OCM: "orbit", CDM: "conjunction",
  APM: "attitude_state", ACM: "attitude_data", RDM: "reentry", AEM: "attitude", TDM: "tracking",
};
const KVN_FORMAT = (type) => FORMAT[type][0];
const XML_FORMAT = (type) => FORMAT[type][1];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// flatc prints a double with as few as three significant digits; the record holds all seventeen,
// and the exact digits are asserted on the text the module writes (the exact-digits test below).
const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) <= 5e-3 * Math.abs(expected), `${message ?? ""} ${actual} is not ${expected}`);

function ncdFrame(bytes, format, { declare = true } = {}) {
  const b = new flatbuffers.Builder(512);
  const sha = bytes && declare ? b.createString(sha256(bytes)) : 0;
  NCD.startNCD(b);
  if (format !== undefined) NCD.addFormat(b, format);
  if (bytes && declare) {
    NCD.addSourceByteLength(b, BigInt(bytes.length));
    NCD.addSourceSha256(b, sha);
  }
  NCD.finishSizePrefixedNCDBuffer(b, NCD.endNCD(b));
  const d = b.asUint8Array();
  if (!bytes) return d;
  const f = new Uint8Array(d.length + bytes.length);
  f.set(d);
  f.set(bytes, d.length);
  return f;
}
const ncdInput = (portId, f) => ({ portId, typeRef: { schemaName: "NCD.fbs", fileIdentifier: "$NCD", rootTypeName: "NCD", wireFormat: "aligned-binary", requiredAlignment: 8, byteLength: f.byteLength }, payload: f });
const recordInput = (type, p) => ({ portId: PORT[type], typeRef: { schemaName: `${type}.fbs`, fileIdentifier: `$${type}`, rootTypeName: type, wireFormat: "aligned-binary", requiredAlignment: 8, byteLength: p.byteLength }, payload: p });
const out = (response, port) => {
  const f = response.outputs.find((o) => o.portId === port);
  assert.ok(f, `no output on ${port}; got ${response.outputs.map((o) => o.portId)}`);
  return f.payload;
};
function split(frame) {
  const n = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
  const bb = new flatbuffers.ByteBuffer(frame.subarray(0, 4 + n));
  bb.setPosition(4);
  return { descriptor: NCD.getRootAsNCD(bb), body: frame.subarray(4 + n) };
}
function descriptorOf(payload) {
  const bb = new flatbuffers.ByteBuffer(payload);
  bb.setPosition(4);
  return NCD.getRootAsNCD(bb);
}

async function harness(t) {
  const h = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM_PATH), manifest: MANIFEST, surface: "direct" });
  t.after(() => h.destroy());
  return h;
}

// -- a decoder that shares nothing with the module: flatc and the SDS schema --------------
let flatc = null;
async function decode(type, record) {
  if (!flatc) {
    flatc = await createFlatc();
    const closure = [];
    const visit = (family) => {
      if (closure.includes(family)) return;
      closure.push(family);
      const text = fs.readFileSync(path.join(STANDARDS, family, "main.fbs"), "utf8");
      for (const m of text.matchAll(/^\s*include\s+"\.\.\/([A-Z0-9_]+)\/main\.fbs"/gm)) visit(m[1]);
    };
    for (const f of Object.keys(PORT)) visit(f);
    for (const dir of ["/schemas", "/in", "/out"]) { try { flatc.FS.mkdir(dir); } catch { /* present */ } }
    for (const f of closure) {
      try { flatc.FS.mkdir(`/schemas/${f}`); } catch { /* present */ }
      flatc.FS.writeFile(`/schemas/${f}/main.fbs`, fs.readFileSync(path.join(STANDARDS, f, "main.fbs"), "utf8"));
    }
  }
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const bytes = view.getUint32(0, true) === record.length - 4 ? record.subarray(4) : record;
  flatc.FS.writeFile("/in/record.bin", bytes);
  const rc = flatc.callMain(["--no-warnings", "--json", "--strict-json", "--raw-binary", "--defaults-json", "-o", "/out", "-I", "/schemas", `/schemas/${type}/main.fbs`, "--", "/in/record.bin"]);
  assert.equal(rc, 0, `flatc could not decode the ${type}`);
  const text = flatc.FS.readFile("/out/record.json", { encoding: "utf8" });
  return JSON.parse(text.replace(/\bnan\b/g, "null").replace(/\binf\b/g, "null"));
}
async function build(type, json) {
  await decode(type, new Uint8Array(0)).catch(() => undefined); // initialise the schema tree
  flatc.FS.writeFile("/in/build.json", JSON.stringify(json));
  const rc = flatc.callMain(["--no-warnings", "--binary", "-o", "/out", "-I", "/schemas", `/schemas/${type}/main.fbs`, "/in/build.json"]);
  assert.equal(rc, 0, `flatc could not build the ${type}`);
  return flatc.FS.readFile("/out/build.bin");
}

// -- the fixtures -------------------------------------------------------------------------
const MESSAGES = [
  { type: "OMM", kvn: "ndm/ndm-omm-sgp4-covariance.kvn", xml: "ndm/ndm-omm-sgp4-covariance.xml", version: "3.0", originator: "SDN-TEST", created: "2026-10-11T14:07:31", system: "UTC", frame: "TEME",
    check: (j) => {
      assert.equal(j.MEAN_MOTION, 1.0027379);
      assert.equal(j.ECCENTRICITY, 0.0003416);
      assert.equal(j.NORAD_CAT_ID, 26824);
      assert.equal(j.COVARIANCE.length, 21);
      near(j.COVARIANCE[0], 3.331349476038534e-04);
      near(j.COVARIANCE[20], 1.563219823411253e-10);
      assert.equal(j.CLASSIFICATION, "UNCLASSIFIED");
      assert.equal(j.MESSAGE_ID, "OMM-0001");
      assert.equal(j.REFERENCE_FRAME.NAME, "TEME");
      assert.equal(j.USER_DEFINED_EARTH_MODEL, "WGS-84");
      assert.deepEqual(j.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]), [["CONSOLE_POC", "MAXWELL RAFERTY"]]);
      assert.equal(j.COMMENT.split("\n").length, 5, "the five COMMENT lines of the message, in one field, in order");
    } },
  { type: "OMM", kvn: "ndm/ndm-omm-sgp4xp.kvn", xml: "ndm/ndm-omm-sgp4xp.xml", version: "3.0", originator: "SDN-TEST", created: "2026-10-11T14:07:31", system: "UTC", frame: "TEME",
    check: (j) => {
      assert.equal(j.MEAN_ELEMENT_THEORY, "SGP4XP");
      assert.equal(j.SEMI_MAJOR_AXIS, 7000.5);
      assert.equal(j.BSTAR, 0.02, "BTERM is carried in BSTAR");
      assert.equal(j.MEAN_MOTION_DDOT, 0.011, "AGOM is carried in MEAN_MOTION_DDOT");
      assert.equal(j.NORAD_CAT_ID, 100000);
    } },
  { type: "OEM", kvn: "ndm/ndm-oem-two-segments.kvn", xml: "ndm/ndm-oem-two-segments.xml", version: "3.0", originator: "SDN-TEST", created: "2026-10-11T14:07:31", system: "UTC", frame: "EME2000",
    check: (j) => {
      assert.equal(j.EPHEMERIS_DATA_BLOCK.length, 2);
      const [a, b] = j.EPHEMERIS_DATA_BLOCK;
      assert.equal(a.EPHEMERIS_DATA_LINES.length, 4);
      assert.equal(b.EPHEMERIS_DATA_LINES.length, 2);
      assert.equal(a.EPHEMERIS_DATA_LINES[2].Z, 7000);
      assert.equal(a.EPHEMERIS_DATA_LINES[2].X_DDOT, 0.001);
      assert.equal(a.EPHEMERIS_DATA_LINES[0].EPOCH, "2026-10-11T12:00:00.000000");
      assert.equal(a.COVARIANCE_MATRIX_LINES.length, 2, "one COVARIANCE_START block holds both matrices");
      near(a.COVARIANCE_MATRIX_LINES[0].CZ_DOT_Z_DOT, 1.563219823411253e-10);
      assert.equal(a.COVARIANCE_MATRIX_LINES[0].COV_REFERENCE_FRAME.NAME, "RTN");
      assert.equal(a.COVARIANCE_MATRIX_LINES[1].EPOCH, "2026-10-11T12:06:00.000000");
      assert.equal(a.COVARIANCE_MATRIX_LINES[1].COV_REFERENCE_FRAME ?? null, null, "the second matrix names no frame of its own");
      assert.equal(a.COVARIANCE_MATRIX_LINES[1].COMMENT, "the second matrix of the same segment, in the segment's own frame");
      assert.equal(a.OBJECT.OBJECT_NAME, "EXAMPLESAT 1");
      assert.equal(a.INTERPOLATION_DEGREE, 7);
      assert.equal(a.STEP_SIZE, 0, "the compact form is never produced");
    } },
  { type: "OPM", kvn: "ndm/ndm-opm-two-maneuvers.kvn", xml: "ndm/ndm-opm-two-maneuvers.xml", version: "3.0", originator: "SDN-TEST", created: "2026-10-11T14:07:31", system: "UTC",
    check: (j) => {
      assert.equal(j.X, 6503.514);
      assert.equal(j.SEMI_MAJOR_AXIS, 41399.5123);
      assert.equal(j.TRUE_ANOMALY, 41.2);
      assert.equal(j.COVARIANCE.length, 21);
      assert.equal(j.MANEUVERS.length, 2);
      assert.equal(j.MANEUVERS[0].MAN_DV_1, -0.0233);
      assert.equal(j.MANEUVERS[0].COMMENT, "First maneuver");
      assert.equal(j.MANEUVERS[1].MAN_REF_FRAME, "RTN");
      assert.equal(j.USER_DEFINED_PARAMETERS[0].PARAM_NAME, "EARTH_MODEL");
    } },
  { type: "OCM", kvn: "ndm/ndm-ocm-blocks.kvn", xml: "ndm/ndm-ocm-blocks.xml", version: "3.0", originator: "SDN-TEST", created: "2026-10-11T14:07:31", system: "UTC",
    check: (j) => {
      assert.equal(j.TRAJECTORY_BLOCKS.length, 2);
      assert.equal(j.TRAJECTORY_BLOCKS[0].LINES.length, 2);
      assert.equal(j.TRAJECTORY_BLOCKS[1].TRAJ_TYPE, "CARTPVA");
      // The first block, a CARTPV with absolute epochs, is also the single-trajectory fields
      // analysis/od and analysis/vcm-adapter read.
      assert.equal(j.TRAJ_TYPE, "CARTESIAN_PV");
      assert.equal(j.STATE_VECTOR_SIZE, 6);
      assert.equal(j.STATE_DATA.length, 12);
      assert.deepEqual(j.STATE_EPOCHS, ["2026-10-11T14:28:25.1172", "2026-10-11T14:38:25.1172"]);
      assert.equal(j.STATE_DATA[0], 2854.5);
      assert.equal(j.CENTER_NAME, "EARTH");
      assert.equal(j.COVARIANCE_BLOCKS.length, 1);
      assert.equal(j.COVARIANCE_DATA.length, 21);
      assert.equal(j.COV_SIZE, 6);
      assert.equal(j.MANEUVER_DATA.length, 1);
      assert.equal(j.MANEUVER_DATA[0].DATA.length, 2);
      assert.deepEqual(j.MANEUVER_DATA[0].MAN_COMPOSITION, ["TIME_RELATIVE", "DV_X", "DV_Y", "DV_Z"]);
      assert.deepEqual(j.PERTURBATIONS.N_BODY_PERTURBATIONS, ["MOON", "SUN"]);
      assert.equal(j.ORBIT_DETERMINATION.OD_OBSERVATIONS_USED, 579);
      assert.equal(j.PHYSICAL_PROPERTIES.RCS, 0, "a stated zero is a stated zero");
      assert.deepEqual(j.METADATA.ALTERNATE_NAMES, ["EXAMPLE ONE", "EX-1"]);
    } },
  { type: "CDM", kvn: "ndm/ndm-cdm-full-covariance.kvn", xml: "ndm/ndm-cdm-full-covariance.xml", version: "1.0", originator: "SDN-TEST", created: "2026-10-11T14:07:31.000", system: null,
    check: (j) => {
      // The message states metres, the record kilometres, and the shift is exact.
      assert.equal(j.MISS_DISTANCE, 0.715);
      assert.equal(j.RELATIVE_SPEED, 14.762);
      assert.equal(j.RELATIVE_POSITION_N, 0.7118);
      assert.equal(j.OBJECT1.COVARIANCE.length, 45);
      assert.equal(j.OBJECT2.COVARIANCE.length, 21);
      assert.equal(j.OBJECT1.COVARIANCE[0], 1.25e-9, "0.00125 m**2 is 1.25e-9 km**2");
      assert.equal(j.OBJECT1.COVARIANCE[44], 0.05625, "the thrust cells are as the message states them");
      assert.equal(j.OBJECT1.OBJECT_DESIGNATOR, "12345");
      assert.equal(j.OBJECT1.OBJECT.NORAD_CAT_ID, 12345);
      assert.equal(j.OBJECT1.MANEUVERABLE, "YES");
      assert.equal(j.OBJECT2.MANEUVERABLE, "NO");
      assert.equal(j.OBJECT1.POC.EMAIL, "OPS@EXAMPLE.ORG");
      assert.equal(j.OBJECT2.OBJECT.OBJECT_TYPE, "DEBRIS");
      assert.equal(j.OBJECT1.X, 2570.097065, "positions are kilometres in both");
    } },
  { type: "APM", kvn: "ndm/ndm-apm-states.kvn", xml: "ndm/ndm-apm-states.xml", version: "2.0", originator: "EXAMPLE-AGENCY", created: "2026-02-14T19:23:57", system: "UTC",
    check: (j) => {
      assert.equal(j.QUATERNION_STATES.length, 2);
      assert.equal(j.QUATERNION_STATES[0].Q1_DOT, 0, "a derivative stated as zero is stored as zero");
      assert.equal(j.QUATERNION_STATES[0].Q3_DOT, -0.00002);
      assert.ok(!("Q1_DOT" in j.QUATERNION_STATES[1]) || j.QUATERNION_STATES[1].Q1_DOT === null, "no derivative stated, none stored");
      assert.equal(j.EULER_ANGLE_STATES[0].EULER_ROT_SEQ, "YXY");
      assert.equal(j.EULER_ANGLE_STATES[0].ANGLE_2_DOT, 0);
      assert.equal(j.ANGULAR_VELOCITIES.length, 1);
      assert.equal(j.SPIN_STATES[0].NUTATION_PER, 60);
      assert.equal(j.INERTIAS[0].IXY, -135.9);
      assert.equal(j.MANEUVERS[0].MAN_DELTA_MASS, -0.01);
    } },
  { type: "ACM", kvn: "ndm/ndm-acm-blocks.kvn", xml: "ndm/ndm-acm-blocks.xml", version: "2.0", originator: "EXAMPLE-AGENCY", created: "2026-10-11T00:00:00", system: "UTC",
    check: (j) => {
      assert.equal(j.ATT_BLOCKS.length, 2);
      assert.equal(j.ATT_BLOCKS[0].NUMBER_STATES, 7);
      assert.equal(j.ATT_BLOCKS[0].TIMES.length, 4);
      assert.equal(j.ATT_BLOCKS[0].VALUES.length, 28);
      assert.equal(j.ATT_BLOCKS[0].VALUES[0], 0.1153);
      assert.equal(j.ATT_BLOCKS[1].EULER_ROT_SEQ, "ZXZ");
      assert.equal(j.COV_BLOCKS[0].VALUES.length, 18);
      assert.equal(j.DETERMINATION.SENSORS.length, 2);
      assert.deepEqual(j.DETERMINATION.SENSORS[0].SENSOR_NOISE_STDDEV, [0.003, 0.003, 0.01]);
      assert.equal(j.PHYS_PROPERTIES.CP_Y, -0.78);
      assert.equal(j.MAN_BLOCKS[0].MAN_DURATION, 450);
      assert.deepEqual(j.MAN_BLOCKS[0].TARGET_MOMENTUM, [1.3, -16.4, -11.35]);
      assert.equal(j.OBJECT_ID, "2009-031A", "INTERNATIONAL_DESIGNATOR is carried in OBJECT_ID");
      assert.equal(j.EPOCH, "2026-10-11T00:00:00.0", "EPOCH_TZERO is carried in EPOCH");
    } },
  { type: "RDM", kvn: "ndm/ndm-rdm-prediction.kvn", xml: "ndm/ndm-rdm-prediction.xml", version: "1.0", originator: "ESA", created: "2026-04-22T09:31:34.00", system: "UTC", frame: "EME2000",
    check: (j) => {
      assert.equal(j.PROBABILITY_OF_IMPACT, 0, "a stated zero probability is stored");
      assert.equal(j.PROBABILITY_OF_BURN_UP, 1);
      assert.equal(j.ORBIT_LIFETIME, 5.5);
      assert.equal(j.REENTRY_ALTITUDE, 80);
      assert.equal(j.REENTRY_EPOCH, "2026-04-27T19:45:33", "NOMINAL_REENTRY_EPOCH is carried in REENTRY_EPOCH");
      assert.equal(j.INITIAL_STATE.X, 4000);
      assert.equal(j.COVARIANCE.length, 21);
      assert.equal(j.MASS, 3582, "WET_MASS is carried in MASS");
      assert.equal(j.NORAD_CAT_ID, 81594);
      assert.equal(j.CONTROLLED_REENTRY, "NO");
    } },
  { type: "AEM", kvn: "ccsds-504.0-B-2-figure-G-4-aem.txt", xml: "ccsds-504.0-B-2-figure-G-4-aem.xml", version: "2.0", originator: "EXAMPLE-AGENCY", created: "2031-03-04T17:22:31", system: "UTC",
    check: (j) => { assert.equal(j.SEGMENTS.length, 2); assert.ok(j.SEGMENTS[0].ATTITUDE_DATA_LINES.length > 3); } },
  { type: "AEM", kvn: "ccsds-504.0-B-2-figure-G-5-aem-spinner.txt", xml: "ccsds-504.0-B-2-figure-G-5-aem-spinner.xml", version: "2.0", originator: "EXAMPLE-AGENCY", created: undefined, system: "UTC",
    check: (j) => { assert.equal(j.SEGMENTS.length, 1); } },
  { type: "TDM", kvn: "ccsds-503.0-B-2-figure-E-17-tdm-radar.txt", xml: "ccsds-503.0-B-2-figure-E-17-tdm-radar.xml", version: "2.0", originator: "EXAMPLE-AGENCY", created: undefined, system: "UTC",
    check: (j) => { assert.ok(j.SEGMENTS.length >= 1); assert.ok(j.SEGMENTS[0].OBSERVATIONS.length > 5); } },
  { type: "TDM", kvn: "ccsds-503.0-B-2-figure-E-18-tdm-phase.txt", xml: "ccsds-503.0-B-2-figure-E-18-tdm-phase.xml", version: "2.0", originator: undefined, created: undefined, system: "UTC",
    check: (j) => { assert.equal(j.SEGMENTS.length, 2); } },
];

const read = (type, bytes, format) => ({ methodId: `read_${type.toLowerCase()}`, inputs: [ncdInput("message", ncdFrame(bytes, format))] });
const write = (type, record, format) => ({
  methodId: `write_${type.toLowerCase()}`,
  inputs: format === undefined ? [recordInput(type, record)] : [recordInput(type, record), { ...ncdInput("descriptor", ncdFrame(undefined, format)) }],
});
const ok = (r) => { assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`); return r; };

for (const m of MESSAGES) {
  const { type } = m;
  test(`${type} ${path.basename(m.kvn)}: the KVN and its NDM/XML twin are one record, and the record says what the message said`, { skip }, async (t) => {
    const h = await harness(t);
    const kvn = fs.readFileSync(path.join(FIXTURES, m.kvn));
    const xml = fs.readFileSync(path.join(FIXTURES, m.xml));

    const fromKvn = ok(await h.invoke(read(type, kvn, KVN_FORMAT(type))));
    const fromXml = ok(await h.invoke(read(type, xml, XML_FORMAT(type))));
    const record = out(fromKvn, PORT[type]);
    assert.deepEqual(Buffer.from(out(fromXml, PORT[type])), Buffer.from(record), "the XML twin is another record");

    for (const [response, bytes, format] of [[fromKvn, kvn, KVN_FORMAT(type)], [fromXml, xml, XML_FORMAT(type)]]) {
      const d = descriptorOf(out(response, "descriptor"));
      assert.equal(d.FORMAT(), format);
      assert.equal(d.FORMAT_VERSION(), m.version);
      if (m.originator) assert.equal(d.ORIGINATOR(), m.originator);
      if (m.created) assert.equal(d.CREATION_DATE(), m.created);
      assert.equal(d.NATIVE_TIME_SYSTEM(), m.system);
      if (m.frame) assert.equal(d.NATIVE_FRAME_NAME(), m.frame);
      // The guest hashed the bytes it read; node:crypto hashed the bytes we sent.
      assert.equal(d.SOURCE_SHA256(), sha256(bytes));
      assert.equal(d.SOURCE_BYTE_LENGTH(), BigInt(bytes.length));
    }

    m.check(await decode(type, record));
  });

  test(`${type} ${path.basename(m.kvn)}: write_${type.toLowerCase()} emits KVN and XML that read back to the record`, { skip }, async (t) => {
    const h = await harness(t);
    const kvn = fs.readFileSync(path.join(FIXTURES, m.kvn));
    const record = out(ok(await h.invoke(read(type, kvn, KVN_FORMAT(type)))), PORT[type]);

    const asKvn = ok(await h.invoke(write(type, record)));
    const kvnFrame = out(asKvn, "message");
    const { descriptor: kd, body: kbody } = split(kvnFrame);
    assert.equal(kd.FORMAT(), KVN_FORMAT(type));
    assert.equal(kd.SOURCE_SHA256(), sha256(kbody));
    assert.match(new TextDecoder().decode(kbody), new RegExp(`^CCSDS_${type}_VERS = ${m.version.replace(".", "\\.")}\\n`));
    const again = ok(await h.invoke({ methodId: `read_${type.toLowerCase()}`, inputs: [ncdInput("message", kvnFrame)] }));
    assert.deepEqual(Buffer.from(out(again, PORT[type])), Buffer.from(record), "the KVN it wrote is another record");

    const asXml = ok(await h.invoke(write(type, record, XML_FORMAT(type))));
    const xmlFrame = out(asXml, "message");
    const { descriptor: xd, body: xbody } = split(xmlFrame);
    assert.equal(xd.FORMAT(), XML_FORMAT(type));
    assert.equal(xd.SOURCE_SHA256(), sha256(xbody));
    assert.equal(Buffer.from(xbody).toString("utf8"), fs.readFileSync(path.join(FIXTURES, m.xml), "utf8"), "the XML it wrote is not the committed twin");
    const back = ok(await h.invoke({ methodId: `read_${type.toLowerCase()}`, inputs: [ncdInput("message", xmlFrame)] }));
    assert.deepEqual(Buffer.from(out(back, PORT[type])), Buffer.from(record), "the XML it wrote is another record");

    // A fixed point: writing what it wrote changes nothing.
    const asKvnAgain = ok(await h.invoke(write(type, out(again, PORT[type]))));
    assert.deepEqual(Buffer.from(out(asKvnAgain, "message")), Buffer.from(kvnFrame));
  });

  test(`${type} ${path.basename(m.kvn)}: NDM/XML that another writer would produce reads as the same record`, { skip }, async (t) => {
    const h = await harness(t);
    const kvn = fs.readFileSync(path.join(FIXTURES, m.kvn));
    const xml = fs.readFileSync(path.join(FIXTURES, m.xml), "utf8");
    const record = out(ok(await h.invoke(read(type, kvn, KVN_FORMAT(type)))), PORT[type]);
    const variants = {
      "inside the <ndm> wrapper, comments and a processing instruction": xml.replace(/^<\?xml[^>]*\?>\s*/, "").replace(/(<\w+ )/, "<!-- one message -->\n$1").replace(/^/, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<ndm xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n').replace(/\s*$/, "\n</ndm>\n"),
      "without indentation": xml.split("\n").map((l) => l.trim()).join(""),
      "with CRLF line ends and no declaration": xml.replace(/^<\?xml[^>]*\?>\s*/, "").replace(/\n/g, "\r\n"),
      "without the units attributes": xml.replace(/ units="[^"]*"/g, ""),
    };
    for (const [why, text] of Object.entries(variants)) {
      const bytes = Buffer.from(text, "utf8");
      const r = ok(await h.invoke(read(type, bytes, undefined)));
      assert.deepEqual(Buffer.from(out(r, PORT[type])), Buffer.from(record), `read ${why}`);
    }
  });
}

test("a message of another kind, a descriptor that does not describe its bytes, and a descriptor of another format are refused", { skip }, async (t) => {
  const h = await harness(t);
  const omm = fs.readFileSync(path.join(FIXTURES, "ndm/ndm-omm-sgp4-covariance.kvn"));
  const ommXml = fs.readFileSync(path.join(FIXTURES, "ndm/ndm-omm-sgp4-covariance.xml"));

  // An OMM given to read_oem is the wrong method, not an OEM to be improvised.
  const wrongKvn = await h.invoke(read("OEM", omm, undefined));
  assert.notEqual(wrongKvn.statusCode, 0);
  assert.equal(wrongKvn.errorCode, "wrong-message-type");
  const wrongXml = await h.invoke(read("OEM", ommXml, undefined));
  assert.notEqual(wrongXml.statusCode, 0);
  assert.equal(wrongXml.errorCode, "wrong-message-type");

  // KVN bytes under a descriptor that says XML.
  const mislabelled = await h.invoke(read("OMM", omm, XML_FORMAT("OMM")));
  assert.equal(mislabelled.errorCode, "format-mismatch");
  // A descriptor of another message.
  const other = await h.invoke(read("OMM", omm, KVN_FORMAT("OEM")));
  assert.notEqual(other.statusCode, 0);
  // A descriptor that declares the length and hash of other bytes.
  const declaredFor = (bytes) => {
    const d = ncdFrame(bytes, KVN_FORMAT("OMM"));
    return d.subarray(0, 4 + new DataView(d.buffer, d.byteOffset).getUint32(0, true));
  };
  const withBody = (descriptor, body) => {
    const f = new Uint8Array(descriptor.length + body.length);
    f.set(descriptor);
    f.set(body, descriptor.length);
    return f;
  };
  const otherLength = await h.invoke({ methodId: "read_omm", inputs: [ncdInput("message", withBody(declaredFor(ommXml), omm))] });
  assert.equal(otherLength.errorCode, "descriptor-length-mismatch");
  const sameLength = Buffer.from(omm);
  sameLength[sameLength.indexOf("EXAMPLESAT")] = "e".charCodeAt(0);
  const otherHash = await h.invoke({ methodId: "read_omm", inputs: [ncdInput("message", withBody(declaredFor(omm), sameLength))] });
  assert.equal(otherHash.errorCode, "descriptor-hash-mismatch");
  // A descriptor with no file behind it: $NCD describes, it does not carry.
  const empty = await h.invoke({ methodId: "read_omm", inputs: [ncdInput("message", ncdFrame(new Uint8Array(0), KVN_FORMAT("OMM"), { declare: false }))] });
  assert.notEqual(empty.statusCode, 0);
});

test("a message that is not well formed, a number that is not a number and two messages in one file are named refusals", { skip }, async (t) => {
  const h = await harness(t);
  const kvn = fs.readFileSync(path.join(FIXTURES, "ndm/ndm-omm-sgp4-covariance.kvn"), "utf8");
  const xml = fs.readFileSync(path.join(FIXTURES, "ndm/ndm-omm-sgp4-covariance.xml"), "utf8");

  const notXml = await h.invoke(read("OMM", Buffer.from(xml.replace("</header>", "</heder>")), undefined));
  assert.equal(notXml.errorCode, "bad-xml");

  const badNumber = await h.invoke(read("OMM", Buffer.from(kvn.replace("ECCENTRICITY = 0.0003416", "ECCENTRICITY = O.0003416")), undefined));
  assert.equal(badNumber.errorCode, "bad-value");
  assert.match(badNumber.errorMessage, /ECCENTRICITY = O\.0003416/);
  assert.match(badNumber.errorMessage, /line \d+/);

  const badEnum = await h.invoke(read("OMM", Buffer.from(kvn.replace("TIME_SYSTEM = UTC", "TIME_SYSTEM = PST")), undefined));
  assert.equal(badEnum.errorCode, "bad-value");

  const twoKvn = await h.invoke(read("OMM", Buffer.from(`${kvn}\n${kvn}`), undefined));
  assert.equal(twoKvn.errorCode, "multiple-messages");
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  const twoXml = await h.invoke(read("OMM", Buffer.from(`<ndm>${body}${body}</ndm>`), undefined));
  assert.equal(twoXml.errorCode, "multiple-messages");

  const noVersion = await h.invoke(read("OMM", Buffer.from(kvn.replace("CCSDS_OMM_VERS = 3.0\n", "")), undefined));
  assert.equal(noVersion.errorCode, "bad-kvn");
});

test("a keyword with no place, a keyword stated twice and a mandatory keyword left out are refused, each named with its line", { skip }, async (t) => {
  // The record has a field for everything the Blue Books define, so a message that carries
  // something else, says something twice, or leaves out what it must say is not read into a
  // record that is quietly different from it.
  const h = await harness(t);
  const kvn = fs.readFileSync(path.join(FIXTURES, "ndm/ndm-omm-sgp4-covariance.kvn"), "utf8");
  const xml = fs.readFileSync(path.join(FIXTURES, "ndm/ndm-omm-sgp4-covariance.xml"), "utf8");
  const refused = async (text, code, pattern) => {
    const r = await h.invoke(read("OMM", Buffer.from(text), undefined));
    assert.notEqual(r.statusCode, 0, `${code} was accepted`);
    assert.equal(r.errorCode, code);
    assert.match(r.errorMessage, pattern);
  };

  await refused(kvn.replace("OBJECT_ID", "UNHEARD_OF = 1\nOBJECT_ID"), "unknown-keyword", /UNHEARD_OF = 1 \(line \d+\) has no place in OMM/);
  await refused(xml.replace("<OBJECT_ID>", "<UNHEARD_OF>1</UNHEARD_OF><OBJECT_ID>"), "unknown-keyword", /UNHEARD_OF/);
  await refused(kvn.replace("OBJECT_ID", "STRAY_MARKER\nOBJECT_ID"), "unknown-structure", /STRAY_MARKER \(line \d+\)/);

  await refused(kvn.replace("CENTER_NAME = EARTH", "CENTER_NAME = EARTH\nCENTER_NAME = MOON"), "duplicate-keyword", /CENTER_NAME \(line \d+\) is stated twice/);
  await refused(xml.replace("<CENTER_NAME>EARTH</CENTER_NAME>", "<CENTER_NAME>EARTH</CENTER_NAME><CENTER_NAME>MOON</CENTER_NAME>"), "duplicate-keyword", /CENTER_NAME/);

  await refused(kvn.replace(/^OBJECT_NAME = .*\n/m, ""), "missing-keyword", /OBJECT_NAME is mandatory in OMM/);
  await refused(kvn.replace(/^REF_FRAME = .*\n/m, ""), "missing-keyword", /REF_FRAME is mandatory/);
  await refused(kvn.replace(/^ECCENTRICITY = .*\n/m, ""), "missing-keyword", /ECCENTRICITY is mandatory/);
  await refused(xml.replace(/<TIME_SYSTEM>[^<]*<\/TIME_SYSTEM>/, ""), "missing-keyword", /TIME_SYSTEM/);
  await refused(kvn.replace("ORIGINATOR = SDN-TEST", "ORIGINATOR ="), "missing-keyword", /ORIGINATOR/);
  // A whole mandatory block left out names what it would have held, and the first thing is enough.
  const noElements = kvn.split("\n").filter((l) => !/^(EPOCH|MEAN_MOTION|ECCENTRICITY|INCLINATION|RA_OF_ASC_NODE|ARG_OF_PERICENTER|MEAN_ANOMALY|GM)\b/.test(l)).join("\n");
  await refused(noElements, "missing-keyword", /EPOCH is mandatory in OMM at omm\/body\/segment\/data\/meanElements and the message does not state it; \d+ more/);

  // Optional keywords and blocks are optional: this message states only what it must.
  const bare = kvn.split("\n").filter((l) => !/^(COMMENT|CLASSIFICATION|MESSAGE_ID|GM|MASS|SOLAR_RAD|DRAG_|EPHEMERIS_TYPE|CLASSIFICATION_TYPE|NORAD_CAT_ID|ELEMENT_SET_NO|REV_AT_EPOCH|BSTAR|MEAN_MOTION_D|COV_REF_FRAME|C[XYZ]_|USER_DEFINED)/.test(l)).join("\n");
  ok(await h.invoke(read("OMM", Buffer.from(bare), undefined)));
});

test("a record that lacks what the message must state is not written, and says what is missing", { skip }, async (t) => {
  const h = await harness(t);
  const kvn = fs.readFileSync(path.join(FIXTURES, "ndm/ndm-omm-sgp4-covariance.kvn"));
  const record = out(ok(await h.invoke(read("OMM", kvn, undefined))), PORT.OMM);
  const json = await decode("OMM", record);
  for (const [field, keyword] of [["OBJECT_NAME", "OBJECT_NAME"], ["ORIGINATOR", "ORIGINATOR"], ["CENTER_NAME", "CENTER_NAME"], ["OBJECT_ID", "OBJECT_ID"]]) {
    const damaged = { ...json, [field]: "" };
    const r = await h.invoke(write("OMM", await build("OMM", damaged)));
    assert.notEqual(r.statusCode, 0, `${field} empty was written`);
    assert.match(r.errorMessage, new RegExp(`the record does not state ${keyword}, which OMM must`));
    const asXml = await h.invoke(write("OMM", await build("OMM", damaged), XML_FORMAT("OMM")));
    assert.notEqual(asXml.statusCode, 0, `${field} empty was written as XML`);
  }
  // An epoch is not a guess: no EPOCH, no message.
  const noEpoch = await h.invoke(write("OMM", await build("OMM", { ...json, EPOCH: "" })));
  assert.match(noEpoch.errorMessage, /EPOCH/);
});

test("OMM and OPM metadata is read with or without META_START and META_STOP, and written without them", { skip }, async (t) => {
  // 502.0-B-3 delimits the metadata of an OEM and an OCM, not of an OMM or an OPM; catalogues that
  // write the markers anyway are read, and what is written is the Blue Book's.
  const h = await harness(t);
  for (const [type, file, openAt, closeAfter] of [
    ["OMM", "ndm/ndm-omm-sgp4-covariance.kvn", "COMMENT metadata comment\n", "MEAN_ELEMENT_THEORY = SGP/SGP4\n"],
    ["OPM", "ndm/ndm-opm-two-maneuvers.kvn", "OBJECT_NAME = EXAMPLESAT 1\n", "TIME_SYSTEM = UTC\n"],
  ]) {
    const plain = fs.readFileSync(path.join(FIXTURES, file), "utf8");
    assert.ok(!plain.includes("META_START"), `${file} is the Blue Book layout`);
    const marked = plain.replace(openAt, `META_START\n${openAt}`).replace(closeAfter, `${closeAfter}META_STOP\n`);
    assert.ok(marked.includes("META_START") && marked.includes("META_STOP"));
    const a = out(ok(await h.invoke(read(type, Buffer.from(plain), undefined))), PORT[type]);
    const b = out(ok(await h.invoke(read(type, Buffer.from(marked), undefined))), PORT[type]);
    assert.deepEqual(Buffer.from(b), Buffer.from(a), `${type} with markers is another record`);
    const text = Buffer.from(split(out(ok(await h.invoke(write(type, b))), "message")).body).toString("utf8");
    assert.ok(!text.includes("META_START") && !text.includes("META_STOP"), `${type} is written without the markers`);
    // A stop marker with no start, or a start with no stop, is not something a reader may shrug at.
    const loneStop = await h.invoke(read(type, Buffer.from(plain.replace(closeAfter, `${closeAfter}META_STOP\n`)), undefined));
    assert.equal(loneStop.errorCode, "unknown-structure");
    assert.match(loneStop.errorMessage, /META_STOP/);
    const loneStart = await h.invoke(read(type, Buffer.from(plain.replace(openAt, `META_START\n${openAt}`)), undefined));
    assert.equal(loneStart.errorCode, "unknown-structure");
    assert.match(loneStart.errorMessage, /META_START/);
  }
});

test("one COVARIANCE_START block holds every matrix of an OEM segment, and a segment that writes one block per matrix is the same record", { skip }, async (t) => {
  const h = await harness(t);
  const kvn = fs.readFileSync(path.join(FIXTURES, "ndm/ndm-oem-two-segments.kvn"), "utf8");
  assert.equal(kvn.match(/^COVARIANCE_START$/gm).length, 1, "the fixture is the book's layout");
  const split2 = kvn.replace("\nCOMMENT the second matrix", "COVARIANCE_STOP\n\nCOVARIANCE_START\nCOMMENT the second matrix");
  assert.equal(split2.match(/^COVARIANCE_START$/gm).length, 2);
  const a = out(ok(await h.invoke(read("OEM", Buffer.from(kvn), undefined))), PORT.OEM);
  const b = out(ok(await h.invoke(read("OEM", Buffer.from(split2), undefined))), PORT.OEM);
  assert.deepEqual(Buffer.from(b), Buffer.from(a));
  const text = Buffer.from(split(out(ok(await h.invoke(write("OEM", b))), "message")).body).toString("utf8");
  assert.equal(text.match(/^COVARIANCE_START$/gm).length, 1);
  assert.equal(text.match(/^COVARIANCE_STOP$/gm).length, 1);
  assert.equal(text.match(/^EPOCH = /gm).length, 2);
});

test("XML that an indenting writer or a PDF wrapped reads as the lines and values the KVN has", { skip }, async (t) => {
  const h = await harness(t);
  const kvn = fs.readFileSync(path.join(FIXTURES, "ndm/ndm-omm-sgp4-covariance.kvn"));
  const xml = fs.readFileSync(path.join(FIXTURES, "ndm/ndm-omm-sgp4-covariance.xml"), "utf8");
  const record = out(ok(await h.invoke(read("OMM", kvn, undefined))), PORT.OMM);
  const wrapped = xml
    .replace("<OBJECT_NAME>EXAMPLESAT 1</OBJECT_NAME>", "<OBJECT_NAME>EXAMPLESAT\n        1</OBJECT_NAME>")
    .replace(/<COMMENT>mean elements<\/COMMENT>/, "<COMMENT>mean\n      elements</COMMENT>");
  assert.notEqual(wrapped, xml);
  const r = ok(await h.invoke(read("OMM", Buffer.from(wrapped), undefined)));
  const j = await decode("OMM", out(r, PORT.OMM));
  assert.equal(j.OBJECT_NAME, "EXAMPLESAT 1", "a wrapped value is one line");
  assert.ok(j.COMMENT.split("\n").includes("mean") && j.COMMENT.split("\n").includes("elements"), "a wrapped comment is its lines, without their indentation");
  void record;
});

test("an OEM whose states are in the compact form is refused when written: its epochs need time arithmetic", { skip }, async (t) => {
  const h = await harness(t);
  const compact = await build("OEM", {
    CCSDS_OEM_VERS: 3.0, CREATION_DATE: "2026-10-11T00:00:00", ORIGINATOR: "TEST",
    EPHEMERIS_DATA_BLOCK: [{ CENTER_NAME: "EARTH", START_TIME: "2026-10-11T00:00:00", STOP_TIME: "2026-10-11T00:02:00", STEP_SIZE: 60, STATE_VECTOR_SIZE: 6, EPHEMERIS_DATA: [1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6, 1, 2, 3, 4, 5, 6] }],
  });
  const r = await h.invoke(write("OEM", compact));
  assert.notEqual(r.statusCode, 0);
  assert.match(r.errorMessage, /compact-form-needs-time-math/);
});

test("an OCM that states one trajectory in the fields analysis/od and the VCM adapter use is written as one block and reads back to the same fields", { skip }, async (t) => {
  const h = await harness(t);
  const legacy = await build("OCM", {
    HEADER: { CCSDS_OCM_VERS: "3.0", CREATION_DATE: "2026-10-11T00:00:00", ORIGINATOR: "TEST" },
    METADATA: { OBJECT_NAME: "LEGACY", TIME_SYSTEM: "UTC", EPOCH_TZERO: "2026-10-11T12:00:00" },
    TRAJ_TYPE: "CARTESIAN_PV", STATE_VECTOR_SIZE: 6, STATE_DATA: [7000, 0, 0, 0, 7.5, 1], CENTER_NAME: "EARTH",
    TRAJ_REF_FRAME: { NAME: "EME2000", REFERENCE_FRAME_type: "CelestialFrameWrapper", REFERENCE_FRAME: { frame: "EME2000" } },
    COVARIANCE_DATA: [1, 0, 2, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 6], COV_SIZE: 6, COV_TYPE: "CARTPV",
    COV_REF_FRAME: { NAME: "EME2000", REFERENCE_FRAME_type: "CelestialFrameWrapper", REFERENCE_FRAME: { frame: "EME2000" } },
  });
  const written = ok(await h.invoke(write("OCM", legacy)));
  const text = Buffer.from(split(out(written, "message")).body).toString("utf8");
  assert.match(text, /TRAJ_TYPE = CARTPV\n0\.0 7000\.0 0\.0 0\.0 0\.0 7\.5 1\.0\nTRAJ_STOP/);
  assert.match(text, /COV_TYPE = CARTPV\nCOV_ORDERING = LTM\n0\.0 1\.0 0\.0 2\.0/);
  const back = ok(await h.invoke({ methodId: "read_ocm", inputs: [ncdInput("message", out(written, "message"))] }));
  const j = await decode("OCM", out(back, PORT.OCM));
  assert.deepEqual(j.STATE_DATA, [7000, 0, 0, 0, 7.5, 1]);
  assert.equal(j.COV_SIZE, 6);
  assert.deepEqual(j.COVARIANCE_DATA.slice(0, 3), [1, 0, 2]);
  assert.equal(j.TRAJECTORY_BLOCKS.length, 1);
});

test("a CDM states metres where the record holds kilometres, and a value reads back as the very text it came from", { skip }, async (t) => {
  const h = await harness(t);
  const kvn = fs.readFileSync(path.join(FIXTURES, "ndm/ndm-cdm-full-covariance.kvn"), "utf8");
  // Values chosen so that multiplying a double by 1000 does not give back the text.
  const awkward = kvn.replace("MISS_DISTANCE = 715 [m]", "MISS_DISTANCE = 1234.5678 [m]").replace("RELATIVE_SPEED = 14762 [m/s]", "RELATIVE_SPEED = 0.1 [m/s]");
  const record = out(ok(await h.invoke(read("CDM", Buffer.from(awkward), undefined))), PORT.CDM);
  const j = await decode("CDM", record);
  assert.equal(j.MISS_DISTANCE, 1.2345678);
  assert.equal(j.RELATIVE_SPEED, 0.0001);
  const text = Buffer.from(split(out(ok(await h.invoke(write("CDM", record))), "message")).body).toString("utf8");
  assert.match(text, /^MISS_DISTANCE = 1234\.5678 \[m\]$/m);
  assert.match(text, /^RELATIVE_SPEED = 0\.1 \[m\/s\]$/m);
  // A message that annotates a length [km] is read as kilometres.
  const inKm = kvn.replace("MISS_DISTANCE = 715 [m]", "MISS_DISTANCE = 0.715 [km]");
  const j2 = await decode("CDM", out(ok(await h.invoke(read("CDM", Buffer.from(inKm), undefined))), PORT.CDM));
  assert.equal(j2.MISS_DISTANCE, 0.715);
});

test("seventeen-digit numbers survive KVN, the record and NDM/XML to the last digit", { skip }, async (t) => {
  const h = await harness(t);
  const kvn = fs.readFileSync(path.join(FIXTURES, "ndm/ndm-omm-sgp4-covariance.kvn"));
  const record = out(ok(await h.invoke(read("OMM", kvn, undefined))), PORT.OMM);
  const asKvn = Buffer.from(split(out(ok(await h.invoke(write("OMM", record))), "message")).body).toString("utf8");
  const asXml = Buffer.from(split(out(ok(await h.invoke(write("OMM", record, XML_FORMAT("OMM")))), "message")).body).toString("utf8");
  for (const cell of ["CX_X = 0.0003331349476038534", "CY_X = 0.0004618927349220216", "CZ_DOT_Z_DOT = 1.563219823411253e-10", "CY_DOT_Z = 2.34146712387001e-08"]) {
    assert.ok(asKvn.includes(cell), `KVN lost digits: ${cell}`);
  }
  assert.match(asXml, />0\.0003331349476038534</);
  assert.match(asXml, />1\.563219823411253e-10</);
});
