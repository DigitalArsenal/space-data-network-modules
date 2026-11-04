// The inputs of tests/ocm-sets.e2e.mjs and of its before-record (tests/record-ocm-sets-before.mjs): one object, NORAD
// 90400 (the sdn-ap fixture's), an SGP4 $OMM from Space-Track, the AP $OCM of propagator/sdn-ap 0.5.1 `fit` published
// by two sources, and the SGP4-XP $OMM of sdn-ap's 0.4.0 fixtures (BTERM in BSTAR, AGOM in MEAN_MOTION_DDOT) as an
// element-set source gives it. JS only builds records with the SDS object API and moves bytes.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OMM, OCM, apOcmRecord, catRecord, flatbuffers, frames, integrate, labelOf, ommRecord, stream } from './integrator-fixtures.mjs';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
export const OBJECT = { norad: 90400, cospar: '2026-904A', name: 'AP E2E' };
export const SGP4_SOURCE = 'space-track-gp', AP_SOURCES = ['sdn-ap-fit-a', 'sdn-ap-fit-b'];
export const AS_OF = Date.UTC(2026, 9, 2) / 1000;  // the day after the AP set's epoch, 2026-10-01T00:00:00
export const catalog = catRecord(OBJECT);
export const sgp4Omm = ommRecord({ source: SGP4_SOURCE, ...OBJECT, epoch: '2026-10-01T00:00:00.000000', label: labelOf('LEO-L') });
export const apOcms = AP_SOURCES.map((source) => apOcmRecord({ source }));
// The integrator's recipe: the AP products measured on LEO-L at one day, `apMedians` km in source order.
export const recipe = (apMedians) => ({
  asOf: AS_OF, maneuvers: { timeToleranceSeconds: 3600, deltaVToleranceKmS: 0.0005 },
  selection: { horizonDays: 1, minSamples: 30, sourceOrder: [SGP4_SOURCE, ...AP_SOURCES],
    table: [{ source: SGP4_SOURCE, product: 'sgp4', regime: 'LEO-L', horizonDays: 1, median3dKm: 2.5, samples: 100 },
      ...AP_SOURCES.map((source, k) => ({ source, product: 'ap', regime: 'LEO-L', horizonDays: 1, median3dKm: apMedians[k], samples: 100 }))] },
});
export const integrateSets = (apMedians) => integrate([frames.recipe(recipe(apMedians)), frames.catalog(catalog), frames.omm(stream([sgp4Omm])), frames.ocm(stream(apOcms))]);

// The SGP4-XP $OMM (plain buffer) as sdn-ap 0.4.18 wrote it, size-prefixed for a record stream.
const xpPlain = fs.readFileSync(here('../../../propagator/sdn-ap/test/fixtures/xp-fit-0.4.0.omm'));
export const xpOmm = (() => {
  const t = OMM.OMM.getRootAsOMM(new flatbuffers.ByteBuffer(new Uint8Array(xpPlain))).unpack();
  const b = new flatbuffers.Builder(2048);
  OMM.OMM.finishSizePrefixedOMMBuffer(b, t.pack(b));
  return Buffer.from(b.asUint8Array());
})();
export { OMM, OCM };
