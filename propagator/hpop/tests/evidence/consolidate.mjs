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
// These diagnostics were recorded at different HPOP settings. Transport the
// pinned trajectories to C++ so the comparison uses the suite setting for all
// tools, and first reproduce each diagnostic's originally recorded score.
function collectDragDiagnostics(summaries, exported) {
  const checked = (file, expected) => {
    const absolute = path.resolve(here, file), checksum = sha(absolute);
    require(digest(expected) && checksum === expected, `Diagnostic input hash differs: ${file}`);
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  };
  const cachePin = summaries.tudatpy.provenance.hpopTrajectories;
  const cacheFile = `tudat/${cachePin.path}`, cache = checked(cacheFile, cachePin.sha256);
  require(JSON.stringify(cache.identity) === JSON.stringify(summaries.tudatpy.provenance.propagationInputs), 'Diagnostic HPOP cache identity differs');
  for (const p of cache.identity) require(sha(path.resolve(here, 'tudat', p.path)) === p.sha256, `Diagnostic HPOP input differs: ${p.path}`);
  const hpop = (id) => {
    const c = cache.cases.find((c) => c.id === id);
    require(c, `Diagnostic HPOP trajectory missing: ${id}`);
    return Object.fromEntries(exported.protocol.stepSettings.map(({id}) => [id, { positions: c[id].positions }]));
  };
  const stock = (tool, id) => {
    const row = summaries[tool].cases.find((c) => c.id === id);
    require(row, `${tool}: diagnostic case missing from stock summary: ${id}`);
    return row.suite.worstM;
  };
  const cacheSource = pin('HPOP trajectories at suite / steps30 / finest', cachePin.sha256, { path: cacheFile });
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
      hpop: hpop(r.id), expected: { setting: 'steps30', worstM: r.hpopMinusGmatCdScaledM },
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
      cases: nyx.trajectories.map((r) => ({ id: r.id, stockM: stock('nyx', r.id), samples: r.samples, hpop: hpop(r.id),
        expected: { setting: 'finest', worstM: nyx.cases.find((c) => c.id === r.id).finest.worstM } })) },
    { id: 'basilisk', label: 'Basilisk', setting: 'suite', adjustment: 'WGS84 coordinates + native gtd7d density',
      evidence: 'basilisk/summary-basilisk-2.12.0.json#/diagnostics/wgs84-gtd7d',
      pins: [pin('WGS84 / gtd7d trajectories', basilisk.sha256, { path: `basilisk/${basilisk.file}` })],
      cases: basilisk.cases.map((r) => ({ id: r.id, stockM: stock('basilisk', r.id), suiteM: r.suite.worstM })) },
  ];
}
function collect() {
  const exported = read('cases/hpop-reference-cases.json');
  const summaries = {}, tools = [], metadata = [], format = {};
  const formatValue = (key, value, unit = 'm', precision) => { format[key] = { value, unit, ...(precision === undefined ? {} : { precision }) }; return key; };
  const hpop = read('../../package.json');
  const moduleHash = sha(path.resolve(here, '../../dist/isomorphic/module.wasm'));
  require(hpop.version === read('../../plugin-manifest.json').version && moduleHash === read('../../dist/build-provenance.json').sha256, 'Shipped HPOP identity differs from build provenance');
  function add(meta, data) {
    require(nonempty(meta.version) && meta.pins.some((p) => digest(p.sha256)), `${meta.id}: missing version/checksum pin`);
    for (const p of meta.pins) require(p.revision || digest(p.sha256), `${meta.id}: invalid pin ${p.label}`);
    metadata.push({ ...meta, summarySha256: sha(path.resolve(here, meta.evidence)) }); tools.push({ ...data, id: meta.id });
  }
  for (const [id, label, evidence, family] of definitions) {
    const s = summaries[id] = read(evidence), tool = s[family]?.tool ?? (id === 'orekit' ? s.orekit : s.tool);
    require(s.module?.version === hpop.version && s.module?.sha256 === moduleHash, `${id}: HPOP version/hash mismatch`);
    require(tool, `${id}: tool identity missing`);
    const version = id.startsWith('gmat') ? s.verdict.release : tool.version ?? tool.nyxSpace;
    const verdict = s.verdict?.tool ?? s.verdict?.stockNyx ?? s.verdict?.suite ?? s.verdict;
    require([verdict?.total, verdict?.met, verdict?.missed].every(Number.isInteger), `${id}: missing numeric verdict counts`);
    const stmStatement = (s.cases.every((r) => !r.stm && !r.suite?.jacobians) ? s.cases[0]?.stmSkipped : undefined) ?? s.verdict?.stm?.statement ?? (id === 'orekit' ? 'Relative column differences; exported protocol specifies no STM pass limit.' : 'No stored STM comparison.');
    const cases = s.cases.map((r) => ({ ...r, id: r.id ?? `${r.orbit} ${r.forces}`,
      ...(r.suite.jacobians ? { stm: { worst: r.suite.jacobians.stm, parameters: r.suite.jacobians.parameters } } : {}) }));
    add({ id, label, version, evidence, pins: toolPins(id, s, tool),
      modelSettings: typeof s[family]?.settings === 'string' ? { configuration: s[family].settings } : s[family]?.settings ?? s.referenceSettings ?? s.protocol,
      hpopSettings: exported.protocol.stepSettings, toolIdentity: tool,
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
    modelSettings: { reference: 'DE441 geometric ICRF, Earth centre 399; identical target IDs', evaluators: 'HPOP Sun/Moon; CSPICE DE440 Venus/Jupiter barycentre', jwst: horizons.jwst.parameters },
    stepSetting: 'stored raw UTC epochs; JWST stored HPOP runs', protocol: { bodyEpochs: read('horizons/raw/index.json').epochsUtc, bodyToleranceRationale: horizons.bodies[0].toleranceRationale, jwstEpochUtc: horizons.jwst.epochUtc, jwstFinalEpochUtc: horizons.jwst.finalEpochUtc } },
  { kind: 'rows', skipped: horizons.skipped, stmStatement: 'not exposed', rows: [
    ...horizons.bodies.flatMap((r) => [
      { id: r.body, label: `${r.body}: ${r.evaluator}`, group: 'bodies', metrics: [metric('position', r.maxPositionM, r.positionToleranceM, 'm', true), metric('velocity', r.maxVelocityMmS, r.velocityToleranceMmS, 'mm/s', true)], expectedMet: r.met, cause: r.cause },
      { id: `${r.body}-submetre`, label: `${r.body}: sub-metre diagnostic`, role: 'diagnostic', group: 'submetre', metrics: [metric('position', r.maxPositionM, r.subMeter.toleranceM, 'm', true)], expectedMet: r.subMeter.met, cause: r.subMeter.cause },
    ]),
    ...horizons.jwst.rows.map((r) => ({ id: `jwst-${r.id}`, label: `JWST ${r.id}`, group: 'jwst', metrics: [metric('position', r.maxPositionM, r.positionToleranceM, 'm', true)], expectedMet: r.met, cause: r.cause })),
  ], expected: { scored: 6, met: 6, missed: 0, diagnostic: 4 }, expectedGroups: { bodies: { scored: horizons.verdict.bodiesTotal, met: horizons.verdict.bodiesMet }, jwst: { scored: horizons.jwst.rows.length, met: horizons.verdict.jwstMet } } });
  const valladoPath = '../../../sgp4/tests/evidence/vallado/summary-vallado.json';
  const vallado = summaries.vallado = read(valladoPath);
  const valladoTools = read('../../../sgp4/tests/evidence/vallado/tools.json');
  const causes = read('../../../sgp4/tests/evidence/vallado/causes.json');
  const acceptance = vallado.acceptance;
  require(acceptance?.criteria && acceptance?.evidence?.blocks && acceptance?.verdict, 'Vallado primary acceptance evidence missing');
  const vrows = [];
  for (const [regime, table] of Object.entries(vallado.tables)) for (const [key, r] of Object.entries(table)) {
    if (key === 'sets') continue;
    const c = causes[key];
    require(c, `Vallado comparison without cause: ${key}`);
    const primary = ['source', 'module', 'wasm'].includes(key), criterion = acceptance.criteria[key];
    const primaryVerdict = primary ? acceptance.tables[regime][key] : undefined;
    const samples = key === 'wasm' ? acceptance.evidence.blocks.filter((b) => !b.initError && (regime === 'all' || b.method === (regime.startsWith('near') ? 'n' : 'd'))).flatMap((b) => b.samples) : undefined;
    vrows.push({ id: `${regime}/${key}`, label: `${regime}: ${key}`, comparison: key, regime,
      role: primary ? 'primary' : 'decomposition', samples: r.samples, worst: r.worst, cause: c,
      printingExceedances: r.samplesBeyondPrinting,
      metrics: [metric('position 3D', r.maxPosition3dM, criterion?.positionM ?? null, 'm'), metric('velocity 3D', r.maxVelocity3dMs, criterion?.velocityMs ?? null, 'm/s'),
        { ...metric('position component', r.maxPositionComponentKm, vallado.printing.positionKm, 'km'), diagnostic: true },
        { ...metric('velocity component', r.maxVelocityComponentKms, vallado.printing.velocityKms, 'km/s'), diagnostic: true }],
      ...(key === 'wasm' ? { consistency: { samples, printing: vallado.printing, expected: primaryVerdict } } : {}),
      expectedPrintingMet: r.samplesBeyondPrinting === 0, expectedMet: primary ? primaryVerdict.met : null });
  }
  add({ id: 'vallado', label: 'Vallado SGP4-VER', version: `${valladoTools.reference.package}; module ${vallado.module.version}`, evidence: valladoPath,
    pins: [pin('python-sgp4 source distribution', valladoTools.reference.sha256), pin('SGP4.cpp source', vallado.module['src/cpp/src/SGP4.cpp']), pin('shipped WASM', vallado.module['dist/isomorphic/module.wasm']), ...Object.entries(vallado.inputs).map(([k,v]) => pin(k,v))],
    modelSettings: { frame: 'TEME', gravity: 'WGS72', operations: 'improved (i); AFSPC (a) separately', compiler: vallado.native },
    acceptanceCriteria: acceptance.criteria, stepSetting: 'every printed tcppver time; intended and single-JD times separated' },
  { kind: 'rows', rows: vrows, skipped: [], stmStatement: 'not exposed', expected: acceptance.verdict });
  require(vallado.sourceWithinPrinting === (vallado.tables.all.source.samplesBeyondPrinting === 0), 'Vallado source verdict mismatch');
  require(vallado.afspcWithinPrinting === (vallado.tables.all.afspc.samplesBeyondPrinting === 0), 'Vallado AFSPC verdict mismatch');
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
  for(const [key, row] of Object.entries(vallado.tables.all)) if (key !== 'sets') formatValue(`vallado-${key}`, row.maxPosition3dM);
  formatValue('vallado-time', vallado.requestTimeShiftSeconds.maxAbs, 's');
  formatValue('vallado-time-us', vallado.requestTimeShiftSeconds.maxAbs, 's-as-us');
  formatValue('vallado-doc-time', vallado.requestTimeShiftSeconds.maxAbs, 's-as-us', 1);
  formatValue('vallado-doc-near', vallado.tables['near-Earth (SGP4)'].wasm.maxPosition3dM, 'm-as-cm', 0);
  formatValue('vallado-doc-deep', vallado.tables['deep space (SDP4)'].wasm.maxPosition3dM, 'm', 2);
  return { exported, summaries, metadata, input: { export: exported, tools, format,
    dragDiagnostics: collectDragDiagnostics(summaries, exported),
    orbits: [...new Set(exported.cases.map((c) => c.orbit))], families: Object.keys(exported.protocol.rows),
    columns: [...definitions.map(([id]) => id), 'orekit-finest'] },
    module: { version: hpop.version, sha256: moduleHash } };
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
  return `### ${tool.label}\n\nVersion: ${tool.version}. Evidence: [${tool.evidence}](${tool.evidence}).\n\n${pinsList(tool.pins)}\n\nModel settings:\n\n${settingLines(tool.modelSettings ?? {}).join('\n')}\n\nStep setting: ${tool.stepSetting ?? 'HPOP suite / steps30 / finest as defined above; reference integrator settings as listed.'}${tool.provenanceLimitations ? `\n\nProvenance limit:\n\n${settingLines(tool.provenanceLimitations, ['availability']).join('\n')}` : ''}`;
}
function dragDiagnosticTable(diagnostics) {
  return table(['Tool', 'Orbit', 'Cases', 'Stock', 'Setting difference removed', 'Limit', 'Stock verdict', 'Diagnostic verdict'], diagnostics.flatMap((d) => d.rows.map((r) => [d.label, r.orbit, r.cases, r.stockDisplay, r.correctedDisplay, r.limitDisplay, r.stockMet ? 'met' : 'not met', r.met ? 'met' : 'not met'])));
}
function renderDragDiagnostics(diagnostics, evidencePrefix = '') {
  return `### Drag cases with the tool-side setting difference removed (diagnostic)\n\nBoth columns use HPOP's suite setting and the same supported drag cases per tool. Each entry is the maximum hourly 3D position difference across that orbit's cases. These diagnostic comparisons do not change the primary counts.\n\n${dragDiagnosticTable(diagnostics)}\n\n${diagnostics.map((d) => `- ${d.label}: ${d.adjustment}. [Evidence](${evidencePrefix}${d.evidence}).`).join('\n')}\n\nGMAT's stored steps30 score and Nyx's stored finest score are reproduced before their corrected trajectories are re-scored against the pinned HPOP suite trajectories. Basilisk's suite diagnostic is stored directly. GMAT's Cd scale uses the recorded mean anomalous-oxygen density fraction for each case.`;
}
const causeText = (r) => r.cause ? `${r.cause.classification}: ${r.cause.statement}` : r.note ?? '';
function renderRows(tool) {
  const note = (r) => tool.id !== 'frames' ? causeText(r) : r.cause?.classification ??
    (r.id === 'c2tBuiltIn' ? `${r.note.split(';')[0]}.` : r.note ?? '');
  return `### ${tool.label}\n\n${table(['Row','Maximum difference','Limit','Verdict / role','Cause / note'], tool.rows.map((r) => [r.label,
    r.metrics.map((m) => `${m.label}: ${m.display}`).join('; '), r.metrics.filter((m) => m.limit !== null).map((m) => `${m.label}: ${m.strict ? '< ' : '≤ '}${m.limitDisplay}`).join('; ') || 'not specified',
    r.status, note(r)]))}`;
}
function valladoPrimary(tool) {
  return table(['Table', 'Comparison', 'Maximum 3D position difference', 'Maximum 3D velocity difference', 'Primary criterion', 'Verdict', 'Printing diagnostic', 'Cause / interpretation'],
    tool.rows.filter((r) => r.role === 'primary').map((r) => {
      const position = r.metrics.find((m) => m.label === 'position component');
      const velocity = r.metrics.find((m) => m.label === 'velocity component');
      const time = tool.rows.find((t) => t.regime === r.regime && t.comparison === 'timeOnly');
      const maximum = ` Maximum on set ${r.worst.satnum}, tsince ${r.worst.tsince} min.`;
      const timing = r.comparison === 'wasm' ? ` The time-only maximum is ${time.metrics[0].display} at set ${time.worst.satnum}, tsince ${time.worst.tsince} min.${r.met ? '' : ` Largest criterion excess: set ${r.consistency.worstPosition.satnum}, tsince ${r.consistency.worstPosition.tsince} min, with native-source-versus-print residual ${r.consistency.sourceResidualDisplay}.`}` : '';
      const criterion = r.comparison === 'wasm' ? 'Each sample: ‖wasm‖ ≤ ‖timeOnly‖ + ‖module‖ + 3D printing envelope, for position and velocity' : `position ≤ ${r.metrics[0].limitDisplay}; velocity ≤ ${r.metrics[1].limitDisplay}`;
      const verdict = r.consistency ? `${r.status}; ${r.consistency.exceeded}/${r.consistency.samples} samples exceed; maximum excess ${r.consistency.positionExceedanceDisplay}, ${r.consistency.velocityExceedanceDisplay}` : r.status;
      const label = { source: 'source: native Vallado vs printed', module: 'module: shipped WASM vs native Vallado at effective minutes since epoch', wasm: 'wasm: shipped propagate_state vs printed at request epoch' }[r.comparison];
      return [r.regime, label, r.metrics[0].display, r.metrics[1].display, criterion, verdict,
        `component maxima ${position.display}; ${velocity.display}; ${r.printingExceedances}/${r.samples} samples exceed the printing envelope`, `${r.cause.statement}${maximum}${timing}`];
    }));
}
function valladoCriteria(tool, formatted) {
  const primary = tool.rows.find((r) => r.comparison === 'source');
  const components = primary.metrics.filter((m) => m.diagnostic).map((m) => m.limitDisplay).join(' / ');
  const consistency = tool.rows.find((r) => r.comparison === 'wasm').consistency;
  return `Source and module use fixed 3D limits of ${primary.metrics[0].limitDisplay} and ${primary.metrics[1].limitDisplay}. ${tool.acceptanceCriteria.source.rationale} ${tool.acceptanceCriteria.module.rationale} The recorded compiler decompositions have position maxima ${formatted['vallado-emccFast']} (emccFast) and ${formatted['vallado-emccStrict']} (emccStrict); these measurements do not enlarge the fixed limit.\n\nPrinting resolution remains a diagnostic: ${components} per component, giving Euclidean 3D envelopes ${consistency.printingNormPositionDisplay} and ${consistency.printingNormVelocityDisplay}. The request-epoch criterion is evaluated on every paired sample, not on table maxima. ${tool.acceptanceCriteria.wasm.rationale} The maximum absolute request-time shift is ${formatted['vallado-time-us']}.`;
}
function renderVallado(tool, formatted) {
  return `### ${tool.label}\n\n${valladoCriteria(tool, formatted)}\n\n${valladoPrimary(tool)}\n\nControlled subtractions explain the primary differences. The rows below remain decomposition rows and do not contribute to met/missed counts.\n\n${table(['Table', 'Subtraction', 'Maximum 3D position difference', 'Maximum 3D velocity difference', 'Printing diagnostic (samples beyond envelope)', 'Role', 'Cause'], tool.rows.filter((r) => r.role === 'decomposition').map((r) => [r.regime, r.comparison, r.metrics[0].display, r.metrics[1].display, `${r.printingExceedances}/${r.samples}`, r.status, causeText(r)]))}`;
}
function renderVerificationSets(data, vallado) {
  const f = data.formatted, xp = data.sgp4.xp;
  const row = (regime, comparison) => vallado.rows.find((r) => r.regime === regime && r.comparison === comparison);
  const source = row('all', 'source'), request = row('all', 'wasm'), deep = row('deep space (SDP4)', 'wasm');
  const selected = [
    ['Source (all)', source], ['Module (all)', row('all', 'module')], ['Request epoch (all)', request],
    ['Request epoch (near-Earth)', row('near-Earth (SGP4)', 'wasm')], ['Request epoch (deep space)', deep],
  ];
  const compact = table(['Comparison', 'Position (max)', 'Velocity (max)', 'Limit', 'Result'], selected.map(([label, r]) => [label,
    r.metrics[0].display, r.metrics[1].display, r.consistency ? '≤ T + M + P per sample' : `≤ ${r.metrics[0].limitDisplay}; ≤ ${r.metrics[1].limitDisplay}`, r.met ? 'met' : 'not met']));
  const xpScope = xp.verdict.split('. ').at(-1);
  return `[Vallado SGP4-VER](tests/evidence/vallado/) uses \`SGP4-VER.TLE\` and \`tcppver.out\` in TEME with WGS-72 and improved mode \`i\`. Source compares native Vallado with printed states; module compares shipped WASM with native Vallado at the same effective minutes since epoch. Request epoch compares shipped \`propagate_state\` with printed states at the requested time. Its per-sample position and velocity bound is T + M + P: the native time-shift norm, module norm and 3D printing envelope.\n\n${compact}\n\nRequest-time rounding (maximum shift ${f['vallado-doc-time']}) accounts for the ${f['vallado-doc-near']} near-Earth and ${f['vallado-doc-deep']} deep-space maxima (set ${deep.worst.satnum}). The ${request.consistency.exceeded} samples exceeding the request criterion by up to ${request.consistency.positionExceedanceDisplay} carry the native-source residual on set ${request.consistency.worstPosition.satnum} ([causes](tests/evidence/vallado/causes.json), [report](../hpop/tests/evidence/CONSOLIDATED.md)).\n\n[SGP4-XP](tests/evidence/xp/) checks ${xp.parity.sets} SGP4/XP sets at ${xp.parity.times} times for exact library parity and records ${xp.anchors.cases} Tier B anchors. ${xpScope}\n\nFrom the repository root:\n\n\`\`\`sh\nUV_THREADPOOL_SIZE=1 node --v8-pool-size=1 propagator/hpop/tests/evidence/check-all.mjs\n\`\`\``;
}
function render(data) {
  const { tools, positionTable, findings, formatted: f } = data;
  const columns = definitions.map(([id, label]) => [id,label]);columns.push(['orekit-finest','Orekit finest']);
  const forceLabels = { pointMass: 'point mass', fullNoDrag: 'field + third bodies + SRP (no drag)', drag: 'drag' };
  const position = table(['Orbit', 'Force class', ...columns.map(([,label]) => label)], positionTable.map((r) => [r.orbit,
    forceLabels[r.forceClass], ...columns.map(([id]) => r.cells[id]?.display ?? '—')]));
  const steps = table(['HPOP setting', 'Maximum step (s)', 'Relative tolerance', 'Point-mass tolerance'], data.protocol.stepSettings.map((s) => [s.id, s.maxStepS, s.relativeTolerance, s.relativeTolerancePointMass]));
  const limits = table(['Tool group', 'Point mass (m)', 'Gravity (m)', 'SRP (m)', 'Drag (m)'], ['default','gmat'].map((name) => [name, ...['pointMass','gravity','srp','drag'].map((key) => data.protocol.tolerancesM[name][key])]));
  const counts = table(['Tool', 'Version', 'Scored (primary)', 'Skipped', 'Met', 'Missed', 'Diagnostic', 'Decomposition'], tools.map((t) => [t.label, t.version, t.counts.scored, t.counts.skipped, t.counts.met, t.counts.missed, t.counts.diagnostic, t.counts.decomposition]));
  const stm = table(['Tool', 'STM maximum relative column difference', 'Interpretation'], tools.map((t) => [t.label,t.stm.display,t.stm.statement]));
  const settings = tools.map(renderSettings).join('\n\n');
  const diagnosticPins = data.dragDiagnostics.map((d) => `### ${d.label} drag diagnostic inputs\n\n${pinsList(d.pins)}`).join('\n\n');
  const dragFootnote = 'For the GMAT R2026a, Nyx and Basilisk drag entries, see [the diagnostic comparison below](#drag-cases-with-the-tool-side-setting-difference-removed-diagnostic).';
  const rowTables = tools.filter((t) => !definitions.some(([id]) => id === t.id)).map((t) => t.id === 'vallado' ? renderVallado(t, f) : renderRows(t)).join('\n\n');
  const ecef = table(['Classical ECEF versus CIO','Position bound'],['leoM','gpsM','geoM'].map((r,i) => [['LEO','GPS','GEO'][i],f[`ecef-${r}`]]));
  const findingText = `Classical-frame source defects remaining: ${findings.defects.length}. ERFA is the authoritative IAU 1976/1980 implementation. Before/after measurements and the velocity-axis diagnostic are in [before-after.json](erfa-spice/before-after.json).\n\n${ecef}\n\nThe remaining classical ECEF budget is UT1 = UTC, zero polar motion, no frame bias and the 1976/1980 model. These values are radius-times-angle bounds over the 50 sample epochs. Reference-suite field/drag cases supply EOP and use the CIO force-model chain.\n\nThe force TDB model spread is ${f['force-clock']}; the exact-epoch Earth-rotation difference is ${f['force-clock-rotation']}, or ${f['force-clock-leo']} at LEO radius. ${findings.forceClock.note} Evidence: [ERFA/SPICE summary](erfa-spice/summary-erfa-spice.json).\n\n${findings.toolCauses.map((x) => `- **${x.label}:** ${x.statement} Evidence: [${x.evidence}](${x.evidence}).`).join('\n')}`;
  const md = `# Consolidated reference evidence\n\nGenerated from pinned summaries by \`consolidate.mjs\`; checked by \`node propagator/hpop/tests/evidence/check-all.mjs\` from the repository root. No timestamps or host details enter this report.\n\nHPOP ${data.module.version}, SHA-256 \`${data.module.sha256}\`. Numerical aggregation and unit formatting run in C++; replay physics stays in C++/WASM.\n\n## Protocol and coverage\n\n${data.protocol.score}. Epochs and input models are in [the case export](cases/hpop-reference-cases.json). Counts use HPOP's suite setting. Skips are explicit unsupported or unavailable cases, never passes. Row-based counts include only primary rows with a stated limit. Diagnostic and decomposition rows are shown separately and do not count as met or missed; all recorded bounds are independently checked.\n\n${steps}\n\n${limits}\n\nThe GMAT limits apply only to GMAT. These are agreement limits from the shared protocol, not orbit-accuracy guarantees.\n\n${counts}\n\n## Maximum position difference\n\nMaxima across each tool's supported cases, at HPOP's suite setting; the Orekit finest column uses its separately stated HPOP setting. A dash means no scored case. The no-drag class also includes supported tides, relativity and thrust cases. Force-class case coverage varies by tool; see scored and skipped IDs in consolidated.json.\n\n${position}\n\n${dragFootnote}\n\n${renderDragDiagnostics(data.dragDiagnostics)}\n\n## STM agreement\n\nNo STM pass threshold is defined by the export.\n\n${stm}\n\n## Frame, time, ephemeris and SGP4 rows\n\n${rowTables}\n\n## Findings\n\n${findingText}\n\n## Pins and model settings\n\nChecksums identify recorded bytes. A source-recipe pin is labelled as such and does not assert availability of an engine archive.\n\n${settings}\n\n${diagnosticPins}\n`;
  const vallado = tools.find((t) => t.id === 'vallado');
  const links = definitions.map(([,label,evidence]) => `[${label}](../tests/evidence/${path.dirname(evidence)}/)`).join(', ');
  const adjustments = data.dragDiagnostics.map((d) => `[${d.label}: ${d.adjustment}](../tests/evidence/${d.evidence})`).join('; ');
  const cross = `<!-- BEGIN GENERATED REFERENCE SUITE -->\n${position}\n\n### Drag cases with the tool-side setting difference removed (diagnostic)\n\n${dragDiagnosticTable(data.dragDiagnostics)}\n\n*Maximum hourly 3D position differences at the suite setting; Orekit finest is separate. Drag adjustments: ${adjustments}. Limits: [shared protocol](../tests/evidence/cases/hpop-reference-cases.json), with GMAT limits applying only to GMAT.*\n\nEvidence: ${links}, [ERFA/SPICE](../tests/evidence/erfa-spice/), [Horizons](../tests/evidence/horizons/), [Vallado](../../sgp4/tests/evidence/vallado/), [SGP4-XP](../../sgp4/tests/evidence/xp/), [consolidated report](../tests/evidence/CONSOLIDATED.md).\n\nFrom the repository root:\n\n\`\`\`sh\nUV_THREADPOOL_SIZE=1 node --v8-pool-size=1 propagator/hpop/tests/evidence/check-all.mjs\n\`\`\`\n<!-- END GENERATED REFERENCE SUITE -->`;
  const sgp4 = `<!-- BEGIN GENERATED VERIFICATION SETS -->\n${renderVerificationSets(data, vallado)}\n<!-- END GENERATED VERIFICATION SETS -->`;
  return { markdown: md, blocks: [
    { file: 'propagator/hpop/docs/cross-validation.md', start: '<!-- BEGIN GENERATED REFERENCE SUITE -->', end: '<!-- END GENERATED REFERENCE SUITE -->', text: cross },
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
    caseExport:{file:'cases/hpop-reference-cases.json',sha256:sha(path.join(here,'cases/hpop-reference-cases.json'))},
    tools:numeric.tools.map((t)=>({...collected.metadata.find((m)=>m.id===t.id),...t, skipped:collected.input.tools.find((x)=>x.id===t.id).skipped})),
    positionTable:numeric.positionTable,dragDiagnostics:numeric.dragDiagnostics,formatted:numeric.formatted,
    findings:{defects:s.frames.verdict.defects,coordsEcefCio:s.frames.rows.find((r)=>r.id==='coordsEcefCio'),forceClock:s.frames.rows.find((r)=>r.id==='forceClock'),toolCauses:[
      {label:'Nyx NRLMSISE-00 port',statement:s.nyx.verdict.drag.statement,evidence:'nyx/summary-nyx-2.6.0.json'},
      {label:'Nyx variational equation',statement:s.nyx.verdict.stm.statement,evidence:'nyx/summary-nyx-2.6.0.json'},
      {label:'GMAT anomalous oxygen',statement:s['gmat-2026'].cases.find((r)=>r.cause).cause.statement,evidence:'gmat/anomalous-oxygen.json'},
      {label:'Basilisk atmosphere altitude and conventions',statement:s.basilisk.cases.find((r)=>r.cause).cause.statement,evidence:'basilisk/summary-basilisk-2.12.0.json'},
    ]},sgp4:{vallado:s.vallado,xp:s.xp}};
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
  require(process.argv.length===3&&process.argv[2]==='--write','Usage: node propagator/hpop/tests/evidence/consolidate.mjs --write');
  const work=fs.mkdtempSync(path.join(here,'.consolidate-'));
  try{const result=generate(work);fs.writeFileSync(path.join(here,'consolidated.json'),JSON.stringify(result.data,null,2)+'\n');fs.writeFileSync(path.join(here,'CONSOLIDATED.md'),result.markdown);applyBlocks(result.blocks,true);console.log('Generated consolidated.json, CONSOLIDATED.md and documentation blocks.');}
  finally{fs.rmSync(work,{recursive:true,force:true});}
}
