// The uncertainty_model record ($ERM, MODEL arm) from an analysis/gp-error-model
// model and its calibration labels: the regimes and age bins
// (STRATA_SETTINGS), and per stratum the RTN covariance (CLIPPED.COVARIANCE
// when the model clipped it, else COVARIANCE; km, km/s), CALIBRATION
// Calibrated where the calibration gate passed, and its reference
// (CALIBRATION_REFERENCE). The module reads it in
// src/cpp/src/plugin_invoke_bridge.cpp (empiricalModel). A model that is
// already an $ERM record (gp-error-model's typed output) is passed through.
//
// usage: node scripts/uncertainty-model.mjs <model.json | model.erm> [<calibration.json>] <out.erm>
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as flatbuffers from 'flatbuffers';
import {
  ERM, ERMAgeBinT, ERMClippedStatisticsT, ERMModelStratumT, ERMModelT, ERMRegimeT, ERMStrataSettingsT, ERMT, covarianceCalibration,
} from '../src/js/sds/ERM.mjs';

export const isErm = (bytes) => bytes?.length >= 8 && ERM.bufferHasIdentifier(new flatbuffers.ByteBuffer(bytes));

export function uncertaintyModelFrame(model, calibration = null, label = '') {
  if (model instanceof Uint8Array) {
    if (!isErm(model) || !ERM.getRootAsERM(new flatbuffers.ByteBuffer(model)).MODEL()) throw new Error('model must be an $ERM MODEL');
    return model;
  }
  if (model?.kind !== 'gp-error-model') throw new Error('model must be a gp-error-model');
  const labels = new Map((calibration?.strata ?? []).map((s) => [`${s.regimeIndex}/${s.ageIndex}`, s]));
  const settings = new ERMStrataSettingsT();
  settings.REGIMES = model.regimes.map((r) => Object.assign(new ERMRegimeT(), {
    ID: r.id ?? null, ALTITUDE_MIN_KM: r.altitudeKm[0], ALTITUDE_MAX_KM: r.altitudeKm[1],
    ECCENTRICITY_MIN: r.eccentricity[0], ECCENTRICITY_MAX: r.eccentricity[1] }));
  settings.AGE_BINS = model.ageBinsDays.map(([lo, hi]) => Object.assign(new ERMAgeBinT(), { MIN_DAYS: lo, MAX_DAYS: hi }));
  const m = new ERMModelT();
  m.LABEL = label;
  m.STRATA_SETTINGS = settings;
  m.STRATA = model.strata.map((s) => {
    const t = Object.assign(new ERMModelStratumT(), { REGIME_INDEX: s.regimeIndex, AGE_INDEX: s.ageIndex, COVARIANCE: s.covariance ?? [] });
    if (s.clipped?.covariance) t.CLIPPED = Object.assign(new ERMClippedStatisticsT(), { COVARIANCE: s.clipped.covariance });
    const gate = labels.get(`${s.regimeIndex}/${s.ageIndex}`);
    if (gate?.label === 'CALIBRATED') {
      t.CALIBRATION = covarianceCalibration.Calibrated;
      t.CALIBRATION_REFERENCE = gate.reference ?? '';
    }
    return t;
  });
  const erm = new ERMT();
  erm.MODEL = m;
  const b = new flatbuffers.Builder(4096);
  b.finish(erm.pack(b), '$ERM');
  return b.asUint8Array().slice();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length < 2) throw new Error('usage: uncertainty-model.mjs <model.json | model.erm> [<calibration.json>] <out.erm>');
  const out = args.pop();
  const raw = new Uint8Array(fs.readFileSync(args[0]));
  const model = isErm(raw) ? raw : JSON.parse(new TextDecoder().decode(raw));
  const calibration = args[1] ? JSON.parse(fs.readFileSync(args[1], 'utf8')) : null;
  const label = `${args[0]}${calibration ? `; calibration ${args[1]}` : ''}`;
  fs.writeFileSync(out, uncertaintyModelFrame(model, calibration, label));
  console.log(`${out}: $ERM MODEL${isErm(raw) ? ' (passed through)' : `, ${model.strata.length} strata, ${(calibration?.strata ?? []).filter((s) => s.label === 'CALIBRATED').length} calibrated`}`);
}
