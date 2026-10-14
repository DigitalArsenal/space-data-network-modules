// The module through the SDK browser harness with typed frames: $ERM records in and out (scripts/erm-codec.mjs), the
// recipes of attach_covariance and attribute_maneuvers as node config (plugin.getConfig).
//
// GP_LEGACY_DIST=<dist of the JSON-port release, 0.6.0> also runs every call on that artifact with the same values as
// JSON and checks that each output is the same: $ERM outputs decoded field by field, every number bit-identical; record
// streams ($OMM, $OCM, $MNV) byte-identical.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { ARM_OF, decode, encode, ermFrame, recipeConfig, modelsFrame, ERM_TYPE } from '../scripts/erm-codec.mjs';

export { ARM_OF, decode, encode, ermFrame, recipeConfig, modelsFrame };
const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
export const wasmPath = here('../dist/isomorphic/module.wasm');
export const wasm = fs.readFileSync(wasmPath);
export const manifest = JSON.parse(fs.readFileSync(here('../plugin-manifest.json')));

const JSON_TYPE = { schemaName: 'application/json' };
/** An input frame: one $ERM record of `arm` from its readable `value` (the value is kept for the legacy comparison). */
export function frame(portId, arm, value) {
  const f = { portId, payload: encode(arm, value), typeRef: { ...ERM_TYPE } };
  Object.defineProperty(f, 'legacy', { value: { portId, payload: Buffer.from(JSON.stringify(value)), typeRef: JSON_TYPE } });
  return f;
}
/** A port's value in its readable form; the call encodes it as the method's $ERM arm for that port. */
export const json = (portId, value) => ({ portId, value, pending: true });
const resolve = (methodId, inputs) => inputs.map((f) => (f.pending ? frame(f.portId, ARM_OF[methodId][f.portId], f.value) : f));

/** attach_covariance / attribute_maneuvers: the recipe as node config, its models on the models port. */
export function recipeInputs(recipe, prefix) {
  const models = recipe.models?.length && prefix === 'attach' ? [modelsFrame(recipe.models)] : [];
  models.forEach((m) => Object.defineProperty(m, 'legacy', { value: null }));
  return { config: recipeConfig(recipe, prefix), inputs: models,
    legacy: { portId: 'recipe', payload: Buffer.from(JSON.stringify(recipe)), typeRef: JSON_TYPE } };
}

async function run(wasmSource, man, methodId, inputs, config) {
  const h = await createBrowserModuleHarness({ wasmSource, manifest: man, surface: 'direct', hostOptions: { config } });
  try {
    return await h.invoke({ methodId, inputs });
  } finally {
    h.destroy();
  }
}

const legacyDist = process.env.GP_LEGACY_DIST;
const legacy = legacyDist
  ? { wasm: fs.readFileSync(path.join(legacyDist, 'isomorphic/module.wasm')), manifest: JSON.parse(fs.readFileSync(path.join(legacyDist, 'plugin-manifest.json'))) }
  : null;
export const parity = { calls: 0, outputs: 0, numbers: 0, records: 0 };

const isErm = (f) => f.typeRef?.fileIdentifier === '$ERM' || f.typeRef?.schemaName === 'ERM.fbs';
// A value an $ERM record holds where the readable form had none: a default (0, "", false, NaN, empty), or the constant
// tags and unit notes the decoder restores.
const defaultish = (v) => v === null || v === undefined || v === 0 || v === '' || v === false || (typeof v === 'number' && Number.isNaN(v))
  || (Array.isArray(v) && v.every(defaultish)) || (typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(defaultish));
