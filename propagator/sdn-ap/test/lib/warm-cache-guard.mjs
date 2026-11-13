// Test-build instrumentation: compare reused coefficients with a fresh reconstruction, byte for byte.
export const guardExports = `
SDNAP_EXPORT("sdnap_test_warm_counts") void sdnap_test_warm_counts(double* out) {
  for (int i = 0; i < 4; ++i) out[i] = static_cast<double>(__atomic_load_n(&sdnap::xpt::g_test_warm[i], __ATOMIC_RELAXED));
}
`;
export function guardTesseral(source) {
  const marker = 'inline float* sp_compact_blk_c(';
  if (!source.includes(marker)) throw new Error('missing compact cache function');
  source = source.replace(marker, 'inline uint64_t g_test_warm[4] = {};\n' + marker);
  const old = '    return th->blk_c;\n  return sp_blk_c(sc, blocks, count);';
  if (!source.includes(old)) throw new Error('missing coefficient reuse branch');
  return source.replace(old, `    {
      const float* rebuilt = sp_blk_c(sc, blocks, count);
      bool equal = true;
      const int n = blocks != nullptr ? count : sc.total_blks;
      for (int j = 0; j < n; ++j) {
        const int bi = blocks != nullptr ? blocks[j] : j;
        equal &= std::memcmp(th->blk_c + bi * 64, rebuilt + bi * 64, 64 * sizeof(float)) == 0;
      }
      __atomic_fetch_add(&g_test_warm[0], 1, __ATOMIC_RELAXED);
      if (!equal) __atomic_fetch_add(&g_test_warm[1], 1, __ATOMIC_RELAXED);
      return th->blk_c;
    }
  __atomic_fetch_add(&g_test_warm[blocks == nullptr ? 2 : 3], 1, __ATOMIC_RELAXED);
  return sp_blk_c(sc, blocks, count);`);
}
export function warmCounts(m) {
  const p = m.x.sdnap_alloc(32);
  m.x.sdnap_test_warm_counts(p);
  const counts = Array.from(new Float64Array(m.h.memory.buffer, p, 4));
  m.x.sdnap_free(p);
  return counts;
}
