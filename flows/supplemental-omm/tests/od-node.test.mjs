// The OD node as built (nodes/od/dist/isomorphic/module.wasm, unsigned) in the SDK's browser module harness, fed the
// $OEM the flow's source modules make from their provider fixtures (and from NASA's ISS ephemeris), against its
// release's records of the same inputs (nodes/od/release-records, made by generate.mjs there), byte for byte. The
// SGP4-XP sets are also checked against propagator/sgp4-xp's own fit of the same states.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { modulesRoot, packageRoot, sha256, splitRecords } from "./lib/flow.mjs";
import { fit, harnessFor, issOem, odNode, sourceOems } from "./lib/nodes.mjs";
import { TYPE, decodeHttpRequest, decodeIngestRequest, decodeIngestResult, decodeObdRecord, decodeOem, decodeOmmRecord, encodeIngestRequest, encodeHttpResponse, encodeIngestResult, encodeOem, encodeOemSizePrefixed } from "./lib/sds.mjs";

const SGP4 = 0;
const SGP4XP = 1;
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const release = (name, standard) => splitRecords(fs.readFileSync(path.join(packageRoot, `nodes/od/release-records/${name}-${standard}-records.bin`)));
const hex = (records) => records.map((r) => Buffer.from(r).toString("hex"));
const isXpObd = (record) => (decodeObdRecord(record).ID ?? "").endsWith("-SGP4XP");
const isXpOmm = (record) => decodeOmmRecord(record).MEAN_ELEMENT_THEORY === SGP4XP;

// propagator/sgp4-xp's fit of an $OEM's states over its first `hours` (the node's window over a short ephemeris).
async function moduleFit(t, oemBytes, hours) {
  const oem = decodeOem(oemBytes);
  const block = oem.EPHEMERIS_DATA_BLOCK[0];
  const first = block.EPHEMERIS_DATA_LINES[0].EPOCH;
  block.USEABLE_START_TIME = first;
  block.USEABLE_STOP_TIME = new Date(Date.parse(first.endsWith("Z") ? first : `${first}Z`) + hours * 3600000).toISOString().replace("Z", "000Z");
  const xp = await harnessFor(t, path.join(modulesRoot, "propagator/sgp4-xp"));
  const response = await xp.invoke({ methodId: "fit", inputs: [{ portId: "ephemeris", typeRef: TYPE.OEM, payload: encodeOemSizePrefixed(oem) }] });
  assert.equal(response.statusCode, 0, response.errorMessage);
  return decodeOmmRecord(response.outputs.find((frame) => frame.portId === "elements").payload);
}
const ELEMENTS = ["EPOCH", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION", "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "BSTAR", "MEAN_MOTION_DDOT"];
const elementsOf = (omm) => Object.fromEntries(ELEMENTS.map((key) => [key, omm[key]]));

test("every source's $OEM fits to the release's records, byte for byte", async (t) => {
  const oems = await sourceOems(t);
  assert.deepEqual(Object.fromEntries(Object.entries(oems).map(([k, v]) => [k, v.length])), { starlink: 2, glonass: 25, intelsat: 1, cpf: 1, iss: 1 });
  // data-source/cpf-source writes LAGEOS-1's international designator, which the records carry.
  assert.equal(decodeOem(oems.cpf[0]).EPHEMERIS_DATA_BLOCK[0].OBJECT.OBJECT_ID, "1976-039A");
  const node = await odNode(t);
  const out = await fit(node, oems);
  assert.equal(out.invocations, 30, "one object an invocation");
  for (const standard of ["omm", "ocm", "obd"]) {
    assert.deepEqual(hex(out[standard]), hex(release("sources", standard)), standard);
  }
});

