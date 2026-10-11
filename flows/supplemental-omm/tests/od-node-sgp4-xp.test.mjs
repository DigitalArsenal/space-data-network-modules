// The OD node fits every ephemeris it is given with SGP4-XP as well as with the OD core's SGP4, and publishes both.
//
// SGP4-XP is the US Space Force's perturbation model with a fitted ballistic term (BTERM) and solar-radiation term
// (AGOM); the node holds the fit engine of propagator/sgp4-xp and the Space Force library, joined into the one
// module.wasm (nodes/od/build.mjs). Each fitted window is an $OMM with MEAN_ELEMENT_THEORY SGP4XP and an $OBD in the
// same record streams as the core's, naming its source.
//
// What is asserted:
//  - NASA's ISS ephemeris (the real 12 hours of files/ccsds-messages/fixtures/real/nasa-iss.oem) gives the core's SGP4
//    sets as before and one SGP4-XP set, ORIGINATOR NASA/JSC/FOD/TOPO, whose fit and held-out statistics are the ones the
//    set says; the status message says so;
//  - that set is the one propagator/sgp4-xp fits to the same states over the same interval, to the last digit: the
//    node and the module hold one engine;
//  - a three-day ephemeris made by the Space Force library from a known SGP4-XP set (so the truth is known) is cut into
//    its two full-day windows, and each window's set predicts the next day to a few metres;
//  - the SGP4 records of the core are not changed by the XP records beside them: they are the records the release
//    artifact of the node produces for the same input.
//
// The node under test is nodes/od/dist/isomorphic/module.wasm when that artifact carries the Space Force notice
// (it was built with SGP4-XP); otherwise it is a verification build of this tree's source with a development signing
// key (SUPPLEMENTAL_OD_VERIFY_OUT; nothing in the tree changes), which needs what nodes/od/build.mjs needs: a native flatc
// at repos/main-packages/flatbuffers/build/flatc (or SUPPLEMENTAL_OD_FLATC) and the SDS checkout next to this one. The
// comparison with propagator/sgp4-xp uses that module's test helpers and artifact: run `npm ci && npm run build` there first.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Builder, ByteBuffer } from "flatbuffers";
import { FSB } from "spacedatastandards.org/lib/js/FSB/FSB.js";
import { FSO } from "spacedatastandards.org/lib/js/FSO/FSO.js";
import { OBD } from "spacedatastandards.org/lib/js/OBD/OBD.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { listWasmCustomSections } from "space-data-module-sdk";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

import { loadModule } from "../../../propagator/sgp4-xp/tests/lib/module.mjs";
import { parseOemKvn, sdsFrame } from "../../../propagator/sgp4-xp/tests/lib/oemkvn.mjs";
import { blockLines, frame, oemBytes, ommBytes, readOem, readOmm } from "../../../propagator/sgp4-xp/tests/lib/sds.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const nodeRoot = path.join(packageRoot, "nodes/od");
const modulesRoot = path.resolve(packageRoot, "../..");
const issFixture = path.join(modulesRoot, "files/ccsds-messages/fixtures/real/nasa-iss.oem");
const SGP4 = 0;
const SGP4XP = 1;
const fsbType = {
  schemaName: "FSB.fbs",
  fileIdentifier: "$FSB",
  schemaVersion: "1.164.0",
  schemaHash: "0b23aa63d0e3f17d828fc84dd433605c2794cb81ade7c043cb200e954c84e945",
  rootTypeName: "FSB",
  wireFormat: "flatbuffer",
};

// ---- the node under test ---------------------------------------------------------------------------------------
const carriesSpaceForceNotice = (bytes) => listWasmCustomSections(bytes).some((section) => section.name === "ussf-sgp4-notice");

