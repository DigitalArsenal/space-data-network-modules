// Contract check and definition renderer. No dynamics, WASM or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as flatbuffers from 'flatbuffers';
import * as P from 'spacedatastandards.org/lib/js/PRW/main.js';
import { encode, fullForceRequest } from '../catalog.mjs';

const moduleDir = fileURLToPath(new URL('../', import.meta.url));
const checkout = path.resolve(moduleDir, '../..');
const read = (name) => fs.readFileSync(path.join(moduleDir, name), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const sorted = (value) => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
const canonical = (value) => JSON.stringify(sorted(value));
const enumValue = (family, name) => {
  assert.equal(typeof P[family]?.[name], 'number', `Unknown ${family}: ${name}`);
  return P[family][name];
};
const decode = (bytes) => P.PRW.getSizePrefixedRootAsPRW(new flatbuffers.ByteBuffer(bytes)).unpack();

function forces(p) {
  return {
    GRAVITY_CHOICE: enumValue('pcfGravitySelection', p.gravity.field),
    ENABLE_POINT_MASS: p.gravity.pointMass,
    GRAVITATIONAL_PARAMETER: p.gravity.gm_m3_s2,
    ENABLE_J2: p.gravity.legacyZonalFlags.j2,
    ENABLE_J3: p.gravity.legacyZonalFlags.j3,
    ENABLE_J4: p.gravity.legacyZonalFlags.j4,
    ENABLE_HIGHER_ZONALS: p.gravity.legacyZonalFlags.higherZonals,
    MAXIMUM_DEGREE: p.gravity.degree,
    HAS_MAXIMUM_DEGREE: p.gravity.degreeSpecified,
    MAXIMUM_ORDER: p.gravity.order,
    HAS_MAXIMUM_ORDER: p.gravity.orderSpecified,
    ENABLE_THIRD_BODY: p.thirdBodies.enabled,
    THIRD_BODY_IDS: p.thirdBodies.bodies.map((body) => body.naifId),
    ENABLE_SRP: p.srp.enabled,
    ENABLE_DRAG: p.drag.enabled,
    INITIAL_MASS_KG: p.srp.initialMass_kg,
    AREA_M2: p.srp.area_m2,
    REFLECTIVITY_COEFFICIENT: p.srp.crAreaOverMass_m2_kg,
    DRAG_COEFFICIENT: p.drag.cdAreaOverMass_m2_kg,
    ATMOSPHERE_MODEL: enumValue('pcfAtmosphereFamily', p.drag.model.replaceAll('-', '').toUpperCase()),
    WEATHER: p.drag.weather,
    EPHEMERIS_SOURCE: p.thirdBodies.ephemerisSource,
    THIRD_BODY_MAXIMUM_DEGREE: p.thirdBodies.fieldMaximumDegree,
    THIRD_BODY_MAXIMUM_ORDER: p.thirdBodies.fieldMaximumOrder,
    CENTRAL_BODY_NAIF_ID: p.gravity.centralBodyNaifId,
    EPHEMERIS_KIND: enumValue('pcfEphemerisKind', p.thirdBodies.ephemerisKind),
    SHADOW_MODEL: enumValue('evlShadowModel', p.srp.shadowModel),
    WEATHER_SOURCE: enumValue('pcfWeatherSource', p.drag.weatherSource),
    WEATHER_EXTENSION: enumValue('pcfWeatherExtension', p.drag.weatherExtension),
    DENSITY_CORRECTION: enumValue('pcfDensityCorrection', p.drag.densityCorrection),
    DENSITY_CORRECTION_RELAXATION_HOURS: p.drag.densityCorrectionRelaxationHours,
    HAS_DENSITY_CORRECTION_RELAXATION_HOURS: p.drag.densityCorrectionRelaxationSpecified,
    NEUTRAL_WIND: enumValue('pcfNeutralWind', p.drag.neutralWind),
    EMPIRICAL_TERMS: p.drag.empiricalTerms,
    SOLID_TIDES: enumValue('pcfSolidTideModel', p.solidTides.selection),
    RELATIVITY: enumValue('pcfRelativityTerms', p.relativity.selection),
    IN_TRACK_ACCELERATION_M_S2: p.inTrackAcceleration.value_m_s2,
    HAS_IN_TRACK_ACCELERATION_M_S2: p.inTrackAcceleration.specified,
    DRAG_AREA_OVER_MASS_RATE_M2_KG_S: p.drag.areaOverMassRate_m2_kg_s,
    HAS_DRAG_AREA_OVER_MASS_RATE_M2_KG_S: p.drag.areaOverMassRateSpecified,
    MAXIMUM_TESSERAL_DEGREE: p.gravity.maximumTesseralDegree,
    HAS_MAXIMUM_TESSERAL_DEGREE: p.gravity.maximumTesseralDegreeSpecified,
    RADIATION_PRESSURE_MODEL: enumValue('pcfRadiationPressureFamily', p.srp.model.toUpperCase()),
    GNSS_BLOCK: enumValue('pcfGnssSpacecraftBlock', p.srp.gnssBlock),
    ECOM2: p.srp.ecom2,
    EARTH_RADIATION: enumValue('pcfEarthRadiationModel', p.earthRadiation.model.toUpperCase()),
    EARTH_RADIATION_RESOLUTION_DEG: p.earthRadiation.resolutionDeg,
    EARTH_RADIATION_AREA_OVER_MASS_M2_KG: p.earthRadiation.areaOverMass_m2_kg,
    HAS_EARTH_RADIATION_AREA_OVER_MASS_M2_KG: p.earthRadiation.areaOverMassSpecified,
    OCEAN_TIDES: enumValue('pcfOceanTideModel', p.oceanTides.model),
    OCEAN_TIDE_MAXIMUM_DEGREE: p.oceanTides.degree,
    OCEAN_TIDE_MAXIMUM_ORDER: p.oceanTides.order,
  };
}

function integrator(p) {
  return {
    ALGORITHM: enumValue('pcfIntegratorAlgorithm', p.algorithm),
    INITIAL_STEP_SECONDS: p.initialStep_s,
    MINIMUM_STEP_SECONDS: p.minStep_s,
    MAXIMUM_STEP_SECONDS: p.maxStep_s,
    ABSOLUTE_TOLERANCES: Array(p.absoluteToleranceComponents).fill(p.absoluteTolerance_m),
    RELATIVE_TOLERANCE: p.relativeTolerance,
    MAXIMUM_STEPS: p.maxSteps,
  };
}

// The whole unpacked table is compared, including its key set. New schema
// defaults cannot silently escape the profile by being omitted from a subset.
function same(actual, expected, label) {
  assert.deepEqual(plain(actual), expected, label);
}

function checkCppDefaults(p) {
  const header = read('lib/force_models.h');
  const dynamics = read('src/cpp/src/prw_dynamics.cpp');
  const boolDefault = (member) => {
    const match = header.match(new RegExp(`bool\\s+${member}\\s*\\{(true|false)\\}`));
    assert.ok(match, `Missing C++ default ${member}`);
    return match[1] === 'true';
  };
  const shadow = header.match(/ShadowModelType shadowModel\{ShadowModelType::(\w+)\}/)?.[1];
  assert.ok(shadow, 'Missing C++ shadow default');
  assert.equal(p.srp.shadow.split(' ')[0], shadow.toLowerCase(), 'SRP shadow');
  assert.equal(p.gravity.tideSystem, boolDefault('zeroTideField') ? 'zero-tide' : 'tide-free', 'Gravity tide system');
  assert.equal(p.poleTide.enabled, boolDefault('usePoleTide'), 'Pole tide default');
  assert.ok(!/out\.usePoleTide\s*=/.test(dynamics), 'PRW pole-tide selection changed; review profile');
  assert.equal(p.drag.winds.includes('false by default'), !boolDefault('includeWinds'), 'Wind default');
  assert.ok(!/out\.drag\.includeWinds\s*=/.test(dynamics), 'PRW wind selection changed; review profile');
  for (const [member, label] of [['includeSunTide', 'Sun'], ['includeMoonTide', 'Moon'], ['frequencyDependent', 'frequency-dependent Step 2']])
    assert.equal(p.solidTides.model.includes(label), boolDefault(member), `Solid tide ${member}`);
  const branch = dynamics.match(new RegExp(`case pcfRelativityTerms::${p.relativity.selection}:([\\s\\S]*?)break;`))?.[1];
  assert.ok(branch, 'Missing selected relativity branch');
  const assignments = [...branch.matchAll(/((?:out\.relativistic\.\w+\s*=\s*)+)(true|false)\s*;/g)];
  const enabled = new Set(assignments.filter((m) => m[2] === 'true').flatMap((m) => [...m[1].matchAll(/out\.relativistic\.(\w+)/g)].map((v) => v[1])));
  const names = { schwarzschild: 'Schwarzschild', lenseThirring: 'Lense-Thirring', deSitter: 'de Sitter' };
  same([...enabled].map((key) => names[key]).sort(), [...p.relativity.terms].sort(), 'Applied relativity terms');
  const reentry = read('lib/reentry.h');
  const threshold = reentry.match(/REENTRY_ALTITUDE_KM\s*=\s*([\d.]+)/)?.[1];
  assert.ok(threshold, 'Missing reentry threshold');
  assert.ok(p.reentry.includes(`${Number(threshold)} km`), 'Reentry altitude disagrees');
  assert.match(reentry, /PropagationStop\{true, "reentry",/);
  for (const file of ['integrators.cpp', 'variational.cpp', 'finite_burn.cpp'])
    assert.match(read(`lib/${file}`), /if\s*\(stopAt\(/, `${file} reentry hook`);
}

// Generic rendering keeps every profile field visible without a second list
// of force values. References have their own column; sources stay in the JSON.
const cell = (text) => String(text).replaceAll('&', '&amp;').replaceAll('|', '&#124;').replaceAll('\n', '<br>');
const valueText = (value) => Array.isArray(value) ? value.map(valueText).join(', ')
  : value && typeof value === 'object' ? Object.entries(value).filter(([key]) => key !== 'reference')
    .map(([key, child]) => `${key}: ${child && typeof child === 'object' && !Array.isArray(child) ? `(${valueText(child)})` : valueText(child)}`).join('; ')
    : String(value);
const rows = (p) => Object.entries(p).filter(([key]) => key !== 'sources').map(([term, value]) =>
  [term, valueText(value), value?.reference ?? 'Code contract (profile sources)'].map(cell));
const table = (p) => ['| term | value | reference standard |', '| --- | --- | --- |', ...rows(p).map((row) => `| ${row.join(' | ')} |`)].join('\n');
function definition(p) {
  return `# FFM (Full Force Model)\n\n## What FFM means\n\nFFM means the full force model, never a reduced model. ${p.profile} specifies the catalog execution request, its applied defaults and its supported alternatives; an alternative is active only when selected.\n\n## Profile ${p.profile}\n\n${table(p)}\n\n## How to cite\n\nCite “${p.profile}” and the \`${p.profile} sha256=<hex>\` printed by the check. The SHA-256 covers UTF-8 JSON with recursively sorted object keys, preserved array order and no whitespace, including sources.\n\n## Conforming implementations\n\nFFM-1 is the force model: the force, frame and time rows above. The sole implementation is \`propagator/ffm\`, module \`com.orbpro.ffm\` version 2.0.0. Forward resident propagation automatically selects GJ8 PEC or eccentric-orbit Sundman RK78; RK also supplies startup, backward propagation and physical reentry handoff. The integrator rows encode its PRW configuration. Numerical reports cite this policy together with the profile. Test-only reference artifacts are never product modes.\n\n## Where it is enforced\n\nRun \`node tests/ffm-profile-check.mjs\`. It compares decoded PRW defaults and module identity with [the profile](ffm-1.profile.json), checks C++ defaults, and verifies this table. The end-to-end gate is \`node scripts/e2e-ffm.mjs\`.\n\n## Versioning\n\nAny force, frame or time change requires a new profile id; an implementation\x27s integrator change is its own version, not a new profile. The implementation version replaces its predecessor.\n`;
}

async function main() {
  const p = JSON.parse(read('ffm-1.profile.json'));
  const manifest = JSON.parse(read('plugin-manifest.json'));
  assert.equal(manifest.pluginId, p.module, 'Module id');
  assert.equal(manifest.version, p.moduleVersion, 'Module version');
  const request = decode(encode('EXECUTION_REQUEST', fullForceRequest({
    epoch: '2026-08-02T00:00:00Z', state: [7000000, 0, 0, 0, 7500, 0],
  }))).EXECUTION_REQUEST;
  same(request.FORCES, forces(p), 'Catalog FORCES');
  same(request.INTEGRATOR, integrator(p.integrator.catalog), 'Catalog INTEGRATOR');
  same(Object.fromEntries(Object.entries(request).filter(([key]) => key.includes('STM') || key === 'DENSITY_TREATMENT')), {
    INCLUDE_STM: p.stm.include,
    STM_TECHNIQUE: enumValue('prwDerivativeTechnique', p.stm.technique),
    DENSITY_TREATMENT: enumValue('prwDensityTreatment', p.stm.densityTreatment),
  }, 'Catalog STM');
  assert.equal(request.INITIAL.COORDINATE_SYSTEM.NAME, p.frames.inertial, 'Inertial frame');
  assert.equal(request.INITIAL.STATE.EPOCH_TIME_SYSTEM, p.time.input, 'Input time scale');
  assert.equal(P.timingStandard[request.TARGET_EPOCH.TIME_SYSTEM], p.time.input, 'Target time scale');

  // Existing OD test bridge uses this builder; encoding/decoding only. No
  // estimator or propagator is instantiated and no numerical result is made.
  const { requestInputs } = await import('./lib/orekitCases.mjs');
  const fit = requestInputs({ degree: p.gravity.degree, order: p.gravity.order, thirdBodies: true, srp: true, drag: true,
    samples: [[0, 7000000, 0, 0, 0, 7500, 0], [1, 0, 0, 0, 0, 0, 0, '2026-08-02T00:00:01Z']] });
  same(decode(fit.find((port) => port.portId === 'request').payload).EXECUTION_REQUEST.INTEGRATOR,
    integrator(p.integrator.fit), 'OD test bridge INTEGRATOR');
  checkCppDefaults(p);
  same(Object.keys(p.sources).sort(), Object.keys(p).filter((key) => key !== 'sources').sort(), 'Source coverage');
  for (const [term, citations] of Object.entries(p.sources)) {
    assert.ok(Array.isArray(citations) && citations.length, `Missing sources for ${term}`);
    for (const citation of citations) {
      const match = /^(.*):(\d+)$/.exec(citation);
      assert.ok(match, `Invalid source: ${citation}`);
      const filename = path.resolve(checkout, match[1]);
      assert.ok(filename.startsWith(checkout + path.sep), `Source outside checkout: ${citation}`);
      assert.ok(Number(match[2]) > 0 && fs.readFileSync(filename, 'utf8').split('\n').length >= Number(match[2]), `Missing source line: ${citation}`);
    }
  }
  assert.ok(process.argv.slice(2).every((arg) => arg === '--write-definition'), 'Only --write-definition is supported');
  if (process.argv.includes('--write-definition')) fs.writeFileSync(path.join(moduleDir, 'FFM.md'), definition(p));
  const markdown = read('FFM.md');
  const section = markdown.split(`## Profile ${p.profile}\n`)[1]?.split('\n## ')[0];
  assert.ok(section, 'Missing profile table section');
  const parsed = section.split('\n').filter((line) => line.startsWith('|')).map((line) => line.slice(1, -1).split('|').map((v) => v.trim()));
  same(parsed, [['term', 'value', 'reference standard'], ['---', '---', '---'], ...rows(p)], 'FFM.md table');
  assert.equal(markdown, definition(p), 'FFM.md must derive from the profile; render with --write-definition');
  console.log(`${p.profile} sha256=${createHash('sha256').update(canonical(p)).digest('hex')}`);
  console.log('FFM profile check: PASS');
}

main().catch((error) => {
  console.error(`FFM profile check: FAIL ${error.message}`);
  process.exitCode = 1;
});
