#!/usr/bin/env node
// One catalog E2E. Numerical reference: the same artifact's configured PRW
// resident profile, qualified independently by scripts/e2e-ffm.mjs. GCRF SI,
// UTC inputs, 1 day; 1 cm / 1 mm/s are dense-to-polynomial fitting tolerances,
// not orbit-truth accuracy. All dynamics and polynomial evaluation are WASM.
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBrowserModuleHarness } from 'space-data-module-sdk/testing';
import { browserMemory } from './catalog-memory-evidence.mjs';
import { catalogClient } from './catalog-coverage-client.mjs';
import * as catalog from '../catalog.mjs';
import { environmentInputs, KERNEL } from '../tests/lib/fullForce.mjs';
import { makeTable, encodePrw, decodePrw, sds, TYPE } from '../tests/lib/prwCodec.mjs';
const read = f => JSON.parse(fs.readFileSync(new URL(f, import.meta.url)));
const seeds = read('../tests/fixtures/seeds.json');
const standard = read('../tests/fixtures/standard.json');
const wasm = fs.readFileSync(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const compiled = await WebAssembly.compile(wasm);
const manifest = read('../plugin-manifest.json');
const epoch = Date.parse(standard.fixtureEpochUtc + 'Z') / 86400000 + 2440587.5;
const environment = environmentInputs();
const request = catalog.fullForceRequest({ epoch: standard.fixtureEpochUtc, state: [...seeds[0].position, ...seeds[0].velocity].map(x => x * 1000) });
const configuration = encodePrw('EXECUTION_REQUEST', request);
const frames = [configuration, ...environment.map(x => x.payload)];
const makeHost = () => createBrowserModuleHarness({ wasmSource: compiled, manifest, surface: 'direct' });
const frame = (portId, arm, value) => ({ portId, typeRef: TYPE, payload: encodePrw(arm, value) });
const report = { artifactSha256: createHash('sha256').update(wasm).digest('hex'), epochUtc: standard.fixtureEpochUtc,
  threads: 1, logicalCpus: os.cpus().length, loadStart: os.loadavg(), kernelBytes: KERNEL.length,
  inputs: Object.fromEntries(environment.map(x => [x.portId, x.payload.length])), durationSeconds: 86400, regimes: [] };
const reportPath = new URL('../tests/evidence/catalog-coverage.json', import.meta.url);
const save = () => { fs.mkdirSync(new URL('../tests/evidence/', import.meta.url), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); };
try {
  for (const seed of seeds) {
    const coverage = await makeHost(), resident = await makeHost();
    let client;
    try {
      client = catalogClient(coverage, frames, [seed], epoch);
      assert.equal(client.profile(), 'FFM-1');
      const instance = makeTable('PRWInstance', { MODULE_ID: 'com.orbpro.ffm', INSTANCE_ID: `coverage-${seed.label}`, GENERATION: 1n });
      const init = await resident.invoke({ methodId: 'ingest_state', inputs: [
        frame('state', 'RESIDENT_STATE', catalog.residentState({ instanceId: instance.INSTANCE_ID, handle: seed.handle,
          epoch: standard.fixtureEpochUtc, state: [...seed.position, ...seed.velocity].map(x => x * 1000),
          cdAm: coverage.instance.exports.plugin_drag_area_over_mass_from_bstar(seed.bstar, .01), crAm: .02 })),
        { portId: 'configuration', typeRef: TYPE, payload: configuration }, ...environment] });
      assert.equal(init.statusCode, 0, init.errorMessage);
      const row = { regime: seed.label, maximumPositionErrorM: 0, maximumVelocityErrorMS: 0, coverageCpuSecondsPerObjectDay: 0, samples: 0 };
      for (let segment = 0; segment < 288; ++segment) {
        const start = segment * 300;
        const before = process.threadCpuUsage(); client.ensure(epoch + (start + 300) / 86400);
        const cpu = process.threadCpuUsage(before); row.coverageCpuSecondsPerObjectDay += (cpu.user + cpu.system) / 1e6;
        for (const offset of [0, 17.125, 149.75, 281.5, 300]) {
          const jd = epoch + (start + offset) / 86400;
          const actual = client.states(jd);
          const response = await resident.invoke({ methodId: 'propagate_state', inputs: [frame('request', 'RESIDENT_REQUEST', makeTable('PRWResidentRequest', {
            INSTANCE: instance, ENTITY_HANDLES: [seed.handle], TARGET_COORDINATE_SYSTEM: catalog.gcrf(),
            TARGET_EPOCH: makeTable('TIMInstant', { TIME_SYSTEM: sds.timingStandard.UTC, EPOCH_FORMAT: sds.timEpochRepresentation.JULIAN_DATE, JULIAN_DATE: jd }),
          }))] });
          assert.equal(response.statusCode, 0, response.errorMessage);
          const expected = decodePrw(response.outputs[0].payload).RESIDENT_STATE.STATE;
          const p = expected.POSITION, v = expected.VELOCITY;
          row.maximumPositionErrorM = Math.max(row.maximumPositionErrorM, Math.hypot(actual[0] - p.X, actual[1] - p.Y, actual[2] - p.Z));
          row.maximumVelocityErrorMS = Math.max(row.maximumVelocityErrorMS, Math.hypot(actual[3] - v.X, actual[4] - v.Y, actual[5] - v.Z));
          ++row.samples;
        }
      }
      row.memoryBytes = client.memoryBytes(); report.regimes.push(row); save(); console.log(JSON.stringify(row));
      assert(row.maximumPositionErrorM <= .01, `${seed.label}: position fit tolerance`);
      assert(row.maximumVelocityErrorMS <= .001, `${seed.label}: velocity fit tolerance`);
    } finally { client?.dispose(); await coverage.destroy(); await resident.destroy(); }
  }
  report.loadEnd = os.loadavg();
  report.numerics = 'PASS';
  report.browserMemory = await browserMemory({ frames, seeds, epoch, manifest });
  save();
} catch (e) { report.failure = e.stack; save(); throw e; }
