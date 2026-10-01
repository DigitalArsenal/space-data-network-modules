// The uncertainty_model frame (CAU1) from an analysis/gp-error-model model
// and its calibration labels: regimes, age bins, and per stratum the clipped
// RTN covariance (km, km/s), whether the calibration gate passed and its
// reference. Layout in src/cpp/src/plugin_invoke_bridge.cpp.
//
// usage: node scripts/uncertainty-model.mjs <model.json> [<calibration.json>] <out.cau1>
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function uncertaintyModelFrame(model, calibration = null, label = '') {
  if (model?.kind !== 'gp-error-model') throw new Error('model must be a gp-error-model');
  const parts = [];
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); parts.push(b); };
  const f64 = (v) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); parts.push(b); };
  const text = (s) => { const b = Buffer.from(s, 'utf8'); u32(b.length); parts.push(b, Buffer.alloc((4 - (b.length % 4)) % 4)); };
  parts.push(Buffer.from('CAU1'));
  text(label);
  u32(model.regimes.length);
  for (const r of model.regimes) [r.altitudeKm[0], r.altitudeKm[1], r.eccentricity[0], r.eccentricity[1]].forEach((x) => f64(Math.min(x, 1e300)));
  u32(model.ageBinsDays.length);
  for (const [lo, hi] of model.ageBinsDays) { f64(lo); f64(hi); }
  const labels = new Map((calibration?.strata ?? []).map((s) => [`${s.regimeIndex}/${s.ageIndex}`, s]));
  const strata = model.strata.filter((s) => (s.clipped?.covariance ?? s.covariance)?.length === 21);
  u32(strata.length);
  for (const s of strata) {
    u32(s.regimeIndex);
    u32(s.ageIndex);
    (s.clipped?.covariance ?? s.covariance).forEach(f64);
    const gate = labels.get(`${s.regimeIndex}/${s.ageIndex}`);
    u32(gate?.label === 'CALIBRATED' ? 1 : 0);
    text(gate?.label === 'CALIBRATED' ? gate.reference : '');
  }
  return Buffer.concat(parts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length < 2) throw new Error('usage: uncertainty-model.mjs <model.json> [<calibration.json>] <out.cau1>');
  const out = args.pop();
  const [model, calibration] = args.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const label = `${args[0]}${calibration ? `; calibration ${args[1]}` : ''}`;
  fs.writeFileSync(out, uncertaintyModelFrame(model, calibration, label));
  console.log(`${out}: ${model.strata.length} strata, ${(calibration?.strata ?? []).filter((s) => s.label === 'CALIBRATED').length} calibrated`);
}
