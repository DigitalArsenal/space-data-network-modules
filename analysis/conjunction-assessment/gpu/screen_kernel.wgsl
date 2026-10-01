// GPU candidate search over coarse_grid steps: the counterpart of
// conjunction::tight_box_pairs (src/cpp/src/screening_tight.cpp).
//
// The authoritative test is conjunction::tight_pair_may_close
// (src/cpp/include/conjunction/screening_tight.h): over [t_k - h, t_k + h] the
// pair may close within THRESHOLD only if the straight-line relative path does
// within THRESHOLD + D_i + D_j, D the source's own bound on how far its path
// strays from the straight line over the interval (coarse_grid computes it).
// Positions are f32 here (0.5 m near 7000 km), so the limit carries SLACK and
// this kernel proposes a superset; refine_candidates repeats the test in f64.
//
// Each object's straight-line segment over the interval, widened by
// (THRESHOLD + SLACK) / 2 + D + MARGIN, is a box; two objects can pass the test
// only if their boxes overlap. Per step:
//   insert: boxes go into the cells of a uniform grid (hashed, one lock-free
//           list per slot); a box spanning more than three cells on an axis is
//           "big" and goes on the step's big list instead;
//   pairs:  each object walks the lists of its cells and tests a pair in the
//           one cell holding the low corner of the boxes' overlap;
//   bigs:   each big box is tested against every object.

struct Params {
  objects: u32,         // objects in the block
  step_base: u32,       // first coarse step of the block
  step_offset: u32,     // first step of this dispatch within the block
  table: u32,           // hash slots per step (a power of two)
  capacity: u32,        // candidate slots
  entry_capacity: u32,  // cell entries over all steps of the dispatch
  big_capacity: u32,    // big boxes per step
  pad0: u32,
  threshold_km: f32,
  half_step_s: f32,
  slack_km: f32,
  cell_km: f32,
};

// Per step, per object: (x, y, z, D), (vx, vy, vz, 0); km and km/s. NaN: excluded.
@group(0) @binding(0) var<storage, read> states: array<vec4<f32>>;
// Per step and slot: 1 + the first entry of the slot's list; 0 for none.
@group(0) @binding(1) var<storage, read_write> heads: array<atomic<u32>>;
// Entries: (object, 1 + next entry or 0, cx | cy << 16, cz), cells as i16.
@group(0) @binding(2) var<storage, read_write> entries: array<vec4<u32>>;
// [0] entries used, [1] candidates, [2 + s] big boxes of step s.
@group(0) @binding(3) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> bigs: array<u32>;
// Candidates: (obj1, obj2, step, 0), obj1 < obj2.
@group(0) @binding(5) var<storage, read_write> candidates: array<vec4<u32>>;
@group(0) @binding(6) var<uniform> P: Params;

const MARGIN_KM: f32 = 0.01;     // f32 rounding of the box bounds
const MAX_SPAN: i32 = 3;         // cells per axis before a box is big
const MAX_CELL: i32 = 32000;     // cell coordinates are stored as i16

struct Box { lo: vec3<f32>, hi: vec3<f32>, c0: vec3<i32>, c1: vec3<i32>, ok: bool, big: bool };

fn state_index(s: u32, i: u32) -> u32 { return ((P.step_offset + s) * P.objects + i) * 2u; }

fn box_of(s: u32, i: u32) -> Box {
  var b: Box;
  let p = states[state_index(s, i)];
  let v = states[state_index(s, i) + 1u].xyz;
  // NaN fails every comparison: an excluded object has no box.
  b.ok = all(p == p) && all(v == v);
  if (!b.ok) { return b; }
  let w = 0.5 * (P.threshold_km + P.slack_km) + p.w + MARGIN_KM;
  let e = abs(v) * P.half_step_s + vec3<f32>(w);
  b.lo = p.xyz - e;
  b.hi = p.xyz + e;
  b.c0 = vec3<i32>(floor(b.lo / P.cell_km));
  b.c1 = vec3<i32>(floor(b.hi / P.cell_km));
  b.big = any(b.c1 - b.c0 >= vec3<i32>(MAX_SPAN)) ||
          any(abs(b.c0) > vec3<i32>(MAX_CELL)) || any(abs(b.c1) > vec3<i32>(MAX_CELL));
  return b;
}

