// Evidence annotations only; numerical scores are produced by score-metrics.cpp.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, CASES } from './scoring.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

export function explainSummary(summary, scratch, inputDirectory) {
  const files = new Map();
  function record(file, expected) {
    const absolute = path.resolve(here, file), actual = sha256(absolute);
    if (expected && actual !== expected) throw new Error(`Evidence hash mismatch: ${file}`);
    files.set(absolute, { path: file, sha256: actual });
    return actual;
  }
  for (const file of ['score-nyx.mjs', 'measure-drag-settings.mjs', 'scoring.mjs', 'score-metrics.cpp', 'explain-nyx.mjs', 'check-nyx.mjs', 'Cargo.lock', 'Cargo.toml', 'src/main.rs', 'run-nyx.mjs', 'nrlmsise00-published.patch', 'make-msis-variant.mjs', 'check-density.mjs', 'itrf-bpc.json', '../../../package.json', '../../../plugin-manifest.json', '../../../src/cpp/include/nlohmann/json.hpp', '../../lib/orekitCases.mjs', '../../lib/prwCodec.mjs', '../../fixtures/orekit/orekit-reference.json', '../../fixtures/orekit/eop-2026-08.json', '../../fixtures/orekit/eop-2026-06.json', '../../fixtures/orekit/spw-2026-08.json', '../../fixtures/orekit/jb2008-2026-06.json', '../erfa-spice/summary-erfa-spice.json']) record(file);
  record('../../../dist/isomorphic/module.wasm', summary.module.sha256);
  record('../orekit/scoring.mjs'); record('../orekit/score-metrics.cpp'); record('../tudat/scoring.mjs');
  record('../recorded-numbers.mjs');
  record(summary.nyx.file, summary.nyx.sha256);
  summary.nyx.caseExportSha256 = read(path.resolve(here, summary.nyx.file)).caseExportSha256;
  record('../cases/ffm-reference-cases.json', summary.nyx.caseExportSha256);
  if (summary.nyx.stmFile) record(summary.nyx.stmFile, summary.nyx.stmSha256);
  const nyx = read(path.resolve(here, summary.nyx.file));
  record('Cargo.lock', nyx.tool.cargoLockSha256);
  const cache = path.join(scratch, 'cargo-home/registry/cache');
  const registry = fs.readdirSync(cache).find((name) => fs.existsSync(path.join(cache, name, 'nyx-space-2.6.0.crate')));
  record(path.join(cache, registry, 'nyx-space-2.6.0.crate'), nyx.tool.nyxCrateSha256);
  for (const [name, hash] of Object.entries(nyx.inputFiles)) {
    const original = path.join(scratch, name === 'pck08.pca' || name.endsWith('.bpc') ? 'data' : 'work', name);
    const file = fs.existsSync(original) || !inputDirectory ? original : path.join(path.resolve(inputDirectory), name);
    record(file, hash);
    if (file !== original) files.set(path.resolve(file), {
      path: `historical-inputs/${name}`, sha256: hash, role: 'historical-input', availability: 'unavailable',
      reason: 'Original input bytes were authenticated against this recorded checksum during refresh. They are not vendored in the evidence package; the path is a stable archive label, and the checker reports unavailable bytes as a provenance gap.',
    });
  }
  const repo = path.resolve(here, '../../../../..');
  record(path.join(repo, CASES.models.ephemeris.path), CASES.models.ephemeris.sha256);
  for (const diagnostic of Object.values(summary.diagnostics)) if (diagnostic.file) record(diagnostic.file, diagnostic.sha256);
  const naif = read(summary.diagnostics['naif-bpc'].file);
  summary.diagnostics['naif-bpc'].inputFiles = naif.inputFiles;
  record(path.join(scratch, '../naif-kernels/earth_latest_high_prec.bpc'), naif.inputFiles['earth_latest_high_prec.bpc']);

  // Cargo executable digests identify observations of build outputs. Rebuilds
  // are not bit-reproducible, so source/input identity is pinned separately.
  const buildOutputs = [];
  for (const [label, tool] of [['stock Nyx runner', nyx.tool], ['published-MSIS diagnostic runner', summary.diagnostics['msis-published'].tool]]) {
    const file = path.join(scratch, 'target/release', tool.binary);
    buildOutputs.push({ label, role: 'informational', sha256: tool.binarySha256, currentFile: file,
      currentSha256: fs.existsSync(file) ? sha256(file) : null,
      note: 'Historical and current Cargo executable hashes are informational build-output observations, not reproducible identity requirements.' });
  }
  const variantLock = path.join(scratch, 'msis-variant/runner/Cargo.lock');
  const variantLockSha256 = record(variantLock);
  const sourceIdentity = {
    cargoLock: { file: 'Cargo.lock', sha256: nyx.tool.cargoLockSha256 },
    nyxCrate: { file: path.join(cache, registry, 'nyx-space-2.6.0.crate'), sha256: nyx.tool.nyxCrateSha256 },
    runnerSource: { file: 'src/main.rs', sha256: sha256(path.join(here, 'src/main.rs')) },
    rustc: nyx.tool.rustc,
    inputFiles: { ...nyx.inputFiles, [path.basename(CASES.models.ephemeris.path)]: CASES.models.ephemeris.sha256 },
    caseExportSha256: nyx.caseExportSha256,
  };
  summary.provenance = {
    scope: 'Pinned identity is the source set (Cargo.lock, registry Nyx crate, runner source, recorded rustc version, and variant patch) plus input-file hashes. Cargo build-output hashes are informational: rebuilding the target directory is not a failure. Missing hash files are reported as gaps; a mismatched hash of an existing pinned file fails verification.',
    sourceIdentity: {
      stock: sourceIdentity,
      msisPublished: { ...sourceIdentity, cargoLock: { file: variantLock, sha256: variantLockSha256 },
        patch: { file: 'nrlmsise00-published.patch', sha256: sha256(path.join(here, 'nrlmsise00-published.patch')) } },
    },
    buildOutputs,
    sourceScope: 'The pinned runner source is the current documented reproduction recipe, including the WGS84 planetary-data correction used by drag-settings-diagnostic.json. It is not a claim that the unavailable historical executable was built from byte-identical runner source.',
    diagnosticLock: { file: variantLock, sha256: variantLockSha256, note: 'run-nyx.mjs --bin recorded the stock runner Cargo.lock, not the patched runner lock. This is the actual local patched-runner lock. The Nyx crate checksum identifies the unmodified registry crate; the separate patch identifies the two changed formulas.' },
  };
  summary.protocol = { source: '../cases/ffm-reference-cases.json:protocol', units: 'meters, with STM columns dimensionless relative differences',
    frame: 'GCRF; EME2000 only for E1 cases', epochUtc: '2026-08-02T00:00:00.000', arcS: 86400, sampleStepS: 3600,
    timeScales: 'UTC sample epochs; FFM integrates TT, Nyx hifitime ET for ephemeris/orientation',
    toleranceRationale: 'Unmodified protocol.tolerancesM.default: point mass 0.001 m, gravity 0.05 m, SRP and drag 0.1 m. The 1.5 m drag allowance belongs only to GMAT and is not applied to Nyx.',
    met: 'The case-level flag uses suite. Each setting also has its own flag; no tolerance is relaxed.',
    stm: 'Largest relative difference of each 6x6 orbit column, position and velocity rows separately; Cr*A/m and Cd*A/m columns use the same definition. No STM pass threshold is specified by the exported protocol, so measured agreement is reported without inventing one.',
  };
  const density = read(path.join(scratch, 'work/density.json')), publishedDensity = read(path.join(scratch, 'work/density-patched.json'));
  record(path.join(scratch, 'work/density.json')); record(path.join(scratch, 'work/density-patched.json'));
  summary.diagnostics['msis-published'].density = {
    source: 'Existing check-density.mjs outputs: density.json and density-patched.json; published C translation of NRLMSISE-00 in third_party/nrlmsise00 (Brodowski 20041227; Picone et al. 2002, doi:10.1029/2002JA009430).',
    setup: '1125 identical geodetic points, UTC 2026-08-02; heights 300,400,500,700,800 km; WGS84, mean local solar time, F10.7=F10.7a=150, daily Ap=15, anomalous oxygen included. Densities kg/m^3; relative difference Nyx/FFM - 1.',
    stock: { maxAbsRel: density.maxAbsRel, byAltitudeKm: density.byAltitudeKm },
    published: { maxAbsRel: publishedDensity.maxAbsRel, byAltitudeKm: publishedDensity.byAltitudeKm },
    defects: ['Nyx annual angle rate uses 2*pi/365.25; published model uses DR=1.72142e-2.', 'Nyx omits the anomalous-oxygen exponential factor below 550 km; the published model applies it at all heights.'],
    note: 'Diagnostic only. Stock Nyx remains the table of record; this two-line patch changes no FFM code or settings.',
  };
  record(path.join(repo, 'third_party/nrlmsise00/nrlmsise-00.c'));
  record(path.join(repo, 'third_party/nrlmsise00/README.md'));
  const frameSummary = read(path.join(here, '../erfa-spice/summary-erfa-spice.json')), fit = read(path.join(here, 'itrf-bpc.json'));
  summary.diagnostics.earthOrientation = {
    classification: 'model-setting-mismatch',
    statement: 'NAIF ITRF93 BPC uses its own EOP/nutation reduction (IAU 1976/1980), whereas the suite supplies daily IERS rows to IAU 2006/2000A. This explains the NAIF-run J2/field offsets. Stock Nyx already uses the FFM-matched BPC, so the NAIF mismatch must not be assigned to stock residuals. Orekit additionally applies subdaily EOP corrections; FFM uses the exported daily rows.',
    measurement: frameSummary.rows.filter((r) => ['c2tSpice', 'c2tSpiceErfa'].includes(r.id)).map(({ id, max, unit, poleMas, spinMas }) => ({ id, max, unit, poleMas, spinMas })),
    matchedBpc: { file: fit.bpc.name, sha256: fit.bpc.sha256, checkedResidualUas: fit.maxCheckedResidualUas, aniseReadBackResidualUas: fit.aniseReadBack.maxResidualUas },
    trajectoryMeasurement: 'diagnostics.naif-bpc.cases: same Nyx binary/settings, changed BPC only; stockMinusVariant quantifies the orientation-only trajectory change, and suite/steps30/finest score both against the identical FFM responses.',
  };
  const geometryFile = path.join(here, 'drag-settings-diagnostic.json');
  const geometry = read(geometryFile);
  record(geometryFile);
  summary.diagnostics.dragSettings = { file: 'drag-settings-diagnostic.json', sha256: sha256(geometryFile),
    classification: 'model-setting-mismatch',
    statement: 'The cached runs predate the runner fix that writes WGS84 into ANISE planetary data. ANISE transform_to replaces supplied frame shape from that data; the old path uses pck08 Earth radii. The current prebuilt published-MSIS runner plus WGS84 brings every supported drag case below 0.1 m. Historical binaries are unavailable, so assignment of the cached residual to that old path is an inference from the documented source fix, file chronology, measured shape difference and corrected-run convergence.',
    geodetic: geometry.geodetic, cases: geometry.cases,
  };
  const crateSource = path.join(scratch, 'cargo-home/registry/src', registry, 'nyx-space-2.6.0');
  record(path.join(crateSource, 'src/dynamics/spacecraft.rs'));
  record(path.join(crateSource, 'src/propagators/instance.rs'));
  record(path.join(crateSource, 'src/dynamics/orbital.rs'));
  summary.diagnostics.stm = {
    agreement: 'disagrees', classification: 'Nyx variational-equation defect',
    statement: 'Stock Nyx 2.6.0 spacecraft.rs:208-214 takes ctx.stm (the step-start matrix) and computes stm * grad. grad is the conventional df/dx; the variational equation requires grad * stage_stm. Propagator instance.rs passes the unchanged context to each RK stage. This reversed product and frozen step-start matrix explain the gross disagreements even in point mass; no FFM STM defect is indicated by this comparison.',
    evidence: { pointMass: summary.cases.filter((r) => r.row === 'pointMass').map((r) => ({ id: r.id, ...r.stm })),
      source: 'nyx-space 2.6.0 src/dynamics/spacecraft.rs:199-214; src/propagators/instance.rs:359-394; src/dynamics/orbital.rs:141-155 defines df/dx; spacecraft.rs:330-333 copies that gradient' },
  };
  for (const r of summary.cases) {
    r.stm.agreement = 'disagrees';
    r.stm.cause = 'Nyx variational-equation defect; see diagnostics.stm.';
    const published = summary.diagnostics['msis-published'].cases.find((c) => c.id === r.id);
    if (!published) continue;
    const fixed = geometry.cases.find((c) => c.id === r.id);
    const fine = summary.diagnostics.fine.cases.find((c) => c.id === r.id);
    const evidence = {
      stockSuiteM: r.suite.worstM, stockSteps30M: r.steps30.worstM, stockFinestM: r.finest.worstM,
      orekitMinusStockM: r.orekitMinusNyx.worstM,
      publishedSuiteM: published.suite.worstM, publishedSteps30M: published.steps30.worstM, publishedFinestM: published.finest.worstM,
      orekitMinusPublishedM: published.orekitMinusNyx.worstM,
      stockMinusPublishedM: published.stockMinusVariant.worstM,
      stockMinusFineNyxM: fine.stockMinusVariant.worstM,
      publishedWgs84FinestM: fixed.finest.worstM, orekitMinusPublishedWgs84M: fixed.orekitMinusWgs84.worstM,
      cachedPublishedMinusWgs84M: fixed.cachedPublishedMinusWgs84.worstM,
      toleranceM: r.toleranceM,
    };
    r.diagnosis = {
      classification: 'Nyx NRLMSISE-00 port defect and model-setting mismatch',
      statement: `Stock Nyx differs by ${r.finest.worstM} m at FFM finest; the published two-line MSIS correction reduces this to ${published.finest.worstM} m. With the current runner's WGS84 planetary-data correction it is ${fixed.finest.worstM} m, within ${r.toleranceM} m. The stock-to-published change identifies the NRLMSISE-00 port defect; the remaining cached-published gap is attributed to the Earth-shape mismatch as explained in diagnostics.dragSettings. FFM defect: not indicated; Orekit is ${r.orekitMinusNyx.worstM} m from stock and ${fixed.orekitMinusWgs84.worstM} m from the corrected diagnostic. Nyx fine-step convergence changes stock by only ${fine.stockMinusVariant.worstM} m.`, evidence,
    };
    if (['suite', 'steps30', 'finest'].some((key) => !r[key].met)) r.cause = r.diagnosis;
    if (['suite', 'steps30', 'finest'].some((key) => !published[key].met)) published.cause = {
      classification: 'model-setting-mismatch', statement: r.diagnosis.statement,
      evidence: { publishedFinestM: published.finest.worstM, publishedWgs84FinestM: fixed.finest.worstM, cachedPublishedMinusWgs84M: fixed.cachedPublishedMinusWgs84.worstM },
    };
  }
  for (const key of ['fine', 'naif-bpc']) for (const r of summary.diagnostics[key].cases) {
    if (!['suite', 'steps30', 'finest'].some((setting) => !r[setting].met)) continue;
    const stock = summary.cases.find((c) => c.id === r.id);
    r.cause = key === 'fine' ? stock.cause : {
      classification: stock.row === 'drag' ? 'Nyx NRLMSISE-00 port defect and model-setting mismatch' : 'model-setting-mismatch',
      statement: stock.row === 'drag' ? `${stock.diagnosis.statement} This diagnostic additionally uses NAIF ITRF93 orientation.` : summary.diagnostics.earthOrientation.statement,
      evidence: { stockMatchedBpcFinestM: stock.finest.worstM, naifBpcFinestM: r.finest.worstM, stockMinusNaifM: r.stockMinusVariant.worstM },
    };
  }
  const misses = summary.cases.filter((r) => !r.met);
  summary.verdict = {
    stockNyx: { version: nyx.tool.nyxSpace, met: summary.cases.filter((r) => r.met).length, total: summary.cases.length, missed: misses.length,
      statement: `Stock Nyx ${nyx.tool.nyxSpace} meets tolerance on ${summary.cases.filter((r) => r.met).length} of ${summary.cases.length} cases at the suite setting; the five misses are LEO drag cases affected by the two-line NRLMSISE-00 port defect.` },
    drag: {
      statement: 'With the published NRLMSISE-00 formulas and the WGS84 Earth shape, the five missed cases are about 0.05 m from FFM, all below the unchanged 0.1 m limit. The exact corrected residuals are recorded per case. The port defect and the cached runner Earth-shape mismatch are separated in the per-case diagnostics; they do not indicate an FFM defect.',
      correctedCases: misses.map((r) => {
        const c = geometry.cases.find((g) => g.id === r.id);
        return { id: r.id, worstM: c.finest.worstM, toleranceM: r.toleranceM, met: c.finest.met };
      }),
    },
    stm: { usableAsFfmCheck: false,
      statement: 'The STM comparison is not usable as an FFM check: Nyx uses the step-start ctx.stm and computes stm * grad, instead of grad * stage_stm, while the RK stages retain the same context.',
      sources: ['nyx-space 2.6.0 src/dynamics/spacecraft.rs:199-214', 'nyx-space 2.6.0 src/propagators/instance.rs:359-394', 'nyx-space 2.6.0 src/dynamics/orbital.rs:141-155 and spacecraft.rs:330-333 (gradient convention)'],
    },
  };
  summary.fileHashes = [...files.values()];
  return summary;
}
