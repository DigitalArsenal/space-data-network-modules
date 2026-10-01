// GPU candidate screen over one coarse_grid block (all pairs i < j).
//
// The authoritative test is conjunction::tight_pair_may_close
// (src/cpp/include/conjunction/screening_tight.h): over [t_k - h, t_k + h] the
// pair may close within THRESHOLD only if the straight-line relative path does
// within THRESHOLD + 1/2 (A_i + A_j) h^2. A comes precomputed from coarse_grid.
// Positions are f32 here (0.5 m near 7000 km), so the limit carries SLACK and
// this kernel proposes a superset; refine_candidates repeats the test in f64.

struct Params {
  objects: u32,     // objects in the block
  step_base: u32,   // first coarse step of the block
  capacity: u32,    // candidate slots
  pad0: u32,
  threshold_km: f32,
  half_step_s: f32,
  slack_km: f32,
  pad1: f32,
};

// Per step, per object: (x, y, z, A), (vx, vy, vz, 0); TEME km, km/s^2, km/s.
@group(0) @binding(0) var<storage, read> states: array<vec4<f32>>;
// Per object: radius range over the block, +-50 km (NaN: excluded).
@group(0) @binding(1) var<storage, read> bands: array<vec2<f32>>;
// Candidates: (obj1, obj2, step, 0).
@group(0) @binding(2) var<storage, read_write> candidates: array<vec4<u32>>;
@group(0) @binding(3) var<storage, read_write> count: atomic<u32>;
@group(0) @binding(4) var<uniform> P: Params;

const WG: u32 = 256u;
var<workgroup> tile_p: array<vec4<f32>, 256>;
var<workgroup> tile_v: array<vec4<f32>, 256>;
var<workgroup> tile_b: array<vec2<f32>, 256>;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let i_base = wid.x * WG;
  let j_base = wid.y * WG;
  // Uniform per workgroup: every j of this tile is <= every i.
  if (j_base + WG - 1u <= i_base) { return; }
  let base = wid.z * P.objects * 2u;
  let j_load = j_base + lid.x;
  if (j_load < P.objects) {
    tile_p[lid.x] = states[base + j_load * 2u];
    tile_v[lid.x] = states[base + j_load * 2u + 1u];
    tile_b[lid.x] = bands[j_load];
  } else {
    tile_b[lid.x] = vec2<f32>(1e30, -1e30);
  }
  workgroupBarrier();
  let i = i_base + lid.x;
  if (i >= P.objects) { return; }
  let pi = states[base + i * 2u];
  let vi = states[base + i * 2u + 1u].xyz;
  let bi = bands[i];
  if (!(bi.x <= bi.y)) { return; }
  let hh = P.half_step_s * P.half_step_s;
  for (var k = 0u; k < WG; k++) {
    let j = j_base + k;
    if (j <= i || j >= P.objects) { continue; }
    let bj = tile_b[k];
    if (!(bi.x <= bj.y && bj.x <= bi.y)) { continue; }   // radius bands apart (or NaN)
    let dr = tile_p[k].xyz - pi.xyz;
    let dv = tile_v[k].xyz - vi;
    let tau = clamp(-dot(dr, dv) / max(dot(dv, dv), 1e-20), -P.half_step_s, P.half_step_s);
    let d = length(dr + dv * tau);
    if (d <= P.threshold_km + 0.5 * (pi.w + tile_p[k].w) * hh + P.slack_km) {
      let at = atomicAdd(&count, 1u);
      if (at < P.capacity) { candidates[at] = vec4<u32>(i, j, P.step_base + wid.z, 0u); }
    }
  }
}
