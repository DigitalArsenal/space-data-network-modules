// Known-answer run of the release-signed Supplemental OMM flow.
//
// Committed provider-native fixtures go in at the five provider nodes, which
// run under their flow-owned plugin IDs; the exact OMM records the flow
// publishes come out and are compared against pinned values. The flow, its
// children and its signature are the built release bytes in dist/; nothing is
// rebuilt or stubbed here except the host's network, clock and storage.
//
// Lane: the isomorphic flow host the browser runs (WebAssembly in V8). The
// WasmEdge lanes need a host that serves the space_data_module_host imports
// these direct-surface nodes call (http.request, pubsub, opaque storage); the
// SDK's WasmEdge runners serve only WASI command modules, so that lane is the
// SDN node host's, not this package's.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseSingleFileBundle,
  verifyModuleArtifact,
} from "space-data-module-sdk";
import { createIsomorphicFlowRuntimeHost } from "space-data-module-sdk/flow";
import { ByteBuffer } from "../../../../spacedatastandards.org/node_modules/flatbuffers/js/flatbuffers.js";
import { OMM } from "../../../../spacedatastandards.org/lib/js/OMM/OMM.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const modulesRoot = path.resolve(packageRoot, "../..");
const releaseArtifactPath = path.join(
  packageRoot,
  "dist/isomorphic/module.wasm",
);
const trustedReleaseSigner =
  "d4b97660cea81cff7db4bccc8be327efb259ec7b48cf8bf6c0d7d9819b1537fd";

const providerPluginIds = Object.freeze({
  "provider-starlink": "org.sdn.flows.supplemental-omm.provider-starlink",
  "provider-glonass": "org.sdn.flows.supplemental-omm.provider-glonass",
  "provider-intelsat": "org.sdn.flows.supplemental-omm.provider-intelsat",
  "provider-cpf": "org.sdn.flows.supplemental-omm.provider-cpf",
  "provider-iss": "org.sdn.flows.supplemental-omm.provider-iss",
});

const starlinkBase = "https://api.starlink.com/public-files/ephemerides/";
const starlinkFiles = Object.freeze([
  "MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt",
  "MEME_67851_STARLINK-36348_1340149_Operational_1463017800_UNCLASSIFIED.txt",
]);
const intelsatUnit = "i_aor_e_302.00_is-21_20260710_235300";
const cpfUnit = "lageos1_cpf_260713_19402.dgf";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture(relativePath) {
  return new Uint8Array(
    fs.readFileSync(path.join(modulesRoot, "data-source", relativePath)),
  );
}

// Provider default URL -> committed provider-native fixture bytes.
function fixtureResponses() {
  return new Map([
    [
      `${starlinkBase}MANIFEST.txt`,
      new TextEncoder().encode(`${starlinkFiles.join("\n")}\n`),
    ],
    ...starlinkFiles.map((filename) => [
      `${starlinkBase}${filename}`,
      fixture(`spacex-starlink-source/test/fixtures/meme/${filename}`),
    ]),
    [
      "https://www.aiub.unibe.ch/download/CODE/COD0OPSULT.SP3",
      fixture("glonass-source/test/fixtures/iac_glonass.sp3.glo"),
    ],
    [
      "https://my.intelsat.com/ephemeris/public",
      fixture("intelsat-source/test/fixtures/ephemeris_public.sample.html"),
    ],
    [
      `https://my.intelsat.com/Resource/Ephemeris/${intelsatUnit}.txt`,
      fixture(`intelsat-source/test/fixtures/${intelsatUnit}.sample.txt`),
    ],
    [
      "https://edc.dgfi.tum.de/pub/slr/cpf_predicts_v2/2026/lageos1/",
      fixture("cpf-source/test/fixtures/listing.sample.html"),
    ],
    [
      `https://edc.dgfi.tum.de/pub/slr/cpf_predicts_v2/2026/lageos1/${cpfUnit}`,
      fixture("cpf-source/test/fixtures/lageos1_cpf_260713_19402.sample.dgf"),
    ],
    [
      "https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt",
      fixture("iss-source/test/fixtures/ISS.OEM_J2K_EPH.sample.txt"),
    ],
  ]);
}