let artifacts;
function nodeArtifacts() {
  artifacts ??= (() => {
    const release = new Uint8Array(fs.readFileSync(path.join(nodeRoot, "dist/isomorphic/module.wasm")));
    if (carriesSpaceForceNotice(release)) return { node: release, release };
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "sdn-od-xp-"));
    const built = spawnSync(process.execPath, [path.join(nodeRoot, "build.mjs")], {
      env: { ...process.env, SUPPLEMENTAL_OD_VERIFY_OUT: out },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(built.status, 0, `the verification build of the OD node failed:\n${built.stderr}\n${built.stdout}`);
    const node = new Uint8Array(fs.readFileSync(path.join(out, "module.wasm")));
    fs.rmSync(out, { recursive: true, force: true });
    assert.ok(carriesSpaceForceNotice(node), "the verification build must carry the Space Force notice");
    return { node, release };
  })();
  return artifacts;
}

async function harness(t, wasmSource) {
  const manifest = JSON.parse(fs.readFileSync(path.join(nodeRoot, "plugin-manifest.json"), "utf8"));
  const node = await createBrowserModuleHarness({ wasmSource, manifest, surface: "direct" });
  t.after(() => node.destroy());
  return node;
}

// ---- requests and answers ----------------------------------------------------------------------------------------
function responseFrame(portId, data, requestId) {
  const builder = new Builder(data.byteLength + 512);
  const schemaName = builder.createString("OEM");
  const fileIdentifier = builder.createString("OEM");
  const dataVector = FSB.createDataVector(builder, data);
  const checksumVector = FSB.createSha256Vector(builder, crypto.createHash("sha256").update(data).digest());
  FSB.startFSB(builder);
  FSB.addRequestId(builder, requestId);
  FSB.addChunkSequence(builder, 0);
  FSB.addFinal(builder, true);
  FSB.addTotalBytes(builder, BigInt(data.byteLength));
  FSB.addRecordCount(builder, 1n);
  FSB.addSchemaName(builder, schemaName);
  FSB.addFileIdentifier(builder, fileIdentifier);
  FSB.addData(builder, dataVector);
  FSB.addSha256(builder, checksumVector);
  FSB.finishFSBBuffer(builder, FSB.endFSB(builder));
  return { portId, wireFormat: "flatbuffer", typeRef: { ...fsbType, schemaHash: [...Buffer.from(fsbType.schemaHash, "hex")] }, payload: builder.asUint8Array() };
}

async function fit(node, portId, data, requestId) {
  const outputs = [];
  let response = await node.invoke({ methodId: "fit", inputs: [responseFrame(portId, data, requestId)] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  outputs.push(...response.outputs);
  while (response.backlogRemaining > 0) {
    response = await node.invoke({ methodId: "fit", inputs: [] });
    assert.equal(response.statusCode, 0, response.errorMessage);
    outputs.push(...response.outputs);
  }
  return outputs;
}

// The size-prefixed records of one record-stream port, in order.
function records(outputs, portId) {
  const chunks = outputs
    .filter((output) => output.portId === portId)
    .map((output) => FSB.getRootAsFSB(new ByteBuffer(new Uint8Array(output.payload))))
    .sort((left, right) => left.CHUNK_SEQUENCE() - right.CHUNK_SEQUENCE());
  const stream = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.dataArray() ?? [])));
  const out = [];
  for (let offset = 0; offset < stream.byteLength; ) {
    const size = stream.readUInt32LE(offset);
    out.push(new Uint8Array(stream.subarray(offset, offset + 4 + size)));
    offset += 4 + size;
  }
  return out;
}

