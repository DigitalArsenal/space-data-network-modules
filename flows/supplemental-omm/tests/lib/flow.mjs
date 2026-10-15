// What the Supplemental OMM tests share: the provider fixtures served as the providers serve them, the legacy records,
// a release built with a key the test generates and throws away, and that release run in the SDK's isomorphic flow host
// with the host side of every hostcall (plugin.getConfig, http.request, storage.ingest_with_source) answered here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSingleFileBundle, verifyModuleArtifact } from "space-data-module-sdk";
import { createIsomorphicFlowRuntimeHost } from "space-data-module-sdk/flow";
import { decodeDss, decodeFlowNotice, decodeHttpResponse, decodeIngestResult, encodeTimerTick, identifierOf } from "./sds.mjs";

export const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
export const modulesRoot = path.resolve(packageRoot, "../..");
const dataSource = (p) => new Uint8Array(fs.readFileSync(path.join(modulesRoot, "data-source", p)));

export const PUBLISH_URL = "http://127.0.0.1:5003/api/v1/admin/dataset-updates/publish";
export const CODE_SP3 = "https://www.aiub.unibe.ch/download/CODE/COD0OPSULT.SP3";
const starlinkBase = "https://api.starlink.com/public-files/ephemerides/";
export const STARLINK_FILES = [
  "MEME_67850_STARLINK-36840_1340142_Operational_1463017380_UNCLASSIFIED.txt",
  "MEME_67851_STARLINK-36348_1340149_Operational_1463017800_UNCLASSIFIED.txt",
];
const intelsatUnit = "i_aor_e_302.00_is-21_20260710_235300";
const cpfListing = "https://edc.dgfi.tum.de/pub/slr/cpf_predicts_v2/2026/lageos1/";

// The fixtures of the source modules, at the URLs the providers serve them from (the legacy flow's known-answer set).
export function fixtureResponses() {
  return new Map([
    [`${starlinkBase}MANIFEST.txt`, new TextEncoder().encode(`${STARLINK_FILES.join("\n")}\n`)],
    ...STARLINK_FILES.map((file) => [`${starlinkBase}${file}`, dataSource(`spacex-starlink-source/tests/fixtures/meme/${file}`)]),
    [CODE_SP3, dataSource("glonass-source/test/fixtures/synthetic_glonass.sp3.glo")],
    ["https://my.intelsat.com/ephemeris/public", dataSource("intelsat-source/test/fixtures/ephemeris_public.sample.html")],
    [`https://my.intelsat.com/Resource/Ephemeris/${intelsatUnit}.txt`, dataSource(`intelsat-source/test/fixtures/${intelsatUnit}.sample.txt`)],
    [cpfListing, dataSource("cpf-source/test/fixtures/listing.sample.html")],
    [`${cpfListing}lageos1_cpf_260713_19402.dgf`, dataSource("cpf-source/test/fixtures/lageos1_cpf_260713_19402.sample.dgf")],
    ["https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt", dataSource("iss-source/test/fixtures/ISS.OEM_J2K_EPH.sample.txt")],
  ]);
}

// A GET of a fixture, a leading byte range answered 206 as the provider would; anything else 404.
export function serve(responses, { url, method, headers = {}, body }) {
  if (url === PUBLISH_URL) {
    assert.equal(method, "POST");
    return { url, status: 202, headers: {}, body: new Uint8Array(0), posted: body };
  }
  assert.equal(method, "GET", url);
  const file = responses.get(url);
  if (!file) return { url, status: 404, headers: {}, body: new Uint8Array(0) };
  const range = /^bytes=0-(\d+)$/.exec(headers.range ?? headers.Range ?? "");
  if (range) {
    const end = Math.min(Number(range[1]), file.length - 1);
    return { url, status: 206, headers: { "content-range": `bytes 0-${end}/${file.length}` }, body: file.subarray(0, end + 1) };
  }
  return { url, status: 200, headers: {}, body: file };
}

// The record streams the legacy flow (release 1.0.1, the FSB/JSON lane) published for these fixtures, in publication
// order (tests/fixtures/legacy/PROVENANCE.md).
export function legacyRecords(standard) {
  const bytes = fs.readFileSync(new URL(`../fixtures/legacy/${standard.toLowerCase()}-records.bin`, import.meta.url));
  return splitRecords(bytes);
}

