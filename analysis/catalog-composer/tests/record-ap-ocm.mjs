// Records tests/fixtures/ap-fit-sdn-ap-0.5.1.ocm: the $OCM propagator/sdn-ap 0.5.1 `fit` writes (task 4a's writer) on
// the inputs of its own 0.4.0 fixtures (propagator/sdn-ap test/lib/fixture-inputs.mjs) under AP's forces, as that
// module's test/fit.e2e.mjs fits it. JS only moves bytes.
//   node analysis/catalog-composer/tests/record-ap-ocm.mjs
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStandaloneHarness } from '../../../propagator/sdn-ap/node_modules/space-data-module-sdk/src/testing/isomorphicHarness.js';
import { inputs } from '../../../propagator/sdn-ap/test/lib/fixture-inputs.mjs';
import { configuration, MSIS_FORCES } from '../../../propagator/sdn-ap/test/lib/pcf.mjs';
import { pcfWeatherSource } from '../../../propagator/sdn-ap/node_modules/spacedatastandards.org/lib/js/PCF/pcfWeatherSource.js';

const wasm = fileURLToPath(new URL('../../../propagator/sdn-ap/dist/isomorphic/module.wasm', import.meta.url));
const version = JSON.parse(fs.readFileSync(new URL('../../../propagator/sdn-ap/plugin-manifest.json', import.meta.url))).version;
if (version !== '0.5.1') throw new Error(`sdn-ap ${version}: the fixture is the 0.5.1 writer's`);
const h = await createStandaloneHarness('browser', wasm, { surface: 'direct' });
const T = (name) => ({ schemaName: `${name}.fbs`, fileIdentifier: `$${name}`, rootTypeName: name });
const { arc, rows } = inputs();
const forces = { ...MSIS_FORCES, HAS_MAXIMUM_TESSERAL_DEGREE: true, MAXIMUM_TESSERAL_DEGREE: 31, HAS_MAXIMUM_DEGREE: true, MAXIMUM_DEGREE: 20,
  WEATHER_SOURCE: pcfWeatherSource.RECORDS };
const r = await h.invoke({ methodId: 'fit', inputs: [{ portId: 'ephemeris', typeRef: T('OEM'), payload: arc },
  configuration({ theory: 'AP', forces }), { portId: 'space_weather', typeRef: T('SPW'), payload: rows.bytes }] });
if (r.statusCode !== 0 || r.outputs.length !== 1 || r.outputs[0].typeRef?.fileIdentifier !== '$OCM') throw new Error(`fit: ${r.errorCode} ${r.errorMessage}`);
const out = fileURLToPath(new URL('fixtures/ap-fit-sdn-ap-0.5.1.ocm', import.meta.url));
fs.writeFileSync(out, r.outputs[0].payload);
console.log(`${out}: ${r.outputs[0].payload.length} bytes`);
process.exit(0);