test("each fit: one batch per standard, its IngestRequest naming the provider and the stream's SHA-256", async (t) => {
  const oems = await sourceOems(t);
  const node = await odNode(t);
  const out = await fit(node, { iss: oems.iss, glonass: oems.glonass.slice(0, 1) });
  assert.deepEqual(out.meta.map((m) => m.port), ["omm_meta", "ocm_meta", "obd_meta", "omm_meta", "ocm_meta", "obd_meta"]);
  const requests = out.meta.map((m) => decodeIngestRequest(m.payload));
  assert.deepEqual(requests.map((r) => [r.schema, r.tags.providerId, r.tags.sourceName, r.tags.contentKeyId, r.reconcile]), [
    ["OMM.fbs", "supplemental-omm", "glonass", "public", "duplicates"],
    ["OCM.fbs", "supplemental-omm", "glonass", "public", "duplicates"],
    ["OBD.fbs", "supplemental-omm", "glonass", "public", "duplicates"],
    ["OMM.fbs", "supplemental-omm", "iss", "public", "duplicates"],
    ["OCM.fbs", "supplemental-omm", "iss", "public", "duplicates"],
    ["OBD.fbs", "supplemental-omm", "iss", "public", "duplicates"],
  ].sort((a, b) => (a[2] === b[2] ? 0 : a[2] === "iss" ? -1 : 1)));
  const issOmm = out.omm.filter((r) => decodeOmmRecord(r).OBJECT_NAME === "ISS");
  assert.equal(requests[0].tags.batchId, sha256(Buffer.concat(issOmm)));
  assert.equal(requests[0].provenance.parser, "org.sdn.flows.supplemental-omm.od");
  assert.deepEqual(out.notices.map((n) => [n.kind, n.reason, n.sourceName, n.items[0]]), [
    ["info", "fitted", "iss", "OD fit complete: ISS (NORAD 25544)"],
    ["info", "fitted", "glonass", "OD fit complete: GLONASS R01"],
  ]);
});

test("NASA's ISS ephemeris: the core's records are the release's, and one SGP4-XP set, propagator/sgp4-xp's, naming NASA and the source module", async (t) => {
  const oem = await issOem(t, fs.readFileSync(path.join(modulesRoot, "files/ccsds-messages/fixtures/real/nasa-iss.oem")));
  const out = await fit(await odNode(t), { iss: [oem] });
  for (const standard of ["omm", "ocm", "obd"]) {
    const core = out[standard].filter((r) => !(standard === "omm" && isXpOmm(r)) && !(standard === "obd" && isXpObd(r)));
    assert.deepEqual(hex(core), hex(release("iss-12h", standard)), `${standard}: the OD core's records`);
  }
  const xp = out.omm.filter(isXpOmm).map(decodeOmmRecord);
  assert.equal(xp.length, 1, "twelve hours: eight to fit and four to score the fit");
  const [set] = xp;
  assert.deepEqual([set.ORIGINATOR, set.OBJECT_NAME, set.OBJECT_ID, set.NORAD_CAT_ID], ["NASA/JSC/FOD/TOPO", "ISS", "1998-067-A", 25544]);
  assert.match(set.COMMENT, /^SOURCE com\.orbpro\.iss-source$/m, "the source module is named");
  // Eight of the twelve hours: two thirds of an ephemeris shorter than a day and a half.
  assert.deepEqual(elementsOf(set), elementsOf(await moduleFit(t, oem, 8)));
  const [obd] = out.obd.filter(isXpObd).map(decodeObdRecord);
  assert.equal(obd.SENSORS[0].SENSOR_ID, "com.orbpro.iss-source");
  assert.deepEqual(out.notices.map((n) => n.items[0]), ["OD fit complete: ISS (NORAD 25544); SGP4-XP: 1 set"]);
});