const RESTORED = new Set(['units', 'version', 'kind']);
// Field-by-field: every number of the JSON-port output, bit-identical in the decoded $ERM (NaN for null); keys the
// $ERM does not carry are listed in `dropped` (constant texts and echoes).
function compare(old, now, at, diffs, dropped) {
  if (old === null || (typeof old === 'number' && Number.isNaN(old))) {
    if (!defaultish(now)) diffs.push(`${at}: ${JSON.stringify(old)} -> ${JSON.stringify(now)}`);
    return;
  }
  if (typeof old === 'number') {
    parity.numbers++;
    if (typeof now !== 'number' || !Object.is(old, now)) diffs.push(`${at}: ${old} -> ${now}`);
    return;
  }
  if (Array.isArray(old)) {
    if (!Array.isArray(now) || now.length !== old.length) { diffs.push(`${at}: array of ${old.length} -> ${Array.isArray(now) ? now.length : typeof now}`); return; }
    old.forEach((x, i) => compare(x, now[i], `${at}[${i}]`, diffs, dropped));
    return;
  }
  if (typeof old === 'object') {
    if (!now || typeof now !== 'object') { diffs.push(`${at}: object -> ${JSON.stringify(now)}`); return; }
    for (const k of Object.keys(old)) {
      const p = `${at}.${k}`;
      if (!(k in now)) {
        const empty = old[k] === null || (Array.isArray(old[k]) && !old[k].length);
        if (!empty) dropped.add(p.replace(/\[\d+\]/g, '[]'));
        continue;
      }
      compare(old[k], now[k], p, diffs, dropped);
    }
    for (const k of Object.keys(now)) if (!(k in old) && !defaultish(now[k]) && !RESTORED.has(k)) diffs.push(`${at}.${k}: absent -> ${JSON.stringify(now[k])}`);
    return;
  }
  if (old !== now) diffs.push(`${at}: ${JSON.stringify(old)} -> ${JSON.stringify(now)}`);
}
// The keys the $ERM records leave out by design: constant unit notes, the fit report's elements (the companion $OMM
// carries them), a factor model's echo of the object's horizon.
export const DROPPED = new Set(['$.units', '$.elements', '$.fits[].elements', '$.objects[].cell.horizon', '$.window']);

/** Invoke a method; with GP_LEGACY_DIST, compare against the JSON-port artifact. */
export async function invoke(methodId, given, { config = {}, legacyInputs } = {}) {
  const inputs = resolve(methodId, given);
  const r = await run(wasm, manifest, methodId, inputs, config);
  // A frame given as $ERM bytes has no readable form to send the JSON-port artifact.
  const comparable = inputs.every((f) => f.legacy !== undefined || !isErm(f)) || legacyInputs;
  if (legacy && comparable && r.statusCode === 0) {
    const old = await run(legacy.wasm, legacy.manifest, methodId, legacyInputs ?? inputs.map((f) => (f.legacy === undefined ? f : f.legacy)).filter(Boolean), {});
    assert.equal(old.statusCode, 0, `legacy ${methodId}: ${old.errorMessage}`);
    parity.calls++;
    const ports = new Set([...r.outputs, ...old.outputs].map((f) => f.portId));
    for (const port of ports) {
      const nowFrames = r.outputs.filter((f) => f.portId === port), oldFrames = old.outputs.filter((f) => f.portId === port);
      assert.equal(nowFrames.length, oldFrames.length, `${methodId}.${port}: frames`);
      nowFrames.forEach((f, i) => {
        parity.outputs++;
        const o = oldFrames[i];
        if (isErm(f)) {
          const diffs = [], dropped = new Set();
          compare(JSON.parse(Buffer.from(o.payload).toString()), decode(f.payload), '$', diffs, dropped);
          assert.deepEqual(diffs, [], `${methodId}.${port}: differs from the JSON-port artifact`);
          for (const d of dropped) assert.ok(DROPPED.has(d), `${methodId}.${port}: ${d} is not carried`);
        } else {
          parity.records++;
          assert.ok(Buffer.from(f.payload).equals(Buffer.from(o.payload)), `${methodId}.${port}: record bytes differ from the JSON-port artifact`);
        }
      });
    }
  }
  return r;
}
/** Invoke; status 0 required; the first output decoded. */
export async function call(methodId, inputs, options) {
  const r = await invoke(methodId, inputs, options);
  assert.equal(r.statusCode, 0, r.errorMessage);
  return decode(r.outputs[0].payload);
}
/** Each output port: decoded when $ERM, else its bytes (frames of a port concatenated). */
export function outputs(r) {
  const out = {};
  for (const f of r.outputs) {
    const bytes = Buffer.from(f.payload);
    out[f.portId] = isErm(f) ? decode(bytes) : Buffer.concat([out[f.portId] ?? Buffer.alloc(0), bytes]);
  }
  return out;
}
if (legacy) process.on('exit', () => console.log(`[parity] ${parity.calls} calls, ${parity.outputs} outputs (${parity.records} record streams byte-identical), ${parity.numbers} numbers bit-identical against ${legacyDist}`));
