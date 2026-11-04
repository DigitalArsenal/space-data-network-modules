#!/usr/bin/env node
// E2E (optical-video-to-obs-od-20261018): s2a systems' time-lapse of
// ICEYE-X36 (NORAD 59103) and COSMOS 2612 (NORAD 68762) over South America,
// 2026-10-18 07:27:22-07:29:22 UTC (x.com/s2a_systems/status/2111745395747361049),
// through the modules as a node would run them:
//
//   the video (H.264, 1076x720, 239 frames) -> ffmpeg -> PGM frames -> $FIL
//   GP history (the SDN archive, Space-Track gp_history) -> $OMM
//   IERS finals2000A.daily -> data-source/eop-parser -> $EOP
//   analysis/gp-error-model's model (docs/model-2026-08.json, the RPO lane's) -> $ERM
//   analysis/optical-astrometry reduce, its propagator query port answered by
//     analysis/epoch-state (SGP4) and its catalog cones by Gaia DR3 (ESA TAP)
//     -> $TDM, $EOO, $SKI, $OCM, $OEM
//   analysis/od fit on the orbit's $OEM -> $OMM (the OD as mean elements)
//   analysis/rpo-history characterize: COSMOS 2612 from the OD, from its prior
//     set and from the next published set (truth), relative to ICEYE-X36
//   the FITS path: every frame written as FITS (burnt-in overlays removed)
//     with DATE-OBS (the solved exposure start), EXPTIME and the solved
//     site, reduced again with the site known: the time bias must come back zero
//
// and checks the result against independent evidence: the frame cadence,
// the plate residuals, the calibrator's observed-minus-computed, and the
// COSMOS 2612 orbit against the NEXT Space-Track element set (published after
// the video; pending when not yet in the archive).
//
// Space-Track data are read from the archive at run time and never written
// into the repository; the video, Gaia cones and IERS file are cached outside
// it; the evidence goes to tests/out (ignored by git).
//
//   S2A_VIDEO            the video file (else the cache, else downloaded)
//   SDN_OPTICAL_CACHE    cache directory (~/.cache/sdn-optical-astrometry)
//   SDN_GP_ARCHIVE       gp_history by-creation root (/opt/data/sdn-archive/spacetrack/gp_history/by-creation)
//   OPTICAL_E2E_OUT      evidence directory (tests/out)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CALIBRATOR, TARGET, FIRST_FRAME, CONFIG, VIDEO_SHA256, T, iso, sds, bb, each, one, ommRecord, filRecord, stream, loadModule, outputsOf,
  answered, reduceAll, videoRun, TYPE,
} from './s2a-run.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OPTICAL_E2E_OUT ?? path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });
const [OMM, TDM, EOO, SKI, OCM] = await Promise.all(['OMM', 'TDM', 'EOO', 'SKI', 'OCM'].map(sds));

const results = [];
let failures = 0;
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
}
const note = (line) => { results.push({ note: line }); console.log(`      ${line}`); };

const item = (report, prefix) => report.ITEMS.find((s) => s.startsWith(prefix)) ?? '';
const field = (text, key) => { const m = new RegExp(`${key}=([^ ]+)`).exec(text); return m ? m[1] : undefined; };
const nums = (text) => (text ?? '').split(',').map(Number);
const targetItem = (report, key) => { const s = item(report, `target ${TARGET} ${key}=`); return s.slice(s.indexOf('=') + 1); };

// ── the run ────────────────────────────────────────────────────────────────
const t0 = Date.now();
const { digest, frames, gp, eop, erm, base, epochState, video } = await videoRun();
check('video: the published 1076x720 variant', digest === VIDEO_SHA256, `sha256 ${digest}`);
check('video: 239 frames decoded by ffmpeg', frames.length === 239, `${frames.length} frames`);
note(`GP sets: ${gp.rows.length} of NORAD ${CALIBRATOR} and ${TARGET} with EPOCH from 2026-10-15, ${gp.files} archive files through ${gp.newest}`);
note(`EOP: ${eop.rows} IERS finals2000A rows within 4 d; error model ${erm.id} (sha256 ${erm.sha256.slice(0, 16)})`);
note(`passes: ${video.passes.map((p) => `${p.reason}(${p.count}, ${p.seconds.toFixed(1)} s)`).join(' -> ')}`);
const rep = video.report;
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(rep.ITEMS, null, 1));

