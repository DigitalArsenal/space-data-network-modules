#!/usr/bin/env node
// E2E (modules-optical-astrometry-typed-20261103): the OD summary $OCM in typed fields. The s2a video run
// (tests/od-summary-run.mjs: cached inputs, archive through ARCHIVE_THROUGH) on this build, against
// tests/fixtures/od-summary.json, the same run on the build that wrote USER_DEFINED_PARAMETERS:
//   - every $OCM on `orbit` carries no USER_DEFINED_PARAMETERS (assertNoUserDefined);
//   - every recorded list value is read from its typed field with the same number, or follows from
//     COVARIANCE_DATA (the SIGMA_TOTAL rows, dropped), or is a diagnostic the report keeps;
//   - STATE_DATA and COVARIANCE_DATA are the recorded bytes; the report's items are the recorded items.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoUserDefined } from '../../../common/tests/no-user-defined.mjs';
import { sds, bb, each, outputsOf, TARGET } from './s2a-run.mjs';
import { odSummaryRun, f64sha, ARCHIVE_THROUGH } from './od-summary-run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/od-summary.json'), 'utf8'));
const [{ OCM }, { EOO }] = await Promise.all([sds('OCM'), sds('EOO')]);

let passed = 0, failed = 0;
function check(name, ok, detail) {
  ok ? passed++ : failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}
const t0 = Date.now();
const { run, report, ocmRecords } = await odSummaryRun();

check('inputs: the recorded run (video, IERS file, error model, GP sets, archive cutoff)', run.digest === fixture.videoSha256 &&
  run.eop.sha256 === fixture.iersSha256 && run.erm.sha256 === fixture.errorModelSha256 && run.gp.rows.length === fixture.gpSets &&
  fixture.archiveThrough === ARCHIVE_THROUGH, `${run.gp.rows.length} GP sets through ${run.gp.newest}`);
const reportSame = report.REASON === fixture.reportReason && Number(report.COUNT) === fixture.reportCount &&
  JSON.stringify(report.ITEMS) === JSON.stringify(fixture.reportItems);
check('report: the recorded text', reportSame, `${report.REASON} (${Number(report.COUNT)}), ${report.ITEMS.length} items`);

let clean = 0;
for (const bytes of ocmRecords) { assertNoUserDefined(bytes); clean++; }
check('assertNoUserDefined on every $OCM on orbit', clean === ocmRecords.length && clean === fixture.records.length, `${clean} records`);

const eooTarget = each(outputsOf(run.video.r, 'optical_observations')[0], (x) => EOO.getSizePrefixedRootAsEOO(x)).filter((e) => e.NORAD_CAT_ID === TARGET).length;
const reportItem = (key) => { const s = report.ITEMS.find((x) => x.startsWith(`target ${TARGET} ${key}=`)); return s === undefined ? undefined : s.slice(s.indexOf('=') + 1); };
// Values printed with `digits` decimals: a sum of squares of such values against the exact one.
const sumSqTol = (vals, digits) => vals.reduce((t, v) => t + Math.abs(v) * 10 ** -digits + (0.5 * 10 ** -digits) ** 2, 0);
const REPORT_ONLY = ['PRIOR_O_MINUS_C_MEDIAN_ARCSEC', 'OD_ITERATIONS', 'OD_MINUS_PRIOR_RTN_KM', 'SIGMA_NOISE_RTN_KM', 'IOD',
  'SEPARATION_FROM_CALIBRATOR_KM', 'RELATIVE_TO_CALIBRATOR_RTN_KM'];

