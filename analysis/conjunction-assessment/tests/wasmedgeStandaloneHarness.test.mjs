import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import { FlatcRunner } from "flatc-wasm";
import { encodeCqr, decodeCqr, pairRequest } from "./lib/cqr.mjs";

import {
  conjunctionArtifactExists,
  createConjunctionCommandHarness,
  invokeConjunctionJson,
} from "./lib/conjunctionCommandHarness.mjs";
import { gpSource } from "./lib/cqr.mjs";
import { buildThreadedWasmEdgeRunner } from "./lib/wasmedgePthreadRunner.mjs";
import { signCdmOutput, verifySignedCdmOutput } from "../index.js";

const CLOSE_PAIR_FIXTURE_PATH = new URL(
  "./fixtures/socrates/gp_61721,67298.json",
  import.meta.url,
);
const SOCRATES_REFERENCE_PATH = new URL(
  "./fixtures/socrates/reference.top3.json",
  import.meta.url,
);
const OREKIT_CDM_EXAMPLE1_KVN = `CCSDS_CDM_VERS                = 1.0
CREATION_DATE                 = 2010-03-12T22:31:12.000
ORIGINATOR                    = JSPOC
MESSAGE_ID                    = 201113719185
TCA                           = 2010-03-13T22:37:52.618
MISS_DISTANCE                 = 715                                  [m]
OBJECT                        = OBJECT1
OBJECT_DESIGNATOR             = 12345
OBJECT_NAME                   = SATELLITE A
INTERNATIONAL_DESIGNATOR      = 1997-030E
EPHEMERIS_NAME                = EPHEMERIS SATELLITE A
COVARIANCE_METHOD             = CALCULATED
MANEUVERABLE                  = YES
REF_FRAME                     = EME2000
X                             = 2570.097065                          [km]
Y                             = 2244.654904                          [km]
Z                             = 6281.497978                          [km]
X_DOT                         = 4.418769571                          [km/s]
Y_DOT                         = 4.833547743                          [km/s]
Z_DOT                         = -3.526774282                         [km/s]
CR_R                          = 4.142E+01                            [m**2]
CT_R                          = -8.579E+00                           [m**2]
CT_T                          = 2.533E+03                            [m**2]
CN_R                          = -2.313E+01                           [m**2]
CN_T                          = 1.336E+01                            [m**2]
CN_N                          = 7.098E+01                            [m**2]
OBJECT                        = OBJECT2
OBJECT_DESIGNATOR             = 30337
OBJECT_NAME                   = FENGYUN 1C DEB
INTERNATIONAL_DESIGNATOR      = 1999-025AA
EPHEMERIS_NAME                = NONE
COVARIANCE_METHOD             = CALCULATED
MANEUVERABLE                  = NO
REF_FRAME                     = EME2000
X                             = 2569.540800                          [km]
Y                             = 2245.093614                          [km]
Z                             = 6281.599946                          [km]
X_DOT                         = -2.888612500                         [km/s]
Y_DOT                         = -6.007247516                         [km/s]
Z_DOT                         = 3.328770172                          [km/s]
CR_R                          = 1.337E+03                            [m**2]
CT_R                          = -4.806E+04                           [m**2]
CT_T                          = 2.492E+06                            [m**2]
CN_R                          = -3.298E+01                           [m**2]
CN_T                          = -7.5888E+02                          [m**2]
CN_N                          = 7.105E+01                            [m**2]
`;

