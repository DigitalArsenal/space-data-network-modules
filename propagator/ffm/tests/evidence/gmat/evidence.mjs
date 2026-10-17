// Files, transport and evidence presentation. All numerical reductions are C++.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export { ALL, CASES, run, scoreResponse } from '../nyx/scoring.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const readJson = (file) => JSON.parse(fs.readFileSync(path.resolve(here, file), 'utf8'));
export const sha256 = (file) => createHash('sha256').update(fs.readFileSync(path.resolve(here, file))).digest('hex');
export const classification = 'model-setting difference (GMAT density without anomalous oxygen)';
export const sourceFiles = ['evidence.mjs', 'gmat-metrics.cpp', 'check-gmat.mjs', 'update-summary.mjs',
  'score-gmat.mjs', 'anomalous-oxygen.mjs', 'run-gmat.mjs', 'gmat-files.mjs',
  '../nyx/scoring.mjs', '../nyx/score-metrics.cpp', '../tudat/scoring.mjs', '../recorded-numbers.mjs', '../../lib/orekitCases.mjs', '../../lib/prwCodec.mjs', '../../../lib/nrlmsise00.cpp'];
export const externalSources = [
  { path: '/Users/tj/software/tools/xval/gmat-src/NRLMsise00Atmosphere.cpp',
    source: 'NASA GMAT NRLMSISE-00 plugin source copy', lines: '284-285, 322',
    statement: 'Density calls gtd7_ and returns xden[5] * 1000 kg/m^3.' },
  { path: '/Users/tj/software/tools/xval/gmat-src/nrlmsise00_sub.c',
    source: 'NASA GMAT NRLMSISE-00 Fortran-to-C source copy', lines: '1044-1054, 1338-1345, 2226-2230',
    statement: 'gtd7 total mass density excludes anomalous oxygen; gtd7d adds species 9 times atomic mass 16.' },
];
export function buildMetrics(work) {
  const binary = path.join(work, 'gmat-metrics');
  execFileSync('c++', ['-std=c++17', '-O2', '-ffp-contract=off', '-I', path.resolve(here, '../../../src/cpp/include'),
    path.join(here, 'gmat-metrics.cpp'), '-o', binary],
  { cwd: work, env: { ...process.env, TMPDIR: work }, stdio: ['ignore', 'pipe', 'pipe'] });
  return (input) => JSON.parse(execFileSync(binary, [], { input: JSON.stringify(input), encoding: 'utf8',
    cwd: work, maxBuffer: 8 << 20, stdio: ['pipe', 'pipe', 'pipe'] }));
}
export function causeFor(row, derived) {
  return {
    classification,
    statement: 'GMAT gtd7 excludes anomalous oxygen; FFM and Orekit use gtd7d drag-effective density. The day-mean density ratio times the independently stored drag effect accounts for the meter-scale gap. A constant Cd multiplier is an approximation to the varying density ratio: the corrected trajectory is the measured residual, not a claim of exact model identity.',
    evidence: { file: 'anomalous-oxygen.json', sourceRelease: 'R2026a', ffmSetting: 'steps30',
      ...row, ...derived, sources: externalSources.map(({ path, lines }) => ({ file: path, lines })),
      ffmSource: '../../../lib/nrlmsise00.cpp:92-104' },
    correctedDifferenceM: derived.correctedDifferenceM,
    correctedMet: derived.correctedMet,
    correctedLimitM: 1.5,
    correctedDefaultMet: derived.correctedDefaultMet,
    correctedDefaultLimitM: 0.1,
    residualInterpretation: row.id.startsWith('SSO700')
      ? '0.106-0.123 m remains after constant Cd scaling: below 1.5 m, above 0.1 m. This measurement rules out another unaccounted meter-scale discrepancy in these cases; it does not isolate the remaining decimeter residual or prove that every other model detail is identical.'
      : 'The measured corrected residual meets both the 1.5 m GMAT limit and the 0.1 m shared default.',
  };
}
export function verdictFor(summary, release, metrics) {
  const misses = summary.cases.filter((row) => row.met === false);
  const stm = metrics({ mode: 'stm', cases: summary.cases });
  return {
    release, setting: 'suite', total: summary.cases.length,
    met: summary.cases.filter((row) => row.met === true).length, missed: misses.length,
    statement: release === 'R2026a'
      ? '51 of 57 cases meet the stated GMAT limits at the suite setting. All six misses are NRLMSISE-00 drag cases at all three FFM settings; each records the anomalous-oxygen density convention and measured Cd-scaled residual. The misses remain met:false at 1.5 m.'
      : '55 of 55 R2022a cases meet the stated GMAT limits at the suite setting. These drag cases use Jacchia-Roberts, not NRLMSISE-00; the R2026a anomalous-oxygen diagnosis is not applicable. The existing JR drag note and 17 skipped cases are retained.',
    misses: misses.map((row) => ({ id: row.id, worstM: row.suite.worstM, toleranceM: row.toleranceM,
      classification: row.cause.classification, correctedDifferenceM: row.cause.correctedDifferenceM,
      correctedMet: row.cause.correctedMet, correctedDefaultMet: row.cause.correctedDefaultMet })),
    stm: { ...stm, agreement: stm.caseCount ? 'reported numerical agreement; no protocol pass threshold' : 'not measured',
      statement: stm.caseCount
        ? `${stm.caseCount} suite STM comparisons; largest relative column difference ${stm.worstRelativeColumnDifference}. Position and velocity rows are compared separately. No STM pass threshold is supplied by this protocol.`
        : 'R2022a has no stored STM comparisons; no agreement claim is made.' },
  };
}
