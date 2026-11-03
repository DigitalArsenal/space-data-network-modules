// AP: SGP4XP with parts replaced (propagator/sdn-ap SPEC 16). One arm's FORCES: the drag atmosphere unless `atmosphere` is false, and the gravity terms by degree.
// Before a build is pinned, the module comes from a file: openAp(file) gives fit and propagate as xp-atmosphere-merit's openModules does. Exploratory only.
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { modulesRoot } from '../../xp-atmosphere-merit/common.mjs';
import { TYPE, oemLines } from '../../xp-atmosphere-merit/lib/sds.mjs';

export const apForces = (atmosphere, { tesseral = 0, zonal = 0, atmosphere: drag = true, noTerms = false }) => ({
  ...(drag ? atmosphere : {}),
  ...(noTerms ? {} : { HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: tesseral, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: zonal }),
});

const short = (e) => String(e?.message ?? e).slice(0, 240);
export async function openAp(file) {
  const entry = createRequire(path.join(modulesRoot(), 'propagator/sdn-ap/package.json')).resolve('space-data-module-sdk/testing/isomorphic');
  const { createStandaloneHarness } = await import(pathToFileURL(entry).href);
  const h = await createStandaloneHarness('browser', file, { surface: 'direct' });
  const weather = (extra) => (extra?.rows ? [{ portId: 'space_weather', typeRef: TYPE('SPW'), payload: extra.rows }] : []);
  return {
    async fit(oem, pcf, extra) {
      const inputs = [{ portId: 'ephemeris', typeRef: TYPE('OEM'), payload: oem }, { portId: 'configuration', typeRef: TYPE('PCF'), payload: pcf }, ...weather(extra)];
      let r;
      try { r = await h.invoke({ methodId: 'fit', inputs }); } catch (error) { return { ok: false, error: short(error) }; }
      if (r.statusCode !== 0) return { ok: false, error: `${r.errorCode}: ${String(r.errorMessage).slice(0, 200)}` };
      return { ok: true, omm: new Uint8Array(r.outputs.find((o) => o.portId === 'elements').payload) };
    },
    async propagate(omm, grid, pcf, extra, count) {
      const inputs = [{ portId: 'omm', typeRef: TYPE('OMM'), payload: omm }, { portId: 'grid', typeRef: TYPE('OEM'), payload: grid }, { portId: 'configuration', typeRef: TYPE('PCF'), payload: pcf }, ...weather(extra)];
      const r = await h.invoke({ methodId: 'propagate', inputs });
      if (r.statusCode !== 0) throw new Error(`propagate: ${r.errorCode}: ${String(r.errorMessage).slice(0, 200)}`);
      const lines = oemLines(new Uint8Array(r.outputs.find((o) => o.portId === 'ephemeris').payload));
      if (lines.length !== count) throw new Error(`propagate returned ${lines.length} of ${count} states`);
      return lines;
    },
  };
}