const OREKIT_CDM_EXAMPLE1_XML = `<?xml version="1.0" encoding="UTF-8"?>
<cdm id="CCSDS_CDM_VERS" version="1.0">
<header>
<CREATION_DATE>2010-03-12T22:31:12.000</CREATION_DATE>
<ORIGINATOR>JSPOC</ORIGINATOR>
<MESSAGE_FOR>SATELLITE A</MESSAGE_FOR>
<MESSAGE_ID>20111371985</MESSAGE_ID>
</header>
<body>
<relativeMetadataData>
<TCA>2010-03-13T22:37:52.618</TCA>
<MISS_DISTANCE units="m">715</MISS_DISTANCE>
<RELATIVE_SPEED units="m/s">14762</RELATIVE_SPEED>
<relativeStateVector>
<RELATIVE_POSITION_R units="m">27.4</RELATIVE_POSITION_R>
<RELATIVE_POSITION_T units="m">-70.2</RELATIVE_POSITION_T>
<RELATIVE_POSITION_N units="m">711.8</RELATIVE_POSITION_N>
<RELATIVE_VELOCITY_R units="m/s">-7.2</RELATIVE_VELOCITY_R>
<RELATIVE_VELOCITY_T units="m/s">-14692.0</RELATIVE_VELOCITY_T>
<RELATIVE_VELOCITY_N units="m/s">-1437.2</RELATIVE_VELOCITY_N>
</relativeStateVector>
<COLLISION_PROBABILITY>4.835E-05</COLLISION_PROBABILITY>
<COLLISION_PROBABILITY_METHOD>FOSTER-1992</COLLISION_PROBABILITY_METHOD>
</relativeMetadataData>
<segment>
<metadata>
<OBJECT>OBJECT1</OBJECT>
<OBJECT_DESIGNATOR>12345</OBJECT_DESIGNATOR>
<OBJECT_NAME>SATELLITE A</OBJECT_NAME>
<INTERNATIONAL_DESIGNATOR>1997-030E</INTERNATIONAL_DESIGNATOR>
<OBJECT_TYPE>PAYLOAD</OBJECT_TYPE>
<EPHEMERIS_NAME>EPHEMERIS SATELLITE A</EPHEMERIS_NAME>
<COVARIANCE_METHOD>CALCULATED</COVARIANCE_METHOD>
<MANEUVERABLE>YES</MANEUVERABLE>
<REF_FRAME>EME2000</REF_FRAME>
</metadata>
<data>
<stateVector>
<X units="km">2570.097065</X>
<Y units="km">2244.654904</Y>
<Z units="km">6281.497978</Z>
<X_DOT units="km/s">4.418769571</X_DOT>
<Y_DOT units="km/s">4.833547743</Y_DOT>
<Z_DOT units="km/s">-3.526774282</Z_DOT>
</stateVector>
<covarianceMatrix>
<CR_R units="m**2">4.142E+01</CR_R>
<CT_R units="m**2">-8.579E+00</CT_R>
<CT_T units="m**2">2.533E+03</CT_T>
<CN_R units="m**2">-2.313E+01</CN_R>
<CN_T units="m**2">1.336E+01</CN_T>
<CN_N units="m**2">7.098E+01</CN_N>
</covarianceMatrix>
</data>
</segment>
<segment>
<metadata>
<OBJECT>OBJECT2</OBJECT>
<OBJECT_DESIGNATOR>30337</OBJECT_DESIGNATOR>
<OBJECT_NAME>FENGYUN 1C DEB</OBJECT_NAME>
<INTERNATIONAL_DESIGNATOR>1999-025AA</INTERNATIONAL_DESIGNATOR>
<OBJECT_TYPE>DEBRIS</OBJECT_TYPE>
<EPHEMERIS_NAME>NONE</EPHEMERIS_NAME>
<COVARIANCE_METHOD>CALCULATED</COVARIANCE_METHOD>
<MANEUVERABLE>NO</MANEUVERABLE>
<REF_FRAME>EME2000</REF_FRAME>
</metadata>
<data>
<stateVector>
<X units="km">2569.540800</X>
<Y units="km">2245.093614</Y>
<Z units="km">6281.599946</Z>
<X_DOT units="km/s">-2.888612500</X_DOT>
<Y_DOT units="km/s">-6.007247516</Y_DOT>
<Z_DOT units="km/s">3.328770172</Z_DOT>
</stateVector>
<covarianceMatrix>
<CR_R units="m**2">1.337E+03</CR_R>
<CT_R units="m**2">-4.806E+04</CT_R>
<CT_T units="m**2">2.492E+06</CT_T>
<CN_R units="m**2">-3.298E+01</CN_R>
<CN_T units="m**2">-7.5888E+02</CN_T>
<CN_N units="m**2">7.105E+01</CN_N>
</covarianceMatrix>
</data>
</segment>
</body>
</cdm>`;