const decodeOmm = (record) => {
  const omm = OMM.getSizePrefixedRootAsOMM(new ByteBuffer(record));
  return {
    theory: omm.MEAN_ELEMENT_THEORY(),
    originator: omm.ORIGINATOR(),
    name: omm.OBJECT_NAME(),
    id: omm.OBJECT_ID(),
    norad: omm.NORAD_CAT_ID(),
    epoch: omm.EPOCH(),
    meanMotion: omm.MEAN_MOTION(),
    eccentricity: omm.ECCENTRICITY(),
    inclination: omm.INCLINATION(),
    raan: omm.RA_OF_ASC_NODE(),
    argPerigee: omm.ARG_OF_PERICENTER(),
    meanAnomaly: omm.MEAN_ANOMALY(),
    bstar: omm.BSTAR(),
    meanMotionDdot: omm.MEAN_MOTION_DDOT(),
    comment: omm.COMMENT() ?? "",
  };
};
const decodeObd = (record) => {
  const obd = OBD.getSizePrefixedRootAsOBD(new ByteBuffer(record));
  return { id: obd.ID(), wrms: obd.WRMS(), methodSource: obd.METHOD_SOURCE(), sensor: obd.SENSORS(0)?.SENSOR_ID(), start: obd.START_TIME(), end: obd.END_TIME() };
};
const statusMessages = (outputs) =>
  outputs
    .filter((output) => output.portId === "status")
    .map((output) => new TextDecoder().decode(FSO.getRootAsFSO(new ByteBuffer(new Uint8Array(output.payload))).messageArray() ?? new Uint8Array()));

// "FIT N=121 RMS_KM=0.19 ..." in an XP set's COMMENT.
function statistic(comment, label) {
  const m = new RegExp(`^${label} N=(\\d+) RMS_KM=(\\S+) MAX_KM=(\\S+)`, "m").exec(comment);
  return m ? { n: Number(m[1]), rms: Number(m[2]), max: Number(m[3]) } : null;
}

// A CCSDS OEM KVN response, the form the ISS provider hands the node.
function kvn(states, { originator = "NASA/JSC/FOD/TOPO" } = {}) {
  const rows = states.map((s) => `${s.epoch.replace(/Z$/, "")} ${[...s.r, ...s.v].map((x) => x.toFixed(9)).join(" ")}`);
  return new TextEncoder().encode(
    ["CCSDS_OEM_VERS = 2.0", `ORIGINATOR = ${originator}`, "", "META_START", "OBJECT_NAME = ISS", "OBJECT_ID = 1998-067-A", "CENTER_NAME = Earth", "REF_FRAME = EME2000", "TIME_SYSTEM = UTC", "META_STOP", "", ...rows, ""].join("\n"),
  );
}

// ---- tests -------------------------------------------------------------------------------------------------------
test("NASA's ISS ephemeris gets an SGP4-XP set beside the OD core's SGP4 sets, and the set names NASA", async (t) => {
  const { node: wasm } = nodeArtifacts();
  const node = await harness(t, wasm);
  const outputs = await fit(node, "iss", new Uint8Array(fs.readFileSync(issFixture)), 7001n);
  const sets = records(outputs, "omm").map(decodeOmm);
  const sgp4 = sets.filter((s) => s.theory === SGP4);
  const xp = sets.filter((s) => s.theory === SGP4XP);
  assert.ok(sgp4.length >= 1, "the OD core's SGP4 sets are still published");
  assert.equal(xp.length, 1, "twelve hours: eight to fit and four to score the fit");
  const [set] = xp;
  assert.equal(set.originator, "NASA/JSC/FOD/TOPO");
  assert.equal(set.name, "ISS");
  assert.equal(set.id, "1998-067-A");
  assert.equal(set.norad, 25544);
  assert.equal(set.epoch, "2026-07-13T12:00:00.000000Z", "the epoch is the first state of the fit");
  assert.ok(set.meanMotion > 15.4 && set.meanMotion < 15.6, `mean motion ${set.meanMotion}`);
  assert.ok(Math.abs(set.inclination - 51.64) < 0.1, `inclination ${set.inclination}`);
  assert.match(set.comment, /^SOURCE org\.sdn\.flows\.supplemental-omm\.provider-iss$/m, "the provider node is named");
  const fitted = statistic(set.comment, "FIT");
  const held = statistic(set.comment, "HELD_OUT");
  t.diagnostic(`ISS: fit ${fitted.n} states RMS ${fitted.rms} km; held out ${held.n} states RMS ${held.rms} km`);
  assert.equal(fitted.n, 121, "eight hours of four-minute states");
  assert.ok(fitted.rms < 0.35, `fit RMS ${fitted.rms} km`);
  assert.equal(held.n, 60, "the four hours after the fit");
  assert.ok(held.rms < 1.0, `held-out RMS ${held.rms} km`);

  const obds = records(outputs, "obd").map(decodeObd).filter((o) => (o.id ?? "").endsWith("-SGP4XP"));
  assert.equal(obds.length, 1);
  assert.equal(obds[0].sensor, "org.sdn.flows.supplemental-omm.provider-iss");
  assert.match(obds[0].methodSource, /Sgp4Prop 9\.1\.1\.0/);
  assert.ok(Math.abs(obds[0].wrms - fitted.rms) <= 1e-8 * fitted.rms);

  assert.deepEqual(statusMessages(outputs), ["OD fit complete: ISS (NORAD 25544); SGP4-XP: 1 set"]);
});

