// A seeded byte mutator for the robustness tests: flips, deletions, duplications, truncations, random bytes.
export function mutator(seed) {
  let state = seed >>> 0;
  const rnd = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const pick = (n) => Math.floor(rnd() * n);
  return function mutate(source) {
    let b = Uint8Array.from(source);
    const rounds = 1 + pick(4);
    for (let r = 0; r < rounds && b.length > 0; r++) {
      const kind = pick(5);
      const at = pick(b.length);
      if (kind === 0) b[at] = pick(256);
      else if (kind === 1) { const n = 1 + pick(64); b = Uint8Array.from([...b.slice(0, at), ...b.slice(Math.min(b.length, at + n))]); }
      else if (kind === 2) { const n = 1 + pick(64); b = Uint8Array.from([...b.slice(0, at), ...b.slice(at, at + n), ...b.slice(at)]); }
      else if (kind === 3) b = b.slice(0, at);
      else { for (let k = 0; k < 1 + pick(8); k++) b[pick(b.length)] ^= 1 << pick(8); }
    }
    return b;
  };
}
