#!/usr/bin/env node
// Annotate the current scores produced by score-gmat.mjs.
// node tests/evidence/gmat/update-summary.mjs
import fs from 'node:fs';
import path from 'node:path';
import { here, readJson, sha256, buildMetrics, causeFor, verdictFor, sourceFiles, externalSources } from './evidence.mjs';

const work = fs.mkdtempSync(path.join(here, '.update-gmat-'));
try {
  const metrics = buildMetrics(work);
  const oxygen = readJson('anomalous-oxygen.json');
  const derived = metrics({ mode: 'density', rows: oxygen.rows });
  const pin = (file) => ({ path: file, sha256: sha256(file) });
  for (const release of ['R2026a', 'R2022a']) {
    const file = `summary-gmat-${release}.json`;
    const summary = readJson(file);
    const record = readJson(summary.gmat.file);
    for (const row of summary.cases) {
      for (const setting of ['suite', 'steps30', 'finest']) row[setting].met = row[setting].worstM <= row.toleranceM;
      row.met = row.suite.met;
      if (!row.met && release === 'R2026a') {
        const measured = oxygen.rows.find((r) => r.id === row.id);
        if (!measured) throw new Error(`Missing diagnosis: ${row.id}`);
        row.cause = causeFor(measured, derived.find((r) => r.id === row.id));
      }
    }
    summary.protocol = {
      source: 'Pinned NASA GMAT trajectories and the shared ffm-reference-cases.json protocol; FFM scores refreshed from the shipped WASM using C++ reductions.',
      units: 'maximum 3D position difference, meters; STM relative column difference, dimensionless',
      frame: 'GCRF; EME2000 for explicitly marked EME2000 cases', epoch: '2026-08-02T00:00:00Z', timeScale: 'UTC',
      durationS: 86400, sampleIntervalS: 3600, scoredSamples: 24,
      toleranceRationale: 'Unchanged shared GMAT protocol: point mass 0.01 m, gravity 0.05 m, SRP 0.1 m, drag 1.5 m. Corrected drag also compared with the shared default 0.1 m. The JR atmosphere frame note is retained verbatim.',
      replayToleranceM: 0,
      replayToleranceRationale: 'Exact replay of the same shipped WASM, inputs and settings. C++ disables fused multiply-add so kilometer-to-meter conversion rounds before subtraction as in the historical scorer; the C++ norm reproduces both stored scores exactly. worstM, atHour and integration steps must all match exactly.',
    };
    summary.verdict = verdictFor(summary, release, metrics);
    const files = [summary.gmat.file, 'anomalous-oxygen.json', '../cases/ffm-reference-cases.json',
      '../../../dist/isomorphic/module.wasm', '../../../plugin-manifest.json', '../../../package.json',
      '../../fixtures/orekit/orekit-reference.json', '../../fixtures/orekit/eop-2026-08.json',
      '../../fixtures/orekit/eop-2026-06.json', '../../fixtures/orekit/jb2008-2026-06.json',
      '../../fixtures/orekit/spw-2026-08.json', '../../../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp'];
    summary.fileHashes = files.map(pin);
    summary.provenance = {
      sourceIdentity: [...sourceFiles.map(pin), ...externalSources.map((source) => ({ ...source, sha256: sha256(source.path) }))],
      trajectory: { path: summary.gmat.file, sha256: summary.gmat.sha256 },
      caseExport: { path: '../cases/ffm-reference-cases.json', sha256: record.caseExportSha256 },
      anomalousOxygen: { path: 'anomalous-oxygen.json', sha256: sha256('anomalous-oxygen.json'),
        scope: 'Recorded R2026a NRLMSISE-00 diagnostic only; no R2022a/Jacchia-Roberts correction inferred.' },
      inputFiles: record.inputFiles,
      sourceScope: 'Local NASA GMAT source copies confirm the density convention; no unrecorded source revision or fresh GMAT rerun is claimed.',
      historicalArtifacts: [],
      hashPolicy: 'Verify every available path against its declared digest; unavailable historical binaries, reports and input files are explicit provenance gaps, never silently re-pinned.',
    };
    const historicalRoot = `/Users/tj/software/tools/xval/gmat-work/final/${release === 'R2026a' ? 'main' : 'r22'}`;
    for (const entry of Object.values(record.inputFiles)) if (entry.sha256) {
      summary.provenance.historicalArtifacts.push({ path: `${historicalRoot}/${entry.file}`, sha256: entry.sha256, role: 'recorded GMAT input' });
    }
    for (const row of record.cases) summary.provenance.historicalArtifacts.push({
      path: `${historicalRoot}/${row.id.replaceAll(' ', '_')}.txt`, sha256: row.reportSha256, role: 'recorded GMAT report', caseId: row.id,
    });
    if (summary.gmat.stmFile) {
      const file = `/Users/tj/software/tools/xval/gmat-work/final/${summary.gmat.stmFile}`;
      summary.provenance.historicalArtifacts.push({ path: file, sha256: summary.gmat.stmSha256, role: 'stored STM trajectory' });
    }
    if (release === 'R2026a') {
      summary.provenance.historicalArtifacts.push(
        { path: '/Users/tj/software/tools/xval/gmat-R2026a/bin/GmatConsole', sha256: record.tool.gmatConsoleSha256, role: 'recorded GMAT executable' },
        { path: '/Users/tj/software/tools/xval/gmat-R2026a/bin/GMAT-R2026a_Beta.app/Contents/Frameworks/libGmatBase.dylib', sha256: record.tool.gmatBaseSha256, role: 'recorded GMAT library' });
    }
    fs.writeFileSync(path.join(here, file), `${JSON.stringify(summary, null, 1)}\n`);
  }
} finally { fs.rmSync(work, { recursive: true, force: true }); }
