// Shared test plumbing for data-source/geonames-source on the typed contracts (1.0): the compiled wasm in the SDK
// browser harness, HttpResponse (HRSP) frames in, $GNP streams and FlowNotice (FNTC) frames out, the job a size-prefixed
// $GNP header record in the response's CONTEXT (exactly what geonames-ingest plans and hostcap/http-request echoes), and
// the node config the SDS $PIV plugin.getConfig answer (one ModuleConfig on raw "config", served by the SDK host).

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  decodeFlowNotice,
  decodeHostCall,
  decodeHttpResponse,
  encodeHttpResponse,
  identifierOf,
} from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

export const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
export const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);
export const STANDARDS_ROOT =
  process.env.SPACE_DATA_STANDARDS_ROOT ?? fileURLToPath(new URL("../../../../spacedatastandards.org/", import.meta.url));
const GNP_LIB = pathToFileURL(path.join(STANDARDS_ROOT, "lib/js/GNP/main.js"));
export const flatbuffers = createRequire(GNP_LIB)("flatbuffers");
export const gnpLib = await import(GNP_LIB.href);

export const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

export const TYPE = {
  HRSP: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
};

// The job as geonames-ingest plans it: ONE size-prefixed $GNP header record. ID = the id prefix, NAME = the text the
// job decodes (the archive member of a .zip edition), SOURCE = the dataset contract. Keys left undefined are not written.
export function jobHeader(job = {}) {
  const { GNPT, GNPProvenanceT } = gnpLib;
  const source = new GNPProvenanceT(
    job.datasetId ?? null, job.datasetName ?? null, job.datasetUrl ?? null, job.datasetEpoch ?? null, null,
    job.sourceUrl ?? null, job.sourceQuery ?? null, "", job.license ?? null, job.licenseUrl ?? null,
    job.attribution ?? null, !!job.nonCommercialOnly, !!job.shareAlike, "", null,
  );
  const header = new GNPT(job.idPrefix ?? "geonames", job.name ?? "");
  header.DEM_MODEL = job.demModel ?? null;
  header.SOURCE = source;
  const b = new flatbuffers.Builder(512);
  b.finishSizePrefixed(header.pack(b), "$GNP");
  return b.asUint8Array().slice();
}

// The delta lane's job for the 2026-08-14 modifications slice (tests/fixtures/PROVENANCE.md).
export const JOB = {
  idPrefix: "geonames",
  name: "modifications-2026-08-14.txt",
  datasetId: "geonames",
  datasetName: "GeoNames gazetteer",
  datasetUrl: "https://download.geonames.org/export/dump/",
  datasetEpoch: "2026-08-14T00:00:00.000Z",
  sourceUrl: "https://download.geonames.org/export/dump/modifications-2026-08-14.txt",
  sourceQuery: "modifications-2026-08-14.txt",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
  attribution: "GeoNames (CC BY 4.0)",
};
export const SEED_JOB = { ...JOB, name: "cities15000.txt", sourceQuery: "cities15000.zip", sourceUrl: "https://download.geonames.org/export/dump/cities15000.zip" };

// An HttpResponse frame as hostcap/http-request answers it (headers lower-case).
export function responseFrame(portId, body, { status = 200, headers = {}, job, context, url = "", error = "", retrievedMs = 0 } = {}) {
  return {
    portId,
    typeRef: TYPE.HRSP,
    payload: encodeHttpResponse({
      url, status, headers, body: Uint8Array.from(Buffer.from(body ?? "")),
      context: context ?? (job ? jobHeader(job) : new Uint8Array(0)), error, retrievedMs,
    }),
  };
}

// The node config is served by the SDK's own host (hostOptions.config): plugin.getConfig answers one ModuleConfig
// (MCFG) on raw "config", exactly what the Go node answers. The hostcall import is wrapped only to record each call;
// any other hostcall would be refused by the host (this plugin performs no I/O, and the tests assert so).
export async function createHarness(t, config = {}) {
  const calls = [];
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (module, imports) => {
    const host = imports.space_data_module_host;
    const wrapped = { ...imports, space_data_module_host: { ...host,
      call: (opPtr, opLen, ptr, len) => {
        calls.push(decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice()));
        return host.call(opPtr, opLen, ptr, len);
      },
    } };
    let memory;
    const instance = await instantiate(module, wrapped);
    memory = (instance.instance ?? instance).exports.memory;
    return instance;
  };
  let harness;
  try {
    harness = await createBrowserModuleHarness({
      wasmSource: new Uint8Array(fs.readFileSync(ISOMORPHIC_WASM_PATH)),
      manifest: JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")),
      surface: "direct",
      hostOptions: { config },
    });
  } finally {
    WebAssembly.instantiate = instantiate;
  }
  t.after(() => harness.destroy());
  harness.calls = calls;
  return harness;
}

export async function invoke(t, methodId, inputs, config = {}) {
  const harness = await createHarness(t, config);
  const response = await harness.invoke({ methodId, inputs });
  response.calls = harness.calls;
  return response;
}

// Outputs by port, each frame decoded by its file identifier; a port may carry several frames.
export function outputsByPort(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const map = new Map();
  for (const out of response.outputs) {
    const id = identifierOf(out.payload);
    const value = id === "FNTC" ? decodeFlowNotice(out.payload) : id === "HRSP" ? decodeHttpResponse(out.payload) : Buffer.from(out.payload);
    if (!map.has(out.portId)) map.set(out.portId, []);
    map.get(out.portId).push(value);
  }
  return map;
}

// FlowNotice ITEMS "key=value" as an object.
export const itemsOf = (notice) => Object.fromEntries(notice.items.map((i) => [i.slice(0, i.indexOf("=")), i.slice(i.indexOf("=") + 1)]));

// Walk a size-prefixed record stream: [uint32 LE length][record] repeated.
export function splitStream(bytes) {
  const buf = Buffer.from(bytes);
  const records = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32LE(off);
    off += 4;
    assert.ok(off + len <= buf.length, "a length prefix must not run past the stream");
    records.push(buf.subarray(off, off + len));
    off += len;
  }
  assert.equal(off, buf.length, "the stream must end exactly on a record boundary");
  return records;
}

export const decodeGnp = (record) => gnpLib.GNP.getRootAsGNP(new flatbuffers.ByteBuffer(Uint8Array.from(record))).unpack();