// 1. Timing.
const timing = item(rep, 'timing=');
const cadence = Number(field(timing, 'cadence_s').split('+-')[0]);
check('timing: every frame time read from the overlay, on the cadence line', field(timing, 'decoded') === '239/239' && field(timing, 'outliers') === '0' &&
  Math.abs(cadence - 0.5002) < 0.001 && Number(field(timing, 'jitter_rms_ms')) < 2, timing);

// 2. Plates.
const plates = item(rep, 'plates ');
const solved = Number(field(plates, 'solved').split('/')[0]);
const plateMedian = Number(field(plates, 'median_residual_arcsec'));
check('plates: median star residual <= 5 arcsec, >= 150 of 239 frames solved', plateMedian <= 5 && solved >= 150, plates);
note(item(rep, 'unsolved_frames='));

// 3. Site and timing from the calibrator.
const site = item(rep, 'site ');
note(site);
note(item(rep, 'time_bias_s='));
const calib = item(rep, 'calibrator ');
const calChi2 = Number(field(calib, 'chi2_per_dof'));
check('calibrator ICEYE-X36: observed-minus-computed consistent with the stated uncertainty (chi2/dof <= 2)', calChi2 > 0 && calChi2 <= 2 &&
  Number(field(calib, 'fit_rms_arcsec')) <= 5, calib);

// 4. The COSMOS 2612 orbit (its $OCM's ORBIT_DETERMINATION).
const orbitOd = (r) => each(outputsOf(r, 'orbit')[0], (x) => OCM.OCM.getSizePrefixedRootAsOCM(x)).find((o) => o.METADATA.OBJECT_DESIGNATOR === String(TARGET))?.ORBIT_DETERMINATION;
const tOd = orbitOd(video.r);
const odRms = tOd.OD_RESIDUAL_RMS, odChi2 = tOd.WEIGHTED_RMS ** 2;
check('COSMOS 2612 OD: residual rms <= 5 arcsec, chi2/dof <= 2', odRms <= 5 && odChi2 <= 2,
  `rms ${odRms.toFixed(2)} arcsec, chi2/dof ${odChi2.toFixed(3)}; ${tOd.OBS_AVAILABLE} observations, ${tOd.OD_OBSERVATIONS_USED} used`);
for (const k of ['PRIOR', 'PRIOR_O_MINUS_C_MEDIAN_ARCSEC', 'OD_MINUS_PRIOR_RTN_KM', 'SIGMA_TOTAL_RTN_KM', 'IOD', 'SEPARATION_FROM_CALIBRATOR_KM']) note(`${k}: ${targetItem(rep, k)}`);
const tLast = T(FIRST_FRAME) + 120;
const checks = rep.ITEMS.filter((s) => s.startsWith(`target ${TARGET} CHECK `)).map((s) => {
  const epoch = T(/EPOCH (\S+)/.exec(s)[1]);
  return { text: s, epoch, d2od: Number(/d2 \(3 dof\) OD ([\d.eE+-]+|nan)/.exec(s)?.[1]), d2prior: Number(/prior ([\d.eE+-]+|nan)$/.exec(s)?.[1]),
    od: nums(/OD-set RTN km ([^ ]+)/.exec(s)?.[1]), prior: nums(/prior-set RTN km ([^ ]+)/.exec(s)?.[1]) };
});
const truth = checks.filter((c) => c.epoch > tLast).sort((a, b) => a.epoch - b.epoch)[0];
let truthSummary = 'pending: no COSMOS 2612 element set after the video in the archive yet';
if (truth) {
  const mag = (v) => Math.hypot(...v);
  truthSummary = truth.text;
  check('COSMOS 2612 OD against the NEXT Space-Track set (truth): consistent (d2 <= 11.34, 99% for 3 dof) and closer than the prior',
    truth.d2od <= 11.34 && mag(truth.od) < mag(truth.prior), `OD-truth RTN km ${truth.od.join(',')} (d2 ${truth.d2od}); prior-truth ${truth.prior.join(',')} (d2 ${truth.d2prior})`);
} else note(truthSummary);

