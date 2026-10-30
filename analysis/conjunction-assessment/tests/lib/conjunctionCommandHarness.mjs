import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness, createModuleHarness } from "space-data-module-sdk/testing";
import { buildNativeWasiThreadsRunner, wasiThreadsLaunchPlan } from './wasmedgeWasiThreadsRunner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const ISOMORPHIC_WASM_PATH = path.join(
  PACKAGE_ROOT,
  "dist",
  "isomorphic",
  "module.wasm",
);

export function conjunctionArtifactPath() {
  return ISOMORPHIC_WASM_PATH;
}

export function conjunctionArtifactExists() {
  return fs.existsSync(ISOMORPHIC_WASM_PATH);
}

export async function createConjunctionCommandHarness(options = {}) {
  const runtimeKind = options.runtimeKind ?? process.env.CQR_TEST_RUNTIME ?? "wasmedge";
  const harness = runtimeKind === "browser" ? await createBrowserModuleHarness({ wasmSource: fs.readFileSync(options.wasmSource ?? ISOMORPHIC_WASM_PATH), surface: "direct", enableThreads: true }) : options.surface === 'direct' || runtimeKind === 'docker-wasmedge' ? await createModuleHarness({ runtime: { kind: 'wasmedge', launchPlan: await wasiThreadsLaunchPlan(runtimeKind, { wasmPath: options.wasmSource ?? ISOMORPHIC_WASM_PATH, args: ['--serve-plugin-invoke'] }) } }) : await loadModule({
    wasmSource: options.wasmSource ?? ISOMORPHIC_WASM_PATH,
    runtimeKind,
    enableThreads: options.enableThreads ?? true,
    wasmEdgeBinary: options.wasmEdgeBinary ?? await buildNativeWasiThreadsRunner(),
    cwd: options.cwd ?? PACKAGE_ROOT,
    env: options.env,
  });
  const invoke = harness.invoke.bind(harness);
  const typed = request => invoke({ ...request, inputs: (request.inputs ?? []).map(input => {
    const bytes = input.payload ?? input.bytes;
    const id = String.fromCharCode(...bytes.subarray(4,8));
    return { ...input, typeRef: input.typeRef ?? { schemaName: `${id.slice(1)}.fbs`, fileIdentifier: id, rootTypeName: id.slice(1), wireFormat: 'flatbuffer' } };
  }) });
  if (!process.env.CA_REPLAY_BASE_WASM || options.replayBase) return { ...harness, invoke: typed };
  return replayHarness(harness, typed, await createConjunctionCommandHarness({ ...options, wasmSource: process.env.CA_REPLAY_BASE_WASM, replayBase: true }));
}

