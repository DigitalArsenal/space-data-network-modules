// Typed-contract (1.0) test support for data-source/sigmf-captures: the module-sdk runtime frames the flow hands the
// nodes (TimerTick, HttpResponse with the parse job in CONTEXT) and the harness that answers the node's
// plugin.getConfig hostcall from the node config (one ModuleConfig on raw "config", answered by the SDK harness), as the Go node does.

import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  ArchiveTargetT,
  IngestRequestT,
  SourceTagsT,
  decodeFlowNotice,
  decodeHostCall,
  decodeHttpRequest,
  decodeIngestRequest,
  encodeHttpResponse,
  encodeTimerTick,
  reconcileMode,
} from "space-data-module-sdk/runtime-contracts";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";

const SDK_ROOT = fileURLToPath(new URL("../node_modules/space-data-module-sdk/package.json", import.meta.url));
const flatbuffers = createRequire(SDK_ROOT)("flatbuffers");

export const MANIFEST_PATH = new URL("../plugin-manifest.json", import.meta.url);
export const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

export const TYPE = {
  TICK: { schemaName: "TimerTick.fbs", fileIdentifier: "TICK", rootTypeName: "TimerTick", wireFormat: "flatbuffer" },
  HRSP: { schemaName: "HttpResponse.fbs", fileIdentifier: "HRSP", rootTypeName: "HttpResponse", wireFormat: "flatbuffer" },
};

export const BASE_URL = "https://www.iqengine.org";
export const SOURCE_URL = `${BASE_URL}/api/datasources/local/local/meta`;
// The job request builds by default (the fields IngestRequest carries).
export const JOB = {
  schema: "IQC.fbs",
  providerId: "space-data-network-02",
  sourceName: "IQEngine",
  sourceUrl: SOURCE_URL,
  reconcile: "none",
  archive: { source: "sigmf", name: "iqengine-bulk-meta-meta.json" },
};

// The job as request writes it: ONE size-prefixed IngestRequest.
export function jobContext(job = JOB) {
  const b = new flatbuffers.Builder(256);
  const q = new IngestRequestT(
    job.schema,
    new SourceTagsT(job.providerId, job.sourceName, null, job.sourceUrl),
    reconcileMode[{ none: "None", duplicates: "Duplicates", current: "Current" }[job.reconcile]],
    job.archive ? new ArchiveTargetT(job.archive.source, job.archive.name) : null,
    null,
  );
  b.finish(q.pack(b), "INGQ", true);
  return b.asUint8Array().slice();
}

// A size-prefixed IngestRequest (the CONTEXT) decoded.
export function decodeJob(context) {
  const length = new DataView(context.buffer, context.byteOffset).getUint32(0, true);
  if (length !== context.length - 4) throw new Error("CONTEXT is not one size-prefixed FlatBuffer");
  return decodeIngestRequest(Uint8Array.from(context.subarray(4)));
}

export const tick = () => ({ portId: "tick", typeRef: TYPE.TICK, payload: encodeTimerTick({ triggerId: "timer-sigmf-captures", firedMs: Date.UTC(2026, 9, 13, 6) }) });

export function responseFrame({ body = new Uint8Array(0), status = 200, headers = {}, job = JOB, context, retrievedMs = Date.UTC(2026, 9, 13, 6, 0, 5), error } = {}) {
  return {
    portId: "response",
    typeRef: TYPE.HRSP,
    payload: encodeHttpResponse({ url: job?.sourceUrl ?? SOURCE_URL, status, headers, body, context: context ?? jobContext(job), retrievedMs, error }),
  };
}

// The SDK harness's BrowserHost answers plugin.getConfig from `config` (one ModuleConfig on raw "config", as the Go node
// answers it). The hostcall import is wrapped only to record the module's calls.
export async function createHarness(t, config = {}) {
  const calls = [];
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async (module, imports) => {
    let memory;
    const host = imports.space_data_module_host;
    if (!host) return instantiate(module, imports);
    const wrapped = { ...imports, space_data_module_host: { ...host,
      call: (opPtr, opLen, ptr, len) => {
        calls.push(decodeHostCall(new Uint8Array(memory.buffer, ptr, len).slice()));
        return host.call(opPtr, opLen, ptr, len);
      },
    } };
    const result = await instantiate(module, wrapped);
    memory = (result.instance ?? result).exports.memory;
    return result;
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

export const outputsByPort = (response) => new Map(response.outputs.map((frame) => [frame.portId, frame]));
export const requestOf = (outputs) => decodeHttpRequest(outputs.get("request").payload);
export const metaOf = (outputs) => decodeIngestRequest(outputs.get("iqc_meta").payload);
export const noticeOf = (outputs) => decodeFlowNotice(outputs.get("unchanged").payload);
