// The translation units of FFM's physics, in link order: the one list every build and native test of this repository reads
// (this package's build.mjs, analysis/od, analysis/density-calibration and the native tests under tests/). A program that
// compiles force_models.cpp links all of them; a build that never evaluates HWM14 winds leaves out `windUnits` (and
// third_party/hwm14). src/cpp/CMakeLists.txt spells the same units in CMake's language; tests/no_duplicate_sources.test.mjs
// checks that it lists each of them.
export const physicsUnits = [
  'astrodynamics', 'integrators', 'rk_engine', 'integrator_events', 'variational', 'finite_burn', 'force_partials', 'coords',
  'atmosphere_plugin', 'environment_models', 'ephemeris', 'force_models', 'atmosphere_winds', 'nrlmsise00', 'time_convert', 'us76',
  'ffm_gravity', 'planetary_fields', 'central_body',
];
export const windUnits = ['atmosphere_winds'];
