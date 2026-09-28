// The OD node's Starlink GP agrees with CelesTrak SupGP: MEME state vectors are
// EME2000, and the node must label them so the fit core rotates them to TEME.
//
// Source: the checked-in OD reference suite analysis/od/tests/data/supgp-reference/
// starlink — ten SpaceX MEME operator ephemerides (captured 2026-05-14, launch
// 2026-034) and CelesTrak's SupGP elements for the same objects
// (celestrak_supgp_2026-034.csv, DATA_SOURCE SpaceX-E), which CelesTrak fitted to
// that same operator ephemeris. Units km; TEME of date; UTC epochs.
//
// Method: feed each MEME file to the signed OD node as one complete canonical FSB
// response on its `starlink` port and take the node's fitted $OMM. Then score two
// element sets with the same SGP4 on the frame-correct TEME states, i.e.
// analysis/od's own MEME reader (EME2000 rotated to TEME, IAU-76/FK5) over the
// same file: the node's GP and CelesTrak's SupGP (REFERENCE_RMS each). Both are
// RMS position errors against the same states, so by Minkowski their sum bounds
// the RMS separation of the node's GP from SupGP. A fit's own RMS cannot catch a
// frame error, because a fit is self-consistent in whatever frame it is handed;
// an independent reference can.
//
// Tolerance 5 km on that bound: frame-correct, the node's GP sits <0.1 km from
// the states and SupGP 2.2-3.0 km (CelesTrak's own fit residual plus propagation
// from its element epoch). The pre-fix node labelled the states TEME, fitted them
// unrotated and put its GP ~35 km from them, the precession since J2000.
//
// SUPPLEMENTAL_OMM_OD_TEST_ARTIFACT_GIT_REF=<ref> scores the node artifact
// committed at <ref> instead of the working tree's (as in od-node.test.mjs).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Builder, ByteBuffer } from "flatbuffers";
import { FSB } from "spacedatastandards.org/lib/js/FSB/FSB.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { createStandaloneHarness } from "space-data-module-sdk/testing/isomorphic";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const nodeRoot = path.join(packageRoot, "nodes/od");
const modulesRoot = path.resolve(packageRoot, "../..");
const suiteDir = path.join(modulesRoot, "analysis/od/tests/data/supgp-reference/starlink");
const memeDir = path.join(suiteDir, "meme");
const supGpCsv = path.join(suiteDir, "celestrak_supgp_2026-034.csv");
const odWasmPath = path.join(modulesRoot, "analysis/od/dist/isomorphic/module.wasm");
const SUPGP_AGREEMENT_MAX_KM = 5.0;
const fsbType = {
  schemaName: "FSB.fbs",
  fileIdentifier: "$FSB",
  schemaVersion: "1.164.0",
  schemaHash: "0b23aa63d0e3f17d828fc84dd433605c2794cb81ade7c043cb200e954c84e945",
  rootTypeName: "FSB",
  wireFormat: "flatbuffer",
};

function readOdNodeArtifact() {
  const gitRef = String(process.env.SUPPLEMENTAL_OMM_OD_TEST_ARTIFACT_GIT_REF ?? "").trim();
  if (!gitRef) {
    return new Uint8Array(fs.readFileSync(path.join(nodeRoot, "dist/isomorphic/module.wasm")));
  }
  const result = spawnSync(
    "git",
    ["show", `${gitRef}:flows/supplemental-omm/nodes/od/dist/isomorphic/module.wasm`],
    { cwd: modulesRoot, maxBuffer: 32 * 1024 * 1024 },
  );
  assert.equal(result.status, 0, `unable to read the OD node artifact at ${gitRef}: ${result.stderr}`);
  return new Uint8Array(result.stdout);
}

