#!/usr/bin/env node
// Offline reproduction; one native build/process or WASM invoke at a time.
// UV_THREADPOOL_SIZE=1 node --v8-pool-size=1 propagator/ffm/tests/evidence/horizons/run-horizons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { here, ffm, repo, casesPath, cases, wasmPath, de440Path, names, targets, env, read, sha256, write,
  authenticateRaw, buildMetrics, parseRaw, compare, brief, harness, bodyStates, jwstRun } from './horizons-common.mjs';

const { values: o } = parseArgs({ options: {
  python: { type: 'string', default: process.env.XVAL_PYTHON ?? '/Users/tj/software/tools/xval/erfa-spice/bin/python' },
  naif: { type: 'string', default: process.env.XVAL_NAIF ?? '/Users/tj/software/tools/xval/naif-kernels' },
  flatbuffers: { type: 'string' },
  'jwst-source': { type: 'string', default: process.env.XVAL_JWST_SOURCE ?? '/Users/tj/software/tools/xval/nyx/cargo-home/registry/src/index.crates.io-1949cf8c6b5b557f/nyx-space-2.6.0/examples/02_jwst_covar_monte_carlo/main.rs' },
} });

const cause = (classification, statement, evidence) => ({ classification, statement, evidence });
function annotate(score, explanation) {
  if (!score.met) score.cause = explanation;
  if (score.subMeter && !score.subMeter.met) score.subMeter.cause = explanation;
  return score;
}
async function main() {
  const authenticated = authenticateRaw();
  const work = fs.mkdtempSync(path.join(here, '.run-horizons-'));
  try {
    const metrics = await buildMetrics(work, o.flatbuffers);
    const parsed = Object.fromEntries(names.map((name) => [name, parseRaw(metrics, authenticated, name)]));
    const epochs = authenticated.index.epochsUtc;
    const lsk = path.join(o.naif, 'naif0012.tls');
    const spice = JSON.parse(execFileSync(o.python, ['-I', '-B', path.join(here, 'spice-reference.py')], {
      input: JSON.stringify({ de440: de440Path, lsk,
        bodies: Object.fromEntries(names.filter((name) => name !== 'jwst')
          .map((name) => [name, { target: targets[name], epochs: parsed[name].rows }])) }),
      encoding: 'utf8', cwd: work, env, maxBuffer: 16 << 20,
    }));
    for (const [name, body] of Object.entries(spice.bodies)) {
      if (body.target !== targets[name]) throw new Error(`${name}: CSPICE target differs from authenticated Horizons target`);
    }
    const parameters = metrics({ mode: 'parameters', constants: cases.constants });
    const sourceText = fs.readFileSync(o['jwst-source'], 'utf8');
    for (const literal of ['21.197 * 14.162', 'coeff_reflectivity: 1.56', '6200.0']) {
      if (!sourceText.includes(literal)) throw new Error('published JWST example no longer contains ' + literal);
    }
    const record = { conventions: 'Geocentric ICRF (SPICE J2000), geometric, km and km/s. Raw JDUT is UTC; nominal UTC labels are the 50 export epochs. Actual TLIST epochs retain the fetcher rounding.',
      parsed, spice, ffm: {}, jwst: {} };
    const h = await harness();
    try {
      for (const name of ['sun', 'moon']) {
        record.ffm[name] = { rawEpoch: await bodyStates(h, parsed[name].rows, targets[name]),
          nominalEpoch: await bodyStates(h, parsed[name].rows, targets[name], 'nominalJdTdb') };
      }
      const rows = parsed.jwst.rows.slice(0, 25);
      if (rows[0].utc !== '2026-06-10T00:00:00.000' || rows.at(-1).utc !== '2026-06-11T00:00:00.000') throw new Error('JWST arc mismatch');
      record.jwst.withSrp = await jwstRun(h, rows, parameters, true);
      record.jwst.noSrp = await jwstRun(h, rows, parameters, false);
    } finally { h.destroy(); }

    const toleranceRationale = 'Pre-existing docs/de440-validation.md cross-release smoke envelope: strict <10 m and <0.1 mm/s. Chosen before evaluating these rows; conservative modern lunar-model allowance, not a JPL accuracy guarantee or a published velocity bound. The separate <1 m question is reported without retuning.';
    const bodies = [];
    for (const name of names.filter((n) => n !== 'jwst')) {
      const raw = parsed[name].rows.map((r) => r.state);
      const sp = spice.bodies[name].epochs;
      const actual = record.ffm[name]?.rawEpoch ?? sp.map((r) => r.rawUtc);
      const releaseCause = cause('ephemeris-release-and-clock',
        `DE440 minus Horizons ${authenticated.files[name].targetSource}, matching target ${targets[name]} and Earth center 399, with FFM versus CSPICE UTC-to-TDB and single-JD rounding where applicable. SPICE removes the FFM clock/reader; its JD-parser control measures time-representation sensitivity. The remaining Horizons/CSPICE time-realization and ephemeris-coefficient contributions cannot be isolated without a local DE441 kernel.`,
        { target: targets[name], center: 399, horizonsSource: authenticated.files[name].targetSource,
          reference: 'docs/de440-validation.md, Park et al. (2021)', diagnostics: `${name}.diagnostics` });
      const score = annotate(brief(compare(metrics, actual, raw, epochs)), releaseCause);
      const release = annotate(brief(compare(metrics, sp.map((r) => r.rawUtc), raw, epochs)), releaseCause);
      const nominal = annotate(brief(compare(metrics, record.ffm[name]?.nominalEpoch ?? sp.map((r) => r.nominalUtc), raw, epochs)),
        cause('rounded-tlist-and-release', 'Nominal hourly export epochs differ from the stored eight-decimal JD UTC TLIST; this adds a velocity-times-time displacement to the release residual.', { maxEpochOffsetS: parsed[name].maxEpochOffsetS }));
      const epochOnly = annotate(brief(compare(metrics, sp.map((r) => r.nominalUtc), sp.map((r) => r.rawUtc), epochs)),
        cause('rounded-tlist', 'Only the rounded-TLIST versus exact-hour time argument differs; both sides use the same CSPICE DE440.', { maxEpochOffsetS: parsed[name].maxEpochOffsetS }));
      const diagnostics = { spiceAtRawUtcMinusHorizons: release, nominalExportEpochMinusHorizons: nominal, tlistEpochOnly: epochOnly };
      diagnostics.spiceJdParserMinusHorizons = annotate(brief(compare(metrics, sp.map((r) => r.jdParserUtc), raw, epochs)), releaseCause);
      diagnostics.spiceJdParserMinusSplitDecimalUtc = annotate(brief(compare(metrics, sp.map((r) => r.jdParserUtc), sp.map((r) => r.rawUtc), epochs)),
        cause('julian-date-parser-precision', 'Same native CSPICE DE440 at the same decimal JD UTC expressed either as a large JD string or as split-decimal-derived ISO. This measures time-parser rounding sensitivity, not a different ephemeris.', { source: 'spice-reference.py str2et / horizons-metrics.cpp split-decimal parser' }));
      Object.assign(releaseCause.evidence, { rawSpiceMinusHorizonsM: release.maxPositionM,
        jdParserMinusHorizonsM: diagnostics.spiceJdParserMinusHorizons.maxPositionM,
        utcInputRepresentationShiftM: diagnostics.spiceJdParserMinusSplitDecimalUtc.maxPositionM });
      if (record.ffm[name]) {
        diagnostics.ffmMinusSpiceAtSameTdb = annotate(brief(compare(metrics, actual, sp.map((r) => r.ffmInstant), epochs, 0.001, 0.001)),
          cause('same-kernel-reader', 'Same DE440 and FFM single-double TDB instant: only interpolation/chain/serialization roundoff should remain.', { source: 'CSPICE spkgeo versus shipped FFM ephemeris' }));
        diagnostics.ffmClockEffect = annotate(brief(compare(metrics, sp.map((r) => r.ffmInstant), sp.map((r) => r.rawUtc), epochs)),
          cause('clock-model-and-single-jd', 'Same CSPICE DE440, FFM converted single-JD TDB versus CSPICE conversion of the decimal JD UTC; includes time-model and Julian-date rounding.', { source: 'horizons-metrics.cpp / spice-reference.py' }));
      }
      bodies.push({ body: name, evaluator: record.ffm[name] ? 'shipped FFM WASM / DE440' : 'SpiceyPy / CSPICE / DE440',
        target: spice.bodies[name].target, center: 399, horizonsTarget: authenticated.index.bodies[name].command,
        horizonsSource: authenticated.files[name].targetSource, ...score, toleranceRationale, diagnostics,
        note: `Matched target ${targets[name]} at the actual stored rounded UTC TLIST.${name === 'jupiter' ? ' Both sides use the Jupiter system barycenter.' : ''} The same-kernel and clock controls distinguish reader and timing effects from the cross-release comparison.`,
        releaseAttribution: {
          applicable: true, consistentWithPriorModernCrossReleaseEnvelope: release.met,
          statement: `Matching-target CSPICE DE440 minus Horizons ${authenticated.files[name].targetSource} reaches ${release.maxPositionM} m and ${release.maxVelocityMmS} mm/s over 50 epochs, ${release.met ? 'within' : 'outside'} the unchanged 10 m / 0.1 mm/s envelope. Nominal-hour versus raw-TLIST epochs alone change DE440 positions by up to ${epochOnly.maxPositionM} m; changing only the CSPICE UTC input representation changes them by up to ${diagnostics.spiceJdParserMinusSplitDecimalUtc.maxPositionM} m and gives a ${diagnostics.spiceJdParserMinusHorizons.maxPositionM} m maximum Horizons residual. The matched-epoch residual combines target/Earth ephemeris release differences and unresolved Horizons/CSPICE time realization; these controls do not isolate DE441 coefficients.${name === 'moon' ? ' The local Park et al. page 2/Figure 1 attribution identifies differing lunar core-damping models as a reason not to expect lunar release equality.' : ''} No local DE441 kernel is available to separate those contributions. No light-time, aberration or rotating-frame corrections are involved.`,
          evidence: { target: targets[name], center: 399, maxPositionM: release.maxPositionM,
            maxVelocityMmS: release.maxVelocityMmS, tlistEpochOnlyMaxPositionM: epochOnly.maxPositionM,
            spiceUtcRepresentationMaxPositionM: diagnostics.spiceJdParserMinusSplitDecimalUtc.maxPositionM,
            spiceJdParserMinusHorizonsMaxPositionM: diagnostics.spiceJdParserMinusHorizons.maxPositionM },
        } });
    }
    const rows = parsed.jwst.rows.slice(0, 25), je = rows.map((r) => r.utc), ref = rows.map((r) => r.state);
    const jwstCause = cause('simplified-spacecraft-versus-fitted-trajectory',
      'Cannonball proxy omits attitude-dependent sunshield optics, current mass, station keeping and fitted trajectory corrections; Horizons JWST_merged is not a force-matched integration reference.', { model: 'published Nyx 2.6.0 JWST example assumptions', raw: 'raw/jwst.json' });
    const jwstRows = ['withSrp', 'noSrp'].map((id) => ({ id,
      ...annotate(brief(compare(metrics, record.jwst[id].states, ref, je, 10000, null, false)), jwstCause),
      toleranceKm: 10, acceptedSteps: record.jwst[id].acceptedSteps,
      note: 'Position-only strict <10 km sanity bound, preselected before evaluation; velocity is descriptive (null tolerance means no velocity gate). This is not an orbit-accuracy claim.' }));
    const sensitivity = annotate(brief(compare(metrics, record.jwst.withSrp.states, record.jwst.noSrp.states, je, 10000, null, false)), jwstCause);
    const dominance = metrics({ mode: 'sensitivity', toggleKm: sensitivity.maxPositionKm,
      withSrpKm: jwstRows[0].maxPositionKm, noSrpKm: jwstRows[1].maxPositionKm });
    write('horizons-comparisons.json', record);
    const sourceFiles = ['run-horizons.mjs', 'horizons-common.mjs', 'horizons-metrics.cpp', 'spice-reference.py', 'check-horizons.mjs',
      '../cases/ffm-reference-cases.json', '../../lib/prwCodec.mjs', '../../../plugin-manifest.json', '../../../package.json',
      '../../../src/cpp/include/ffm/prw_codec.h', '../../../lib/time_convert.cpp', '../../../lib/time_convert.h', '../../../lib/time_types.h',
      '../../../../../docs/de440-validation.md', 'raw/index.json', 'horizons-comparisons.json'];
    const summary = {
      about: 'Offline Horizons sanity references. All dynamics and numerical arithmetic are C++/WASM/native CSPICE; JavaScript and Python only orchestrate transport.',
      module: { version: read(path.join(ffm, 'package.json')).version, file: path.relative(here, wasmPath), sha256: sha256(wasmPath) },
      horizons: { version: '1.2', fetched: authenticated.index.fetched, center: '500@399', frame: 'ICRF', units: ['km', 'km/s'], correction: 'NONE (geometric)',
        timeScale: 'UT is UTC after 1962, explicitly documented by each raw footer', sampleCountPerBody: 50,
        maxTlistOffsetFromNominalS: parsed.moon.maxEpochOffsetS,
        hashConvention: 'sha256 is on-disk bytes. responseSha256 must equal raw/index.json sha256 using JSON.stringify(parsedRaw)+newline, reconstructing the original API response serialization exactly.',
        rawFiles: Object.fromEntries(names.map((name) => { const { raw, ...metadata } = authenticated.files[name]; return [name, metadata]; })) },
      provenance: { caseExport: { file: path.relative(here, casesPath), sha256: sha256(casesPath) },
        ephemeris: { file: path.relative(here, de440Path), sha256: sha256(de440Path), name: cases.models.ephemeris.name },
        spice: { ...spice.tools, lsk: { file: lsk, sha256: sha256(lsk) }, kernelTargetIds: spice.kernelTargetIds },
        jwstPublishedExample: { file: o['jwst-source'], sha256: sha256(o['jwst-source']),
          url: 'https://docs.rs/crate/nyx-space/2.6.0/source/examples/02_jwst_covar_monte_carlo/main.rs',
          citedSources: ['https://webb.nasa.gov/content/about/faqs/facts.html', 'https://amostech.com/TechnicalPapers/2018/Poster/Bengtson.pdf'],
          note: 'Read from the locally installed published crate; no network. Full rectangular sunshield area, nominal 6200 kg mass, Kapton proxy Cr=2-0.44=1.56. These are published assumptions, not measured 2026 JWST parameters.' },
        publication: { title: 'Park et al. (2021), The JPL Planetary and Lunar Ephemerides DE440 and DE441, AJ 161:105', doi: '10.3847/1538-3881/abd414',
          url: 'https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/de440_and_de441.pdf', localEvidence: '../../../../../docs/de440-validation.md', consulted: 'local repository attribution only; primary PDF not available offline' } },
      bodies,
      jwst: { epochUtc: je[0], finalEpochUtc: je.at(-1), frame: 'GCRF/ICRF geocentric', sampleCount: 25,
        initialStateKmKmS: ref[0], parameters,
        forceModel: 'Earth point mass (shared export GM) + Sun + Moon via exported DE440, with/without cannonball SRP; no maneuvers, drag, harmonics, relativity or planetary perturbations.',
        integrator: { algorithm: 'shipped FFM RK78', relativeTolerance: 1e-13, maxStepS: 300, minStepS: 0.001 },
        toleranceRationale: 'Preselected strict 10 km over 24 h: a loose order-of-magnitude sanity ceiling, not fitted to these residuals. C++ reports its equivalent constant acceleration and the nominal one-AU SRP displacement below. The bound allows several times a full-SRP modeling error, nominal/current mass and attitude/optics differences, plus small unmodeled corrections; an actual large maneuver could legitimately exceed it.',
        rows: jwstRows, srpMinusNoSrp: sensitivity, sensitivityRatios: dominance,
        note: `Horizons JWST_merged is a fitted, maneuver-corrected trajectory; neither run reproduces its OD/attitude/operational force model. The SRP-toggle displacement ${dominance.dominatesBothResiduals ? 'exceeds both reference residuals, demonstrating dominant sensitivity to the assumed optical force' : 'does not exceed both residuals; SRP dominance is not established'}. This toggle does not identify every remaining error or establish an accurate spacecraft Cr.` },
      skipped: [{ id: 'jwst-august-arc', reason: 'Task requests the June 10 24 h arc; all 50 JWST rows are parsed and authenticated, only June\'s 25 are propagated.' }],
      verdict: { status: bodies.every((r) => r.met) && jwstRows.every((r) => r.met) ? 'sanity-bounds-met' : 'qualified-with-explained-misses',
        bodiesMet: bodies.filter((r) => r.met).length, bodiesTotal: bodies.length, jwstMet: jwstRows.filter((r) => r.met).length,
        statement: 'Sun/Moon exercise shipped FFM ephemeris; Venus and Jupiter system barycenter exercise independent CSPICE DE440 against the same Horizons targets. All four use the same 10 m / 0.1 mm/s bounds. JWST is a loose operational-trajectory sanity comparison. See measured rows and causes; no overall propagation-accuracy claim.' },
      fileHashes: sourceFiles.map((file) => ({ file, sha256: sha256(path.resolve(here, file)) })),
    };
    write('summary-horizons.json', summary);
    for (const row of bodies) console.log(`${row.body}: max position ${row.maxPositionM} m; velocity ${row.maxVelocityMmS} mm/s; met=${row.met}; <1m=${row.subMeter.met}`);
    for (const row of jwstRows) console.log(`JWST ${row.id}: max position ${row.maxPositionKm} km; <10km=${row.met}`);
    console.log(`JWST SRP-toggle sensitivity: ${sensitivity.maxPositionKm} km`);
    console.log(`Wrote summary-horizons.json; verdict=${summary.verdict.status}`);
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
await main().catch((error) => { console.error(error.stack); if (error.stderr) console.error(String(error.stderr)); process.exitCode = 1; });