// 5. The products decode as SDS.
const tdm = TDM.TDM.getRootAsTDM(bb(outputsOf(video.r, 'observations')[0])).unpack();
const eoos = each(outputsOf(video.r, 'optical_observations')[0], (x) => EOO.EOO.getSizePrefixedRootAsEOO(x));
const skis = each(outputsOf(video.r, 'plates')[0], (x) => SKI.SKI.getSizePrefixedRootAsSKI(x));
const ocms = each(outputsOf(video.r, 'orbit')[0], (x) => OCM.OCM.getSizePrefixedRootAsOCM(x));
const tdmRows = tdm.SEGMENTS.reduce((n, s) => n + s.OBSERVATIONS.length, 0);
check('products: TDM RADEC segments, one EOO per angle pair, one SKI per solved frame, one OCM', tdm.SEGMENTS.length === 2 &&
  tdm.SEGMENTS.every((s) => s.ANGLE_TYPE === 'RADEC' && s.REFERENCE_FRAME === 'GCRF' && s.TIMETAG_REF === 'RECEIVE') &&
  tdmRows === 2 * eoos.length && eoos.length === Number(rep.COUNT) && skis.length === solved && ocms.length === 1 &&
  ocms[0].COVARIANCE_DATA.length === 21 && eoos.every((e) => e.RA_UNC > 0 && e.DECLINATION_UNC > 0),
  `TDM segments ${tdm.SEGMENTS.map((s) => `${s.PARTICIPANT_2}:${s.OBSERVATIONS.length / 2}`).join(' ')}, EOO ${eoos.length}, SKI ${skis.length}, OCM ${ocms.length}`);
const raUnc = eoos.filter((e) => e.NORAD_CAT_ID === TARGET).map((e) => e.DECLINATION_UNC * 3600).sort((a, b) => a - b);
note(`COSMOS 2612 per-point declination 1-sigma median ${raUnc[raUnc.length >> 1].toFixed(2)} arcsec`);

// 6. analysis/od: the orbit's trajectory as mean elements.
const trajectory = outputsOf(video.r, 'orbit_trajectory')[0];
const od = await loadModule('analysis/od', { dataSource: 's2a-video-optical', noradCatId: TARGET });
const fit = await od.invoke('fit', [{ portId: 'oem', payload: trajectory, typeRef: TYPE.OEM }]);
await od.destroy();
const odOmm = outputsOf(fit, 'omm')[0];
const odSet = one(odOmm, OMM.OMM, 'OMM');
const obd = outputsOf(fit, 'obd')[0];
const { OBD } = await sds('OBD');
const obdRec = obd ? one(obd, OBD, 'OBD') : null;
check('analysis/od: mean elements fitted to the orbit trajectory (fit rms < 0.1 km)', odOmm && obdRec && obdRec.WRMS < 0.1,
  `EPOCH ${odSet.EPOCH} n ${odSet.MEAN_MOTION} e ${odSet.ECCENTRICITY}; WRMS ${obdRec?.WRMS} km`);

