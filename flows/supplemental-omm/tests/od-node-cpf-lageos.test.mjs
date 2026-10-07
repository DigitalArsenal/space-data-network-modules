// The OD node's LAGEOS-1 elements from an ILRS CPF prediction agree with
// CelesTrak's SupGP for the same prediction, and an arc the fit core cannot
// fit is refused.
//
// CPF positions carry no velocity. The node must hand them to the fit core as
// position-only states (compact $OEM, STATE_VECTOR_SIZE 3) so the fitter seeds
// its velocity from the positions. Handed over as full states with zero
// velocity, each Earth-fixed position is a body at rest, its TEME velocity is
// the Earth's rotation, and OD 1.0.0 fitted this same arc to e 0.98,
// n -4.76 rev/day.
//
// Source: data-source/cpf-source/test/fixtures/lageos1_cpf_260713_19402.4h.dgf,
// the first 241 position records (4 h, 60 s, ITRF, metres, UTC) of the DGF
// prediction lageos1_cpf_260713_19402. Reference: CelesTrak's CPF SupGP row
// LAGEOS1 [DGF] for the same prediction (element set 194, epoch
// 2026-07-13T00:00:00) in analysis/od/tests/data/supgp-reference/cpf. Both are
// fits to one ILRS prediction, so this checks the node's handling of CPF, not
// the prediction itself.
//
// Tolerances are the CPF parity tolerances the reference suite states
// (provider.json): mean motion 2e-4 rev/day, eccentricity 5e-5, inclination
// 0.01 deg, RAAN 0.02 deg, argument of latitude 0.05 deg. The 1.0.1 node is
// inside each by 18x or more at the matching epoch.
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
import { FSO } from "spacedatastandards.org/lib/js/FSO/FSO.js";
import { OMM } from "spacedatastandards.org/lib/js/OMM/OMM.js";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const nodeRoot = path.join(packageRoot, "nodes/od");
const modulesRoot = path.resolve(packageRoot, "../..");
const cpfFixture = path.join(
  modulesRoot,
  "data-source/cpf-source/test/fixtures/lageos1_cpf_260713_19402.4h.dgf",
);
const supGpCsv = path.join(
  modulesRoot,
  "analysis/od/tests/data/supgp-reference/cpf/celestrak_supgp_cpf_2026-07-13.csv",
);
const tolerance = Object.freeze({
  meanMotion: 0.0002,
  eccentricity: 0.00005,
  inclinationDeg: 0.01,
  raanDeg: 0.02,
  argLatDeg: 0.05,
});
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

// One complete provider-native CPF response as a single canonical FSB chunk.
function cpfResponseFrame(data, requestId) {
  const builder = new Builder(data.byteLength + 512);
  const schemaName = builder.createString("CPF");
  const fileIdentifier = builder.createString("CPF");
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
  FSB.addSchemaName(builder, schemaName);
  FSB.addFileIdentifier(builder, fileIdentifier);
  FSB.addData(builder, dataVector);
  FSB.addSha256(builder, checksumVector);
  FSB.finishFSBBuffer(builder, FSB.endFSB(builder));
  return {
    portId: "cpf",
    wireFormat: "flatbuffer",
    typeRef: { ...fsbType, schemaHash: [...Buffer.from(fsbType.schemaHash, "hex")] },
    payload: builder.asUint8Array(),
  };
}

async function fitCpf(node, data, requestId) {
  const outputs = [];
  let response = await node.invoke({
    methodId: "fit",
    inputs: [cpfResponseFrame(data, requestId)],
  });
  const errorCodes = [response.errorCode];
  assert.equal(response.statusCode, 0, response.errorMessage);
  outputs.push(...response.outputs);
  while (response.backlogRemaining > 0) {
    response = await node.invoke({ methodId: "fit", inputs: [] });
    assert.equal(response.statusCode, 0, response.errorMessage);
    errorCodes.push(response.errorCode);
    outputs.push(...response.outputs);
  }
  return { outputs, errorCodes };
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
    });
  }
  return elements;
}

function statusMessages(outputs) {
  return outputs
    .filter((output) => output.portId === "status")
    .map((output) => {
      const status = FSO.getRootAsFSO(new ByteBuffer(new Uint8Array(output.payload)));
      const message = new TextDecoder().decode(status.messageArray() ?? new Uint8Array());
      return `${status.ERROR_CODE() ?? ""}: ${message}`;
    });
}

