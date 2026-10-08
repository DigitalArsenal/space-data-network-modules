// The JB2008 and Jacchia 1970 atmospheres through PRW (SDS 1.240.0):
// which inputs each takes and refuses, and that Jacchia 1970 drives drag.
// The models' values are checked in atmosphere_ports.test.mjs (against
// Orekit and GMAT) and JB2008 propagation in orekit_reference (J1 cases).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { REFERENCE, requestInputs, score, jb2008Input, spaceWeatherInput } from './lib/orekitCases.mjs';
import { sds } from './lib/prwCodec.mjs';

const WASM = new URL('../dist/isomorphic/module.wasm', import.meta.url);
const MANIFEST = new URL('../plugin-manifest.json', import.meta.url);
const harness = () => createBrowserModuleHarness({ wasmSource: fs.readFileSync(WASM), manifest: JSON.parse(fs.readFileSync(MANIFEST, 'utf8')), surface: 'direct' });
const find = (orbit, prefix) => REFERENCE.cases.find((c) => c.orbit === orbit && c.forces.startsWith(prefix));
const shorten = (exec) => { exec.SAMPLE_EPOCHS = exec.SAMPLE_EPOCHS.slice(0, 2); exec.TARGET_EPOCH = exec.SAMPLE_EPOCHS[1]; };

test('JB2008 takes jb2008_indices only, and only JB2008 takes them', async (t) => {
  const h = await harness(); t.after(() => h.destroy());
  const J1 = find('LEO400', 'J1'), W1 = find('LEO400', 'W1');
  const refuse = async (inputs, pattern) => {
    const r = await h.invoke({ methodId: 'invoke', inputs });
    assert.notEqual(r.statusCode, 0); assert.match(`${r.errorCode}: ${r.errorMessage}`, pattern);
  };
  const without = (inputs, port) => inputs.filter((i) => i.portId !== port);
  await refuse(without(requestInputs(J1, { edit: shorten }), 'jb2008_indices'), /jb2008-indices-required/);
  await refuse([...requestInputs(W1, { edit: shorten }), jb2008Input()], /unsupported-jb2008-indices/);
  await refuse([...requestInputs(J1, { edit: shorten }), spaceWeatherInput()], /JB2008 reads jb2008_indices/);
  // The August arcs are outside the June rows.
  await refuse(requestInputs({ ...find('LEO400', 'F6'), atmosphere: 'JB2008' }, { edit: shorten }), /jb2008-indices-out-of-range/);
});

test('Jacchia 1970 drives drag from WEATHER or the space_weather rows', async (t) => {
  const h = await harness(); t.after(() => h.destroy());
  const W1 = find('LEO400', 'W1'), F6 = find('LEO400', 'F6');
  const j70 = (exec) => { exec.FORCES.ATMOSPHERE_MODEL = sds.prwAtmosphereFamily.JACCHIA_70; };
  for (const c of [W1, F6]) {
    const r = await h.invoke({ methodId: 'invoke', inputs: requestInputs(c, { edit: j70 }) });
    assert.equal(r.statusCode, 0, `${r.errorCode}: ${r.errorMessage}`);
    // Against Orekit's NRLMSISE-00 trajectory: another atmosphere moves the
    // day's arc by kilometres, not by nothing and not by orders of magnitude.
    const { worst } = score(c, r);
    t.diagnostic(`${c.forces} with Jacchia 1970: ${(worst / 1000).toFixed(1)} km from NRLMSISE-00`);
    assert.ok(worst > 100 && worst < 2e5, `${c.forces}: ${worst} m`);
  }
});