test("a three-day ephemeris: two full-day SGP4-XP windows, the first recovering the set that made it; the core's records are the release's", async (t) => {
  // The ephemeris of a known SGP4-XP set (15.5 rev/day, BTERM 0.005, AGOM 0.01), made by propagator/sgp4-xp
  // (tests/fixtures/PROVENANCE.md).
  const out = await fit(await odNode(t), { iss: [await issOem(t, fixture("iss-sgp4xp-3day.oem"))] });
  const xp = out.omm.filter(isXpOmm).map(decodeOmmRecord);
  assert.deepEqual(xp.map((s) => s.EPOCH), ["2024-04-09T12:00:00.000000Z", "2024-04-10T12:00:00.000000Z"], "windows of a day; the third would have nothing to score it");
  assert.equal(xp[0].MEAN_MOTION, 15.5);
  assert.ok(Math.abs(xp[0].BSTAR - 0.005) <= 2e-4 * 0.005 + 1e-6, `BTERM ${xp[0].BSTAR}`);
  assert.ok(Math.abs(xp[0].MEAN_MOTION_DDOT - 0.01) <= 1e-3 * 0.01 + 1e-6, `AGOM ${xp[0].MEAN_MOTION_DDOT}`);
  for (const standard of ["omm", "ocm", "obd"]) {
    const core = (records) => records.filter((r) => !(standard === "omm" && isXpOmm(r)) && !(standard === "obd" && isXpObd(r)));
    assert.deepEqual(hex(core(out[standard])), hex(release("iss-3day", standard)), `${standard}: the OD core's records`);
  }
  assert.deepEqual(out.notices.map((n) => n.items[0]), ["OD fit complete: ISS (NORAD 25544); SGP4-XP: 2 sets"]);
  assert.ok(out.omm.filter((r) => decodeOmmRecord(r).MEAN_ELEMENT_THEORY === SGP4).length >= 1);
});

test("an arc the fit core cannot fit is refused before it, with a notice; the next object is still fitted", async (t) => {
  const oems = await sourceOems(t);
  // LAGEOS-1's CPF with its second state's epoch repeated: the fitter's velocity seed would divide by zero.
  const broken = decodeOem(oems.cpf[0]);
  const lines = broken.EPHEMERIS_DATA_BLOCK[0].EPHEMERIS_DATA_LINES;
  lines[1].EPOCH = lines[0].EPOCH;
  const out = await fit(await odNode(t), { cpf: [encodeOem(broken)], iss: oems.iss });
  assert.deepEqual(out.notices.map((n) => [n.kind, n.reason, n.sourceName]), [["skipped", "unfittable", "cpf"], ["info", "fitted", "iss"]]);
  assert.match(out.notices[0].items[0], /lageos1 \(NORAD 8820\)/);
  assert.equal(out.meta.length, 3, "only the ISS batches");
});

test("a frame that is not an $OEM the node can read refuses the invocation", async (t) => {
  const node = await odNode(t);
  const notOem = await node.invoke({ methodId: "fit", inputs: [{ portId: "iss", typeRef: TYPE.OEM, payload: encodeIngestResult({ schema: "OMM.fbs" }) }] });
  assert.equal(notOem.statusCode, 400);
  assert.equal(notOem.errorCode, "od-input-invalid");
  const oems = await sourceOems(t);
  const teme = decodeOem(oems.iss[0]);
  teme.EPHEMERIS_DATA_BLOCK[0].REFERENCE_FRAME.REFERENCE_FRAME.frame = 0;
  const notEme = await node.invoke({ methodId: "fit", inputs: [{ portId: "iss", typeRef: TYPE.OEM, payload: encodeOem(teme) }] });
  assert.equal(notEme.statusCode, 400);
  assert.match(notEme.errorMessage, /not EME2000/);
});

test("publish_request: a stored batch becomes the publication POST; nothing without omm_publish_url or for a refused batch", async (t) => {
  const meta = encodeIngestRequest({ schema: "OMM.fbs", tags: { providerId: "supplemental-omm", sourceName: "iss", batchId: "a".repeat(64), contentKeyId: "public" } });
  const stored = encodeIngestResult({ schema: "OMM.fbs", providerId: "supplemental-omm", sourceName: "iss", batchId: "a".repeat(64), inserted: 3n });
  const inputs = (result) => [{ portId: "result", typeRef: TYPE.INGR, payload: result }, { portId: "meta", typeRef: TYPE.INGQ, payload: meta }];
  const quiet = await (await odNode(t)).invoke({ methodId: "publish_request", inputs: inputs(stored) });
  assert.equal(quiet.statusCode, 0);
  assert.equal(quiet.outputs.length, 0);
  const node = await odNode(t, { omm_publish_url: "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish" });
  const published = await node.invoke({ methodId: "publish_request", inputs: inputs(stored) });
  assert.equal(published.statusCode, 0, published.errorMessage);
  const request = decodeHttpRequest(published.outputs[0].payload);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish");
  assert.equal(request.headers["content-type"], "application/octet-stream");
  assert.deepEqual(decodeIngestResult(request.body), decodeIngestResult(stored));
  const refused = encodeIngestResult({ schema: "OMM.fbs", providerId: "supplemental-omm", sourceName: "iss", batchId: "a".repeat(64), refused: "quota" });
  const none = await node.invoke({ methodId: "publish_request", inputs: inputs(refused) });
  assert.equal(none.statusCode, 0);
  assert.equal(none.outputs.length, 0);
});