fn slot_of(s: u32, c: vec3<i32>) -> u32 {
  let h = (u32(c.x) * 73856093u) ^ (u32(c.y) * 19349663u) ^ (u32(c.z) * 83492791u);
  return s * P.table + (h & (P.table - 1u));
}

fn packed_xy(c: vec3<i32>) -> u32 { return (u32(c.x) & 0xffffu) | (u32(c.y) << 16u); }

fn may_close(s: u32, i: u32, j: u32) -> bool {
  let pi = states[state_index(s, i)];
  let pj = states[state_index(s, j)];
  let dr = pj.xyz - pi.xyz;
  let dv = states[state_index(s, j) + 1u].xyz - states[state_index(s, i) + 1u].xyz;
  let tau = clamp(-dot(dr, dv) / max(dot(dv, dv), 1e-20), -P.half_step_s, P.half_step_s);
  return length(dr + dv * tau) <= P.threshold_km + pi.w + pj.w + P.slack_km;
}

fn emit(s: u32, i: u32, j: u32) {
  let at = atomicAdd(&counters[1], 1u);
  if (at < P.capacity) {
    candidates[at] = vec4<u32>(min(i, j), max(i, j), P.step_base + P.step_offset + s, 0u);
  }
}

@compute @workgroup_size(256)
fn insert(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  let s = id.z;
  if (i >= P.objects) { return; }
  let b = box_of(s, i);
  if (!b.ok) { return; }
  if (b.big) {
    let k = atomicAdd(&counters[2u + s], 1u);
    if (k < P.big_capacity) { bigs[s * P.big_capacity + k] = i; }
    return;
  }
  for (var x = b.c0.x; x <= b.c1.x; x++) {
    for (var y = b.c0.y; y <= b.c1.y; y++) {
      for (var z = b.c0.z; z <= b.c1.z; z++) {
        let c = vec3<i32>(x, y, z);
        let e = atomicAdd(&counters[0], 1u);
        if (e >= P.entry_capacity) { return; }   // the host sees the overflow and retries
        let next = atomicExchange(&heads[slot_of(s, c)], e + 1u);
        entries[e] = vec4<u32>(i, next, packed_xy(c), u32(c.z) & 0xffffu);
      }
    }
  }
}

@compute @workgroup_size(256)
fn pairs(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  let s = id.z;
  if (i >= P.objects) { return; }
  let a = box_of(s, i);
  if (!a.ok || a.big) { return; }
  for (var x = a.c0.x; x <= a.c1.x; x++) {
    for (var y = a.c0.y; y <= a.c1.y; y++) {
      for (var z = a.c0.z; z <= a.c1.z; z++) {
        let c = vec3<i32>(x, y, z);
        let xy = packed_xy(c);
        let zz = u32(c.z) & 0xffffu;
        var n = atomicLoad(&heads[slot_of(s, c)]);
        loop {
          if (n == 0u) { break; }
          let e = entries[n - 1u];
          n = e.y;
          let j = e.x;
          // Each pair once (i < j), only entries of this cell (slots are shared).
          if (j <= i || e.z != xy || e.w != zz) { continue; }
          let b = box_of(s, j);
          let lo = max(a.lo, b.lo);
          if (any(lo > min(a.hi, b.hi))) { continue; }
          // The one cell that holds the overlap's low corner tests the pair.
          if (any(vec3<i32>(floor(lo / P.cell_km)) != c)) { continue; }
          if (may_close(s, i, j)) { emit(s, i, j); }
        }
      }
    }
  }
}

@compute @workgroup_size(256)
fn bigs_against_all(@builtin(global_invocation_id) id: vec3<u32>) {
  let j = id.x;
  let s = id.z;
  if (j >= P.objects) { return; }
  let b = box_of(s, j);
  if (!b.ok) { return; }
  let count = min(atomicLoad(&counters[2u + s]), P.big_capacity);
  for (var k = 0u; k < count; k++) {
    let i = bigs[s * P.big_capacity + k];
    // Two big boxes: once, from the lower index.
    if (i == j || (b.big && j < i)) { continue; }
    if (may_close(s, i, j)) { emit(s, i, j); }
  }
}