for (const [i, rec] of fixture.records.entries()) {
  const o = OCM.getSizePrefixedRootAsOCM(bb(ocmRecords[i])).unpack();
  const od = o.ORBIT_DETERMINATION;
  const udp = Object.fromEntries(rec.USER_DEFINED_PARAMETERS);
  const tag = rec.MESSAGE_ID;
  check(`${tag}: STATE_DATA and COVARIANCE_DATA are the recorded bytes`, o.HEADER.MESSAGE_ID === tag &&
    f64sha(o.STATE_DATA) === rec.STATE_DATA_SHA256 && f64sha(o.COVARIANCE_DATA) === rec.COVARIANCE_DATA_SHA256 &&
    JSON.stringify(o.STATE_EPOCHS) === JSON.stringify(rec.STATE_EPOCHS));
  const seen = new Set();
  const typed = (key, ok, detail) => { seen.add(key); check(`${tag}: ${key} -> ${detail}`, ok); };

  typed('EPOCH', o.STATE_EPOCHS[0] === udp.EPOCH && od.OD_EPOCH === udp.EPOCH, `STATE_EPOCHS[0], OD_EPOCH ${od.OD_EPOCH}`);
  const [points, used, edited] = /^(\d+) points, (\d+) used, (\d+) edited$/.exec(udp.TRACK).slice(1).map(Number);
  typed('TRACK', od.OD_OBSERVATIONS_USED === used && od.OD_TRACKS_USED === 1 && od.OBS_AVAILABLE - od.OD_OBSERVATIONS_USED === edited &&
    od.OBS_AVAILABLE === eooTarget,
    `OD_OBSERVATIONS_USED ${od.OD_OBSERVATIONS_USED}, OD_TRACKS_USED ${od.OD_TRACKS_USED}, OBS_AVAILABLE ${od.OBS_AVAILABLE} (= the target's $EOO ` +
    `${eooTarget}; minus used = ${edited} edited); ${points} points with frames lacking a plate: report only`);
  typed('PRIOR', od.OD_APRIORI_DATA === udp.PRIOR, 'OD_APRIORI_DATA');
  typed('OD_RMS_ARCSEC', od.OD_RESIDUAL_RMS.toFixed(2) === udp.OD_RMS_ARCSEC, `OD_RESIDUAL_RMS ${od.OD_RESIDUAL_RMS} arcsec (${udp.OD_RMS_ARCSEC})`);
  typed('OD_CHI2_PER_DOF', (od.WEIGHTED_RMS ** 2).toFixed(3) === udp.OD_CHI2_PER_DOF, `WEIGHTED_RMS ${od.WEIGHTED_RMS}, squared ${(od.WEIGHTED_RMS ** 2).toFixed(3)} (${udp.OD_CHI2_PER_DOF})`);

  // Dropped: the total covariance is COVARIANCE_DATA (LTM; the trace is frame-free, so RTN sigmas squared sum to it).
  const c = o.COVARIANCE_DATA, diag = (k) => c[(k * (k + 3)) / 2];
  const sp = udp.SIGMA_TOTAL_RTN_KM.split(',').map(Number), sv = udp.SIGMA_TOTAL_VELOCITY_RTN_KM_S.split(',').map(Number);
  const trP = diag(0) + diag(1) + diag(2), trV = diag(3) + diag(4) + diag(5);
  const sumP = sp.reduce((t, v) => t + v * v, 0), sumV = sv.reduce((t, v) => t + v * v, 0);
  typed('SIGMA_TOTAL_RTN_KM', Math.abs(sumP - trP) <= sumSqTol(sp, 3), `dropped: COVARIANCE_DATA position trace ${trP.toFixed(6)} km**2, sigmas squared ${sumP.toFixed(6)}`);
  typed('SIGMA_TOTAL_VELOCITY_RTN_KM_S', Math.abs(sumV - trV) <= sumSqTol(sv, 6), `dropped: COVARIANCE_DATA velocity trace ${trV.toExponential(6)} km**2/s**2, sigmas squared ${sumV.toExponential(6)}`);

  // Diagnostics: no typed home in SDS 1.276.0 for this fit; the report keeps each, unchanged.
  const reportKeys = [...REPORT_ONLY, ...Object.keys(udp).filter((k) => k.startsWith('CHECK '))];
  const inReport = reportKeys.filter((k) => k in udp).every((k) => reportItem(k) === udp[k]);
  for (const k of reportKeys) seen.add(k);
  check(`${tag}: ${reportKeys.filter((k) => k in udp).length} diagnostics in the report (${REPORT_ONLY.join(', ')}, the CHECK rows)`, inReport);
  const unplaced = Object.keys(udp).filter((k) => !seen.has(k));
  check(`${tag}: every recorded key placed (${Object.keys(udp).length})`, unplaced.length === 0, unplaced.length ? unplaced : undefined);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} checks passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(failed === 0 ? 0 : 1);
