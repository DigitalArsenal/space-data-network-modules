// Browser-worker portion of the single band-vs-gaia E2E: IO and assertions only.
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {encodeRequest, decodeResult} from '../codec.js';

const report = {checks: [], lines: []};
function check(name, ok, detail = '') { report.checks.push({name, ok: Boolean(ok), detail}); }
function same(actual, expected) { return JSON.stringify(actual) === JSON.stringify(expected); }
function validLayout(harness, name, layout, expected) {
  check(`${name} typed layout`, Array.isArray(layout) && same(layout.slice(2), expected), JSON.stringify(layout));
  check(`${name} complete storage`, layout?.[1] === 16777216, `bytes=${layout?.[1]}`);
  check(`${name} SAB bounds`, Number.isInteger(layout?.[0]) && layout[0] > 0 && layout[1] > 0 &&
    layout[0] + layout[1] <= harness.memory.buffer.byteLength, JSON.stringify(layout));
  if (layout?.[0] > 0 && layout[1] > 0) {
    const bytes = new Uint8Array(harness.memory.buffer, layout[0], layout[1]);
    check(`${name} contains baked data`, bytes.some(value => value !== 0));
  }
}
export async function runE2E(runtime) {
  const {plan, wasm, progress} = runtime;
  await progress('worker started');
  check('browser cross-origin isolation', runtime.browser && globalThis.crossOriginIsolated && typeof SharedArrayBuffer === 'function',
    runtime.browser ? '' : 'Browser unavailable; Node diagnostic fallback cannot certify browser acceptance.');
  const harness = await createBrowserModuleHarness({wasmSource: wasm, surface: 'direct',
    ...(runtime.browser ? {wasiThreadWorkerUrl: new URL('/wasi-worker.js', location.href).href} : {}),
    enableBrowserWasiThreads: true, wasiThreadPoolSize: 4, maxThreads: 4});
  await progress('WASM and pthread pool ready');
  check('WASM shared memory', harness.memory.buffer instanceof SharedArrayBuffer);
  async function invoke(method, values = {}) {
    await progress(method);
    const response = await harness.invoke(encodeRequest(method, values));
    if (response.statusCode !== 0) throw new Error(`${method}: ${response.errorCode}: ${response.errorMessage}`);
    if (response.outputs.length !== 1 || response.outputs[0].portId !== 'result') throw new Error(`${method}: expected one SDS result frame`);
    return decodeResult(response.outputs[0].payload);
  }
  try {
    const legacy = await invoke('bake_legacy');
    validLayout(harness, 'legacy global RGBA16F', legacy.global_layout, [256, 256, 32, 4, 2]);
    validLayout(harness, 'legacy local RGBA16F', legacy.local_layout, [128, 128, 128, 4, 2]);
    const parity = await invoke('verify_legacy');
    report.legacy = parity;
    // Source: OrbPro GalaxyFS.glsl, J2000 Galactic basis, static model. Error in
    // dimensionless tone-mapped RGB. Limits budget RGBA16F trilinear baking of
    // a 0.1-kpc dust layer onto 32 rectilinear global z samples.
    // The global signed-square z axis preserves dimensions and extent; physical
    // z-coordinate products are required for interpolation. Limits unchanged.
    check('legacy shader parity maximum', parity.max_error <= 0.08, `error=${parity.max_error}, tolerance=0.08`);
    check('legacy shader parity RMS', parity.rms_error <= 0.015, `error=${parity.rms_error}, tolerance=0.015`);
    check('legacy all-sky sample coverage', parity.samples === 777600, `samples=${parity.samples}`);
    report.lines.push(`Legacy 0.5-degree sky: max=${parity.max_error}, RMS=${parity.rms_error}, samples=${parity.samples}`);
    if (plan.legacyOnly) return report;

    const bake = await invoke('bake');
    validLayout(harness, 'global RGBA16F', bake.global_layout, [256, 256, 32, 4, 2]);
    validLayout(harness, 'local RGBA16F', bake.local_layout, [128, 128, 128, 4, 2]);
    check('explicit rectilinear global z', bake.global_z_mapping === 1 && bake.global_z_coordinates?.length === 32);
    check('uniform local z', bake.local_z_mapping === 0 && bake.local_z_coordinates?.length === 128);
    check('global domain kpc', same(bake.global_bounds, [-16, -16, -3, 16, 16, 3]), JSON.stringify(bake.global_bounds));
    check('model label', bake.label === 'model', bake.label);
    check('detail tile layout', Array.isArray(bake.noise_layout) && bake.noise_layout.length === 7 &&
      bake.noise_layout[0] > 0 && bake.noise_layout[1] > 0, JSON.stringify(bake.noise_layout));
    const counts = {spawned: harness.threadHost?.spawnCount() ?? 0,
      workers: harness.threadHost?.distinctOsThreadCount() ?? 0};
    check('real WASI pthread workers', counts.spawned > 0 && counts.workers > 0, JSON.stringify(counts));
    report.threads = counts;

    // Closed-form extinction oracle: integral along zero path is exactly zero.
    // Sun from task's R0=8.178 kpc and z_sun=20.8 pc; tolerance 1e-12 mag
    // allows scalar serialization only. Static J2000 Galactic frame.
    const extinction = await invoke('extinction', {points: [-8.178, 0, 0.0208, -8, 0, 0.0208, -7, 0, 0.0208]});
    check('zero-path A_G closed form', extinction.a_g?.[0] === 0, JSON.stringify(extinction));
    check('zero-path E(BP-RP) closed form', extinction.e_bp_rp?.[0] === 0, JSON.stringify(extinction));
    check('extinction monotonic positive path', extinction.a_g?.[1] > 0 && extinction.a_g[2] > extinction.a_g[1], JSON.stringify(extinction));
    check('reddening positive path', extinction.e_bp_rp?.[1] > 0 && extinction.e_bp_rp[2] > extinction.e_bp_rp[1]);
    const sample = {bounds: [-9, -1, -0.5, -7, 1, 0.5], seed: 314159, candidates: 512, completeness: 0, tier_limit_g: 100};
    const stars = await invoke('sample_stars', sample);
    const repeat = await invoke('sample_stars', sample);
    const complete = await invoke('sample_stars', {...sample, completeness: 1});
    check('deterministic statistical stars', same(stars, repeat));
    check('typed statistical star layout', stars.count > 0 && stars.stars?.length === stars.count * 7, `count=${stars.count}`);
    check('statistical star values finite', stars.stars?.every(Number.isFinite));
    check('statistical stars identified as model', stars.label === 'model' && stars.pickable === 0);
    check('complete catalog suppresses statistical stars', complete.count === 0 && complete.stars?.length === 0, JSON.stringify(complete));
    report.lines.push(`Volume/SAB, pthreads=${counts.spawned}, extinction, deterministic stars=${stars.count}, complete-catalog stars=${complete.count}`);

    const pointers = [];
    async function loadImage(source) {
      const {width, height, pixels} = await runtime.loadImage(source);
      check(`${source.id} oracle dimensions`, width === source.width && height === source.height);
      const pointer = harness.instance.exports.plugin_alloc(pixels.byteLength);
      if (!pointer) throw new Error(`Cannot allocate ${source.id} pixel input`);
      pointers.push(pointer);
      new Uint8Array(harness.memory.buffer, pointer, pixels.byteLength).set(pixels);
      return [pointer, width, height, 4];
    }
    let metrics;
    try {
      const flux_image = await loadImage(plan.maps.find(source => source.id === 'flux'));
      const density_image = await loadImage(plan.maps.find(source => source.id === 'density'));
      // Run-three: never calibrate physical parameters against this oracle.
      metrics = await invoke('oracle_metrics', {flux_image, density_image});
      report.lines.push('No Gaia dust recalibration performed (run-three decision).');
    } finally { for (const pointer of pointers) harness.instance.exports.plugin_free(pointer); }
    report.calibration = metrics;
    // Evidence image (IO only): the fitted model sky over the oracle flux
    // map on the same 0.5-degree Galactic grid, log-stretched alike.
    if (typeof OffscreenCanvas === 'function' && metrics.sky_layout?.[0] > 0 && metrics.flux_layout?.[0] > 0) {
      const model = new Float32Array(harness.memory.buffer, metrics.sky_layout[0], 720 * 360);
      const flux = new Float32Array(harness.memory.buffer, metrics.flux_layout[0], 720 * 360);
      const canvas = new OffscreenCanvas(720, 720);
      const context = canvas.getContext('2d');
      const image = context.createImageData(720, 720);
      const put = (values, rowOffset, transform) => {
        const stretched = Array.from(values, (v) => (Number.isFinite(v) && v > 0 ? Math.log(transform(v)) : NaN));
        const finite = stretched.filter(Number.isFinite).sort((a, b) => a - b);
        const low = finite[Math.floor(finite.length * 0.02)], high = finite[Math.floor(finite.length * 0.995)];
        for (let i = 0; i < stretched.length; i++) {
          const code = Number.isFinite(stretched[i]) ? Math.max(0, Math.min(255, Math.round(255 * (stretched[i] - low) / (high - low)))) : 0;
          const o = (rowOffset * 720 + i) * 4;
          image.data[o] = image.data[o + 1] = image.data[o + 2] = code;
          image.data[o + 3] = 255;
        }
      };
      put(model, 0, (v) => Math.exp(metrics.fit_intercept + metrics.fit_scale * Math.log(v)));
      put(flux, 360, (v) => v);
      context.putImageData(image, 0, 0);
      const blob = await canvas.convertToBlob({type: 'image/png'});
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      report.skyPng = btoa(binary);
    }
    check('Gaia flux log-intensity Pearson r', metrics.flux_r >= 0.85, `r=${metrics.flux_r}, required>=0.85`);
    check('Gaia density log-intensity Pearson r', metrics.density_r >= 0.75, `r=${metrics.density_r}, required>=0.75`);
    check('four longitude FWHM comparisons', metrics.fwhm_relative_errors?.length === 4);
    for (const [index, longitude] of [0, 90, 180, 270].entries()) {
      check(`latitude FWHM at l=${longitude}`, metrics.fwhm_relative_errors?.[index] <= 0.25,
        `relative error=${metrics.fwhm_relative_errors?.[index]}, model=${metrics.fwhm_model?.[index]}, oracle=${metrics.fwhm_flux?.[index]} deg`);
    }
    check('Great Rift dip', metrics.rift_ratio > 0 && metrics.rift_ratio < 1, `ratio=${metrics.rift_ratio}`);
    report.lines.push(`Gaia display-map log r: flux=${metrics.flux_r}, density=${metrics.density_r}; FWHM errors=${JSON.stringify(metrics.fwhm_relative_errors)}; Rift=${metrics.rift_ratio}`);
    report.lines.push(`Calibration: log-slope=${metrics.fit_scale}, intercept=${metrics.fit_intercept}, log-RMS=${metrics.fit_log_rmse}; display map, not linear photometry`);
    const masers = plan.masers.records.flatMap(record => [record.longitude, record.latitude, record.parallax, record.arm]);
    const ridges = await invoke('ridge_metrics', {masers,
      parallax_errors: plan.masers.records.map(record => record.parallaxError),
      maser_segments: plan.masers.records.map(record => record.segment),
      maser_excluded: plan.masers.records.map(record => record.exclusion ? 1 : 0),
      published_arms: plan.reidOracle.rows.flat()});
    report.ridges = ridges;
    check('complete assigned maser sample', ridges.count === plan.masers.records.length, `count=${ridges.count}`);
    check('all named paper exclusions resolved', ridges.paper_exclusions === plan.reidOracle.exclusions.length);
    check('all parallax uncertainties propagated in WASM',
      ridges.perpendicular_measurement_sigma?.length === plan.masers.records.length &&
      ridges.perpendicular_measurement_sigma.every(value => Number.isFinite(value) && value >= 0));
    for (const [index, name] of plan.reidOracle.armNames.entries()) {
      check(`Reid Table 2 curve: ${name}`, ridges.curve_max_errors?.[index] <= 1e-6,
        `max error=${ridges.curve_max_errors?.[index]} kpc`);
      check(`Reid per-arm chi-square: ${name}`, ridges.arm_counts?.[index] > 0 &&
        ridges.arm_chi2_nu?.[index] <= 2.0,
        `n=${ridges.arm_counts?.[index]}, RMS=${ridges.arm_rms?.[index]} kpc, chi2_nu=${ridges.arm_chi2_nu?.[index]}, limit=2`);
    }
    report.lines.push(`Reid masers: n=${ridges.count}, unresolved=${ridges.missing}, max=${ridges.max} kpc, RMS=${ridges.rms} kpc, within0.3=${ridges.within_fraction}; excluded codes=${JSON.stringify(plan.masers.excluded)}`);
  } catch (error) { report.error = error.stack ?? String(error); }
  finally { await harness.destroy(); }
  return report;
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  (async () => runE2E({browser: true,
    plan: await (await fetch('/plan')).json(),
    wasm: new Uint8Array(await (await fetch('/module.wasm')).arrayBuffer()),
    progress: body => fetch('/progress', {method: 'POST', body}),
    async loadImage(source) {
      const response = await fetch(`/oracle/${source.file}`);
      if (!response.ok) throw new Error(`Missing offline oracle ${source.file}`);
      const bitmap = await createImageBitmap(await response.blob(), {colorSpaceConversion: 'none', premultiplyAlpha: 'none'});
      const {width, height} = bitmap;
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', {willReadFrequently: true, colorSpace: 'srgb'});
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, width, height).data;
      bitmap.close();
      return {width, height, pixels};
    },
  }))().catch(error => { report.error = error.stack ?? String(error); }).finally(async () => {
    await fetch('/done', {method: 'POST', body: JSON.stringify(report)});
  });
}