function readText(path) {
  return fs.readFileSync(new URL(path, import.meta.url), "utf8");
}

test("conjunction WasmEdge harness accepts canonical OMM sources for the known close pair", async (t) => {
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the WasmEdge harness test.");
    return;
  }
  const runnerBinary = await buildThreadedWasmEdgeRunner(
    t,
    "conjunction-wasmedge-replay-runner-",
  );
  if (!runnerBinary) {
    return;
  }

  const gpRecords = JSON.parse(fs.readFileSync(CLOSE_PAIR_FIXTURE_PATH, "utf8"));
  const reference = JSON.parse(fs.readFileSync(SOCRATES_REFERENCE_PATH, "utf8"))
    .conjunctions[0];
  const harness = await createConjunctionCommandHarness({
    wasmEdgeRunnerBinary: runnerBinary,
  });

  t.after(async () => {
    await harness.destroy();
  });

  const [primaryTrack, secondaryTrack] = gpRecords.map(gpSource);

  const { response, json } = await invokeConjunctionJson(harness, {
    operation: "assessTracks",
    params: {
      primary_track: primaryTrack,
      secondary_track: secondaryTrack,
      tca_hint_jd: Date.parse(reference.tca) / 86400000 + 2440587.5,
      window_hours: 0.2,
    },
  });

  assert.equal(response.statusCode, 0);
  assert.ok(Number.isFinite(Number(json?.tca_jd)));
  assert.ok(Number(json?.min_range_km) < 0.2);
  assert.ok(Number(json?.rel_speed_kms) > 5);
  assert.equal(json?.obj1_norad, 61721);
  assert.equal(json?.obj2_norad, 67298);
});

test("emit_cdm accepts canonical OMM-backed conjunction requests", async (t) => {
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the WasmEdge harness test.");
    return;
  }
  const runnerBinary = await buildThreadedWasmEdgeRunner(
    t,
    "conjunction-wasmedge-track-cdm-runner-",
  );
  if (!runnerBinary) {
    return;
  }

  const gpRecords = JSON.parse(fs.readFileSync(CLOSE_PAIR_FIXTURE_PATH, "utf8"));
  const reference = JSON.parse(fs.readFileSync(SOCRATES_REFERENCE_PATH, "utf8"))
    .conjunctions[0];
  const harness = await createConjunctionCommandHarness({
    wasmEdgeRunnerBinary: runnerBinary,
  });

  t.after(async () => {
    await harness.destroy();
  });

  const [primaryTrack, secondaryTrack] = gpRecords.map(gpSource);
  const tcaHintJd = Date.parse(reference.tca) / 86400000 + 2440587.5;
  const flatc = await FlatcRunner.init();
  const requestPayload = encodeCqr(flatc, pairRequest({
      primaryTrack,
      secondaryTrack,
      startJd: tcaHintJd - 0.1 / 24,
      durationDays: 0.2 / 24,
      radius1M: 5,
      radius2M: 5,
    }),
  );

  const response = await harness.invoke({
    methodId: "emit_cdm",
    inputs: [{ portId: "request", payload: requestPayload }],
  });

  assert.equal(response.statusCode, 0, response.errorMessage);
  const cdm = response.outputs?.find((frame) => frame.portId === "cdm");
  assert.ok(cdm?.payload instanceof Uint8Array, "CDM payload is emitted");
  assert.ok(cdm.payload.byteLength > 0, "CDM payload is non-empty");

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const signed = signCdmOutput(cdm.payload, {
    privateKey,
    providerId: "celestrak.eth",
    sourcePnmCid: "bafybeisocratesfixture",
    moduleArtifactHash: "sha256:" + "b".repeat(64),
    moduleVersion: "0.2.0",
    cdmOutputId: "CDM-61721-67298",
  });
  assert.equal(
    verifySignedCdmOutput(cdm.payload, signed, publicKey),
    true,
    "signed CDM metadata verifies against emitted CDM bytes",
  );

  const pcResponse = await harness.invoke({
    methodId: "compute_pc_from_cdm",
    inputs: [{ portId: "cdm", payload: cdm.payload }],
  });
  assert.equal(pcResponse.statusCode, 0, pcResponse.errorMessage);
  const pcResult = pcResponse.outputs?.find((frame) => frame.portId === "result");
  assert.ok(pcResult?.payload instanceof Uint8Array, "Pc result payload is emitted");
  const decodedPc = decodeCqr(flatc, pcResult.payload).PROBABILITY_RESULT;
  assert.ok(decodedPc.ALGORITHM !== "UNSPECIFIED");
  assert.ok(Number.isFinite(decodedPc.PROBABILITY));
});

