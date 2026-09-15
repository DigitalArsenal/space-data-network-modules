import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadModule } from "space-data-module-sdk/host/isomorphic";
import { createBrowserModuleHarness } from "space-data-module-sdk/testing";
import { buildNativeWasiThreadsRunner } from './wasmedgeWasiThreadsRunner.mjs';

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
  const harness = runtimeKind === "browser" ? await createBrowserModuleHarness({ wasmSource: fs.readFileSync(options.wasmSource ?? ISOMORPHIC_WASM_PATH), surface: "direct", enableThreads: true }) : await loadModule({
    wasmSource: options.wasmSource ?? ISOMORPHIC_WASM_PATH,
    runtimeKind,
    enableThreads: options.enableThreads ?? true,
    wasmEdgeBinary: options.wasmEdgeBinary ?? await buildNativeWasiThreadsRunner(),
    cwd: options.cwd ?? PACKAGE_ROOT,
    env: options.env,
  });
  const invoke = harness.invoke.bind(harness);
  return { ...harness, invoke: request => invoke({ ...request, inputs: (request.inputs ?? []).map(input => {
    const bytes = input.payload ?? input.bytes;
    const id = String.fromCharCode(...bytes.subarray(4,8));
    return { ...input, typeRef: input.typeRef ?? { schemaName: `${id.slice(1)}.fbs`, fileIdentifier: id, rootTypeName: id.slice(1), wireFormat: 'flatbuffer' } };
  }) }) };
}

// Legacy fixture argument names are adapted in the test host; the WASM only
// receives advertised CQR methods. This is not an alternate JSON wire path.
import { initCqrFlatc, encodeCqr, decodeCqr, pairRequest, eventInReferenceUnits } from './cqr.mjs';
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