// LAGEOS-1 from a 4-hour ILRS CPF arc (data-source/cpf-source/test/fixtures/lageos1_cpf_260713_19402.4h.dgf: 241
// Earth-fixed positions, 60 s, no velocities), through data-source/cpf-source emit. The node hands the positions to the
// fit core as positions (compact $OEM, STATE_VECTOR_SIZE 3), so the fitter seeds its velocities from them; handed over
// as states at rest in the Earth-fixed frame, OD 1.0.0 fitted this arc to e 0.98. The legacy test also scored these
// fits against CelesTrak's SupGP for the same prediction (private fixtures); the records here are that node's.
async function cpfOem(t, text) {
  const harness = await harnessFor(t, path.join(modulesRoot, "data-source/cpf-source"));
  const url = "https://edc.dgfi.tum.de/pub/slr/cpf_predicts_v2/2026/lageos1/lageos1_cpf_260713_19402.dgf";
  const response = await harness.invoke({
    methodId: "emit",
    inputs: [{ portId: "response", typeRef: TYPE.HRSP, payload: encodeHttpResponse({ url, status: 200, headers: {}, body: new TextEncoder().encode(text), retrievedMs: 0 }) }],
  });
  return response.statusCode === 0 ? response.outputs.filter((frame) => frame.portId === "oem").map((frame) => new Uint8Array(frame.payload)) : [];
}
const cpfArc = fs.readFileSync(path.join(modulesRoot, "data-source/cpf-source/test/fixtures/lageos1_cpf_260713_19402.4h.dgf"), "utf8");

test("LAGEOS-1 from a 4-hour Earth-fixed CPF arc: positions alone, a bound near-circular orbit at both local epochs", async (t) => {
  const out = await fit(await odNode(t), { cpf: await cpfOem(t, cpfArc) });
  const sets = out.omm.map(decodeOmmRecord);
  assert.deepEqual(sets.map((s) => s.EPOCH), ["2026-07-13T00:00:00.000000Z", "2026-07-13T00:47:59.999989Z"], "one full 192-minute window from the first state and one ending at the last");
  for (const set of sets) {
    assert.equal(set.NORAD_CAT_ID, 8820);
    assert.ok(Math.abs(set.MEAN_MOTION - 6.3867) < 0.001 && set.ECCENTRICITY < 0.01 && Math.abs(set.INCLINATION - 109.8) < 0.05, JSON.stringify(set));
  }
});

test("a CPF arc the fit core cannot fit is refused before it: two states, a repeated epoch, an unbound seed", async (t) => {
  const lines = cpfArc.split("\n");
  const header = lines.filter((line) => /^H[1-9]/.test(line));
  const records = lines.filter((line) => line.startsWith("10 "));
  const node = await odNode(t);
  const reached = [];
  for (const [label, body] of [
    ["two states", [...header, ...records.slice(0, 2), "99"]],
    ["repeated epoch", [...header, records[0], records[1], records[1], records[2], "99"]],
    ["unbound seed", [
      ...header,
      "10 0 61234      0.000000  0      12270000.000             0.000             0.000",
      "10 0 61234     60.000000  0      12270000.000       1200000.000             0.000",
      "10 0 61234    120.000000  0      12270000.000       2400000.000             0.000",
      "99",
    ]],
  ]) {
    const oems = await cpfOem(t, `${body.join("\n")}\n`);
    if (oems.length === 0) continue;
    reached.push(label);
    const out = await fit(node, { cpf: oems });
    assert.equal(out.omm.length, 0, `${label}: no OMM`);
    assert.deepEqual(out.notices.map((n) => [n.kind, n.reason]), [["skipped", "unfittable"]], label);
  }
  assert.deepEqual(reached, ["two states", "repeated epoch", "unbound seed"], "data-source/cpf-source hands each to the node");
});