test("emit_csm accepts canonical OMM-backed conjunction requests", async (t) => {
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the WasmEdge harness test.");
    return;
  }
  const runnerBinary = await buildThreadedWasmEdgeRunner(
    t,
    "conjunction-wasmedge-track-csm-runner-",
  );
  if (!runnerBinary) {
    return;
  }

  const gpRecords = JSON.parse(fs.readFileSync(CLOSE_PAIR_FIXTURE_PATH, "utf8"));
  const reference = JSON.parse(fs.readFileSync(SOCRATES_REFERENCE_PATH, "utf8"))
    .conjunctions[0];
  const harness = await createConjunctionCommandHarness({
    wasmEdgeRunnerBinary: runnerBinary,
  });

  t.after(async () => {
    await harness.destroy();
  });

  const [primaryTrack, secondaryTrack] = gpRecords.map(gpSource);
  const tcaHintJd = Date.parse(reference.tca) / 86400000 + 2440587.5;
  const flatc = await FlatcRunner.init();
  const requestPayload = encodeCqr(flatc, pairRequest({
      primaryTrack,
      secondaryTrack,
      startJd: tcaHintJd - 0.1 / 24,
      durationDays: 0.2 / 24,
      radius1M: 5,
      radius2M: 5,
    }),
  );

  const response = await harness.invoke({
    methodId: "emit_csm",
    inputs: [{ portId: "request", payload: requestPayload }],
  });

  assert.equal(response.statusCode, 0, response.errorMessage);
  const csm = response.outputs?.find((frame) => frame.portId === "csm");
  assert.ok(csm?.payload instanceof Uint8Array, "CSM payload is emitted");
  assert.ok(csm.payload.byteLength > 0, "CSM payload is non-empty");
});

