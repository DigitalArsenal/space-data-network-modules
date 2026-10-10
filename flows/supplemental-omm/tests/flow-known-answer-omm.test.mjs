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
      fixture("glonass-source/test/fixtures/synthetic_glonass.sp3.glo"),
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
// The GLONASS and Intelsat fixtures are synthetic (analysis/od/scripts/
// synthetic-fixtures.mjs): their records were re-pinned from this flow on those
// files. OD 1.0.1 hands the position-only providers' states (GLONASS SP3, Intelsat
// ECF, CPF) to the fit core as position-only, so their 28 records differ from
// the OD 1.0.0 bundle's; the 2 Starlink and 1 ISS records are byte for byte
// the same, and every record keeps its epoch.
const expectedOmmRecords = [
  ["GLONASS R01", "2026-07-10T23:59:42.000017Z", 99999, "9d0af571d64b5afd72fc8ea8886e023f9fc60ed1d4a6345e15c9f2a62b3d2d18"],
  ["GLONASS R02", "2026-07-10T23:59:42.000017Z", 99999, "5d981404d14fb0203cbe378edeaabfc9104cb0916d6db5e06954748ef7171e98"],
  ["GLONASS R03", "2026-07-10T23:59:42.000017Z", 99999, "8cbd59273c6d396fa05597d5dbb7394868691857736d339ee0a9c56759458f54"],
  ["GLONASS R04", "2026-07-10T23:59:42.000017Z", 99999, "b87001abeae3b5a5bc19555fca066aa334237db1cf290703e7331688cfc38816"],
  ["GLONASS R05", "2026-07-10T23:59:42.000017Z", 99999, "e6f367afda806acd4276b7744e56f3f6bb9da990f65016d7f27e58244e1a7b23"],
  ["GLONASS R06", "2026-07-10T23:59:42.000017Z", 99999, "6d23273b8cb9b41736f09f9d1bd28c11e2dd14a951acfd82ec27c9a16fc886d4"],
  ["GLONASS R07", "2026-07-10T23:59:42.000017Z", 99999, "b9eb73715118d5e59ad56be3d0f85082caa9915d2bfdbb471cf6ae80e73971bd"],
  ["GLONASS R08", "2026-07-10T23:59:42.000017Z", 99999, "99ea1845c5c005ba9e445de08c5687a0e7351c5f14e44cc2626e864bea843b6d"],
  ["GLONASS R09", "2026-07-10T23:59:42.000017Z", 99999, "51e96c19d213b1ea6160e9430d23634aac79e438aacd30d19c91eaea1018187a"],
  ["GLONASS R10", "2026-07-10T23:59:42.000017Z", 99999, "9214f72f35f860542378cad031a49ae705cbd31b1d1849045395d95aa6e5ccca"],
  ["GLONASS R11", "2026-07-10T23:59:42.000017Z", 99999, "99fd6e242e505f6fa2d0a6569679d3500de73e69371ad428fa42a38e037530a5"],
  ["GLONASS R12", "2026-07-10T23:59:42.000017Z", 99999, "50c218fb5e8223b184755f6cfe9a23a1181a6ac2388a992cd6b63d13f0b08942"],
  ["GLONASS R13", "2026-07-10T23:59:42.000017Z", 99999, "62b9834cc8ef6bff621c79afa6d5f95fc4f5c84877e4c773a4afc2595ce7a9ee"],
  ["GLONASS R14", "2026-07-10T23:59:42.000017Z", 99999, "2b750d549f8dd04408556d9e4d88e8bf9e9745ba314f692e36bf8c33465f30ec"],
  ["GLONASS R15", "2026-07-10T23:59:42.000017Z", 99999, "dc0f1e151898efa018557686a25a7779cb286502a99ed8a3cacf3b567d34f7c4"],
  ["GLONASS R16", "2026-07-10T23:59:42.000017Z", 99999, "4865f677c563417cc61be36c4791a1e06197e484a669a3d3e655a8f70dfcaa78"],
  ["GLONASS R17", "2026-07-10T23:59:42.000017Z", 99999, "b2d52f9864b1e0fe81f6788821ecbdce423102f4c13e775774d1f130f7cf39d9"],
  ["GLONASS R18", "2026-07-10T23:59:42.000017Z", 99999, "793c0bfc3fd9c436f11daf6f3fcc63ba795b6e7b9d914750e11d61e89d22afc8"],
  ["GLONASS R19", "2026-07-10T23:59:42.000017Z", 99999, "e1d3f446150826442b6bc21d4c7b07ad79f31ad18ba21ae9b33e9ea8ce86e82c"],
  ["GLONASS R20", "2026-07-10T23:59:42.000017Z", 99999, "f01673c6e770553717f3c42bcef81d01c7fe29177faacd08a7fb8b5abcbfcbdd"],
  ["GLONASS R21", "2026-07-10T23:59:42.000017Z", 99999, "1e2c2ece28381b6ee54b2b278aab572f49f869f670a1fa09c6d318c1ff462932"],
  ["GLONASS R22", "2026-07-10T23:59:42.000017Z", 99999, "de20d7226a2138b96ba195c41d28868e9feb99d179d247148051d4b29af7d603"],
  ["GLONASS R23", "2026-07-10T23:59:42.000017Z", 99999, "f2255ba066dd464ba9af64c4750b87e32bf70e67a46bf748385bcf9f01eb003c"],
  ["GLONASS R24", "2026-07-10T23:59:42.000017Z", 99999, "a597de92b74ad799fd0ef4a94ad5ce01bf5c45fd08e0826aef22d12c29efb70c"],
  ["GLONASS R26", "2026-07-10T23:59:42.000017Z", 99999, "6d2434e625d8400a3fbf14e2c9349fc8804f89761701783dfbe2b64e50195c09"],
  ["ISS", "2026-07-13T12:00:00.000000Z", 25544, "8da9171dc893962a8a29b50eab7a7743654802baf800f4797299e751be65e429"],
  ["STARLINK-36348", "2026-05-14T01:49:41.999986Z", 67851, "515b1109ce1403bc1d455c7a63c97f87f2f34c4539b31e8bcf1b991d74b7adc6"],
  ["STARLINK-36840", "2026-05-14T01:42:42.000011Z", 67850, "89032119817a3cdca54518e9913d11fecf30ee6ad63b3bc0c107c80502412fdd"],
  ["SYN-GEO-1", "2026-07-10T23:53:00.000025Z", 99999, "42d8bb14ceec1fb4d64b7f12792934500000b4880de79a0d0f0c818f2153c0a1"],
  ["SYN-GEO-1", "2026-07-11T02:23:00.000012Z", 99999, "ae95b631f281168ba3844828698b6046d8f1ae3c92a654e4f8f28a6843924ca8"],
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
    MEAN_MOTION: 2.1312812853151017,
    ECCENTRICITY: 0.0008401363658932432,
    INCLINATION: 64.72483164297341,
    RA_OF_ASC_NODE: 30.28535950906229,
    ARG_OF_PERICENTER: 6.654287931986289,
    MEAN_ANOMALY: 45.00188632666817,
    BSTAR: 0,
  },
  {
    OBJECT_NAME: "SYN-GEO-1",
    OBJECT_ID: "99999A  ",
    NORAD_CAT_ID: 99999,
    EPOCH: "2026-07-10T23:53:00.000025Z",
    MEAN_MOTION: 1.0024838254053225,
    ECCENTRICITY: 8.1999012951173e-05,
    INCLINATION: 0.062005925725525615,
    RA_OF_ASC_NODE: 148.00734162161234,
    ARG_OF_PERICENTER: 211.99267435254262,
    MEAN_ANOMALY: 229.16697826325992,
    BSTAR: 9.646000642578745e-06,
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