function serveFixture(params, body) {
  assert.equal(params.method, "GET");
  const range = params.headers?.Range;
  const rangeMatch =
    typeof range === "string" ? /^bytes=0-([0-9]+)$/u.exec(range) : null;
  if (rangeMatch) {
    const end = Math.min(Number(rangeMatch[1]), body.byteLength - 1);
    const slice = new Uint8Array(body.subarray(0, end + 1));
    return {
      status: 206,
      headers: {
        "Content-Range": `bytes 0-${end}/${body.byteLength}`,
        "Content-Length": String(slice.byteLength),
      },
      body: slice,
    };
  }
  assert.equal(range, undefined, `unexpected range for ${params.url}`);
  return {
    status: 200,
    headers: { "Content-Length": String(body.byteLength) },
    body: new Uint8Array(body),
  };
}

function decodeOmm(record) {
  const text = (offset) =>
    new TextDecoder().decode(record.subarray(offset, offset + 4));
  let omm;
  if (text(8) === "$OMM") {
    omm = OMM.getSizePrefixedRootAsOMM(new ByteBuffer(record));
  } else {
    assert.equal(text(4), "$OMM", "publication is not a canonical OMM");
    omm = OMM.getRootAsOMM(new ByteBuffer(record));
  }
  return {
    OBJECT_NAME: omm.OBJECT_NAME(),
    OBJECT_ID: omm.OBJECT_ID(),
    NORAD_CAT_ID: omm.NORAD_CAT_ID(),
    EPOCH: omm.EPOCH(),
    MEAN_MOTION: omm.MEAN_MOTION(),
    ECCENTRICITY: omm.ECCENTRICITY(),
    INCLINATION: omm.INCLINATION(),
    RA_OF_ASC_NODE: omm.RA_OF_ASC_NODE(),
    ARG_OF_PERICENTER: omm.ARG_OF_PERICENTER(),
    MEAN_ANOMALY: omm.MEAN_ANOMALY(),
    BSTAR: omm.BSTAR(),
    sha256: sha256(record),
  };
}

async function runReleaseFlow() {
  const published = new Uint8Array(fs.readFileSync(releaseArtifactPath));
  const verified = await verifyModuleArtifact(published, {
    trustedPublicKeys: [trustedReleaseSigner],
    requireSignature: true,
  });
  assert.equal(verified.verified, true);
  const parsed = await parseSingleFileBundle(published);
  const entries = new Map(parsed.entries.map((entry) => [entry.entryId, entry]));
  const artifact = JSON.parse(
    new TextDecoder().decode(entries.get("artifact.json").payloadBytes),
  );

  const responses = fixtureResponses();
  let clockNowMs = Date.parse("2026-07-21T12:34:56Z");
  const opaque = new Map();
  const fetches = [];
  const publications = [];
  const children = artifact.nodeArtifacts.map((descriptor) => ({
    pluginId: descriptor.pluginId,
    wasmSource: entries.get(descriptor.entryId).payloadBytes,
    verifySignature: {
      trustedPublicKeys: [trustedReleaseSigner],
      requireSignature: true,
    },
    hostcallDispatch(operation, params) {
      if (operation === "clock.now") return clockNowMs;
      if (operation === "timers.arm" || operation === "timers.cancel") {
        return { accepted: true };
      }
      if (operation === "http.request") {
        fetches.push({ nodeId: descriptor.nodeId, url: params.url });
        const body = responses.get(params.url);
        return body
          ? serveFixture(params, body)
          : { status: 404, body: new Uint8Array() };
      }
      if (operation === "pubsub.publish") {
        publications.push({
          nodeId: descriptor.nodeId,
          standard: params.standard,
          source: params.source,
          data: new Uint8Array(params.data),
        });
        return true;
      }
      const key = `${descriptor.nodeId}\0${params?.namespace}\0${params?.key}`;
      if (operation === "storage.adapter.opaque.read") {
        const value = opaque.get(key);
        return {
          found: value !== undefined,
          bytes_b64: value?.slice() ?? new Uint8Array(),
        };
      }
      if (operation === "storage.adapter.opaque.list") {
        const prefix = `${descriptor.nodeId}\0${params.namespace}\0`;
        return {
          keys: [...opaque.keys()]
            .filter((candidate) => candidate.startsWith(prefix))
            .map((candidate) => candidate.slice(prefix.length))
            .sort(),
        };
      }
      if (operation === "storage.adapter.opaque.replace") {
        opaque.set(key, new Uint8Array(params.data));
        return { stored_bytes: params.data.byteLength };
      }
      if (operation === "storage.adapter.opaque.delete") {
        opaque.delete(key);
        return { deleted: true };
      }
      if (operation === "storage.adapter.opaque.sync") return { synced: true };
      throw new Error(`${descriptor.nodeId} requested ${operation}`);
    },
  }));

  const host = await createIsomorphicFlowRuntimeHost({
    wasmSource: published,
    children,
  });
  try {
    host.enqueueTrigger(0);
    await host.drain({ maxIterations: 20_000, frameBudget: 64 });
    clockNowMs += 30_000;
    host.enqueueTrigger(0);
    await host.drain({ maxIterations: 20_000, frameBudget: 64 });
  } finally {
    host.destroy();
  }
  return { artifact, fetches, publications };
}