// 7. analysis/rpo-history: COSMOS 2612 relative to ICEYE-X36 after the pass, from the OD, the prior and the truth.
const calSet = gp.rows.filter((r) => Number(r.NORAD_CAT_ID) === CALIBRATOR).sort((a, b) => Math.abs(T(a.EPOCH) - T(FIRST_FRAME)) - Math.abs(T(b.EPOCH) - T(FIRST_FRAME)))[0];
const priorRow = gp.rows.filter((r) => Number(r.NORAD_CAT_ID) === TARGET && T(r.EPOCH) <= T(FIRST_FRAME) && T(r.CREATION_DATE) <= T(FIRST_FRAME)).at(-1);
const truthRow = truth ? gp.rows.filter((r) => Number(r.NORAD_CAT_ID) === TARGET && Math.abs(T(r.EPOCH) - truth.epoch) < 1).at(-1) : null;
const startS = Math.ceil(Math.max(T(calSet.EPOCH), T(odSet.EPOCH), truthRow ? T(truthRow.EPOCH) : 0) / 10) * 10;
async function rpoRange(chaserRecord) {
  const rpo = await loadModule('analysis/rpo-history', { rpo: {
    chaser: String(TARGET), target: String(CALIBRATOR), start: iso(startS), stop: iso(startS + 1800), step_seconds: 10, projection_hours: 0, hindcast: false, calibration_days: 0 } });
  const el = stream([chaserRecord, ommRecord(calSet)]);
  const inputs = [{ portId: 'element_sets', payload: el, typeRef: TYPE.OMM }];
  const first = await rpo.invoke('characterize', inputs);
  const second = await rpo.invoke('characterize', [...inputs, ...(await answered(epochState, outputsOf(first, 'propagation_requests')[0], el))]);
  await rpo.destroy();
  const rows = [];
  for (const rec of each(outputsOf(second, 'geometry')[0], (x) => OCM.OCM.getSizePrefixedRootAsOCM(x))) {
    const g = rec.RPO_GEOMETRY, start = T(rec.METADATA.START_TIME);
    for (let i = 0; i < g.SEPARATION_KM.length; i++) rows.push({ t: start + i * rec.STATE_STEP_SIZE, sep: g.SEPARATION_KM[i], r: g.R_KM[i], it: g.I_KM[i], c: g.C_KM[i] });
  }
  return rows;
}
const fromOd = await rpoRange(odOmm), fromPrior = await rpoRange(ommRecord(priorRow));
const fromTruth = truthRow ? await rpoRange(ommRecord(truthRow)) : null;
const at0 = (rows) => rows[0];
note(`RPO ${iso(startS)}: separation from ICEYE-X36 ${at0(fromOd).sep.toFixed(3)} km (OD; R,I,C ${at0(fromOd).r.toFixed(3)},${at0(fromOd).it.toFixed(3)},${at0(fromOd).c.toFixed(3)}), ` +
  `${at0(fromPrior).sep.toFixed(3)} km (prior)${fromTruth ? `, ${at0(fromTruth).sep.toFixed(3)} km (truth)` : ''}`);
if (fromTruth) {
  const rms = (a) => Math.sqrt(a.reduce((s, row, i) => s + (row.sep - fromTruth[i].sep) ** 2, 0) / a.length);
  check('rpo-history: separation series from the OD closer to the truth set than the prior set over 30 min', rms(fromOd) < rms(fromPrior),
    `rms vs truth: OD ${rms(fromOd).toFixed(3)} km, prior ${rms(fromPrior).toFixed(3)} km over ${fromOd.length} samples`);
}