test("CDM KVN command surface round-trips the Orekit CDMExample1 fixture", async (t) => {
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the WasmEdge harness test.");
    return;
  }
  const runnerBinary = await buildThreadedWasmEdgeRunner(
    t,
    "conjunction-wasmedge-cdm-kvn-runner-",
  );
  if (!runnerBinary) {
    return;
  }

  const harness = await createConjunctionCommandHarness({
    wasmEdgeRunnerBinary: runnerBinary,
  });
  t.after(async () => {
    await harness.destroy();
  });

  const parseResponse = await harness.invoke({
    methodId: "parse_cdm_kvn",
    inputs: [{ portId: "kvn", payload: encodeCqr(await FlatcRunner.init(), { NATIVE_DOCUMENT: { SERIALIZATION: "CCSDS_CDM_KVN", CONTENT: Array.from(new TextEncoder().encode(OREKIT_CDM_EXAMPLE1_KVN)) } }) }],
  });
  assert.equal(parseResponse.statusCode, 0, parseResponse.errorMessage);
  const cdm = parseResponse.outputs?.find((frame) => frame.portId === "cdm");
  assert.ok(cdm?.payload instanceof Uint8Array, "CDM payload is emitted");
  assert.ok(cdm.payload.byteLength > 0, "CDM payload is non-empty");

  const writeResponse = await harness.invoke({
    methodId: "write_cdm_kvn",
    inputs: [{ portId: "cdm", payload: cdm.payload }],
  });
  assert.equal(writeResponse.statusCode, 0, writeResponse.errorMessage);
  const kvn = writeResponse.outputs?.find((frame) => frame.portId === "kvn");
  assert.ok(kvn?.payload instanceof Uint8Array, "KVN payload is emitted");
  const roundtripText = new TextDecoder().decode(new Uint8Array(decodeCqr(await FlatcRunner.init(), kvn.payload).NATIVE_DOCUMENT.CONTENT));
  assert.match(roundtripText, /MESSAGE_ID\s*=\s*201113719185/);
  assert.match(roundtripText, /MISS_DISTANCE\s*=\s*715(?:\\.0+)?\s+\[m\]/);
  assert.match(roundtripText, /OBJECT\s*=\s*OBJECT1/);
  assert.match(roundtripText, /CR_R\s*=\s*4\.142E\+01\s+\[m\*\*2\]/);
});

test("CDM XML command surface round-trips the Orekit CDMExample1 fixture", async (t) => {
  if (!conjunctionArtifactExists()) {
    t.skip("Build conjunction-assessment before running the WasmEdge harness test.");
    return;
  }
  const runnerBinary = await buildThreadedWasmEdgeRunner(
    t,
    "conjunction-wasmedge-cdm-xml-runner-",
  );
  if (!runnerBinary) {
    return;
  }

  const harness = await createConjunctionCommandHarness({
    wasmEdgeRunnerBinary: runnerBinary,
  });
  t.after(async () => {
    await harness.destroy();
  });

  const parseResponse = await harness.invoke({
    methodId: "parse_cdm_xml",
    inputs: [{ portId: "xml", payload: encodeCqr(await FlatcRunner.init(), { NATIVE_DOCUMENT: { SERIALIZATION: "CCSDS_CDM_XML", CONTENT: Array.from(new TextEncoder().encode(OREKIT_CDM_EXAMPLE1_XML)) } }) }],
  });
  assert.equal(parseResponse.statusCode, 0, parseResponse.errorMessage);
  const cdm = parseResponse.outputs?.find((frame) => frame.portId === "cdm");
  assert.ok(cdm?.payload instanceof Uint8Array, "CDM payload is emitted");
  assert.ok(cdm.payload.byteLength > 0, "CDM payload is non-empty");

  const writeResponse = await harness.invoke({
    methodId: "write_cdm_xml",
    inputs: [{ portId: "cdm", payload: cdm.payload }],
  });
  assert.equal(writeResponse.statusCode, 0, writeResponse.errorMessage);
  const xml = writeResponse.outputs?.find((frame) => frame.portId === "xml");
  assert.ok(xml?.payload instanceof Uint8Array, "XML payload is emitted");
  const roundtripText = new TextDecoder().decode(new Uint8Array(decodeCqr(await FlatcRunner.init(), xml.payload).NATIVE_DOCUMENT.CONTENT));
  assert.match(roundtripText, /<MESSAGE_ID>20111371985<\/MESSAGE_ID>/);
  assert.match(roundtripText, /<MISS_DISTANCE units="m">715<\/MISS_DISTANCE>/);
  assert.match(roundtripText, /<RELATIVE_SPEED units="m\/s">14762<\/RELATIVE_SPEED>/);
  assert.match(roundtripText, /<OBJECT>OBJECT1<\/OBJECT>/);
  assert.match(roundtripText, /<CR_R units="m\*\*2">4\.142E\+01<\/CR_R>/);
});