// One complete provider-native response as a single canonical FSB chunk.
function memeResponseFrame(data, requestId, schemaName) {
  const builder = new Builder(data.byteLength + 512);
  const encodedSchemaName = builder.createString(schemaName);
  const encodedFileIdentifier = builder.createString("MEME");
  const dataVector = FSB.createDataVector(builder, data);
  const checksumVector = FSB.createSha256Vector(
    builder,
    crypto.createHash("sha256").update(data).digest(),
  );
  FSB.startFSB(builder);
  FSB.addRequestId(builder, requestId);
  FSB.addChunkSequence(builder, 0);
  FSB.addFinal(builder, true);
  FSB.addTotalBytes(builder, BigInt(data.byteLength));
  FSB.addRecordCount(builder, 1n);
  FSB.addSchemaName(builder, encodedSchemaName);
  FSB.addFileIdentifier(builder, encodedFileIdentifier);
  FSB.addData(builder, dataVector);
  FSB.addSha256(builder, checksumVector);
  FSB.finishFSBBuffer(builder, FSB.endFSB(builder));
  return {
    portId: "starlink",
    wireFormat: "flatbuffer",
    typeRef: { ...fsbType, schemaHash: [...Buffer.from(fsbType.schemaHash, "hex")] },
    payload: builder.asUint8Array(),
  };
}

function fittedElements(outputs) {
  const chunks = outputs
    .filter((output) => output.portId === "omm")
    .map((output) => FSB.getRootAsFSB(new ByteBuffer(new Uint8Array(output.payload))))
    .sort((left, right) => left.CHUNK_SEQUENCE() - right.CHUNK_SEQUENCE());
  const stream = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.dataArray() ?? [])));
  const elements = [];
  let offset = 0;
  while (offset < stream.byteLength) {
    const size = stream.readUInt32LE(offset);
    const omm = OMM.getSizePrefixedRootAsOMM(
      new ByteBuffer(new Uint8Array(stream.subarray(offset, offset + 4 + size))),
    );
    offset += 4 + size;
    elements.push({
      noradCatId: omm.NORAD_CAT_ID(),
      epoch: omm.EPOCH(),
      meanMotion: omm.MEAN_MOTION(),
      eccentricity: omm.ECCENTRICITY(),
      inclination: omm.INCLINATION(),
      raan: omm.RA_OF_ASC_NODE(),
      argp: omm.ARG_OF_PERICENTER(),
      meanAnomaly: omm.MEAN_ANOMALY(),
      bstar: omm.BSTAR(),
      meanMotionDot: omm.MEAN_MOTION_DOT(),
      meanMotionDdot: omm.MEAN_MOTION_DDOT(),
    });
  }
  return elements;
}

function parseSupGpRows(csvPath) {
  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter((line) => line.trim());
  const header = lines[0].split(",");
  const col = (name) => header.indexOf(name);
  const byNorad = new Map();
  for (const line of lines.slice(1)) {
    const f = line.split(",");
    const num = (name) => Number.parseFloat(f[col(name)]);
    const norad = Number.parseInt(f[col("NORAD_CAT_ID")], 10);
    const row = {
      epoch: f[col("EPOCH")],
      meanMotion: num("MEAN_MOTION"),
      eccentricity: num("ECCENTRICITY"),
      inclination: num("INCLINATION"),
      raan: num("RA_OF_ASC_NODE"),
      argp: num("ARG_OF_PERICENTER"),
      meanAnomaly: num("MEAN_ANOMALY"),
      bstar: num("BSTAR"),
      meanMotionDot: num("MEAN_MOTION_DOT"),
      meanMotionDdot: num("MEAN_MOTION_DDOT"),
    };
    if (!byNorad.has(norad)) byNorad.set(norad, []);
    byNorad.get(norad).push(row);
  }
  return byNorad;
}

function epochMs(iso) {
  return Date.parse(/[zZ]$/.test(iso) ? iso : `${iso}Z`);
}

function closest(candidates, iso) {
  return candidates.reduce((best, candidate) =>
    !best ||
    Math.abs(epochMs(candidate.epoch) - epochMs(iso)) < Math.abs(epochMs(best.epoch) - epochMs(iso))
      ? candidate
      : best, null);
}