test("the node's SGP4-XP set is the set propagator/sgp4-xp fits to the same states over the same interval", async (t) => {
  const { node: wasm } = nodeArtifacts();
  const node = await harness(t, wasm);
  const text = fs.readFileSync(issFixture, "utf8");
  const outputs = await fit(node, "iss", new TextEncoder().encode(text), 7002n);
  const [fromNode] = records(outputs, "omm").map(decodeOmm).filter((s) => s.theory === SGP4XP);

  const { header, blocks } = parseOemKvn(text);
  const b = blocks[0];
  const module = await loadModule();
  t.after(() => module.destroy());
  // Eight of the twelve hours: two thirds of the ephemeris, which is shorter than a day and a half.
  const stop = new Date(Date.parse(`${b.lines[0].epoch.replace(/Z$/, "")}Z`) + 8 * 3600000).toISOString().replace("Z", "000Z");
  const out = await module.invoke("fit", [
    frame("ephemeris", "OEM", oemBytes({
      originator: header.ORIGINATOR,
      blocks: [{ frame: sdsFrame(b.frame), object: { name: "ISS", id: "1998-067-A", norad: 25544 }, lines: b.lines, start: b.start, stop: b.stop, useableStart: b.lines[0].epoch, useableStop: stop }],
    })),
  ]);
  const fromModule = readOmm(out.elements[0]);
  assert.equal(fromNode.epoch, fromModule.EPOCH);
  for (const [nodeField, moduleField] of [["meanMotion", "MEAN_MOTION"], ["eccentricity", "ECCENTRICITY"], ["inclination", "INCLINATION"], ["raan", "RA_OF_ASC_NODE"], ["argPerigee", "ARG_OF_PERICENTER"], ["meanAnomaly", "MEAN_ANOMALY"], ["bstar", "BSTAR"], ["meanMotionDdot", "MEAN_MOTION_DDOT"]]) {
    assert.equal(fromNode[nodeField], fromModule[moduleField], moduleField);
  }
  assert.equal(statistic(fromNode.comment, "FIT").rms, Number(fromModule.USER_DEFINED_PARAMETERS.find((p) => p.PARAM_NAME === "FIT_RMS_KM").PARAM_VALUE));
});

