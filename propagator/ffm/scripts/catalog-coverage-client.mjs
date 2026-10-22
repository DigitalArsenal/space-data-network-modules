// ABI transport only, shared by Node CPU measurements and the real browser.
export function catalogClient(h, frames, seeds, epochJD) {
  const x = h.instance.exports, memory = x.memory ?? h.memory;
  const allocated = [];
  const copy = (array) => {
    const p = x.plugin_alloc(array.byteLength); if (!p) throw new Error('catalog allocation failed');
    allocated.push(p);
    new Uint8Array(memory.buffer, p, array.byteLength).set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    return p;
  };
  const text = p => { const b = new Uint8Array(memory.buffer); let end = p; while (b[end]) ++end; return new TextDecoder().decode(b.slice(p, end)); };
  const check = (value, expected) => { if (value !== expected) throw new Error(`${value}, expected ${expected}: ${text(x.plugin_catalog_error())}`); return value; };
  check(x.plugin_init(), 0);
  const bytes = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let at = 0; for (const frame of frames) { bytes.set(frame, at); at += frame.length; }
  check(x.plugin_configure_catalog(copy(bytes), bytes.length, copy(new Float64Array(seeds.map(s => s.bstar))), seeds.length), 0);
  const states = new Float64Array(seeds.flatMap(s => [epochJD, ...s.position, ...s.velocity]));
  const statePtr = copy(states);
  // Exercise the production ECEF seed entry. The module converts the known
  // inertial fixtures; no host rotation or velocity transport is introduced.
  for (let i = 0; i < seeds.length; ++i) {
    const ptr = statePtr + i * 56 + 8;
    const row = new Float64Array(memory.buffer, ptr, 6);
    for (let j = 0; j < 6; ++j) row[j] *= 1000;
    check(x.plugin_catalog_transform_state(epochJD, ptr, ptr, 0), 0);
  }
  check(x.plugin_init_states_ecef(statePtr, seeds.length), seeds.length);
  for (const p of allocated) x.plugin_free(p); allocated.length = 0;
  const out = copy(new Float64Array(seeds.length * 6));
  return {
    profile: () => text(x.plugin_get_profile()),
    ensure: (jd) => check(x.plugin_ensure_coverage(jd, 0, seeds.length), seeds.length),
    states: (jd) => { check(x.plugin_eval_catalog_states_gcrf(jd, out, seeds.length), seeds.length); return new Float64Array(memory.buffer, out, seeds.length * 6).slice(); },
    positions: (jd) => { check(x.plugin_eval_positions(jd, out, seeds.length), seeds.length); return new Float64Array(memory.buffer, out, seeds.length * 3).slice(); },
    memoryBytes: () => memory.buffer.byteLength,
    dispose: () => { for (const p of allocated) x.plugin_free(p); x.plugin_destroy(); },
  };
}