function referenceOptions(elements) {
  return {
    inputFormat: "meme",
    refEpoch: elements.epoch,
    refMeanMotion: elements.meanMotion,
    refEccentricity: elements.eccentricity,
    refInclination: elements.inclination,
    refRaan: elements.raan,
    refArgPericenter: elements.argp,
    refMeanAnomaly: elements.meanAnomaly,
    refBstar: elements.bstar,
    refMeanMotionDot: elements.meanMotionDot,
    refMeanMotionDdot: elements.meanMotionDdot,
  };
}

test("OD node's Starlink GP agrees with CelesTrak SupGP within 5 km (MEME states are EME2000)", async (t) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(nodeRoot, "plugin-manifest.json"), "utf8"));
  const node = await createBrowserModuleHarness({
    wasmSource: readOdNodeArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => node.destroy());
  const od = await createStandaloneHarness("browser", odWasmPath, { enableThreads: true });
  t.after(() => od.destroy());

  const fitMeme = async (meme, options) => {
    const response = await od.invoke({
      methodId: "fit",
      inputs: [
        { portId: "meme", payload: meme },
        { portId: "options", payload: new TextEncoder().encode(JSON.stringify(options)) },
      ],
    });
    assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
    return JSON.parse(
      new TextDecoder().decode(response.outputs.find((output) => output.portId === "result").payload),
    );
  };
  const scoreOnMemeStates = async (meme, elements) => {
    const km = Number.parseFloat((await fitMeme(meme, referenceOptions(elements))).REFERENCE_RMS);
    assert.ok(Number.isFinite(km), "analysis/od reported no REFERENCE_RMS");
    return km;
  };

  const supGp = parseSupGpRows(supGpCsv);
  const files = fs.readdirSync(memeDir).filter((name) => /^MEME_\d+_.*\.txt$/.test(name)).sort();
  assert.equal(files.length, 10, "the Starlink SupGP suite holds ten MEME files");
  let requestId = 94_100n;
  for (const file of files) {
    const [, noradText, objectName] = file.split("_");
    const norad = Number.parseInt(noradText, 10);
    const meme = new Uint8Array(fs.readFileSync(path.join(memeDir, file)));

    const outputs = [];
    let response = await node.invoke({
      methodId: "fit",
      inputs: [memeResponseFrame(meme, requestId, `MEME:${norad}:${objectName}`)],
    });
    requestId += 1n;
    assert.equal(response.statusCode, 0, `${norad}: ${response.errorMessage}`);
    outputs.push(...response.outputs);
    while (response.backlogRemaining > 0) {
      response = await node.invoke({ methodId: "fit", inputs: [] });
      assert.equal(response.statusCode, 0, `${norad}: ${response.errorMessage}`);
      outputs.push(...response.outputs);
    }
    const fits = fittedElements(outputs);
    assert.ok(fits.length > 0, `${norad}: the node emitted no $OMM`);
    for (const fit of fits) assert.equal(fit.noradCatId, norad);

    // Score the node epoch and the SupGP row nearest analysis/od's own fit epoch,
    // so both are propagated over the same reference window.
    const window = await fitMeme(meme, { inputFormat: "meme" });
    const nodeKm = await scoreOnMemeStates(meme, closest(fits, window.EPOCH));
    const rows = supGp.get(norad);
    assert.ok(rows?.length, `no CelesTrak SupGP row for NORAD ${norad}`);
    const supGpKm = await scoreOnMemeStates(meme, closest(rows, window.EPOCH));
    t.diagnostic(
      `NORAD ${norad}: node GP ${nodeKm.toFixed(3)} km, SupGP ${supGpKm.toFixed(3)} km from the TEME states; ` +
        `node GP to SupGP ${Math.abs(nodeKm - supGpKm).toFixed(3)}..${(nodeKm + supGpKm).toFixed(3)} km`,
    );
    assert.ok(
      nodeKm + supGpKm <= SUPGP_AGREEMENT_MAX_KM,
      `${norad}: the node's GP is ${nodeKm} km and CelesTrak SupGP ${supGpKm} km from the ` +
        `frame-correct TEME states (sum limit ${SUPGP_AGREEMENT_MAX_KM} km); the node fitted ` +
        "the MEME states in the wrong frame.",
    );
  }
});