// Byte-identity replay (tests/sgp4ByteIdentity.e2e.mjs): with CA_REPLAY_BASE_WASM naming another build of this
// module, every invoke also runs on that build. A request that takes no GP input (no $OMM record, no MEAN_ELEMENTS
// or TLE_LINES source, no resident index built from them, and not `version`) must answer byte for byte alike, except
// for the instant a message is created (CREATION_DATE, and the MESSAGE_ID that names it), which is the wall clock.
// The answer returned is this build's. Each comparison is appended to CA_REPLAY_REPORT (JSON lines).
function replayHarness(harness, typed, base) {
  const gpInstances = new Set();
  const decoded = async (bytes) => {
    const id = String.fromCharCode(...bytes.subarray(4, 8));
    if (!/^\$[A-Z]{3}$/.test(id)) return null;
    const flatc = await initCqrFlatc();
    try { return id === '$CQR' ? decodeCqr(flatc, bytes) : parseFlatcJson(flatc.generateJSON(publishedSchema(id.slice(1)), { path: '/replay.bin', data: bytes }, { defaultsJson: true })); }
    catch { return null; }
  };
  const takesGp = async (request) => {
    let gp = request.methodId === 'version';
    for (const input of request.inputs ?? []) {
      const bytes = input.payload ?? input.bytes;
      const id = String.fromCharCode(...bytes.subarray(4, 8));
      if (id === '$OMM') gp = true;
      if (id !== '$CQR') continue;
      const text = JSON.stringify(await decoded(bytes));
      const instances = [...text.matchAll(/"INSTANCE_ID":"([^"]*)"/g)].map((m) => m[1]);
      if (/"(MEAN_ELEMENTS|TLE_LINES)":/.test(text)) { gp = true; instances.forEach((i) => gpInstances.add(i)); }
      if (instances.some((i) => gpInstances.has(i))) gp = true;
    }
    return gp;
  };
  const creationFree = (x) => JSON.stringify(x, (key, value) => (key === 'CREATION_DATE' || key === 'MESSAGE_ID' ? '<created>' : value));
  const differences = (x, y, at, out) => {
    if (out.length >= 6) return out;
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) differences(x[key], y[key], `${at}.${key}`, out);
    } else if (JSON.stringify(x) !== JSON.stringify(y)) out.push({ at, answer: x, base: y });
    return out;
  };
  const compare = async (a, b) => {
    if (a.statusCode !== b.statusCode || a.errorCode !== b.errorCode || a.errorMessage !== b.errorMessage ||
        (a.outputs ?? []).length !== (b.outputs ?? []).length)
      return { identical: false, fields: [{ at: 'response', answer: [a.statusCode, a.errorCode, a.errorMessage, (a.outputs ?? []).length], base: [b.statusCode, b.errorCode, b.errorMessage, (b.outputs ?? []).length] }] };
    let creationOnly = false;
    for (const [k, o] of (a.outputs ?? []).entries()) {
      const p = b.outputs[k];
      if (o.portId === p.portId && Buffer.compare(Buffer.from(o.payload), Buffer.from(p.payload)) === 0) continue;
      const x = await decoded(o.payload), y = await decoded(p.payload);
      if (o.portId === p.portId && x && y && creationFree(x) === creationFree(y)) { creationOnly = true; continue; }
      return { identical: false, fields: differences(x, y, `outputs[${k}]`, []) };
    }
    return { identical: true, creationOnly };
  };
  return { ...harness,
    destroy: async () => { await harness.destroy?.(); await base.destroy?.(); },
    invoke: async (request) => {
      const gp = await takesGp(request);
      const answer = await typed(request), reference = await base.invoke(request);
      const row = { suite: path.basename(process.argv[1] ?? ''), methodId: request.methodId, gp, ...(await compare(answer, reference)) };
      if (process.env.CA_REPLAY_REPORT) fs.appendFileSync(process.env.CA_REPLAY_REPORT, `${JSON.stringify(row)}\n`);
      if (!gp && !row.identical) throw new Error(`byte identity: ${request.methodId} answers differently from ${process.env.CA_REPLAY_BASE_WASM}: ${JSON.stringify(row.fields)}`);
      return answer;
    } };
}

// Legacy fixture argument names are adapted in the test host; the WASM only
// receives advertised CQR methods. This is not an alternate JSON wire path.
import { initCqrFlatc, encodeCqr, decodeCqr, pairRequest, eventInReferenceUnits, parseFlatcJson, publishedSchema } from './cqr.mjs';
export async function invokeConjunctionJson(harness, request) {
  const flatc = await initCqrFlatc();
  const operation = request.operation ?? request.type;
  const p = request.params ?? {};
  let methodId, record;
  if (operation === 'version') { methodId = 'version'; record = { VERSION_QUERY: true }; }
  else if (['assessTracks','assess_tracks','assess'].includes(operation)) {
    methodId = 'assess_conjunction';
    const primaryTrack = p.primary_track;
    const secondaryTrack = p.secondary_track;
    const startJd = p.start_jd ?? (p.tca_hint_jd != null ? p.tca_hint_jd - (p.window_hours ?? 2) / 24 : primaryTrack?.samples?.[0]?.epochJD);
    record = pairRequest({ primaryTrack, secondaryTrack, tle1: p.object1, tle2: p.object2, startJd, durationDays: p.duration_days ?? (p.window_hours ?? 2) / 12, radius1M: p.radius1_m, radius2M: p.radius2_m });
  } else throw new Error(`Unsupported legacy test adapter operation: ${operation}`);
  const response = await harness.invoke({ methodId, inputs: [{ portId: 'request', payload: encodeCqr(flatc, record) }] });
  const bytes = response.outputs?.find(f => f.portId === 'result')?.payload;
  if (!bytes) return { response, json: null };
  const result = decodeCqr(flatc, bytes);
  if (result.VERSION_RESULT) return { response, json: { version: result.VERSION_RESULT.VERSION } };
  const e = eventInReferenceUnits(result.EVENT_RESULT);
  return { response, json: { tca_jd: e.tcaJd, tca_iso: e.tcaIso, min_range_km: e.minRangeKm, rel_speed_kms: e.relSpeedKms, obj1_norad: e.obj1Norad, obj2_norad: e.obj2Norad, max_probability: e.maxProbability, probability_method: e.probabilityMethod } };
}
