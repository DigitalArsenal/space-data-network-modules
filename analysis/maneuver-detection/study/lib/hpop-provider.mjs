// propagator/hpop 1.3.0 behind the detector's query port: each element set's
// GCRF state at its epoch (analysis/epoch-state, the HPOP screen's seeds),
// propagated at full force (propagator/hpop/catalog.mjs: EGM2008 70x70, Sun,
// Moon and planets, SRP, NRLMSISE-00 drag, tides, relativity, Earth radiation;
// Cd*A/m from B* by the module) forwards to the span's end and backwards to
// its start, sampled at the query's times in one integration each way. The
// environment directory holds kernel.prw, earth_orientation.prw and
// space_weather.prw (one release covering the span).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBrowserModuleHarness } from 'space-data-module-sdk/host/browser-module';
import { MODULES, OEM, iso, seconds, oemFrame, flatbuffers } from './host.mjs';

const catalog = await import(pathToFileURL(path.join(MODULES, 'propagator/hpop/catalog.mjs')).href);
const { epochStates } = await import(pathToFileURL(path.join(MODULES, 'analysis/gp-error-model/scripts/hpop.mjs')).href);

export async function hpopProvider({ environment }) {
  const dir = path.join(MODULES, 'propagator/hpop');
  const harness = await createBrowserModuleHarness({ wasmSource: fs.readFileSync(path.join(dir, 'dist/isomorphic/module.wasm')),
    manifest: JSON.parse(fs.readFileSync(path.join(dir, 'plugin-manifest.json'), 'utf8')), surface: 'direct' });
  const frame = (portId) => ({ portId, typeRef: catalog.TYPE, payload: new Uint8Array(fs.readFileSync(path.join(environment, `${portId}.prw`))) });
  const env = [frame('kernel'), frame('earth_orientation'), frame('space_weather')];
  const run = async (seed, cdAm, targets) => {
    const request = catalog.fullForceRequest({ epoch: seed.epoch, state: [...seed.position, ...seed.velocity].map((x) => x * 1000),
      target: targets.at(-1), cdAm, crAm: catalog.DEFAULT_SRP_AREA_OVER_MASS });
    request.SAMPLE_EPOCHS = targets.map((t) => catalog.instant(t, 'UTC'));
    const res = await harness.invoke({ methodId: 'invoke', inputs: [{ portId: 'request', typeRef: catalog.TYPE, payload: catalog.encode('EXECUTION_REQUEST', request) }, ...env] });
    if (res.statusCode !== 0) throw new Error(`${res.errorCode}: ${res.errorMessage}`);
    const out = catalog.prw.PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(res.outputs[0].payload)).EXECUTION_RESULT();
    return targets.map((t, i) => {
      const st = out.SAMPLES(i).STATE().STATE(), p = st.POSITION(), v = st.VELOCITY();
      return { t: seconds(t), s: [p.X(), p.Y(), p.Z(), v.X(), v.Y(), v.Z()].map((x) => x / 1000) };
    });
  };
  return {
    name: 'propagator/hpop (full force)',
    async answer(requests, rows) {
      const seeds = await epochStates(requests.queries.map((q) => {
        const r = rows[q.set];
        return { key: q.sequence, epoch: seconds(r.EPOCH),
          values: [r.MEAN_MOTION, r.ECCENTRICITY, r.INCLINATION, r.RA_OF_ASC_NODE, r.ARG_OF_PERICENTER, r.MEAN_ANOMALY, r.BSTAR].map(Number) };
      }));
      const blocks = [];
      for (const q of requests.queries) {
        const seed = seeds.get(q.sequence);
        const b = new OEM.ephemerisDataBlockT();
        b.OBJECT = Object.assign(new OEM.CATT(), { NORAD_CAT_ID: q.norad, OBJECT_ID: q.object_id ?? '' });
        b.CENTER_NAME = 'EARTH';
        b.TIME_SYSTEM = OEM.timingStandard.UTC;
        b.REFERENCE_FRAME = Object.assign(new OEM.RFMT(), { NAME: 'GCRF' });
        try {
          if (!seed) throw new Error('no epoch state');
          const cdAm = catalog.dragAreaOverMass(harness.instance.exports, Number(rows[q.set].BSTAR));
          const start = seconds(q.start), stop = seconds(q.stop), epoch = seconds(seed.epoch);
          const times = [];
          for (let k = 0; ; ++k) { const t = Math.min(stop, start + k * q.step_s); times.push(t); if (t >= stop) break; }
          const after = times.filter((t) => t >= epoch), before = times.filter((t) => t < epoch).reverse();
          const samples = [...(before.length ? (await run(seed, cdAm, before.map(iso))).reverse() : []), ...(after.length ? await run(seed, cdAm, after.map(iso)) : [])];
          b.EPHEMERIS_DATA_LINES = samples.map(({ t, s }) => {
            const l = new OEM.ephemerisDataLineT();
            l.EPOCH = iso(t);
            [l.X, l.Y, l.Z, l.X_DOT, l.Y_DOT, l.Z_DOT] = s;
            return l;
          });
        } catch (e) {
          b.COMMENT = `REFUSED ${String(e.message ?? e)}`.slice(0, 300);
          b.EPHEMERIS_DATA_LINES = [];
        }
        blocks.push(b);
      }
      return [oemFrame(blocks)];
    },
    destroy: () => harness.destroy(),
  };
}