export function splitRecords(stream) {
  const bytes = Buffer.from(stream);
  const out = [];
  for (let at = 0; at < bytes.length;) {
    const length = bytes.readUInt32LE(at);
    out.push(bytes.subarray(at, at + 4 + length));
    at += 4 + length;
  }
  return out;
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The release, built once per test process by scripts/release.mjs with a key generated here and thrown away: the
// signed bundle, its parsed entries and the throwaway public key.
let release;
export function buildRelease() {
  release ??= (() => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "supplemental-omm-release-"));
    const stdout = execFileSync(process.execPath, [path.join(packageRoot, "scripts/release.mjs"), "--out", out], {
      env: {
        ...process.env,
        NODE_ENV: "",
        SUPPLEMENTAL_OMM_BUILD_MODE: "",
        SUPPLEMENTAL_OMM_SIGNING_SEED_HEX: randomBytes(32).toString("hex"),
        SUPPLEMENTAL_OMM_SIGNING_KEY_ID: "throwaway-test-key",
      },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const summary = JSON.parse(stdout.trim().split("\n").at(-1));
    return { out, summary, bundle: new Uint8Array(fs.readFileSync(path.join(out, "isomorphic/module.wasm"))) };
  })();
  return release;
}

export async function openRelease() {
  const { bundle, summary, out } = buildRelease();
  const verified = await verifyModuleArtifact(bundle, { trustedPublicKeys: [summary.publicKeyHex], requireSignature: true });
  assert.equal(verified.verified, true);
  const parsed = await parseSingleFileBundle(bundle);
  const entries = new Map(parsed.entries.map((entry) => [entry.entryId, entry]));
  const artifact = JSON.parse(new TextDecoder().decode(entries.get("artifact.json").payloadBytes));
  return { bundle, summary, out, entries, artifact };
}

// The release in the isomorphic flow host. `config` is each plugin's node config (plugin.getConfig); the host answers
// http.request from `responses` and storage.ingest_with_source by storing the records here.
export async function runRelease({ config = {}, responses = fixtureResponses(), ticks = 1 } = {}) {
  const { bundle, summary, entries, artifact } = await openRelease();
  const calls = [];
  const ingests = [];
  const plugins = [...new Set(artifact.nodeArtifacts.map((node) => node.pluginId))];
  const children = plugins.map((pluginId) => {
    const descriptor = artifact.nodeArtifacts.find((node) => node.pluginId === pluginId);
    return {
      pluginId,
      wasmSource: entries.get(descriptor.entryId).payloadBytes,
      verifySignature: { trustedPublicKeys: [summary.publicKeyHex], requireSignature: true },
      hostcallDispatch(operation, params) {
        calls.push({ pluginId, operation, params });
        if (operation === "plugin.getConfig") return config[pluginId] ?? {};
        if (operation === "http.request") return serve(responses, params);
        if (operation === "storage.ingest_with_source") {
          const records = splitRecords(params.records);
          ingests.push({ ...params, records });
          return { schema: params.schema, batch_id: params.batch_id, inserted: records.length };
        }
        throw new Error(`${pluginId} asked for ${operation}`);
      },
    };
  });
  const host = await createIsomorphicFlowRuntimeHost({ wasmSource: bundle, children });
  const egress = { results: [], notices: [], publications: [] };
  const routes = new Map();
  const handlers = {
    "sdn.flow.egress:emit": ({ frames }) => {
      for (const frame of frames) {
        const id = identifierOf(frame.bytes);
        if (id === "INGR") egress.results.push(decodeIngestResult(frame.bytes));
        else if (id === "FNTC") egress.notices.push(decodeFlowNotice(frame.bytes));
        else if (id === "HRSP") egress.publications.push(decodeHttpResponse(frame.bytes));
        else assert.fail(`an egress frame of no runtime type: ${id}`);
      }
      return { statusCode: 0 };
    },
  };
  // The status board reads the route outputs of the status child (runtimeNodeRoutes); the test keeps the last $DSS of
  // each by watching that child's invocations.
  const status = host.children.get("status");
  const invoke = status.harness.invoke.bind(status.harness);
  status.harness.invoke = async (request) => {
    const response = await invoke(request);
    for (const frame of response.outputs ?? []) routes.set(frame.portId, decodeDss(frame.payload));
    return response;
  };
  try {
    for (let tick = 0; tick < ticks; tick += 1) {
      host.enqueueTriggerFrame(0, {
        portId: "tick",
        typeRef: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" },
        bytes: encodeTimerTick({ triggerId: "timer-supplemental-omm", scheduledMs: Date.UTC(2026, 6, 21, 12 + tick), firedMs: Date.UTC(2026, 6, 21, 12 + tick) }),
      });
      await host.drain({ handlers, maxIterations: 100000 });
    }
  } finally {
    host.destroy();
  }
  return { calls, ingests, egress, routes, artifact, summary };
}