function supGpRow(objectName) {
  const lines = fs.readFileSync(supGpCsv, "utf8").split(/\r?\n/).filter((line) => line.trim());
  const header = lines[0].split(",");
  const row = lines.slice(1).map((line) => line.split(",")).find((f) => f[0] === objectName);
  assert.ok(row, `no CelesTrak SupGP row ${objectName}`);
  const num = (name) => Number.parseFloat(row[header.indexOf(name)]);
  return {
    noradCatId: Number.parseInt(row[header.indexOf("NORAD_CAT_ID")], 10),
    epoch: `${row[header.indexOf("EPOCH")]}Z`,
    meanMotion: num("MEAN_MOTION"),
    eccentricity: num("ECCENTRICITY"),
    inclination: num("INCLINATION"),
    raan: num("RA_OF_ASC_NODE"),
    argp: num("ARG_OF_PERICENTER"),
    meanAnomaly: num("MEAN_ANOMALY"),
  };
}

function angleDelta(a, b) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

async function odNode(t) {
  const manifest = JSON.parse(fs.readFileSync(path.join(nodeRoot, "plugin-manifest.json"), "utf8"));
  const node = await createBrowserModuleHarness({
    wasmSource: readOdNodeArtifact(),
    manifest,
    surface: "direct",
  });
  t.after(() => node.destroy());
  return node;
}

test("OD node fits LAGEOS-1 from a 4-hour CPF arc to CelesTrak's SupGP for the same prediction", async (t) => {
  const node = await odNode(t);
  const reference = supGpRow("LAGEOS1 [DGF]");
  const { outputs } = await fitCpf(node, new Uint8Array(fs.readFileSync(cpfFixture)), 95_100n);
  const fits = fittedElements(outputs);
  assert.deepEqual(
    fits.map(({ epoch }) => epoch),
    ["2026-07-13T00:00:00.000000Z", "2026-07-13T00:47:59.999989Z"],
    "one full 192-minute window from the first state and one ending at the last",
  );
  for (const fit of fits) {
    assert.equal(fit.noradCatId, reference.noradCatId);
    t.diagnostic(
      `${fit.epoch}: n ${fit.meanMotion.toFixed(8)} e ${fit.eccentricity.toFixed(7)} ` +
        `i ${fit.inclination.toFixed(4)} RAAN ${fit.raan.toFixed(4)}`,
    );
    // Over 48 minutes LAGEOS-1's n, e and i stay inside these tolerances and
    // its RAAN moves 0.011 deg; a near-radial fit misses n by whole rev/day.
    assert.ok(
      Math.abs(fit.meanMotion - reference.meanMotion) <= tolerance.meanMotion,
      `${fit.epoch}: mean motion ${fit.meanMotion} vs SupGP ${reference.meanMotion}`,
    );
    assert.ok(
      Math.abs(fit.eccentricity - reference.eccentricity) <= tolerance.eccentricity,
      `${fit.epoch}: eccentricity ${fit.eccentricity} vs SupGP ${reference.eccentricity}`,
    );
    assert.ok(
      Math.abs(fit.inclination - reference.inclination) <= tolerance.inclinationDeg,
      `${fit.epoch}: inclination ${fit.inclination} vs SupGP ${reference.inclination}`,
    );
    assert.ok(
      angleDelta(fit.raan, reference.raan) <= tolerance.raanDeg,
      `${fit.epoch}: RAAN ${fit.raan} vs SupGP ${reference.raan}`,
    );
  }
  const atReference = fits.find(({ epoch }) => epoch === reference.epoch);
  assert.ok(atReference, `no fit at the SupGP epoch ${reference.epoch}`);
  const argLat = angleDelta(
    atReference.argp + atReference.meanAnomaly,
    reference.argp + reference.meanAnomaly,
  );
  t.diagnostic(`argument of latitude at ${reference.epoch}: ${argLat.toFixed(5)} deg from SupGP`);
  assert.ok(argLat <= tolerance.argLatDeg, `argument of latitude off SupGP by ${argLat} deg`);
});

test("OD node refuses a CPF arc the fit core cannot fit", async (t) => {
  const node = await odNode(t);
  const lines = fs.readFileSync(cpfFixture, "utf8").split("\n");
  const header = lines.slice(0, 4);
  const records = lines.filter((line) => line.startsWith("10 "));
  const refuse = async (body, requestId, label) => {
    const { outputs, errorCodes } = await fitCpf(
      node,
      new TextEncoder().encode(`${body.join("\n")}\n`),
      requestId,
    );
    assert.deepEqual(fittedElements(outputs), [], `${label}: no OMM`);
    assert.ok(errorCodes.includes("od-native-parse"), `${label}: ${errorCodes}`);
    const messages = statusMessages(outputs);
    assert.equal(messages.length, 1, `${label}: one status`);
    assert.match(messages[0], /^od-native-parse: .*fewer than three usable states/);
  };
  // The fit core needs three states; two are refused before any fit.
  await refuse([...header, ...records.slice(0, 2), "99"], 95_200n, "two states");
  // Epochs must strictly increase: a repeated record is refused, not fitted.
  await refuse(
    [...header, records[0], records[1], records[1], records[2], "99"],
    95_201n,
    "repeated epoch",
  );
});