// 8. The FITS path: every frame with DATE-OBS (the solved exposure start), EXPTIME and the solved site.
const lat = Number(field(site, 'lat_deg')), lon = Number(field(site, 'lon_deg')), h = Number(field(site, 'height_m'));
const exposure = Number(item(rep, 'exposure_s=').split('=')[1]);
const card = (k, v) => `${k.padEnd(8)}= ${typeof v === 'string' ? `'${v}'`.padEnd(20) : (v === true ? 'T' : String(v)).padStart(20)}`.padEnd(80);
// An instrument frame carries no burnt-in overlays: the time's box (from the
// video run, 4 px margin) and the s2a logo (bottom right of this video) are
// filled with the frame's median level.
const box = nums(field(timing, 'overlay_box_px'));
const LOGO = [880, 662, 1075, 712];
function fits(pgm, cards) {
  const text = pgm.subarray(0, 32).toString('latin1');
  const m = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(text);
  const w = Number(m[1]), hgt = Number(m[2]), data = Buffer.from(pgm.subarray(m[0].length, m[0].length + w * hgt));
  const level = [...data.subarray(0, data.length).filter((_, i) => i % 97 === 0)].sort((a, b) => a - b)[0 | (data.length / 97 / 2)];
  for (const [x0, y0, x1, y1] of [[box[0] - 4, box[1] - 4, box[2] + 4, box[3] + 4], LOGO])
    for (let y = Math.max(0, y0); y <= Math.min(hgt - 1, y1); y++) data.fill(level, y * w + Math.max(0, x0), y * w + Math.min(w, x1 + 1));
  let head = [card('SIMPLE', true), card('BITPIX', 8), card('NAXIS', 2), card('NAXIS1', w), card('NAXIS2', hgt), ...cards, 'END'.padEnd(80)].join('');
  head = head.padEnd(Math.ceil(head.length / 2880) * 2880, ' ');
  const body = Buffer.alloc(Math.ceil(data.length / 2880) * 2880);
  data.copy(body);
  return Buffer.concat([Buffer.from(head, 'latin1'), body]);
}
// Exposure starts: frame 0's solved start plus the overlay's cadence (jitter 0.3 ms).
const start0 = T(skis.find((s) => s.SEQUENCE_ID === 0).EXP_START_TIME);
const fitsInputs = frames.map((f, i) => {
  const bytes = fits(f.bytes, [card('DATE-OBS', iso(start0 + i * cadence).replace('Z', '')), card('EXPTIME', exposure), card('SITELAT', lat), card('SITELONG', lon), card('SITEELEV', h)]);
  return { portId: 'frames', payload: filRecord(f.name.replace('.pgm', '.fits'), 'image/fits', bytes), typeRef: TYPE.FIL };
});
const { search_latitude_deg: _a, search_longitude_deg: _o, ...known } = CONFIG;
const fitsRun = await reduceAll(epochState, fitsInputs, { ...known, time_reference: 'start' }, base, video.catalog);
const fr = fitsRun.report;
const fPlates = item(fr, 'plates '), fBias = item(fr, 'time_bias_s='), fCal = item(fr, 'calibrator ');
const bias = nums(fBias.split('=')[1].split(' ')[0].replace('+-', ','));
const fOd = orbitOd(fitsRun.r).OD_RESIDUAL_RMS;
check('FITS path: DATE-OBS frames reduce with the site from the headers; the time bias comes back zero', item(fr, 'timing=').includes('FITS DATE-OBS') &&
  item(fr, 'site ').includes('given') && Number(field(fPlates, 'median_residual_arcsec')) <= 5 && Math.abs(bias[0]) <= 3 * bias[1] + 0.01 &&
  Number(field(fCal, 'chi2_per_dof')) <= 2 && fOd <= 5, `${fitsInputs.length} FITS frames; ${fPlates.split(' scale')[0]}; ${fBias}; calibrator chi2/dof ${field(fCal, 'chi2_per_dof')}; COSMOS 2612 OD rms ${fOd.toFixed(2)} arcsec`);
await epochState.destroy();

fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify({ results, passes: video.passes, fitsPasses: fitsRun.passes, truth: truthSummary,
  rpo: { start: iso(startS), od: at0(fromOd), prior: at0(fromPrior), truth: fromTruth ? at0(fromTruth) : null } }, null, 1));
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${results.filter((r) => r.ok).length} checks passed, ${failures} failed (${((Date.now() - t0) / 1000).toFixed(0)} s); evidence in ${path.relative(process.cwd(), OUT)}`);
process.exit(failures === 0 ? 0 : 1);
