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
// The pre-rename release bundle (7ade2cf3, provider IDs com.orbpro.*-source)
// publishes these same 31 records byte for byte: the OD node is unchanged, and
// the rename moves node identity only.
const expectedOmmRecords = [
  ["GLONASS R01", "2026-07-10T23:59:42.000017Z", 99999, "92ac64cf6e9aa05139731b79c8540a5c0930406b991394dd7654250dbc9cefe6"],
  ["GLONASS R02", "2026-07-10T23:59:42.000017Z", 99999, "fa69f7001e3d3acb004fa4c76fcf07a1fa0552f6f9a0f87f7a0443984d886f2a"],
  ["GLONASS R03", "2026-07-10T23:59:42.000017Z", 99999, "47e87fe0899d91bb3209d738fb13cef07bcad901c0cedef38ab28c1101ef105e"],
  ["GLONASS R04", "2026-07-10T23:59:42.000017Z", 99999, "998f9fc024ab12ab0afa9fb2baeea9de3c85a6d63dd849b47443143cb8332e52"],
  ["GLONASS R05", "2026-07-10T23:59:42.000017Z", 99999, "7fa048e49ee1bf9eb36613cf5caffb3e9d15077ee035e09b919761f201c6941f"],
  ["GLONASS R06", "2026-07-10T23:59:42.000017Z", 99999, "8c2cb371b9e06f8de310fc0ea571339c1b8e4d55bd012413e4d8931cd9efb4a1"],
  ["GLONASS R07", "2026-07-10T23:59:42.000017Z", 99999, "7e07b3f094946cb3ccdb1a483f0f2ffc9c3fa1d2e7395b1b16be9288989426e6"],
  ["GLONASS R08", "2026-07-10T23:59:42.000017Z", 99999, "4079e3ca827aab2a70e6fa7d4cf871e0e2392a6fd0e15bcee52e423ce4e13c6c"],
  ["GLONASS R09", "2026-07-10T23:59:42.000017Z", 99999, "5f3c8958be3c1142dc28d861fba5d4a2e4a0eae63fb5e58f9741c50f14d5d3a5"],
  ["GLONASS R10", "2026-07-10T23:59:42.000017Z", 99999, "aeb2bcb60f126663a6478e6d7e4618461b9d0bb02fa22d99a4afe9ffff4c21b0"],
  ["GLONASS R11", "2026-07-10T23:59:42.000017Z", 99999, "42356ea748f6bb7b60e1a0b9ea9d5c2772a82c55fae1b39d312a3bdb8721a53a"],
  ["GLONASS R12", "2026-07-10T23:59:42.000017Z", 99999, "85de26c21e8742a38363c9d7ffcee5bc873cf09cc2ca961771abe717f4e9548f"],
  ["GLONASS R13", "2026-07-10T23:59:42.000017Z", 99999, "cf48d10c32cf8cb543ab4c95a35ac73887dab5b85f2bb82ab3a64a4c0bbd0328"],
  ["GLONASS R14", "2026-07-10T23:59:42.000017Z", 99999, "39d8f8493071f75bb81c2238ed5576ee6a08b9d0a37f6d787607dc96cf65dd92"],
  ["GLONASS R15", "2026-07-10T23:59:42.000017Z", 99999, "4cd7565614c24bfea9f8d7c6211cdd98293b71a2bc61dbbcde26246842fe97d7"],
  ["GLONASS R16", "2026-07-10T23:59:42.000017Z", 99999, "e875f08879213dcc681d6b827d022655e57e82dde67628c271fb8a8a9aed8e01"],
  ["GLONASS R17", "2026-07-10T23:59:42.000017Z", 99999, "7016bbd593b01bddfe6e879dec029ae93380108202c5f56e818aa063bc5b8e5a"],
  ["GLONASS R18", "2026-07-10T23:59:42.000017Z", 99999, "8be94a87b1774aca68c46753fd4f9a36ee92e97f284fca5e7d64ab07090b68e2"],
  ["GLONASS R19", "2026-07-10T23:59:42.000017Z", 99999, "c64eaa525241b594cdc0eb3239bf8c584228af1dcf95fb71e5483f9498ed7810"],
  ["GLONASS R20", "2026-07-10T23:59:42.000017Z", 99999, "999231eefbafd2d4c56d90005b10deaacb82481395c846a9edaec2d0c16041d6"],
  ["GLONASS R21", "2026-07-10T23:59:42.000017Z", 99999, "76ede1af68e46c79cf6643687b683196171b8877962990c9c15c6d416269f790"],
  ["GLONASS R22", "2026-07-10T23:59:42.000017Z", 99999, "fa139f4e206d5ef5669726205c8ee4a286880c3861498fc57091ddcf3e8b19ae"],
  ["GLONASS R23", "2026-07-10T23:59:42.000017Z", 99999, "d64c70ae1a0311841fb9194c2a1e3ede1e1a3505cf59d4eb2555686423735922"],
  ["GLONASS R24", "2026-07-10T23:59:42.000017Z", 99999, "c77e4b7849baba83d70c9ce4ed8774290eaf6a31f99a369bb06fc77ad0000356"],
  ["GLONASS R26", "2026-07-10T23:59:42.000017Z", 99999, "d59bc3d66dd3d6a2bda72898d55a1509fd7c211fce9463b2706b6717a6c7f383"],
  ["IS-21", "2026-07-10T23:53:00.000025Z", 99999, "6b11365b7cd4055d3cb99214e15881a2be484b98c0939e297adc658c9a204799"],
  ["IS-21", "2026-07-11T02:23:00.000012Z", 99999, "3ada772e84b92b3c49111c7dfb1ec3762fc0c0d65384a43e027eb19153e8f395"],
  ["ISS", "2026-07-13T12:00:00.000000Z", 25544, "8da9171dc893962a8a29b50eab7a7743654802baf800f4797299e751be65e429"],
  ["STARLINK-36348", "2026-05-14T01:49:41.999986Z", 67851, "515b1109ce1403bc1d455c7a63c97f87f2f34c4539b31e8bcf1b991d74b7adc6"],
  ["STARLINK-36840", "2026-05-14T01:42:42.000011Z", 67850, "89032119817a3cdca54518e9913d11fecf30ee6ad63b3bc0c107c80502412fdd"],
  ["lageos1", "2026-07-13T00:00:00.000000Z", 8820, "5b0d051a58e48154092e110bc611bd174292ef51eb8d556ae919129e07624436"],
];

// Decoded elements of one record from each of four providers. The CPF
// fixture is a 12-point, 11-minute arc, so lageos1 is pinned by its bytes
// above only.
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
    MEAN_MOTION: 2.1387853537613033,
    ECCENTRICITY: 0.003121145969060933,
    INCLINATION: 65.43714765235278,
    RA_OF_ASC_NODE: 72.79976015240277,
    ARG_OF_PERICENTER: 287.2002397439254,
    MEAN_ANOMALY: 193.37466930518474,
    BSTAR: -0.00016926659344752913,
  },
  {
    OBJECT_NAME: "IS-21",
    OBJECT_ID: "99999A  ",
    NORAD_CAT_ID: 99999,
    EPOCH: "2026-07-10T23:53:00.000025Z",
    MEAN_MOTION: 1.002668396511494,
    ECCENTRICITY: 0.00015075245015639752,
    INCLINATION: 3.20805826372717e-5,
    RA_OF_ASC_NODE: 19.75244992208752,
    ARG_OF_PERICENTER: 126.66043042500746,
    MEAN_ANOMALY: 82.74327474450934,
    BSTAR: 1.4056863916975598e-6,
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
];