test("a three-day ephemeris is cut into its full-day windows, and each window's set predicts the next day", async (t) => {
  const { node: wasm } = nodeArtifacts();
  const node = await harness(t, wasm);
  // The ephemeris of a known SGP4-XP set, made by the Space Force library through propagator/sgp4-xp: EME2000, 4 minutes.
  const truth = { epoch: "2024-04-09T12:00:00.000000", meanMotion: 15.5, eccentricity: 0.0006317, inclination: 51.64, raan: 208.9163, argPerigee: 69.9862, meanAnomaly: 25.2906, bterm: 0.005, agom: 0.01, norad: 25544, name: "ISS", id: "1998-067A" };
  const module = await loadModule();
  t.after(() => module.destroy());
  const grid = oemBytes({ blocks: [{ frame: "EME2000", start: `${truth.epoch}Z`, stop: "2024-04-12T12:00:00.000000Z", step: 240, data: [] }] });
  const produced = await module.invoke("propagate", [frame("omm", "OMM", ommBytes(truth)), frame("grid", "OEM", grid)]);
  const states = blockLines(readOem(produced.ephemeris[0]).EPHEMERIS_DATA_BLOCK[0]);
  assert.equal(states.length, 1081);

  const outputs = await fit(node, "iss", kvn(states), 7003n);
  const xp = records(outputs, "omm").map(decodeOmm).filter((s) => s.theory === SGP4XP);
  assert.deepEqual(xp.map((s) => s.epoch), ["2024-04-09T12:00:00.000000Z", "2024-04-10T12:00:00.000000Z"], "windows of a day, the third would have nothing to score it");
  xp.forEach((set, k) => {
    const fitted = statistic(set.comment, "FIT");
    const held = statistic(set.comment, "HELD_OUT");
    t.diagnostic(`window ${k + 1}: fit RMS ${fitted.rms} km, held out ${held.n} states RMS ${held.rms} km`);
    assert.equal(fitted.n, 361, `window ${k + 1}: a day of four-minute states`);
    // The first window starts at the epoch of the set that made the ephemeris and recovers it; the second starts a day
    // later, where that set is not a point of the two-line text's digits, and is within the text's resolution of it.
    const limit = k === 0 ? 1e-4 : 1e-2;
    assert.ok(fitted.rms < limit, `window ${k + 1}: fit RMS ${fitted.rms} km`);
    assert.equal(held.n, 360, `window ${k + 1}: the next day`);
    assert.ok(held.rms < limit, `window ${k + 1}: held-out RMS ${held.rms} km`);
  });
  // The first window recovers the set that made the ephemeris, ballistic and solar-radiation terms included.
  const [first] = xp;
  assert.equal(first.meanMotion, truth.meanMotion);
  assert.ok(Math.abs(first.eccentricity - truth.eccentricity) <= 2e-7);
  assert.ok(Math.abs(first.inclination - truth.inclination) <= 2e-4);
  assert.ok(Math.abs(first.raan - truth.raan) <= 2e-4);
  assert.ok(Math.abs(first.bstar - truth.bterm) <= 2e-4 * truth.bterm + 1e-6, `BTERM ${first.bstar}`);
  assert.ok(Math.abs(first.meanMotionDdot - truth.agom) <= 1e-3 * truth.agom + 1e-6, `AGOM ${first.meanMotionDdot}`);
  assert.deepEqual(statusMessages(outputs), ["OD fit complete: ISS (NORAD 25544); SGP4-XP: 2 sets"]);
});

test("the OD core's records are what the release artifact of the node produces for the same input", async (t) => {
  const { node: wasm, release } = nodeArtifacts();
  if (wasm === release) return t.skip("the release artifact is the artifact under test");
  const data = new Uint8Array(fs.readFileSync(issFixture));
  const withXp = await fit(await harness(t, wasm), "iss", data, 7004n);
  const before = await fit(await harness(t, release), "iss", data, 7004n);
  const core = (outputs, port) => records(outputs, port).filter((r) => !(port === "omm" && decodeOmm(r).theory === SGP4XP) && !(port === "obd" && (decodeObd(r).id ?? "").endsWith("-SGP4XP")));
  for (const port of ["omm", "ocm", "obd"]) {
    assert.deepEqual(core(withXp, port).map((r) => Buffer.from(r).toString("hex")), core(before, port).map((r) => Buffer.from(r).toString("hex")), `${port}: the core's records`);
  }
});
