#!/usr/bin/env node
// Records the module's dist OD summary $OCM on the fixture run (tests/od-summary-run.mjs) into
// tests/fixtures/od-summary.json: per record its USER_DEFINED_PARAMETERS, the SHA-256 of STATE_DATA and of
// COVARIANCE_DATA as Float64 bytes, STATE_EPOCHS; and the run's report items. Run once, on the build before
// the typed-field change; tests/typed-od.e2e.mjs reads it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sds, bb } from './s2a-run.mjs';
import { odSummaryRun, f64sha, ARCHIVE_THROUGH } from './od-summary-run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { OCM } = await sds('OCM');
const { run, report, ocmRecords } = await odSummaryRun();
const records = ocmRecords.map((bytes) => {
  const o = OCM.getSizePrefixedRootAsOCM(bb(bytes)).unpack();
  return {
    MESSAGE_ID: o.HEADER.MESSAGE_ID,
    USER_DEFINED_PARAMETERS: o.USER_DEFINED_PARAMETERS.map((p) => [p.PARAM_NAME, p.PARAM_VALUE]),
    STATE_EPOCHS: o.STATE_EPOCHS,
    STATE_DATA_SHA256: f64sha(o.STATE_DATA),
    COVARIANCE_DATA_SHA256: f64sha(o.COVARIANCE_DATA),
  };
});
const out = {
  recorded: 'the dist before the typed-field change', archiveThrough: ARCHIVE_THROUGH, gpSets: run.gp.rows.length,
  videoSha256: run.digest, iersSha256: run.eop.sha256, errorModelSha256: run.erm.sha256,
  passes: run.video.passes.map((p) => p.reason), reportReason: report.REASON, reportCount: Number(report.COUNT), reportItems: report.ITEMS, records,
};
fs.mkdirSync(path.join(HERE, 'fixtures'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'fixtures/od-summary.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log(`recorded ${records.length} $OCM, ${report.ITEMS.length} report items, ${run.gp.rows.length} GP sets through ${ARCHIVE_THROUGH}`);
