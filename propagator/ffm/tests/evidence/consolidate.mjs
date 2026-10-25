// Data adapters and deterministic presentation for check-all.mjs. Numerical
// reductions and unit formatting live in consolidated-metrics.cpp.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '../../../..');
const read = (p) => JSON.parse(fs.readFileSync(path.resolve(here, p), 'utf8'));
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const require = (ok, why) => { if (!ok) throw new Error(why); };
const digest = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const nonempty = (s) => typeof s === 'string' && s.trim().length;
export const childEnv = (work) => ({ ...process.env, TMPDIR: work, TMP: work, TEMP: work,
  UV_THREADPOOL_SIZE: '1', NODE_OPTIONS: '--v8-pool-size=1', OMP_NUM_THREADS: '1',
  OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1',
  CMAKE_BUILD_PARALLEL_LEVEL: '1', MAKEFLAGS: '-j1', EMCC_CORES: '1' });
const definitions = [
  ['orekit', 'Orekit', 'orekit/summary.json', 'orekit'],
  ['gmat-2026', 'GMAT R2026a', 'gmat/summary-gmat-R2026a.json', 'gmat'],
  ['gmat-2022', 'GMAT R2022a', 'gmat/summary-gmat-R2022a.json', 'gmat'],
  ['nyx', 'Nyx', 'nyx/summary-nyx-2.6.0.json', 'nyx'],
  ['tudatpy', 'tudatpy', 'tudat/summary-tudatpy-1.0.0.json', 'tudat'],
  ['tudat-wasm', 'Tudat WASM', 'tudat/summary-tudat-wasm.json', 'tudat'],
  ['basilisk', 'Basilisk', 'basilisk/summary-basilisk-2.12.0.json', 'basilisk'],
];
const pin = (label, sha256, extra = {}) => ({ label, sha256, ...extra });
function filePin(s, pattern, label) {
  const entry = s.fileHashes?.find((p) => pattern.test(p.path ?? p.file));
  require(entry, `Missing ${label} source/package pin`);
  return pin(label, entry.sha256, { path: entry.path ?? entry.file });
}
function toolPins(id, s, tool) {
  if (id === 'orekit') {
    require(s.orekit?.sourcePin, 'Orekit reference-generator source pin missing');
    return [pin('Orekit reference-generator source (engine archive unavailable)', s.orekit.sourcePin.sha256,
      { path: s.orekit.sourcePin.path })];
  }
  if (id.startsWith('gmat')) return [pin('GmatConsole', tool.gmatConsoleSha256), pin('libGmatBase', tool.gmatBaseSha256)];
  if (id === 'nyx') return [pin('nyx-space crate', tool.nyxCrateSha256), pin('Cargo.lock', tool.cargoLockSha256)];
  if (id === 'tudatpy') return [pin('installed kernel.so', tool.kernelSha256)];
  if (id === 'tudat-wasm') return [filePin(s, /tudat_wasm_driver\.cpp$/, 'reference C++ driver source'),
    { label: 'Tudat package source revision', revision: s.provenance.packageCommit }];
  return [filePin(s, /Basilisk\/simulation\/_spacecraft\.so$/, 'Basilisk spacecraft binary'),
    { label: 'Basilisk source revision', revision: tool.buildInfo.artifact.sourceRevision }];
}
const metric = (label, value, limit, unit, strict = false) => ({ label, value, limit, unit, strict });
// These diagnostics were recorded at different FFM settings. Transport the
// pinned trajectories to C++ so the comparison uses the suite setting for all
// tools, and first reproduce each diagnostic's originally recorded score.
function collectDragDiagnostics(summaries, exported) {
  const checked = (file, expected) => {
    const absolute = path.resolve(here, file), checksum = sha(absolute);
    require(digest(expected) && checksum === expected, `Diagnostic input hash differs: ${file}`);
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  };
  const cachePin = summaries.tudatpy.provenance.ffmTrajectories;
  const cacheFile = `tudat/${cachePin.path}`, cache = checked(cacheFile, cachePin.sha256);
  require(JSON.stringify(cache.identity) === JSON.stringify(summaries.tudatpy.provenance.propagationInputs), 'Diagnostic FFM cache identity differs');
  for (const p of cache.identity) require(sha(path.resolve(here, 'tudat', p.path)) === p.sha256, `Diagnostic FFM input differs: ${p.path}`);
  const ffm = (id) => {
    const c = cache.cases.find((c) => c.id === id);
    require(c, `Diagnostic FFM trajectory missing: ${id}`);
    return Object.fromEntries(exported.protocol.stepSettings.map(({id}) => [id, { positions: c[id].positions }]));
  };
  const stock = (tool, id) => {
    const row = summaries[tool].cases.find((c) => c.id === id);
    require(row, `${tool}: diagnostic case missing from stock summary: ${id}`);
    return row.suite.worstM;
  };
  const cacheSource = pin('FFM trajectories at suite / steps30 / finest', cachePin.sha256, { path: cacheFile });
  const oxygenPin = summaries['gmat-2026'].provenance.anomalousOxygen;
  const oxygenFile = `gmat/${oxygenPin.path}`, oxygen = checked(oxygenFile, oxygenPin.sha256);
  const gmatPins = [cacheSource, pin('Anomalous-oxygen diagnostic', oxygenPin.sha256, { path: oxygenFile })];
  const gmatCases = oxygen.rows.map((r) => {
    const stem = path.join('/Users/tj/software/tools/xval/gmat-work/anomalous-oxygen', r.id.replaceAll(' ', '_'));
    const report = `${stem}.txt`, script = `${stem}.script`, text = fs.readFileSync(script, 'utf8');
    const cd = /GMAT Sat\.Cd = ([\d.eE+-]+);/.exec(text);
    require(cd && text.includes('GMAT FM.Drag.AtmosphereModel = NRLMSISE00;'), `${r.id}: Cd-scaled NRLMSISE-00 script missing`);
    for (const file of [report, script]) gmatPins.push(pin(path.basename(file), sha(file), { path: file }));
    return { id: r.id, stockM: stock('gmat-2026', r.id), gmatReport: fs.readFileSync(report, 'utf8'),
      ffm: ffm(r.id), expected: { setting: 'steps30', worstM: r.ffmMinusGmatCdScaledM },
      eps: r.eps, Cd: Number(cd[1]), baseCd: exported.cases.find((c) => c.id === r.id).forces.drag.cd };
  });
  const nyxPin = summaries.nyx.diagnostics.dragSettings;
  const nyxFile = `nyx/${nyxPin.file}`, nyx = checked(nyxFile, nyxPin.sha256);
  const basilisk = summaries.basilisk.diagnostics['wgs84-gtd7d'];
  checked(`basilisk/${basilisk.file}`, basilisk.sha256);
  return [
    { id: 'gmat-2026', label: 'GMAT R2026a', setting: 'suite', adjustment: 'Cd scaled by 1 + eps from the anomalous-oxygen diagnostic',
      evidence: oxygenFile, pins: gmatPins, cases: gmatCases },
    { id: 'nyx', label: 'Nyx', setting: 'suite', adjustment: 'Published NRLMSISE-00 formulas + WGS84 shape',
      evidence: nyxFile, pins: [cacheSource, pin('Published-formula / WGS84 trajectories', nyxPin.sha256, { path: nyxFile })],
      cases: nyx.trajectories.map((r) => ({ id: r.id, stockM: stock('nyx', r.id), samples: r.samples, ffm: ffm(r.id),
        expected: { setting: 'finest', worstM: nyx.cases.find((c) => c.id === r.id).finest.worstM } })) },
    { id: 'basilisk', label: 'Basilisk', setting: 'suite', adjustment: 'WGS84 coordinates + native gtd7d density',
      evidence: 'basilisk/summary-basilisk-2.12.0.json#/diagnostics/wgs84-gtd7d',
      pins: [pin('WGS84 / gtd7d trajectories', basilisk.sha256, { path: `basilisk/${basilisk.file}` })],
      cases: basilisk.cases.map((r) => ({ id: r.id, stockM: stock('basilisk', r.id), suiteM: r.suite.worstM })) },
  ];
}
function collect() {
  const exported = read('cases/ffm-reference-cases.json');
  const summaries = {}, tools = [], metadata = [], format = {};
  const formatValue = (key, value, unit = 'm', precision) => { format[key] = { value, unit, ...(precision === undefined ? {} : { precision }) }; return key; };
  const ffm = read('../../package.json');
  const moduleHash = sha(path.resolve(here, '../../dist/isomorphic/module.wasm'));
  require(ffm.version === read('../../plugin-manifest.json').version && moduleHash === read('../../dist/build-provenance.json').sha256, 'Shipped FFM identity differs from build provenance');
  function add(meta, data) {
    require(nonempty(meta.version) && meta.pins.some((p) => digest(p.sha256)), `${meta.id}: missing version/checksum pin`);
    for (const p of meta.pins) require(p.revision || digest(p.sha256), `${meta.id}: invalid pin ${p.label}`);
    metadata.push({ ...meta, summarySha256: sha(path.resolve(here, meta.evidence)) }); tools.push({ ...data, id: meta.id });
  }
  for (const [id, label, evidence, family] of definitions) {
    const s = summaries[id] = read(evidence), tool = s[family]?.tool ?? (id === 'orekit' ? s.orekit : s.tool);
    require(s.module?.version === ffm.version && s.module?.sha256 === moduleHash, `${id}: FFM version/hash mismatch`);
    require(tool, `${id}: tool identity missing`);
    const version = id.startsWith('gmat') ? s.verdict.release : tool.version ?? tool.nyxSpace;
    const verdict = s.verdict?.tool ?? s.verdict?.stockNyx ?? s.verdict?.suite ?? s.verdict;
    require([verdict?.total, verdict?.met, verdict?.missed].every(Number.isInteger), `${id}: missing numeric verdict counts`);
    const stmStatement = (s.cases.every((r) => !r.stm && !r.suite?.jacobians) ? s.cases[0]?.stmSkipped : undefined) ?? s.verdict?.stm?.statement ?? (id === 'orekit' ? 'Relative column differences; exported protocol specifies no STM pass limit.' : 'No stored STM comparison.');
    const cases = s.cases.map((r) => ({ ...r, id: r.id ?? `${r.orbit} ${r.forces}`,
      ...(r.suite.jacobians ? { stm: { worst: r.suite.jacobians.stm, parameters: r.suite.jacobians.parameters } } : {}) }));
    add({ id, label, version, evidence, pins: toolPins(id, s, tool),
      modelSettings: typeof s[family]?.settings === 'string' ? { configuration: s[family].settings } : s[family]?.settings ?? s.referenceSettings ?? s.protocol,
      ffmSettings: exported.protocol.stepSettings, toolIdentity: tool,
      provenanceLimitations: id === 'orekit' ? s.orekit.engineBinary : id === 'tudat-wasm' ? s.provenance.apiLimitation : undefined,
    }, { kind: 'propagation', cases, skipped: s.skipped ?? [], toleranceGroup: family === 'gmat' ? 'gmat' : 'default',
      expected: { scored: verdict.total, met: verdict.met, missed: verdict.missed, ...(s.verdict.coverage ? { skipped: s.verdict.coverage.skipped } : {}) },
      ...(id === 'orekit' ? { expectedSettings: Object.fromEntries(Object.entries(s.verdict).map(([key,v]) => [key, { scored: v.total, met: v.met, missed: v.missed }])) } : {}), stmStatement });
  }
  const erfa = summaries.frames = read('erfa-spice/summary-erfa-spice.json'), packages = read('erfa-spice/tools.json');
  const framePins = Object.entries(packages.wheels).filter(([name]) => !name.startsWith('numpy')).map(([name, p]) => pin(name, p.sha256));
  add({ id: 'frames', label: 'ERFA / SPICE', version: `${erfa.tools.erfa} / ${erfa.tools.cspice}`, evidence: 'erfa-spice/summary-erfa-spice.json', pins: framePins,
    modelSettings: { epochs: erfa.epochs, frame: 'IAU 2006/2000A CIO and classical chains; shared EOP; SPICE ITRF93; same-date and UTC-date comparisons', ephemeris: 'DE440', time: 'UTC, TT, UT1, TDB as labelled per row' },
    stepSetting: 'stored epochs; no integration', protocol: erfa.provenance.measurement },
  { kind: 'rows', skipped: erfa.skipped, stmStatement: 'not exposed',
    rows: erfa.rows.map((r) => ({ id: r.id, label: r.quantity, reference: r.reference, note: r.note, cause: r.cause,
      metrics: [metric('maximum difference', r.max, r.tolerance, r.unit)], expectedMet: r.met })),
    expected: { scored: erfa.rows.filter((r) => r.tolerance !== null).length, met: erfa.verdict.met, missed: erfa.verdict.missed, untoleranced: erfa.verdict.untoleranced, diagnostic: erfa.verdict.untoleranced } });
  require(erfa.rows.length === erfa.verdict.rows, 'ERFA/SPICE row count differs from summary verdict');
  const horizons = summaries.horizons = read('horizons/summary-horizons.json');
  const rawPins = Object.entries(horizons.horizons.rawFiles).map(([name, r]) => pin(`Horizons ${name} response`, r.responseSha256));
  add({ id: 'horizons', label: 'JPL Horizons', version: horizons.horizons.version, evidence: 'horizons/summary-horizons.json',
    pins: [...rawPins, ...framePins.filter((p) => p.label.startsWith('spice'))],
    provenanceLimitations: 'Remote Horizons engine binary is not distributed; API version and exact response bytes are pinned.',
    modelSettings: { reference: 'DE441 geometric ICRF, Earth center 399; identical target IDs', evaluators: 'FFM Sun/Moon; CSPICE DE440 Venus/Jupiter barycenter', jwst: horizons.jwst.parameters },
    stepSetting: 'stored raw UTC epochs; JWST stored FFM runs', protocol: { bodyEpochs: read('horizons/raw/index.json').epochsUtc, bodyToleranceRationale: horizons.bodies[0].toleranceRationale, jwstEpochUtc: horizons.jwst.epochUtc, jwstFinalEpochUtc: horizons.jwst.finalEpochUtc } },
  { kind: 'rows', skipped: horizons.skipped, stmStatement: 'not exposed', rows: [
    ...horizons.bodies.flatMap((r) => [
      { id: r.body, label: `${r.body}: ${r.evaluator}`, group: 'bodies', metrics: [metric('position', r.maxPositionM, r.positionToleranceM, 'm', true), metric('velocity', r.maxVelocityMmS, r.velocityToleranceMmS, 'mm/s', true)], expectedMet: r.met, cause: r.cause },
      { id: `${r.body}-submeter`, label: `${r.body}: sub-meter diagnostic`, role: 'diagnostic', group: 'submeter', metrics: [metric('position', r.maxPositionM, r.subMeter.toleranceM, 'm', true)], expectedMet: r.subMeter.met, cause: r.subMeter.cause },
    ]),
    ...horizons.jwst.rows.map((r) => ({ id: `jwst-${r.id}`, label: `JWST ${r.id}`, group: 'jwst', metrics: [metric('position', r.maxPositionM, r.positionToleranceM, 'm', true)], expectedMet: r.met, cause: r.cause })),
  ], expected: { scored: 6, met: 6, missed: 0, diagnostic: 4 }, expectedGroups: { bodies: { scored: horizons.verdict.bodiesTotal, met: horizons.verdict.bodiesMet }, jwst: { scored: horizons.jwst.rows.length, met: horizons.verdict.jwstMet } } });
  // The module against its SGP4/SDP4 base (foundation/sgp4-str3), per regime: the largest position and velocity differences. The
  // evidence states no limit, so its rows are diagnostic and enter no met/missed count.
  const str3Path = '../../../sgp4/tests/evidence/str3/summary-str3.json';
  const str3 = summaries.str3 = read(str3Path);
  const str3Dir = path.resolve(here, '../../../sgp4/tests/evidence/str3');
  const regimeLabels = { 'near-earth': 'near-Earth (SGP4)', deep: 'deep space (SDP4)', geo: 'geosynchronous (SDP4)' };
  require(Object.keys(str3.regimes).every((k) => regimeLabels[k]) && Object.keys(str3.regimes).length === 3, 'STR#3 evidence regimes differ from the three the report names');
  const str3Rows = Object.entries(str3.regimes).map(([regime, r]) => ({ id: `str3/${regime}`, label: `${regimeLabels[regime]}: ${r.sets} sets, ${r.states} states`, regime, samples: r.states,
    metrics: [metric('position 3D', r.maxPositionM, null, 'm'), metric('velocity 3D', r.maxVelocityMps, null, 'm/s')],
    note: `Largest on set ${r.at}; ${r.refusedBoth} states refused by both` }));
  add({ id: 'str3', label: 'SGP4 against its STR#3 base', version: `foundation/sgp4-str3; module ${read('../../../sgp4/package.json').version}`, evidence: str3Path,
    pins: [pin('shipped WASM (propagator/sgp4 dist/browser)', sha(path.resolve(here, '../../../sgp4/dist/browser/module.wasm'))), pin('library_states.cpp', sha(path.join(str3Dir, 'library_states.cpp'))), pin('run-str3.mjs', sha(path.join(str3Dir, 'run-str3.mjs')))],
    modelSettings: { frame: 'TEME', reference: str3.reference, minutesFromEpoch: str3.minutes },
    stepSetting: `${str3.minutes.length} times per set, from ${Math.min(...str3.minutes)} to ${Math.max(...str3.minutes)} minutes from epoch` },
  { kind: 'rows', rows: str3Rows, skipped: [], stmStatement: 'not exposed', expected: { scored: 0, met: 0, missed: 0, diagnostic: str3Rows.length, untoleranced: str3Rows.length } });
  const xpPath = '../../../sgp4/tests/evidence/xp/summary-xp.json', xp = summaries.xp = read(xpPath);
  const xpVersion = /Sgp4Prop ([\d.]+)/.exec(xp.about)?.[1];
  add({ id: 'xp', label: 'SGP4-XP', version: `${xpVersion}; module ${xp.module.version}`, evidence: xpPath,
    pins: Object.entries(xp.hashes).filter(([p]) => p.endsWith('.wasm')).map(([p,h]) => pin(p,h)),
    modelSettings: { comparison: xp.parity.comparison, statement: xp.verdict, anchors: xp.anchors }, stepSetting: `${xp.parity.sets} sets × ${xp.parity.times} times` },
  { kind: 'rows', skipped: [], stmStatement: 'not exposed', rows: [{ id: 'library-parity', label: 'Exact library parity', metrics: [metric('failed parity tests', xp.parity.fail, 0, 'tests')], expectedMet: xp.parity.met }], expected: { scored: xp.parity.pass, met: xp.parity.pass, missed: xp.parity.fail } });
  require(nonempty(xpVersion), 'SGP4-XP engine version pin missing');
  for (const [index, defect] of erfa.verdict.defects.entries()) for (const radius of ['leoM', 'gpsM', 'geoM'])formatValue(`defect-${index}-${radius}`, defect.effect[radius]);
  const ecef = erfa.rows.find((r) => r.id === 'coordsEcefCio');
  for (const radius of ['leoM','gpsM','geoM']) formatValue(`ecef-${radius}`, ecef[radius]);
  const clock = erfa.rows.find((r) => r.id === 'forceClock'), rotation = erfa.rows.find((r) => r.id === 'c2tTrue');
  formatValue('force-clock', clock.max, clock.unit); formatValue('force-clock-rotation', rotation.max, rotation.unit);
  formatValue('force-clock-leo', rotation.leoM);
  return { exported, summaries, metadata, input: { export: exported, tools, format,
    dragDiagnostics: collectDragDiagnostics(summaries, exported),
    orbits: [...new Set(exported.cases.map((c) => c.orbit))], families: Object.keys(exported.protocol.rows),
    columns: [...definitions.map(([id]) => id), 'orekit-finest'] },
    module: { version: ffm.version, sha256: moduleHash } };
}
const esc = (s) => String(s ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
const words = (key) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
const sentence = (value) => /[.!?]$/.test(String(value)) ? String(value) : `${value}.`;
function settingLines(value, labels = []) {
  const label = labels.map(words).join(' · '), key = labels.at(-1) ?? '';
  if (Array.isArray(value)) {
    if (/caseIds$/i.test(key)) return [`- ${label}: ${value.length} cases (IDs retained in consolidated.json).`];
    if (value.every((v) => typeof v !== 'object' || v === null))
      return [`- ${label}: ${sentence(value.length ? value.join(/flags/i.test(label) ? ' ' : ', ') : 'none')}`];
    return value.flatMap((v, i) => settingLines(v, [...labels, `item ${i + 1}`]));
  }
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k,v]) => settingLines(v, [...labels,k]));
  return [`- ${label}: ${sentence(value ?? 'not specified')}`];
}
const pinsList = (pins) => pins.map((p) => `- ${p.label}: \`${p.sha256 ?? p.revision}\`.`).join('\n');
function renderSettings(tool) {
  return `### ${tool.label}\n\nVersion: ${tool.version}. Evidence: [${tool.evidence}](${tool.evidence}).\n\n${pinsList(tool.pins)}\n\nModel settings:\n\n${settingLines(tool.modelSettings ?? {}).join('\n')}\n\nStep setting: ${tool.stepSetting ?? 'FFM suite / steps30 / finest as defined above; reference integrator settings as listed.'}${tool.provenanceLimitations ? `\n\nProvenance limit:\n\n${settingLines(tool.provenanceLimitations, ['availability']).join('\n')}` : ''}`;
}
function dragDiagnosticTable(diagnostics) {
  return table(['Tool', 'Orbit', 'Cases', 'Stock', 'Setting difference removed', 'Limit', 'Stock verdict', 'Diagnostic verdict'], diagnostics.flatMap((d) => d.rows.map((r) => [d.label, r.orbit, r.cases, r.stockDisplay, r.correctedDisplay, r.limitDisplay, r.stockMet ? 'met' : 'not met', r.met ? 'met' : 'not met'])));
}
function renderDragDiagnostics(diagnostics, evidencePrefix = '') {
  return `### Drag cases with the tool-side setting difference removed (diagnostic)\n\nBoth columns use FFM's suite setting and the same supported drag cases per tool. Each entry is the maximum hourly 3D position difference across that orbit's cases. These diagnostic comparisons do not change the primary counts.\n\n${dragDiagnosticTable(diagnostics)}\n\n${diagnostics.map((d) => `- ${d.label}: ${d.adjustment}. [Evidence](${evidencePrefix}${d.evidence}).`).join('\n')}\n\nGMAT's stored steps30 score and Nyx's stored finest score are reproduced before their corrected trajectories are re-scored against the pinned FFM suite trajectories. Basilisk's suite diagnostic is stored directly. GMAT's Cd scale uses the recorded mean anomalous-oxygen density fraction for each case.`;
}
const causeText = (r) => r.cause ? `${r.cause.classification}: ${r.cause.statement}` : r.note ?? '';
function renderRows(tool) {
  const note = (r) => tool.id !== 'frames' ? causeText(r) : r.cause?.classification ??
    (r.id === 'c2tBuiltIn' ? `${r.note.split(';')[0]}.` : r.note ?? '');
  return `### ${tool.label}\n\n${table(['Row','Maximum difference','Limit','Verdict / role','Cause / note'], tool.rows.map((r) => [r.label,
    r.metrics.map((m) => `${m.label}: ${m.display}`).join('; '), r.metrics.filter((m) => m.limit !== null).map((m) => `${m.label}: ${m.strict ? '< ' : '≤ '}${m.limitDisplay}`).join('; ') || 'not specified',
    r.status, note(r)]))}`;
}
function renderVerificationSets(data) {
  const xp = data.sgp4.xp;
  const str3 = data.tools.find((t) => t.id === 'str3');
  const compact = table(['Regime', 'Sets', 'States', 'Position (max)', 'Velocity (max)', 'Largest at'], str3.rows.map((r) => [r.label.split(':')[0], r.label.match(/(\d+) sets/)[1], r.samples,
    r.metrics[0].display, r.metrics[1].display, r.note.match(/set ([^;]+);/)[1]]));
  const xpScope = xp.verdict.split('. ').at(-1);
  return `[SGP4 against its STR#3 base](tests/evidence/str3/) holds every state of the shipped module to the base it is built on, compiled natively without \`-ffast-math\`: the seven SGP4-VER element sets, the module's own test sets and four more regimes, at ${data.sgp4.str3.minutes.length} times from a day before epoch to ten days after, in TEME. The request is the epoch plus the minutes the module computes.\n\n${compact}\n\n[SGP4-XP](tests/evidence/xp/) checks ${xp.parity.sets} SGP4/XP sets at ${xp.parity.times} times for exact library parity and records ${xp.anchors.cases} Tier B anchors. ${xpScope}\n\nFrom the repository root:\n\n\`\`\`sh\nUV_THREADPOOL_SIZE=1 node --v8-pool-size=1 propagator/ffm/tests/evidence/check-all.mjs\n\`\`\``;
}
function render(data) {
  const { tools, positionTable, findings, formatted: f } = data;
  const columns = definitions.map(([id, label]) => [id,label]);columns.push(['orekit-finest','Orekit finest']);
  const forceLabels = { pointMass: 'point mass', fullNoDrag: 'field + third bodies + SRP (no drag)', drag: 'drag' };
  const position = table(['Orbit', 'Force class', ...columns.map(([,label]) => label)], positionTable.map((r) => [r.orbit,
    forceLabels[r.forceClass], ...columns.map(([id]) => r.cells[id]?.display ?? '—')]));
  const steps = table(['FFM setting', 'Maximum step (s)', 'Relative tolerance', 'Point-mass tolerance'], data.protocol.stepSettings.map((s) => [s.id, s.maxStepS, s.relativeTolerance, s.relativeTolerancePointMass]));
  const limits = table(['Tool group', 'Point mass (m)', 'Gravity (m)', 'SRP (m)', 'Drag (m)'], ['default','gmat'].map((name) => [name, ...['pointMass','gravity','srp','drag'].map((key) => data.protocol.tolerancesM[name][key])]));
  const counts = table(['Tool', 'Version', 'Scored (primary)', 'Skipped', 'Met', 'Missed', 'Diagnostic', 'Decomposition'], tools.map((t) => [t.label, t.version, t.counts.scored, t.counts.skipped, t.counts.met, t.counts.missed, t.counts.diagnostic, t.counts.decomposition]));
  const stm = table(['Tool', 'STM maximum relative column difference', 'Interpretation'], tools.map((t) => [t.label,t.stm.display,t.stm.statement]));
  const settings = tools.map(renderSettings).join('\n\n');
  const diagnosticPins = data.dragDiagnostics.map((d) => `### ${d.label} drag diagnostic inputs\n\n${pinsList(d.pins)}`).join('\n\n');
  const dragFootnote = 'For the GMAT R2026a, Nyx and Basilisk drag entries, see [the diagnostic comparison below](#drag-cases-with-the-tool-side-setting-difference-removed-diagnostic).';
  const rowTables = tools.filter((t) => !definitions.some(([id]) => id === t.id)).map(renderRows).join('\n\n');
  const ecef = table(['Classical ECEF versus CIO','Position bound'],['leoM','gpsM','geoM'].map((r,i) => [['LEO','GPS','GEO'][i],f[`ecef-${r}`]]));
  const findingText = `Classical-frame source defects remaining: ${findings.defects.length}. ERFA is the authoritative IAU 1976/1980 implementation. Before/after measurements and the velocity-axis diagnostic are in [before-after.json](erfa-spice/before-after.json).\n\n${ecef}\n\nThe remaining classical ECEF budget is UT1 = UTC, zero polar motion, no frame bias and the 1976/1980 model. These values are radius-times-angle bounds over the 50 sample epochs. Reference-suite field/drag cases supply EOP and use the CIO force-model chain.\n\nThe force TDB model spread is ${f['force-clock']}; the exact-epoch Earth-rotation difference is ${f['force-clock-rotation']}, or ${f['force-clock-leo']} at LEO radius. ${findings.forceClock.note} Evidence: [ERFA/SPICE summary](erfa-spice/summary-erfa-spice.json).\n\n${findings.toolCauses.map((x) => `- **${x.label}:** ${x.statement} Evidence: [${x.evidence}](${x.evidence}).`).join('\n')}`;
  const md = `# Consolidated reference evidence\n\nFFM (Full Force Model) is defined in [the FFM profile](../../FFM.md).\n\nGenerated from pinned summaries by \`consolidate.mjs\`; checked by \`node propagator/ffm/tests/evidence/check-all.mjs\` from the repository root. No timestamps or host details enter this report.\n\nFFM ${data.module.version}, SHA-256 \`${data.module.sha256}\`. Numerical aggregation and unit formatting run in C++; replay physics stays in C++/WASM.\n\n## Protocol and coverage\n\n${data.protocol.score}. Epochs and input models are in [the case export](cases/ffm-reference-cases.json). Counts use FFM's suite setting. Skips are explicit unsupported or unavailable cases, never passes. Row-based counts include only primary rows with a stated limit. Diagnostic and decomposition rows are shown separately and do not count as met or missed; all recorded bounds are independently checked.\n\n${steps}\n\n${limits}\n\nThe GMAT limits apply only to GMAT. These are agreement limits from the shared protocol, not orbit-accuracy guarantees.\n\n${counts}\n\n## Maximum position difference\n\nMaxima across each tool's supported cases, at FFM's suite setting; the Orekit finest column uses its separately stated FFM setting. A dash means no scored case. The no-drag class also includes supported tides, relativity and thrust cases. Force-class case coverage varies by tool; see scored and skipped IDs in consolidated.json.\n\n${position}\n\n${dragFootnote}\n\n${renderDragDiagnostics(data.dragDiagnostics)}\n\n## STM agreement\n\nNo STM pass threshold is defined by the export.\n\n${stm}\n\n## Frame, time, ephemeris and SGP4 rows\n\n${rowTables}\n\n## Findings\n\n${findingText}\n\n## Pins and model settings\n\nChecksums identify recorded bytes. A source-recipe pin is labelled as such and does not assert availability of an engine archive.\n\n${settings}\n\n${diagnosticPins}\n`;
  const links = definitions.map(([,label,evidence]) => `[${label}](../tests/evidence/${path.dirname(evidence)}/)`).join(', ');
  const adjustments = data.dragDiagnostics.map((d) => `[${d.label}: ${d.adjustment}](../tests/evidence/${d.evidence})`).join('; ');
  const cross = `<!-- BEGIN GENERATED REFERENCE SUITE -->\n${position}\n\n### Drag cases with the tool-side setting difference removed (diagnostic)\n\n${dragDiagnosticTable(data.dragDiagnostics)}\n\n*Maximum hourly 3D position differences at the suite setting; Orekit finest is separate. Drag adjustments: ${adjustments}. Limits: [shared protocol](../tests/evidence/cases/ffm-reference-cases.json), with GMAT limits applying only to GMAT.*\n\nEvidence: ${links}, [ERFA/SPICE](../tests/evidence/erfa-spice/), [Horizons](../tests/evidence/horizons/), [SGP4 against its STR#3 base](../../sgp4/tests/evidence/str3/), [SGP4-XP](../../sgp4/tests/evidence/xp/), [consolidated report](../tests/evidence/CONSOLIDATED.md).\n\nFrom the repository root:\n\n\`\`\`sh\nUV_THREADPOOL_SIZE=1 node --v8-pool-size=1 propagator/ffm/tests/evidence/check-all.mjs\n\`\`\`\n<!-- END GENERATED REFERENCE SUITE -->`;
  const sgp4 = `<!-- BEGIN GENERATED VERIFICATION SETS -->\n${renderVerificationSets(data)}\n<!-- END GENERATED VERIFICATION SETS -->`;
  return { markdown: md, blocks: [
    { file: 'propagator/ffm/docs/cross-validation.md', start: '<!-- BEGIN GENERATED REFERENCE SUITE -->', end: '<!-- END GENERATED REFERENCE SUITE -->', text: cross },
    { file: 'propagator/sgp4/README.md', start: '<!-- BEGIN GENERATED VERIFICATION SETS -->', end: '<!-- END GENERATED VERIFICATION SETS -->', text: sgp4 },
  ] };
}
export function generate(work) {
  const collected = collect(), binary = path.join(work,'consolidated-metrics');
  const run = (cmd,args,options={}) => {
    const r=spawnSync(cmd,args,{cwd:root,env:childEnv(work),encoding:'utf8',maxBuffer:32<<20,...options});
    require(!r.error && r.status === 0 && !r.stderr, `${cmd} failed: ${r.error?.message ?? r.stderr ?? ''}\n${r.stdout ?? ''}`);return r.stdout;
  };
  run('c++',['-std=c++17','-O2','-ffp-contract=off','-I',path.resolve(here,'../../src/cpp/include'),path.join(here,'consolidated-metrics.cpp'),'-o',binary]);
  const numeric=JSON.parse(run(binary,[],{input:JSON.stringify(collected.input)}));
  const {summaries:s}=collected;
  const data={schemaVersion:1,module:collected.module,protocol:collected.exported.protocol,
    caseExport:{file:'cases/ffm-reference-cases.json',sha256:sha(path.join(here,'cases/ffm-reference-cases.json'))},
    tools:numeric.tools.map((t)=>({...collected.metadata.find((m)=>m.id===t.id),...t, skipped:collected.input.tools.find((x)=>x.id===t.id).skipped})),
    positionTable:numeric.positionTable,dragDiagnostics:numeric.dragDiagnostics,formatted:numeric.formatted,
    findings:{defects:s.frames.verdict.defects,coordsEcefCio:s.frames.rows.find((r)=>r.id==='coordsEcefCio'),forceClock:s.frames.rows.find((r)=>r.id==='forceClock'),toolCauses:[
      {label:'Nyx NRLMSISE-00 port',statement:s.nyx.verdict.drag.statement,evidence:'nyx/summary-nyx-2.6.0.json'},
      {label:'Nyx variational equation',statement:s.nyx.verdict.stm.statement,evidence:'nyx/summary-nyx-2.6.0.json'},
      {label:'GMAT anomalous oxygen',statement:s['gmat-2026'].cases.find((r)=>r.cause).cause.statement,evidence:'gmat/anomalous-oxygen.json'},
      {label:'Basilisk atmosphere altitude and conventions',statement:s.basilisk.cases.find((r)=>r.cause).cause.statement,evidence:'basilisk/summary-basilisk-2.12.0.json'},
    ]},sgp4:{str3:s.str3,xp:s.xp}};
  return {data,...render(data)};
}
export function applyBlocks(blocks,write=false) {
  for(const b of blocks){const file=path.join(root,b.file),old=fs.readFileSync(file,'utf8');
    const start=old.indexOf(b.start),end=old.indexOf(b.end);require(start>=0&&end>start,`${b.file}: generated markers missing`);
    const next=old.slice(0,start)+b.text+old.slice(end+b.end.length);
    if(write&&next!==old)fs.writeFileSync(file,next);else if(!write)require(next===old,`${b.file}: generated block differs; regenerate with consolidate.mjs --write`);
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  require(process.argv.length===3&&process.argv[2]==='--write','Usage: node propagator/ffm/tests/evidence/consolidate.mjs --write');
  const work=fs.mkdtempSync(path.join(here,'.consolidate-'));
  try{const result=generate(work);fs.writeFileSync(path.join(here,'consolidated.json'),JSON.stringify(result.data,null,2)+'\n');fs.writeFileSync(path.join(here,'CONSOLIDATED.md'),result.markdown);applyBlocks(result.blocks,true);console.log('Generated consolidated.json, CONSOLIDATED.md and documentation blocks.');}
  finally{fs.rmSync(work,{recursive:true,force:true});}
}