test("the release-signed flow turns committed provider fixtures into the known OMM records", async () => {
  const { artifact, fetches, publications } = await runReleaseFlow();

  for (const [nodeId, pluginId] of Object.entries(providerPluginIds)) {
    const descriptor = artifact.nodeArtifacts.find(
      (candidate) => candidate.nodeId === nodeId,
    );
    assert.equal(descriptor?.pluginId, pluginId);
    assert.equal(descriptor.entryId, pluginId);
  }
  assert.deepEqual(
    [...new Set(fetches.map(({ nodeId }) => nodeId))].sort(),
    Object.keys(providerPluginIds).sort(),
    "every provider node must fetch its fixture",
  );

  const omms = publications
    .filter(({ standard }) => standard === "OMM")
    .map(({ nodeId, source, data }) => {
      assert.equal(nodeId, "publication");
      assert.equal(source, "supplemental-omm");
      return decodeOmm(data);
    })
    .sort((left, right) => {
      const a = `${left.OBJECT_NAME}\0${left.EPOCH}`;
      const b = `${right.OBJECT_NAME}\0${right.EPOCH}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  assert.deepEqual(
    omms.map(({ OBJECT_NAME, EPOCH, NORAD_CAT_ID, sha256: recordSha256 }) => [
      OBJECT_NAME,
      EPOCH,
      NORAD_CAT_ID,
      recordSha256,
    ]),
    expectedOmmRecords,
  );
  for (const expected of expectedElements) {
    const actual = omms.find(
      ({ OBJECT_NAME, EPOCH }) =>
        OBJECT_NAME === expected.OBJECT_NAME && EPOCH === expected.EPOCH,
    );
    assert.ok(actual, `${expected.OBJECT_NAME} ${expected.EPOCH} was not published`);
    const { sha256: _recordSha256, ...elements } = actual;
    assert.deepEqual(elements, expected);
  }
});

// Every OMM the flow publishes for the fixtures above, in OBJECT_NAME then
// EPOCH order: [OBJECT_NAME, EPOCH, NORAD_CAT_ID, sha256 of the record].
// OD 1.0.1 hands the position-only providers' states (GLONASS SP3, Intelsat
// ECF, CPF) to the fit core as position-only, so their 28 records differ from
// the OD 1.0.0 bundle's; the 2 Starlink and 1 ISS records are byte for byte
// the same, and every record keeps its epoch.
const expectedOmmRecords = [
  ["GLONASS R01", "2026-07-10T23:59:42.000017Z", 99999, "e912da8a8633aaf4ba019839177d4a6f0418df80c85952869961309b60c2d94f"],
  ["GLONASS R02", "2026-07-10T23:59:42.000017Z", 99999, "3def222a6a69e3c8443062d5a14cc13624c9e6004c499bb39489c806488ca1c4"],
  ["GLONASS R03", "2026-07-10T23:59:42.000017Z", 99999, "38badf7d03ad2c35af3ebc70c81937b16e465c7571f231bb033823a59262598e"],
  ["GLONASS R04", "2026-07-10T23:59:42.000017Z", 99999, "5b74b7c6118c21dcc3eb7b9cac0d179101f57af3425b1e5f93156b5e552be8ac"],
  ["GLONASS R05", "2026-07-10T23:59:42.000017Z", 99999, "783680096b7fbd3632b266a6bffb77cdde28a65c8ff02046f48ec4c2f48e32f0"],
  ["GLONASS R06", "2026-07-10T23:59:42.000017Z", 99999, "728cadc49d92d3597fec3e18c1743611c6c902583525aacd46be0e6371d266db"],
  ["GLONASS R07", "2026-07-10T23:59:42.000017Z", 99999, "e28d7ef265aa2f92bf4188d9a20bcc3ef3fb487e1fd985c939bc008df81f1231"],
  ["GLONASS R08", "2026-07-10T23:59:42.000017Z", 99999, "5e410b6b4f84cf8af71f8b24ea9fd51c7a4412a18fa9447297b4c330b6420b09"],
  ["GLONASS R09", "2026-07-10T23:59:42.000017Z", 99999, "2cd00e8da80d5efde0c7e213b2528128165b092cd485490d12a2a02c81b84804"],
  ["GLONASS R10", "2026-07-10T23:59:42.000017Z", 99999, "0f115d39f9f4027a00b10b24ec34396a099eec259c4783c84e76b0d4d3fe46ec"],
  ["GLONASS R11", "2026-07-10T23:59:42.000017Z", 99999, "480b7673b635ca8ba64487e41079d91f4bded8eeda8c2ee72863f88808f92617"],
  ["GLONASS R12", "2026-07-10T23:59:42.000017Z", 99999, "3157955b4430c5bbfe0596c0d1d216df2296ed9e0c06b2a839a6d34d3b0ac648"],
  ["GLONASS R13", "2026-07-10T23:59:42.000017Z", 99999, "451c09bd7a837da8dda2be404a21de73af051c57e1e79007f093b5e809dc1b18"],
  ["GLONASS R14", "2026-07-10T23:59:42.000017Z", 99999, "e145223d476439f1c6565c20f6efc8e15bf701ae71f3c0d20b11bdbd119afd38"],
  ["GLONASS R15", "2026-07-10T23:59:42.000017Z", 99999, "466b193381260c42befbfa21cd0391ace8724ccff4cfc9ecb2549a0ed00f9129"],
  ["GLONASS R16", "2026-07-10T23:59:42.000017Z", 99999, "ffb8c0cf4e2f26a484464d1026fcc889eb1c24f4eee9d517d5bcbc19badb8c7f"],
  ["GLONASS R17", "2026-07-10T23:59:42.000017Z", 99999, "c46a75bb63b5bcf83160817fcf1b61b632fe7c14aeb3c1797c9aa4adf4768234"],
  ["GLONASS R18", "2026-07-10T23:59:42.000017Z", 99999, "f67f1670b87e23bd7fd3206f3f4071894f25991c3e4d7cb0f4e91d2519be9dc6"],
  ["GLONASS R19", "2026-07-10T23:59:42.000017Z", 99999, "d101c60978bce8032b3d6c3a982aef60ba57dcde58fce7a6be470d5bef0b3a09"],
  ["GLONASS R20", "2026-07-10T23:59:42.000017Z", 99999, "90f02d24973a4b34805ed8405b40535cce454a0e167c2d80b3d8e05f5aac75fa"],
  ["GLONASS R21", "2026-07-10T23:59:42.000017Z", 99999, "05fa996fda4086d72857714a82a62680ca80cc72b4c2a9f6ccc3d3f5651a3680"],
  ["GLONASS R22", "2026-07-10T23:59:42.000017Z", 99999, "709134d57832f2d10ef4a412a58492c06e4bd0bc6430d5f4b288503c686bd531"],
  ["GLONASS R23", "2026-07-10T23:59:42.000017Z", 99999, "b099f3b918995f0fdd5b03c6b8fe3cc3f6c2d299e767891e24a97475712163dd"],
  ["GLONASS R24", "2026-07-10T23:59:42.000017Z", 99999, "e16257e475e5690cad65ac71461d4bd85253407f20c7971f17ceaa9327c80255"],
  ["GLONASS R26", "2026-07-10T23:59:42.000017Z", 99999, "25354ef92a22d8ae8c4d58af13e0746adb3e00ff6f080aa6cc329beb1dcb71cb"],
  ["IS-21", "2026-07-10T23:53:00.000025Z", 99999, "6aeef7fc854f0f4ca7904f4d81374ab91a05cae7783c465e7672290e96ca941f"],
  ["IS-21", "2026-07-11T02:23:00.000012Z", 99999, "f9ffb7d663fc83cd6ab606b570c0f7dd152cb4a1089f2f5b3fe79dee3bb487a4"],
  ["ISS", "2026-07-13T12:00:00.000000Z", 25544, "8da9171dc893962a8a29b50eab7a7743654802baf800f4797299e751be65e429"],
  ["STARLINK-36348", "2026-05-14T01:49:41.999986Z", 67851, "515b1109ce1403bc1d455c7a63c97f87f2f34c4539b31e8bcf1b991d74b7adc6"],
  ["STARLINK-36840", "2026-05-14T01:42:42.000011Z", 67850, "89032119817a3cdca54518e9913d11fecf30ee6ad63b3bc0c107c80502412fdd"],
  ["lageos1", "2026-07-13T00:00:00.000000Z", 8820, "f14582aa809fb2d2d7102733d507d5ae08b754f72de0a91bf4da0b6da671bd5c"],
];

// Decoded elements of one record from each of the five providers.
const expectedElements = [
  {
    OBJECT_NAME: "STARLINK-36840",
    OBJECT_ID: "99999A  ",
    NORAD_CAT_ID: 67850,
    EPOCH: "2026-05-14T01:42:42.000011Z",
    MEAN_MOTION: 15.301894153001616,
    ECCENTRICITY: 5.609996696863168e-5,
    INCLINATION: 53.159501720367686,
    RA_OF_ASC_NODE: 260.2663656194409,
    ARG_OF_PERICENTER: 66.0733034892524,
    MEAN_ANOMALY: 173.07451151887278,
    BSTAR: 5.2798734947356036e-9,
  },
  {
    OBJECT_NAME: "GLONASS R02",
    OBJECT_ID: "99999A  ",
    NORAD_CAT_ID: 99999,
    EPOCH: "2026-07-10T23:59:42.000017Z",
    MEAN_MOTION: 2.1310387195092497,
    ECCENTRICITY: 0.002256549366590885,
    INCLINATION: 65.43259296672403,
    RA_OF_ASC_NODE: 72.80591057818367,
    ARG_OF_PERICENTER: 231.05240933930656,
    MEAN_ANOMALY: 249.67066555508575,
    BSTAR: -7.64451586260981e-6,
  },
  {
    OBJECT_NAME: "IS-21",
    OBJECT_ID: "99999A  ",
    NORAD_CAT_ID: 99999,
    EPOCH: "2026-07-10T23:53:00.000025Z",
    MEAN_MOTION: 1.0026291760926132,
    ECCENTRICITY: 0.0001445212845317564,
    INCLINATION: 0.04700110748759116,
    RA_OF_ASC_NODE: 201.31528170888714,
    ARG_OF_PERICENTER: 314.76507001063226,
    MEAN_ANOMALY: 73.07683705249877,
    BSTAR: -8.18360918329852e-7,
  },
  {
    OBJECT_NAME: "ISS",
    OBJECT_ID: "1998-067-A",
    NORAD_CAT_ID: 25544,
    EPOCH: "2026-07-13T12:00:00.000000Z",
    MEAN_MOTION: 15.48975373516196,
    ECCENTRICITY: 0.0006672965003946375,
    INCLINATION: 51.628316503027186,
    RA_OF_ASC_NODE: 169.8716410632045,
    ARG_OF_PERICENTER: 292.94599165779107,
    MEAN_ANOMALY: 20.275789012506095,
    BSTAR: 0.00026845326934726095,
  },
  {
    OBJECT_NAME: "lageos1",
    OBJECT_ID: "7603901",
    NORAD_CAT_ID: 8820,
    EPOCH: "2026-07-13T00:00:00.000000Z",
    MEAN_MOTION: 6.3866795614990695,
    ECCENTRICITY: 0.004465297163381733,
    INCLINATION: 109.8038341797344,
    RA_OF_ASC_NODE: 188.16725802572944,
    ARG_OF_PERICENTER: 296.8074215691362,
    MEAN_ANOMALY: 264.53776546788595,
    BSTAR: 3.9999999999999996e-13,
  },
];
