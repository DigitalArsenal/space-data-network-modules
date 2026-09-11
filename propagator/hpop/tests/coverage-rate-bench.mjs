// How fast can one HPOP instance build Chebyshev coverage?
//
// The per-frame cost of the pool is a Clenshaw evaluation, which is trivially
// cheap. The cost that decides whether 33,000 objects can hold a frame rate is
// COVERAGE: every 600-second segment costs 13 high-fidelity propagations, and
// that work competes with the renderer for cores. This measures segments per
// second per core, which is the number the whole question reduces to.
import { createHPOPPropagator } from "../index.js";

const JD0 = 2460000.5;
const MU_EARTH = 398600.4418;

function buildStates(count) {
  const states = new Float64Array(count * 7);
  for (let i = 0; i < count; i++) {
    const radius = 6778.0 + (i % 16) * 450.0;
    const inc = ((i * 7) % 180) * (Math.PI / 180);
    const raan = ((i * 23) % 360) * (Math.PI / 180);
    const speed = Math.sqrt(MU_EARTH / radius);
    states[i * 7 + 0] = JD0;
    states[i * 7 + 1] = radius * Math.cos(raan);
    states[i * 7 + 2] = radius * Math.sin(raan);
    states[i * 7 + 3] = 0.0;
    states[i * 7 + 4] = -speed * Math.sin(raan) * Math.cos(inc);
    states[i * 7 + 5] = speed * Math.cos(raan) * Math.cos(inc);
    states[i * 7 + 6] = speed * Math.sin(inc);
  }
  return states;
}

const COUNT = Number(process.env.COUNT ?? 256);
const MINUTES = Number(process.env.MINUTES ?? 30);

const plugin = await createHPOPPropagator();
const ex = plugin.exports;
if (ex.plugin_init() !== 0) throw new Error("plugin_init failed");
ex.plugin_set_grid_stagger?.(1);
ex.plugin_set_ephemeris_retention?.(0.02);

// Force model under test. The default configuration is NOT the console's:
// the beta brief asks for EGM2008 70x70 with drag and third bodies, and the
// gravity term is the cost that scales as degree^2, so a rate measured on the
// default says nothing about the rate the console would see.
const MODE = process.env.FORCE_MODE ?? "default";
if (MODE !== "default") {
  const cfg = new Float64Array(17);
  cfg[0] = 398600.4418;
  const degree = Number(process.env.GRAV_DEGREE ?? 70);
  cfg[1] = degree; cfg[2] = degree;
  cfg[3] = process.env.JS === "0" ? 0 : 1; cfg[4] = process.env.JS === "0" ? 0 : 1; cfg[5] = process.env.JS === "0" ? 0 : 1;
  cfg[6] = process.env.DRAG === "0" ? 0 : 1;   // drag
  cfg[7] = 0;                                   // SRP
  cfg[8] = process.env.SUN === "0" ? 0 : 1;
  cfg[9] = process.env.MOON === "0" ? 0 : 1;
  cfg[10] = 1000; cfg[11] = 10; cfg[12] = 10; cfg[13] = 2.2; cfg[14] = 1.3;
  cfg[15] = Number(process.env.GRAVITY_MODE ?? 5); // 5 = vendored EGM2008
  cfg[16] = 4;
  const cfgPtr = ex.malloc(cfg.byteLength);
  new Float64Array(ex.memory.buffer, cfgPtr, cfg.length).set(cfg);
  const rc = ex.plugin_set_force_model_v2(cfgPtr, cfg.length);
  ex.free(cfgPtr);
  if (rc !== 0) throw new Error(`force model refused: ${rc}`);
  // plugin_set_force_model_v2 carries gravDeg/gravOrd, but on the vendored
  // EGM2008 path the field that actually truncates the series is
  // `egm2008.truncationDegree`, which only plugin_set_gravity writes. Call it
  // explicitly so a requested degree is the degree evaluated.
  if (process.env.SET_GRAVITY === "1" && typeof ex.plugin_set_gravity === "function") {
    ex.plugin_set_gravity(degree, degree, 0);
  }
}

const states = buildStates(COUNT);
const statesPtr = ex.malloc(states.byteLength);
new Float64Array(ex.memory.buffer, statesPtr, COUNT * 7).set(states);
if (ex.plugin_init_states(statesPtr, COUNT) !== COUNT) throw new Error("init_states failed");
ex.free(statesPtr);

const target = JD0 + MINUTES / 1440;
const started = performance.now();
let covered = 0;
for (let s = 0; s < COUNT; s += 64) {
  covered += ex.plugin_ensure_coverage(target, s, Math.min(64, COUNT - s));
}
const ensureMs = performance.now() - started;

const evalPtr = ex.malloc(COUNT * 3 * 8);
const evalStart = performance.now();
const EVAL_ROUNDS = 200;
for (let r = 0; r < EVAL_ROUNDS; r++) {
  ex.plugin_eval_positions(JD0 + (MINUTES * (r / EVAL_ROUNDS)) / 1440, evalPtr, COUNT);
}
const evalMs = (performance.now() - evalStart) / EVAL_ROUNDS;
ex.free(evalPtr);

const segments = COUNT * Math.ceil((MINUTES * 60) / 600);
console.log(JSON.stringify({
  force_model: MODE === "default" ? "module default" : `gravity mode ${process.env.GRAVITY_MODE ?? 5}, degree ${process.env.GRAV_DEGREE ?? 70}, drag ${process.env.DRAG === "0" ? "off" : "on"}, sun ${process.env.SUN === "0" ? "off" : "on"}, moon ${process.env.MOON === "0" ? "off" : "on"}`,
  entities: COUNT,
  minutes_covered: MINUTES,
  segments_built: segments,
  ensure_ms: Math.round(ensureMs),
  segments_per_second: Math.round((segments / ensureMs) * 1000),
  propagations_per_second: Math.round((segments * 13 / ensureMs) * 1000),
  eval_ms_per_frame_for_count: Number(evalMs.toFixed(3)),
  eval_entities_per_second: Math.round(COUNT / (evalMs / 1000)),
}, null, 1));
await plugin.destroy?.();
