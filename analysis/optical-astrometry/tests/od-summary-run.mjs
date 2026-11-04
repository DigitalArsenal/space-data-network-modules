// The fixture run of tests/typed-od.e2e.mjs and tests/record-od-summary.mjs: the s2a video reduction
// (tests/s2a-run.mjs) on the cached inputs only, the SDN GP archive read through ARCHIVE_THROUGH so that
// the element sets, and with them the report's checks against later sets, are fixed.
import { videoRun, outputsOf, sizePrefixed, sha256 } from './s2a-run.mjs';

export const ARCHIVE_THROUGH = '2026-11-03T231700Z--2026-11-04T003200Z.json.gz';
// Float64 vector bytes as written, for a byte comparison.
export const f64sha = (v) => sha256(Buffer.from(Float64Array.from(v).buffer));

export async function odSummaryRun() {
  const run = await videoRun({ through: ARCHIVE_THROUGH, offline: true });
  await run.epochState.destroy();
  const orbit = outputsOf(run.video.r, 'orbit')[0];
  return { run, report: run.video.report, ocmRecords: [...sizePrefixed(orbit)].map((r) => Uint8Array.from(r)) };
}
