// One end-to-end acceptance runner for tiered Pc: the native engine, public
// synthetic screens and four full-catalog screens. All physics stays in C++/WASM.
// usage: node tests/pcTieredScreen.e2e.mjs [--only native|screen|synthetic]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(root, '../..');
const build = path.join(root, 'src/cpp/build');
const data = path.join(root, 'tests/data/ca-retime');
const { values: options } = parseArgs({ options: { only: { type: 'string' } } });
assert(!options.only || ['native', 'screen', 'synthetic'].includes(options.only), '--only must be native, screen or synthetic');

async function run(command, args = [], { echo = true, timeoutMs = 20 * 60 * 1000 } = {}) {
  if (echo) console.log(`$ ${[command, ...args].join(' ')}`);
  const temporary = path.join(build, 'tmp');
  fs.mkdirSync(temporary, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, TMPDIR: temporary }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failure = '', forceKill;
    const terminate = (reason) => {
      if (failure) return;
      failure = reason;
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 1000);
      forceKill.unref();
    };
    const deadline = setTimeout(() => terminate(`timed out after ${timeoutMs / 1000} seconds`), timeoutMs);
    deadline.unref();
    const cleanup = () => { clearTimeout(deadline); clearTimeout(forceKill); };
    child.stdout.on('data', (chunk) => { output += chunk; if (echo) process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => {
      output += chunk; if (echo) process.stderr.write(chunk);
      // A trapped WASI worker cannot complete pthread_join. Stop this owned
      // child promptly instead of waiting forever or calling a partial run a pass.
      if (/\[wasi-thread\][^\n]* trapped:/.test(output)) terminate('WASM worker trapped; its join cannot complete');
    });
    child.on('error', (error) => { cleanup(); reject(error); });
    child.on('close', (code, signal) => {
      cleanup();
      if (code === 0 && !failure) return resolve(output);
      const error = new Error(`${path.basename(command)} ${args.join(' ')} failed (${failure || signal || `exit ${code}`})${echo && !failure ? '' : `\n${output.slice(-8192)}`}`);
      error.output = output;
      reject(error);
    });
  });
}

// HYBRID mode forbids git execution. Read the same worktree metadata that
// git rev-parse --git-common-dir would resolve, without running git.
function stackRoot() {
  const marker = path.join(repository, '.git');
  if (!fs.existsSync(marker)) return null;
  let common = marker;
  if (fs.statSync(marker).isFile()) {
    const match = fs.readFileSync(marker, 'utf8').match(/^gitdir:\s*(.+)\s*$/m);
    if (!match) return null;
    common = path.resolve(repository, match[1]);
  }
  const commondir = path.join(common, 'commondir');
  if (fs.existsSync(commondir)) common = path.resolve(common, fs.readFileSync(commondir, 'utf8').trim());
  return path.resolve(common, '../../../..');
}

function flatbuffersInclude() {
  const stack = stackRoot();
  const include = process.env.SDN_FLATBUFFERS_INCLUDE_DIR ??
    (process.env.GAUNTLET_STACK_ROOT ? path.join(process.env.GAUNTLET_STACK_ROOT, 'repos/main-packages/flatbuffers/include') :
      stack ? path.join(stack, 'repos/main-packages/flatbuffers/include') : null);
  assert(include && fs.existsSync(path.join(include, 'flatbuffers/flatbuffers.h')),
    'FlatBuffers C++ headers unavailable offline. Set SDN_FLATBUFFERS_INCLUDE_DIR or GAUNTLET_STACK_ROOT to the existing stack checkout.');
  return path.resolve(include);
}

function writeIfChanged(filename, content) {
  if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8') !== content) fs.writeFileSync(filename, content);
}

// This is compiled as part of this E2E, not a second test suite. The independent
// references and all numerical assertions execute in native C++.
const nativeAcceptance = String.raw`
#include "conjunction/conjunction_engine.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <utility>
#include <vector>
using namespace conjunction;
namespace {
unsigned passed = 0;
void require(bool okay, const char* reason) {
  if (!okay) throw std::runtime_error(reason);
  ++passed;
}
PcEncounter centered(double radius, bool violation) {
  PcEncounter e;
  e.epoch_jd = 2451545.0;
  e.primary = {7000, 0, 0, 0, 0, 0};
  e.secondary = {7000, 0, 0, 0, 1, 0};
  e.gravitational_parameter = 0;
  e.has_velocity_covariance = true;
  e.combined_radius = radius;
  for (unsigned i = 0; i < 3; ++i) e.covariance_primary[i * 6 + i] = .01;
  if (violation) e.covariance_primary[28] = .0121;
  return e;
}
bool same(double a, double b) { return a == b || (std::isnan(a) && std::isnan(b)); }
void equal(const ConjunctionEvent2& a, const ConjunctionEvent2& b) {
  require(a.pc.method == b.pc.method && a.pc.tier == b.pc.tier &&
    same(a.pc.probability, b.pc.probability) && same(a.pc.probability_2d, b.pc.probability_2d) &&
    a.has_covariance == b.has_covariance && a.pc.converged == b.pc.converged &&
    a.pc.usage_checked == b.pc.usage_checked && a.pc.usage_violation == b.pc.usage_violation &&
    a.pc.usage_reason == b.pc.usage_reason && a.pc.failure_reason == b.pc.failure_reason &&
    a.usage.violated == b.usage.violated && a.usage.fully_evaluated == b.usage.fully_evaluated &&
    a.usage.curvature_skipped == b.usage.curvature_skipped && a.usage.reason == b.usage.reason &&
    same(a.usage.relative_velocity_uncertainty, b.usage.relative_velocity_uncertainty) &&
    same(a.usage.extended, b.usage.extended) && same(a.usage.offset, b.usage.offset) &&
    a.pc.sample_count == b.pc.sample_count && a.pc.collision_count == b.pc.collision_count &&
    a.pc.initial_overlap_count == b.pc.initial_overlap_count && a.pc.entry_collision_count == b.pc.entry_collision_count &&
    same(a.pc.lower_probability, b.pc.lower_probability) && same(a.pc.upper_probability, b.pc.upper_probability),
    "batch differs from event-seeded serial result");
}
void optimized_hall_oracle() {
  // NASA CARA's twelve published Alfano Hall cases, unchanged cara_hall.csv
  // references and tolerances. Positions/velocities are ECI km and km/s at
  // TCA; time bounds are SI seconds from those supplied states (the fixture
  // records each epoch's provenance). The original 0.001 relative acceptance
  // allows independent numerical propagation/quadrature, as in fixture NOTICE.
  // This specifically
  // checks the cheaper 16-angle/128-time startup at the same 1e-4 integrator
  // convergence tolerance, against the original per-case relative limits.
  std::ifstream input(std::string(CONJUNCTION_TEST_FIXTURE_DIR) + "/cara_hall.csv");
  require(bool(input), "CARA Hall fixture available");
  std::string line;
  std::getline(input, line);
  unsigned count = 0;
  double maximum_relative_error = 0;
  while (std::getline(input, line)) {
    if (line.empty()) continue;
    std::stringstream stream(line);
    std::vector<std::string> row;
    for (std::string value; std::getline(stream, value, ',');) row.push_back(value);
    require(row.size() >= 90, "CARA Hall fixture columns");
    PcEncounter encounter; encounter.has_velocity_covariance = true;
    unsigned column = 1;
    for (double& value : encounter.primary) value = std::stod(row[column++]);
    for (double& value : encounter.secondary) value = std::stod(row[column++]);
    for (double& value : encounter.covariance_primary) value = std::stod(row[column++]);
    for (double& value : encounter.covariance_secondary) value = std::stod(row[column++]);
    encounter.combined_radius = std::stod(row[column++]);
    const double expected = std::stod(row[column++]), tolerance = std::stod(row[column++]);
    PcFallbackOptions options;
    options.angular_order = 16; options.time_intervals = 128;
    options.time_start = std::stod(row[column++]); options.time_end = std::stod(row[column++]);
    const auto actual = pc_3d_nc_hall(encounter, options);
    const double error = std::abs(actual.pc.probability / expected - 1);
    maximum_relative_error = std::max(maximum_relative_error, error);
    if (!actual.pc.converged || error > tolerance) std::fprintf(stderr,
      "Optimized Hall %s: computed=%.15g reference=%.15g relative_error=%.15g tolerance=%.15g converged=%d\n",
      row[0].c_str(), actual.pc.probability, expected, error, tolerance, actual.pc.converged);
    require(actual.pc.converged && error <= tolerance, ("optimized Hall original tolerance: " + row[0]).c_str());
    ++count;
  }
  require(count == 12, "all twelve CARA Hall cases checked at optimized startup");
  std::printf("Optimized Hall CARA: %u cases passed, startup=16/128, relative_tolerance=1e-4, max_relative_error=%.12g\n",
    count, maximum_relative_error);
}
void screening_disk_oracle() {
  // Independent SciPy dblquad values: static encounter-plane geometry in km
  // and km^2, no epoch. Preserve each original 1e-4 relative/absolute bound;
  // its rationale is binary64 quadrature agreement, as in fixture NOTICE.
  std::ifstream input(std::string(CONJUNCTION_TEST_FIXTURE_DIR) + "/pc_dblquad.csv");
  require(bool(input), "Screening dblquad fixture available");
  std::string line;
  std::getline(input, line);
  unsigned count = 0, fixed_quadrature = 0;
  double maximum = 0;
  while (std::getline(input, line)) {
    if (line.empty()) continue;
    std::stringstream stream(line);
    std::vector<std::string> row;
    for (std::string value; std::getline(stream, value, ',');) row.push_back(value);
    require(row.size() == 13, "Screening dblquad fixture columns");
    BPlaneGeometry geometry;
    geometry.xi = std::stod(row[1]); geometry.zeta = std::stod(row[2]);
    geometry.sigma_xx = std::stod(row[3]); geometry.sigma_xz = std::stod(row[4]);
    geometry.sigma_zz = std::stod(row[5]); geometry.combined_radius = std::stod(row[6]);
    const double expected = std::stod(row[7]), tolerance = std::stod(row[8]), absolute = std::stod(row[9]);
    const auto actual = screening_foster_2d(geometry);
    fixed_quadrature += actual.iterations == 48;
    const double error = std::abs(actual.probability - expected);
    maximum = std::max(maximum, expected ? error / expected : 0);
    require(actual.method == "FOSTER-2D" && actual.converged && std::isfinite(actual.probability) &&
      error <= std::max(absolute, tolerance * std::abs(expected)), "Screening Foster original dblquad tolerance");
    if (std::stoi(row[10])) require(actual.covariance_remediated, "Screening preserves oracle covariance remediation");
    ++count;
  }
  require(count == 20, "all twenty Screening dblquad geometries checked");
  require(fixed_quadrature > 0, "Screening bounded Foster quadrature exercised by independent oracle");
  std::printf("Screening 20-geometry dblquad comparison: %u cases; max_relative_error=%.12e; fixed_quadrature=%u\n",
    count, maximum, fixed_quadrature);
}
void screening_far_tail_oracle() {
  // Independent closed-form Gaussian polar integral (Rice/Bessel identity):
  // P=exp(-lambda)*integral_0^a exp(-t)*I0(2*sqrt(lambda*t)) dt.
  // Expand exp(-t) and I0 and integrate each monomial analytically below;
  // this uses no production quadrature. Static encounter-plane distances are
  // km, covariance is identity km^2, and no epoch/time scale applies. The
  // public synthetic miss is 36.6 sigma and HBR .08 sigma. At these values,
  // truncating at k=64,j=32 leaves relative series tails below 1e-100; the
  // 1e-5 tolerance allows Screening's stated bounded-rule error and rounding.
  BPlaneGeometry geometry;
  geometry.xi = 36.6;
  geometry.sigma_xx = geometry.sigma_zz = 1;
  geometry.combined_radius = .08;
  const long double miss = geometry.xi, radius = geometry.combined_radius;
  const long double lambda = miss * miss / 2, a = radius * radius / 2;
  long double sum = 0, bessel = 1;
  for (unsigned k = 0; k < 64; ++k) {
    long double radial = 0, exponential = 1;
    for (unsigned j = 0; j < 32; ++j) {
      radial += exponential / (k + j + 1);
      exponential *= -a / (j + 1);
    }
    sum += bessel * radial;
    bessel *= lambda * a / ((k + 1) * (k + 1));
  }
  const long double expected = std::exp(-lambda) * a * sum;
  const auto reference = Foster2D().compute(geometry);
  const auto actual = screening_foster_2d(geometry);
  require(!reference.converged && reference.failure_reason == "Disk quadrature error exceeds relative budget",
    "public far-tail geometry exercises the unchanged Reference stopping floor");
  require(actual.converged && actual.method == "FOSTER-2D" && actual.iterations == 576 &&
    actual.usage_reason.find("relative error bound=2.71e-6") != std::string::npos,
    "Screening far-tail disk uses its disclosed bounded positive quadrature");
  const long double relative = std::abs(static_cast<long double>(actual.probability) / expected - 1);
  require(expected > 0 && std::isfinite(actual.probability) && actual.probability > 0 && relative <= 1e-5L,
    "Screening far-tail disk agrees with independent analytic Rice/Bessel series");
  std::printf("Screening far-tail disk: analytic_series=%.17Lg; Pc=%.17g; relative_error=%.12Lg; nodes=%d\n",
    expected, actual.probability, relative, actual.iterations);
}
void screening_curvature_policy() {
  // Public synthetic inertial states: km, km/s, covariance km^2 and
  // km^2/s^2, common UTC JD 2451545, Earth mu 398600.4418 km^3/s^2.
  // The perpendicular relative speed is exactly 1 km/s. A velocity variance
  // of 0.0121 therefore gives 0.11 relative uncertainty; zero variance
  // gives 0. The 1 km radial miss with 0.1 km position sigma gives a far-tail
  // Foster Pc. This checks an evaluation policy, not a new orbital oracle:
  // both branches must retain the identical computed disk integral.
  constexpr const char* skipped = "curvature not evaluated: Pc2D far below the reporting floor";
  for (bool velocity_violation : {false, true}) {
    auto encounter = centered(.02, false);
    encounter.gravitational_parameter = 398600.4418;
    encounter.primary[4] = encounter.secondary[4] = 7.5;
    encounter.secondary[5] = 1;
    encounter.secondary[0] += 1;
    if (velocity_violation) encounter.covariance_primary[35] = .0121;
    ConjunctionEngine screening;
    screening.set_pc_grade(PcGrade::Screening);
    const auto after = screening.compute_pc(encounter);
    require(after.has_covariance && after.pc.probability_2d > 0 &&
      after.pc.probability_2d < kDefaultPcReportingFloor * 1e-3,
      "public orbital encounter is safely three decades below the reporting floor");
    ConjunctionEngine full;
    full.set_pc_grade(PcGrade::Screening);
    require(full.set_pc_tier_options({after.pc.probability_2d * 999, kDefaultPcMonteCarloFloor}),
      "public control floor disables only the far-below-floor shortcut");
    const auto before = full.compute_pc(encounter);
    require(before.has_covariance && before.pc.probability == after.pc.probability &&
      before.pc.probability_2d == after.pc.probability_2d,
      "curvature shortcut leaves the final Foster probability and Pc2D bit identical");
    require(after.usage.curvature_skipped && !after.pc.usage_checked &&
      after.pc.usage_reason.find(skipped) != std::string::npos &&
      before.pc.usage_reason.find(skipped) == std::string::npos,
      "curvature omission is explicitly disclosed only below the three-decade boundary");
    require(std::abs(after.usage.relative_velocity_uncertainty - (velocity_violation ? .11 : 0)) < 2e-15 &&
      after.usage.extended < .02 && after.usage.offset < .01 &&
      after.pc.usage_violation == velocity_violation,
      "far-below-floor policy still evaluates rectilinear duration, offset and velocity uncertainty");
    require(after.pc.method == "FOSTER-2D" &&
      after.pc.tier == (velocity_violation ? "usage-violation, below floor" : "FOSTER-2D") &&
      (before.pc.tier == "FOSTER-2D" || before.pc.tier == "usage-violation, below floor"),
      "curvature shortcut only permits disclosed Foster/below-floor routing and never changes fallback membership");
    ConjunctionEngine reference;
    const auto reference_result = reference.compute_pc(encounter);
    require(reference_result.pc.usage_reason.find(skipped) == std::string::npos,
      "Reference grade never uses the Screening far-below-floor shortcut");
    std::printf("Screening curvature policy: velocity_uncertainty=%.12g; Pc2D=%.17g; before=%s; after=%s; usage_checked=false; %s\n",
      after.usage.relative_velocity_uncertainty, after.pc.probability_2d,
      before.pc.tier.c_str(), after.pc.tier.c_str(), skipped);
  }
}
void screening_work_budget() {
  // Public synthetic Earth encounter, inertial km/km/s at UTC JD 2451545;
  // covariance in km^2 and km^2/s^2. The independent acceptance reference is
  // Reference's identical seeded prefix of fully classified trajectories,
  // not a probability generated by this new stopping rule. Wilson arithmetic
  // is compared within 2e-15 for endpoint cancellation in binary64.
  auto encounter = centered(.02, false);
  encounter.gravitational_parameter = 398600.4418;
  encounter.primary[4] = encounter.secondary[4] = 7.5;
  encounter.secondary[0] += .05;
  encounter.secondary[5] = .1;
  encounter.covariance_primary[35] = .0121;
  PcFallbackOptions options;
  options.grade = PcGrade::Screening;
  options.time_start = -30; options.time_end = 30;
  options.samples = options.minimum_samples = 4096;
  options.target_hits = 0; options.seed = 12345;
  options.screening_propagation_budget = 32;
  const auto limited = pc_monte_carlo(encounter, options);
  require(limited.pc.converged && limited.work_limited && limited.samples > 0 && limited.samples < options.samples,
    "Screening deterministic work budget can override the sample minimum after a complete trajectory");
  require(limited.propagation_budget == options.screening_propagation_budget &&
    limited.propagation_evaluations >= limited.propagation_budget &&
    limited.propagation_evaluations <= limited.propagation_budget + 401410,
    "Screening work checkpoint is bounded by one fully classified trajectory");
  require(limited.hits == limited.initial_hits + limited.entry_hits &&
    limited.limitation.find("Screening budget: " + std::to_string(limited.samples) + " samples") != std::string::npos &&
    limited.limitation.find("complete-sample stopping=propagation budget") != std::string::npos &&
    limited.limitation.find("sample minimum overridden") != std::string::npos,
    "Screening work limit exposes the actual sample count and complete-sample stop reason");
  auto reference = options;
  reference.grade = PcGrade::Reference; reference.samples = limited.samples;
  const auto prefix = pc_monte_carlo(encounter, reference);
  require(prefix.pc.converged && prefix.samples == limited.samples && prefix.hits == limited.hits &&
    prefix.initial_hits == limited.initial_hits && prefix.entry_hits == limited.entry_hits &&
    prefix.pc.probability == limited.pc.probability &&
    std::abs(prefix.pc.lower_probability - limited.pc.lower_probability) < 2e-15 &&
    std::abs(prefix.pc.upper_probability - limited.pc.upper_probability) < 2e-15,
    "work-limited Screening result equals the complete Reference sample prefix including Wilson uncertainty");
  require(limited.pc.lower_probability >= 0 && limited.pc.lower_probability <= limited.pc.probability &&
    limited.pc.upper_probability >= limited.pc.probability && limited.pc.upper_probability <= 1,
    "work-limited probability retains a valid 95 percent Wilson interval");
  reference.samples = 97; reference.screening_propagation_budget = 1;
  const auto reference_budget = pc_monte_carlo(encounter, reference);
  require(reference_budget.pc.converged && reference_budget.samples == reference.samples &&
    !reference_budget.work_limited && reference_budget.propagation_evaluations == 0 && reference_budget.propagation_budget == 0,
    "Reference ignores the Screening work budget and retains its requested sample count");
  auto automatic = options;
  automatic.samples = automatic.minimum_samples = 32;
  automatic.screening_propagation_budget = 0;
  const auto default_budget = pc_monte_carlo(encounter, automatic);
  require(default_budget.pc.converged && default_budget.propagation_budget == kDefaultScreeningPcPropagationBudget,
    "zero Screening work budget selects its documented named default");
  ConjunctionEngine engine;
  engine.set_pc_grade(PcGrade::Screening);
  engine.set_pc_fallback(ConjunctionEngine::Fallback::MonteCarlo, options);
  const auto scalar = engine.compute_pc(encounter);
  require(scalar.has_covariance && scalar.pc.sample_count > 0 && scalar.pc.sample_count < options.samples &&
    scalar.pc.usage_reason.find("complete-sample stopping=propagation budget") != std::string::npos,
    "engine result exposes work-limited Monte Carlo samples and stop rule");
  const std::vector<PcEncounter> inputs(31, encounter);
  for (unsigned threads : {1u, 4u, 27u}) {
    const auto batch = engine.compute_pc_batch(inputs, threads);
    require(batch.size() == inputs.size(), "work-budget batch preserves every event");
    for (const auto& result : batch) equal(result, scalar);
  }
  std::printf("Screening MC work budget: samples=%llu/%llu; propagations=%llu/%llu; hits=%llu; Wilson=[%.12g,%.12g]; complete Reference prefix identical; engine threads 1/4/27 identical\n",
    static_cast<unsigned long long>(limited.samples), static_cast<unsigned long long>(options.samples),
    static_cast<unsigned long long>(limited.propagation_evaluations), static_cast<unsigned long long>(limited.propagation_budget),
    static_cast<unsigned long long>(limited.hits), limited.pc.lower_probability, limited.pc.upper_probability);
}
void screening_cara_agreement() {
  // Synthetic variants of ALL twelve public CARA Alfano geometries, never
  // catalog records: states/covariances are ECI km, km/s and corresponding
  // covariance units at each published TCA. Hall uses a physical 0.01 km
  // combined HBR and the fixture's finite interval; MC uses the original HBR over
  // +/-30 SI seconds from TCA. Three further LEO crossing-orbit variants
  // (Alfano05/06/07) rotate
  // the secondary's tangential velocity by 30 degrees about its radial axis,
  // preserving orbit energy/angular-momentum magnitude. Isotropic position
  // sigma=0.2 km per object gives R/sigma_combined=0.03536; relative velocity
  // uncertainty=0.007 represents the real sample's median, without
  // embedding any licensed encounter. These use +/-3 SI seconds (over sixteen
  // encounter-width sigmas), keeping the Hall linearization local. Screening's
  // acceptance is median<=1%, p99<=10% vs Reference Hall, and >=90% of MC
  // estimates inside Reference's 95% Wilson interval, per catalog contract.
  std::ifstream input(std::string(CONJUNCTION_TEST_FIXTURE_DIR) + "/cara_hall.csv");
  require(bool(input), "Screening CARA geometry fixture available");
  std::string line;
  std::getline(input, line);
  std::vector<double> differences, quadratic_differences, sphere_differences;
  unsigned count = 0, inside = 0, reduced = 0, applicability_handoffs = 0;
  std::uint64_t reference_samples = 0, screening_samples = 0;
  while (std::getline(input, line)) {
    if (line.empty()) continue;
    std::stringstream stream(line);
    std::vector<std::string> row;
    for (std::string value; std::getline(stream, value, ',');) row.push_back(value);
    require(row.size() >= 90, "Screening CARA geometry fixture columns");
    PcEncounter encounter; encounter.has_velocity_covariance = true;
    unsigned column = 1;
    for (double& value : encounter.primary) value = std::stod(row[column++]);
    for (double& value : encounter.secondary) value = std::stod(row[column++]);
    for (double& value : encounter.covariance_primary) value = std::stod(row[column++]);
    for (double& value : encounter.covariance_secondary) value = std::stod(row[column++]);
    const double radius = std::stod(row[column++]);
    column += 2; // Published unmodified Pc and tolerance remain checked above.
    PcFallbackOptions reference;
    reference.angular_order = 16;
    reference.time_start = std::stod(row[column++]); reference.time_end = std::stod(row[column++]);
    auto screening = reference; screening.grade = PcGrade::Screening;
    screening.relative_tolerance = 1e-2; screening.angular_order = 8; screening.time_intervals = 16;
    encounter.combined_radius = .01;
    const auto hall_reference = pc_3d_nc_hall(encounter, reference);
    const auto hall_screening = pc_3d_nc_hall(encounter, screening);
    if (!hall_screening.pc.converged && hall_screening.requires_monte_carlo) {
      require(hall_reference.requires_monte_carlo,
        "Screening early Nc applicability decision agrees with Reference full integration");
      ConjunctionEngine routed;
      auto route_options = screening; route_options.samples = route_options.minimum_samples = 32;
      routed.set_pc_grade(PcGrade::Screening);
      routed.set_pc_fallback(ConjunctionEngine::Fallback::ThreeDimensionalNc, route_options);
      const auto routed_result = routed.compute_pc(encounter);
      if (routed_result.pc.usage_violation)
        require(routed_result.pc.converged && routed_result.pc.method == "SDMC-TWO-BODY" &&
          routed_result.pc.tier == "usage-violation, Monte Carlo" && routed_result.pc.sample_count == 32,
          "Screening early Nc applicability handoff reaches engine Monte Carlo");
      else require(routed_result.pc.converged && routed_result.pc.tier == "FOSTER-2D",
        "valid two-dimensional CARA geometry retains engine Foster routing");
      ++applicability_handoffs;
    } else {
      require(hall_reference.pc.converged && hall_screening.pc.converged &&
        std::isfinite(hall_reference.pc.probability) && std::isfinite(hall_screening.pc.probability),
        "synthetic CARA Hall Reference and Screening converge");
      const double relative = hall_reference.pc.probability ?
        std::abs(hall_screening.pc.probability / hall_reference.pc.probability - 1) :
        (hall_screening.pc.probability == 0 ? 0 : std::numeric_limits<double>::infinity());
      differences.push_back(relative);
      (hall_screening.pc.method == "3D-NC-HALL-QUADRATIC-TIME" ? quadratic_differences : sphere_differences).push_back(relative);
    }
    require(hall_screening.limitation.find("Screening") != std::string::npos,
      "Screening Hall exposes grade and quadrature policy");
    if (count == 4 || count == 5 || count == 6) {
      auto synthetic = encounter;
      double radial[3], tangent[3], normal[3], distance = 0, radial_speed = 0;
      for (unsigned j = 0; j < 3; ++j) distance += synthetic.secondary[j] * synthetic.secondary[j];
      distance = std::sqrt(distance);
      for (unsigned j = 0; j < 3; ++j) {
        radial[j] = synthetic.secondary[j] / distance;
        radial_speed += radial[j] * synthetic.secondary[j + 3];
      }
      for (unsigned j = 0; j < 3; ++j) tangent[j] = synthetic.secondary[j + 3] - radial_speed * radial[j];
      for (unsigned j = 0; j < 3; ++j) normal[j] = radial[(j + 1) % 3] * tangent[(j + 2) % 3] -
        radial[(j + 2) % 3] * tangent[(j + 1) % 3];
      double relative_speed_squared = 0;
      for (unsigned j = 0; j < 3; ++j) {
        synthetic.secondary[j + 3] = radial_speed * radial[j] + .8660254037844386 * tangent[j] + .5 * normal[j];
        const double speed = synthetic.secondary[j + 3] - synthetic.primary[j + 3];
        relative_speed_squared += speed * speed;
      }
      synthetic.covariance_primary.fill(0); synthetic.covariance_secondary.fill(0);
      for (unsigned j = 0; j < 6; ++j) synthetic.covariance_primary[j * 6 + j] =
        synthetic.covariance_secondary[j * 6 + j] = j < 3 ? .04 : .007 * .007 * relative_speed_squared / 6;
      auto short_reference = reference, short_screening = screening;
      short_reference.time_start = short_screening.time_start = -3;
      short_reference.time_end = short_screening.time_end = 3;
      const auto a = pc_3d_nc_hall(synthetic, short_reference), b = pc_3d_nc_hall(synthetic, short_screening);
      require(a.usage.time_sigma > 0 && std::isfinite(a.usage.time_sigma) &&
        std::abs(a.usage.time_center) + 8.304785425194112 * a.usage.time_sigma < 3,
        "synthetic Hall window covers the full CARA 8.304785-sigma overlap extent");
      if (!a.pc.converged || !b.pc.converged || a.requires_monte_carlo || b.requires_monte_carlo ||
          !(a.pc.probability > 0) || !std::isfinite(b.pc.probability)) std::fprintf(stderr,
        "Synthetic Hall %s: Reference p=%.12g converged=%d requires_mc=%d reason=%s; Screening p=%.12g converged=%d requires_mc=%d method=%s reason=%s\n",
        row[0].c_str(), a.pc.probability, a.pc.converged, a.requires_monte_carlo, a.limitation.c_str(),
        b.pc.probability, b.pc.converged, b.requires_monte_carlo, b.pc.method.c_str(), b.limitation.c_str());
      require(a.pc.converged && b.pc.converged && !a.requires_monte_carlo && !b.requires_monte_carlo &&
        a.pc.probability > 0 && std::isfinite(b.pc.probability), "physical small-sphere synthetic Hall remains applicable");
      const double difference = std::abs(b.pc.probability / a.pc.probability - 1);
      differences.push_back(difference);
      (b.pc.method == "3D-NC-HALL-QUADRATIC-TIME" ? quadratic_differences : sphere_differences).push_back(difference);
    }
    encounter.combined_radius = radius;
    reference.time_start = -30; reference.time_end = 30; reference.samples = 2048;
    reference.seed = 12345 + count;
    screening = reference; screening.grade = PcGrade::Screening;
    screening.minimum_samples = reference.samples;
    const auto exact_reference = pc_monte_carlo(encounter, reference);
    const auto exact_screening = pc_monte_carlo(encounter, screening);
    require(exact_reference.pc.converged && exact_screening.pc.converged &&
      exact_reference.hits == exact_screening.hits && exact_reference.initial_hits == exact_screening.initial_hits &&
      exact_reference.entry_hits == exact_screening.entry_hits && exact_reference.samples == exact_screening.samples &&
      exact_reference.pc.probability == exact_screening.pc.probability &&
      exact_reference.pc.lower_probability == exact_screening.pc.lower_probability &&
      exact_reference.pc.upper_probability == exact_screening.pc.upper_probability,
      "Screening exact trajectory rejection preserves all fixed-sample MC hits and Wilson interval");
    reference.samples = 65536;
    screening = reference; screening.grade = PcGrade::Screening;
    screening.samples = kDefaultScreeningPcSampleCap;
    const auto mc_reference = pc_monte_carlo(encounter, reference);
    const auto mc_screening = pc_monte_carlo(encounter, screening);
    if (!mc_reference.pc.converged || !mc_screening.pc.converged ||
        mc_screening.samples < screening.minimum_samples || mc_screening.samples > reference.samples ||
        !(mc_screening.pc.lower_probability <= mc_screening.pc.probability) ||
        !(mc_screening.pc.upper_probability >= mc_screening.pc.probability)) std::fprintf(stderr,
      "Synthetic MC %s: Reference converged=%d n=%llu hits=%llu p=%.17g CI=[%.17g,%.17g] reason=%s; Screening converged=%d n=%llu min=%llu cap=%llu hits=%llu p=%.17g CI=[%.17g,%.17g] reason=%s\n",
      row[0].c_str(), mc_reference.pc.converged, static_cast<unsigned long long>(mc_reference.samples),
      static_cast<unsigned long long>(mc_reference.hits), mc_reference.pc.probability,
      mc_reference.pc.lower_probability, mc_reference.pc.upper_probability, mc_reference.limitation.c_str(),
      mc_screening.pc.converged, static_cast<unsigned long long>(mc_screening.samples),
      static_cast<unsigned long long>(screening.minimum_samples), static_cast<unsigned long long>(screening.samples),
      static_cast<unsigned long long>(mc_screening.hits), mc_screening.pc.probability,
      mc_screening.pc.lower_probability, mc_screening.pc.upper_probability, mc_screening.limitation.c_str());
    require(mc_reference.pc.converged && mc_screening.pc.converged &&
      mc_screening.samples >= screening.minimum_samples && mc_screening.samples <= reference.samples &&
      mc_screening.pc.lower_probability <= mc_screening.pc.probability &&
      mc_screening.pc.upper_probability >= mc_screening.pc.probability,
      "Screening adaptive MC reports realized sample count and Wilson interval");
    require(mc_screening.limitation.find("Screening grade") != std::string::npos &&
      mc_screening.limitation.find("target_hits=") != std::string::npos,
      "Screening MC exposes grade and adaptive stop rule");
    const bool covered = mc_screening.pc.probability >= mc_reference.pc.lower_probability &&
      mc_screening.pc.probability <= mc_reference.pc.upper_probability;
    if (covered) ++inside;
    else std::printf("Screening MC outside Reference interval: %s estimate=%.12g Reference95%%=[%.12g,%.12g]\n",
      row[0].c_str(), mc_screening.pc.probability, mc_reference.pc.lower_probability, mc_reference.pc.upper_probability);
    reduced += mc_screening.samples < mc_reference.samples;
    reference_samples += mc_reference.samples; screening_samples += mc_screening.samples;
    ++count;
  }
  require(count == 12, "all twelve public synthetic CARA geometries checked");
  require(differences.size() + applicability_handoffs == 15, "all fifteen Hall accuracy/applicability cases checked");
  require(!quadratic_differences.empty(), "physical synthetic CARA geometry exercises guarded quadratic-time Hall");
  std::sort(differences.begin(), differences.end());
  const double median = (differences[differences.size() / 2] + differences[(differences.size() - 1) / 2]) / 2;
  const double p99 = differences[static_cast<std::size_t>(std::ceil(.99 * differences.size())) - 1];
  require(median <= .01 && p99 <= .1, "Screening synthetic Hall median/p99 agreement contract");
  require(inside * 10 >= count * 9, "Screening MC >=90% inside Reference 95% Wilson intervals");
  require(reduced > 0, "Screening MC adaptive rule reduces sample count on public geometries");
  std::printf("Screening synthetic CARA Hall: %zu comparisons, %u matching MC handoffs; median_relative_difference=%.12g; p99=%.12g; max=%.12g\n",
    differences.size(), applicability_handoffs, median, p99, differences.back());
  for (auto group : {std::make_pair("quadratic-time", quadratic_differences), std::make_pair("sphere-flux", sphere_differences)}) {
    auto& errors = group.second;
    if (errors.empty()) continue;
    std::sort(errors.begin(), errors.end());
    const double group_median = (errors[errors.size() / 2] + errors[(errors.size() - 1) / 2]) / 2;
    const double group_p99 = errors[static_cast<std::size_t>(std::ceil(.99 * errors.size())) - 1];
    require(group_median <= .01 && group_p99 <= .1, "each Screening Hall method satisfies agreement contract");
    std::printf("Screening synthetic CARA %s: %zu cases; median_relative_difference=%.12g; p99=%.12g; max=%.12g\n",
      group.first, errors.size(), group_median, group_p99, errors.back());
  }
  std::printf("Screening synthetic CARA MC: %u/%u inside Reference 95%% Wilson; exact-hit rejection %u/%u; samples=%llu/%llu\n",
    inside, count, count, count, static_cast<unsigned long long>(screening_samples), static_cast<unsigned long long>(reference_samples));
}
}
int main() {
  try {
    ConjunctionEngine engine;
    PcFallbackOptions fallback;
    fallback.two_body = false; fallback.time_start = -3; fallback.time_end = 3;
    fallback.angular_order = 16; fallback.time_intervals = 128;
    fallback.samples = 4096; fallback.seed = 12345;
    engine.set_pc_fallback(ConjunctionEngine::Fallback::Automatic, fallback);
    const auto valid = centered(.02, false), high = centered(.02, true), moderate = centered(.001, true);
    auto low = high; low.secondary[0] += 1;
    // Independent closed form: centered isotropic Gaussian disk integral
    // 1-exp(-R^2/(2 sigma^2)). Units km, km/s; inertial XYZ, JD 2451545 UTC;
    // mu=0 rectilinear. 2e-12 absolute allows binary64 adaptive quadrature.
    const double expected = -std::expm1(-.02);
    auto ordinary = engine.compute_pc(valid);
    require(ordinary.has_covariance && ordinary.pc.tier == "FOSTER-2D" && !ordinary.pc.usage_violation,
      "valid encounter must remain Foster-2D");
    require(std::abs(ordinary.pc.probability - expected) < 2e-12, "Foster closed-form disk reference");
    auto below = engine.compute_pc(low);
    require(below.has_covariance && below.pc.method == "FOSTER-2D" &&
      below.pc.tier == "usage-violation, below floor" && below.pc.usage_violation &&
      !below.pc.usage_reason.empty() && below.pc.probability < kDefaultPcReportingFloor,
      "below-floor violation must preserve Foster probability and reason");
    const auto shape = create_pc_method("PC2D-SHAPE-SCALED-MAX")->compute(below.bplane);
    require(shape.converged && shape.probability > kDefaultPcReportingFloor,
      "below-floor gate must use Pc2D despite shape maximum above floor");
    auto nc = engine.compute_pc(moderate);
    require(nc.has_covariance && nc.pc.method == "3D-NC-CARTESIAN" &&
      nc.pc.tier == "usage-violation, 3D-Nc" && nc.pc.usage_violation,
      "moderate Pc must use 3D-Nc despite velocity uncertainty above ten percent");
    require(std::abs(nc.pc.probability_2d + std::expm1(-.00005)) < 2e-12,
      "3D-Nc must retain the independent closed-form Pc2D");
    // 1e-4 relative retains the integrator's required convergence accuracy.
    require(std::abs(nc.pc.probability / -std::expm1(-.00005) - 1) < 1e-4,
      "optimized 3D-Nc matches the independent Gaussian disk integral");
    ConjunctionEngine default_engine;
    const auto default_nc = default_engine.compute_pc(moderate);
    require(default_nc.has_covariance && default_nc.pc.method == "3D-NC-CARTESIAN" &&
      default_nc.pc.tier == "usage-violation, 3D-Nc" && default_nc.pc.probability_2d == nc.pc.probability_2d &&
      std::abs(default_nc.pc.probability / -std::expm1(-.00005) - 1) < 1e-4,
      "default automatic Nc startup preserves tier, Pc2D and closed-form accuracy");
    auto short_window = fallback; short_window.time_start = -.01; short_window.time_end = .01;
    engine.set_pc_fallback(ConjunctionEngine::Fallback::Automatic, short_window);
    const auto escalated = engine.compute_pc(moderate);
    require(escalated.pc.tier == "usage-violation, Monte Carlo" &&
      escalated.pc.usage_reason.find("INITIAL_OCCUPANCY_REQUIRES_MC") != std::string::npos &&
      escalated.pc.probability_2d == nc.pc.probability_2d,
      "Nc applicability flag must escalate a moderate gate to Monte Carlo");
    engine.set_pc_fallback(ConjunctionEngine::Fallback::Automatic, fallback);
    auto mc = engine.compute_pc(high);
    require(mc.has_covariance && mc.pc.method == "SDMC-RECTILINEAR" &&
      mc.pc.tier == "usage-violation, Monte Carlo" && mc.pc.sample_count == fallback.samples,
      "high Pc must use Monte Carlo directly");
    require(std::abs(mc.pc.probability_2d - expected) < 2e-12, "Monte Carlo must retain Pc2D");
    // Five binomial standard deviations verify sampling against the same
    // independent disk integral; no production-generated golden values.
    require(std::abs(mc.pc.probability - expected) < 5 * std::sqrt(expected * (1 - expected) / fallback.samples),
      "Monte Carlo disk within five binomial standard deviations");
    require(engine.set_pc_tier_options({ordinary.pc.probability, 1}), "reporting boundary configured");
    require(engine.compute_pc(high).pc.tier == "usage-violation, 3D-Nc", "reporting-floor equality enters Nc tier");
    require(engine.set_pc_tier_options({0, ordinary.pc.probability}), "Monte Carlo boundary configured");
    require(engine.compute_pc(high).pc.tier == "usage-violation, Monte Carlo", "Monte-Carlo-floor equality enters MC tier");
    require(engine.set_pc_tier_options({1, 1}), "configurable floors accepted");
    require(engine.compute_pc(high).pc.tier == "usage-violation, below floor", "configured reporting floor applies");
    require(!engine.set_pc_tier_options({.5, .1}), "unordered floors rejected without throwing");
    require(engine.compute_pc(high).pc.tier == "usage-violation, below floor", "invalid floors preserve configuration");
    for (const auto forced : {ConjunctionEngine::Fallback::TwoDimensionalNc,
         ConjunctionEngine::Fallback::ThreeDimensionalNc, ConjunctionEngine::Fallback::MonteCarlo}) {
      engine.set_pc_fallback(forced, fallback);
      const auto result = engine.compute_pc(high);
      const char* method = forced == ConjunctionEngine::Fallback::TwoDimensionalNc ? "2D-NC-CARTESIAN" :
        forced == ConjunctionEngine::Fallback::ThreeDimensionalNc ? "3D-NC-CARTESIAN" : "SDMC-RECTILINEAR";
      require(result.has_covariance && result.pc.method == method && result.pc.usage_violation,
        "explicit fallback must ignore automatic floors");
    }
    engine.set_pc_fallback(ConjunctionEngine::Fallback::Automatic, fallback);
    require(engine.set_pc_tier_options({}), "default floors restored");
    auto invalid = high; invalid.covariance_primary.fill(0);
    const auto unavailable = engine.compute_pc(invalid);
    require(!unavailable.has_covariance && unavailable.pc.method == "PC-UNAVAILABLE" && !unavailable.pc.converged,
      "unusable covariance must stay unavailable");
    auto nonfinite = low;
    nonfinite.covariance_primary[3] = nonfinite.covariance_primary[18] = std::numeric_limits<double>::quiet_NaN();
    const auto rejected = engine.compute_pc(nonfinite);
    require(!rejected.has_covariance && rejected.pc.method == "PC-UNAVAILABLE" &&
      rejected.pc.usage_reason.find("INVALID_ENCOUNTER") != std::string::npos,
      "below-floor tier must not bypass invalid position-velocity covariance");
    std::vector<PcEncounter> inputs{valid, low, moderate, high, invalid, nonfinite, high};
    std::vector<ConjunctionEvent2> serial;
    for (const auto& input : inputs) serial.push_back(engine.compute_pc(input));
    for (unsigned threads : {1u, 4u, 27u}) {
      const auto batch = engine.compute_pc_batch(inputs, threads);
      require(batch.size() == serial.size(), "batch preserves result count");
      for (unsigned i = 0; i < batch.size(); ++i) equal(batch[i], serial[i]);
    }
    std::reverse(inputs.begin(), inputs.end());
    const auto reversed = engine.compute_pc_batch(inputs, 4);
    for (unsigned i = 0; i < reversed.size(); ++i) equal(reversed[i], serial[serial.size() - 1 - i]);
    require(engine.compute_pc_batch({}, 27).empty(), "empty batch remains empty");
    engine.set_pc_grade(PcGrade::Reference);
    for (unsigned i = 0; i < inputs.size(); ++i) equal(engine.compute_pc(inputs[i]), serial[serial.size() - 1 - i]);
    engine.set_pc_grade(PcGrade::Screening);
    const auto screening_serial = engine.compute_pc_batch(inputs, 1);
    for (unsigned threads : {4u, 27u}) {
      const auto batch = engine.compute_pc_batch(inputs, threads);
      require(batch.size() == screening_serial.size(), "Screening batch preserves result count");
      for (unsigned i = 0; i < batch.size(); ++i) equal(batch[i], screening_serial[i]);
    }
    // More inputs than workers exercise all 27 workers. Interleave cheap
    // Foster/unavailable results with Nc and MC so a cost-ordered fallback
    // pass must restore input order, including duplicate event seeds.
    std::vector<PcEncounter> mixed;
    for (unsigned repeat = 0; repeat < 5; ++repeat)
      mixed.insert(mixed.end(), inputs.begin(), inputs.end());
    std::vector<ConjunctionEvent2> mixed_scalar;
    for (const auto& input : mixed) mixed_scalar.push_back(engine.compute_pc(input));
    for (unsigned threads : {1u, 4u, 27u}) {
      const auto batch = engine.compute_pc_batch(mixed, threads);
      require(batch.size() == mixed_scalar.size(), "two-pass Screening batch keeps every input");
      for (unsigned i = 0; i < batch.size(); ++i) equal(batch[i], mixed_scalar[i]);
    }
    std::reverse(mixed.begin(), mixed.end());
    for (unsigned threads : {1u, 4u, 27u}) {
      const auto batch = engine.compute_pc_batch(mixed, threads);
      require(batch.size() == mixed_scalar.size(), "reordered two-pass Screening batch keeps every input");
      for (unsigned i = 0; i < batch.size(); ++i) equal(batch[i], mixed_scalar[mixed_scalar.size() - 1 - i]);
    }
    std::printf("Screening two-pass batch: %zu mixed encounters; scalar and threads 1/4/27 identical in original and reversed input order\n",
      mixed.size());
    ConjunctionEngine screening_budget;
    screening_budget.set_pc_grade(PcGrade::Screening);
    screening_budget.set_pc_fallback(ConjunctionEngine::Fallback::MonteCarlo);
    const auto default_budget = screening_budget.compute_pc(moderate);
    require(default_budget.pc.converged && default_budget.pc.method == "SDMC-RECTILINEAR" &&
      default_budget.pc.sample_count == kDefaultScreeningPcSampleCap,
      "Screening method-only fallback keeps the default screening sample cap");
    PcFallbackOptions explicit_budget; explicit_budget.samples = 4096;
    screening_budget.set_pc_fallback(ConjunctionEngine::Fallback::MonteCarlo, explicit_budget);
    const auto custom_budget = screening_budget.compute_pc(moderate);
    require(custom_budget.pc.converged && custom_budget.pc.sample_count == explicit_budget.samples,
      "Screening explicit fallback options preserve the caller sample budget");
    optimized_hall_oracle();
    screening_disk_oracle();
    screening_far_tail_oracle();
    screening_curvature_policy();
    screening_work_budget();
    screening_cara_agreement();
    std::printf("Tiered engine E2E: %u assertions passed; four tiers, forced fallbacks, unavailable covariance, batch threads 1/4/27 and reordered inputs\n", passed);
    std::printf("Tier evidence: valid=%s; below=%s; moderate=%s; high=%s; Pc2D=%.12g; shape_max=%.12g\n",
      ordinary.pc.tier.c_str(), below.pc.tier.c_str(), nc.pc.tier.c_str(), mc.pc.tier.c_str(), below.pc.probability, shape.probability);
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "Tiered engine E2E FAIL: %s\n", error.what());
    return 1;
  }
}
`;

async function native() {
  await waitForLoad('Native');
  const include = flatbuffersInclude();
  fs.mkdirSync(build, { recursive: true });
  const header = path.join(build, 'macos_undef_math.h');
  if (process.platform === 'darwin') writeIfChanged(header,
    '#include <cmath>\n#include <math.h>\n#undef SING\n#undef DOMAIN\n#undef OVERFLOW\n#undef UNDERFLOW\n#undef TLOSS\n#undef PLOSS\n');
  const cacheFile = path.join(build, 'CMakeCache.txt');
  let cache = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, 'utf8') : '';
  const cached = (key) => cache.match(new RegExp(`^${key}:[^=]*=(.*)$`, 'm'))?.[1];
  const source = path.join(root, 'src/cpp');
  assert(!cache || cached('CMAKE_HOME_DIRECTORY') === source, `Native build cache belongs to another checkout: ${build}`);
  if (!cache || cached('FLATBUFFERS_INCLUDE_DIR') !== include ||
      (process.platform === 'darwin' && !cached('CMAKE_CXX_FLAGS')?.includes(header))) {
    const configured = await run('cmake', ['-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=Release', `-DFLATBUFFERS_INCLUDE_DIR=${include}`,
      ...(process.platform === 'darwin' ? [`-DCMAKE_CXX_FLAGS=-include ${header}`] : [])], { echo: false });
    fs.writeFileSync(path.join(build, 'pc_tiered_screen_configure.log'), configured);
    cache = fs.readFileSync(cacheFile, 'utf8');
    console.log(`Configured native build: ${build}`);
  } else console.log(`Reusing configured native build: ${build}`);
  const targets = ['test_pc_cara', 'test_pc_engine', 'test_pc_fallbacks', 'test_pc_maximum', 'test_pc_monte_carlo'];
  console.log(`Building native targets: ${targets.join(', ')}`);
  const built = await run('cmake', ['--build', build, '--target', ...targets, '-j6'], { echo: false });
  fs.writeFileSync(path.join(build, 'pc_tiered_screen_build.log'), built);
  console.log('Native build PASS');
  const evidence = /(?:CARA cases:|20-geometry dblquad comparison:|CARA\/oracle assertions:|Engine assertions:|Pc fallback tests:|[Mm]aximum.*(?:passed|error)|[Mm]onte.*(?:passed|failed)|CARA Hall max relative error=|Optimized Hall CARA:|Screening far-tail disk:|Screening curvature policy:|Screening MC work budget:|Screening two-pass batch:|Screening synthetic CARA|Screening MC outside|Tiered engine E2E:|Tier evidence:)/;
  async function checkedBinary(target, args = []) {
    const output = await run(path.join(build, target), args, { echo: false });
    fs.writeFileSync(path.join(build, `pc_tiered_screen_${target}${args.length ? '_hall' : ''}.log`), output);
    console.log(`${target}${args.length ? ` ${args.join(' ')}` : ''}: exit 0`);
    for (const line of output.split(/\r?\n/)) if (evidence.test(line)) console.log(line);
    return output;
  }
  for (const target of targets) {
    const output = await checkedBinary(target);
    if (target === 'test_pc_cara') {
      assert.match(output, /CARA\/oracle assertions:\s*[1-9]\d* passed, 0 failed/, 'CARA assertion evidence missing');
      assert.match(output, /20-geometry dblquad comparison: 20 cases; max_relative_error=[^\s]+/, '20-geometry oracle evidence missing');
    }
  }
  await checkedBinary('test_pc_fallbacks', ['--hall']);
  const driver = path.join(build, 'pc_tiered_screen_e2e.cpp');
  const executable = path.join(build, 'pc_tiered_screen_e2e');
  writeIfChanged(driver, nativeAcceptance);
  await run(cached('CMAKE_CXX_COMPILER') ?? 'c++', ['-std=c++17', '-O2', '-pthread',
    '-I', path.join(source, 'include'), '-I', path.join(source, 'generated'), '-I', include,
    `-DCONJUNCTION_TEST_FIXTURE_DIR=${JSON.stringify(path.join(source, 'tests/fixtures'))}`,
    ...(process.platform === 'darwin' ? ['-include', header] : []), driver,
    path.join(build, 'libconjunction_assessment.a'), path.join(build, 'libsgp4_lib.a'), path.join(build, 'liberfa_lib.a'),
    '-o', executable], { echo: false });
  await checkedBinary('pc_tiered_screen_e2e');
  console.log('Native stage PASS');
}

// The explicit no-git instruction takes precedence over git check-ignore.
// Accept only this repository's known ignore rule; fail closed if it changes.
function verifyIgnoredData() {
  const ignore = path.join(root, '.gitignore');
  const lines = fs.readFileSync(ignore, 'utf8').split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const rule = lines.lastIndexOf('tests/data/*');
  assert(rule >= 0 && lines.slice(rule + 1).every((line) => line === '!tests/data/README.md'),
    `Cannot establish ignored data destination without git; expected terminal tests/data/* rule in ${ignore}`);
  for (const directory of [path.join(root, 'tests'), path.join(root, 'tests/data')]) {
    assert(!fs.existsSync(path.join(directory, '.gitignore')), `Unexpected nested ignore rules: ${directory}/.gitignore`);
  }
  let ancestor = data;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  assert(fs.realpathSync(ancestor) === ancestor, `Data destination must not escape the worktree through a symlink: ${ancestor}`);
  fs.mkdirSync(data, { recursive: true });
  assert(fs.realpathSync(data) === data, `Data destination must not escape the worktree through a symlink: ${data}`);
  console.log('Offline data protection: tests/data/* verified directly in package .gitignore (no git execution).');
}

async function provision() {
  verifyIgnoredData();
  const catalog = path.join(data, 'catalog.omm.bin');
  if (!fs.existsSync(catalog)) {
    const gp = path.join(data, 'gp.json');
    if (!fs.existsSync(gp)) {
      const archive = '/opt/data/sdn-archive/spacetrack/gp/2026/2026-09-30.json.gz';
      assert(fs.existsSync(archive), `Catalog missing; neither ${gp} nor offline archive ${archive} exists. Network provisioning is forbidden.`);
      await pipeline(fs.createReadStream(archive), createGunzip(), fs.createWriteStream(gp, { flags: 'wx' }));
    }
    await run(process.execPath, ['scripts/make-omm-catalog.mjs', gp, catalog]);
  }
  return { catalog, model: await provisionModel() };
}

// The synthetic acceptance needs only the public model, never a GP catalog.
async function provisionModel() {
  const model = path.join(data, 'model.erm');
  if (!fs.existsSync(model)) {
    verifyIgnoredData();
    const modelJson = path.resolve(root, '../gp-error-model/docs/model-2026-08-scaled.json');
    const calibration = path.resolve(root, '../gp-error-model/docs/calibration-2026-08.json');
    assert(fs.existsSync(modelJson) && fs.existsSync(calibration), `Offline uncertainty model inputs missing: ${modelJson}, ${calibration}`);
    await run(process.execPath, ['scripts/uncertainty-model.mjs', modelJson, calibration, model]);
  }
  return model;
}

async function waitForLoad(label) {
  const deadline = Date.now() + 20 * 60 * 1000;
  while (os.loadavg()[0] > 30) {
    assert(Date.now() < deadline, `${label}: load average stayed above 30 for 20 minutes`);
    console.log(`${label}: load ${os.loadavg()[0].toFixed(2)} > 30; waiting 15 s`);
    await sleep(15000);
  }
  console.log(`${label}: uptime ${(await run('uptime', [], { echo: false })).trim()}`);
}

function collectAssertion(failures, assertion) {
  try { assertion(); } catch (error) { failures.push(error.message); }
}

function verifyScreen(summary, label) {
  const failures = [];
  const check = (assertion) => collectAssertion(failures, assertion);
  check(() => assert(Array.isArray(summary.events) && summary.events.length > 0, `${label}: no conjunctions`));
  if (!Array.isArray(summary.events)) return failures;
  check(() => assert.equal(summary.conjunctions, summary.events.length, `${label}: conjunction count`));
  for (const field of ['methodCounts', 'tierCounts']) {
    check(() => {
      const counts = summary[field];
      assert(counts && typeof counts === 'object' && !Array.isArray(counts), `${label}: ${field} missing`);
      assert.deepEqual(Object.keys(counts), Object.keys(counts).sort(), `${label}: ${field} must be sorted`);
      assert(Object.values(counts).every((count) => Number.isInteger(count) && count >= 0), `${label}: invalid ${field}`);
      assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), summary.events.length, `${label}: ${field} sum`);
      const eventField = field === 'methodCounts' ? 'method' : 'tier';
      const actual = {};
      for (const event of summary.events) actual[event[eventField]] = (actual[event[eventField]] ?? 0) + 1;
      assert.deepEqual(counts, Object.fromEntries(Object.entries(actual).sort(([a], [b]) => a.localeCompare(b))), `${label}: ${field} event agreement`);
    });
  }
  const tiers = new Set(['FOSTER-2D', 'usage-violation, below floor', 'usage-violation, 3D-Nc', 'usage-violation, Monte Carlo', 'maximum-only']);
  const methods = new Set(['FOSTER-2D', '3D-NC-HALL', '3D-NC-HALL-QUADRATIC-TIME', '3D-NC-CARTESIAN', 'SDMC-TWO-BODY', 'SDMC-RECTILINEAR', 'ALFANO-SPHERICAL-SMALL-HBR-MAX']);
  for (const [index, event] of summary.events.entries()) {
    check(() => assert(!event.error && !event.errorCode && !event.errorMessage,
      `${label}: event ${index} error: ${event.error || event.errorCode || event.errorMessage}`));
    check(() => {
      assert(methods.has(event.method) && tiers.has(event.tier), `${label}: unavailable or unknown Pc result ${event.method} / ${event.tier}`);
      assert(Number.isFinite(event.pc) && event.pc >= 0 && event.pc <= 1, `${label}: invalid probability`);
      if (event.tier === 'maximum-only') {
        assert.equal(event.uncertainty, 'MAXIMUM_PROBABILITY_ONLY', `${label}: maximum-only uncertainty`);
        assert.equal(event.method, 'ALFANO-SPHERICAL-SMALL-HBR-MAX', `${label}: no-covariance method`);
      } else if (event.tier === 'FOSTER-2D' || event.tier === 'usage-violation, below floor') {
        assert.equal(event.method, 'FOSTER-2D', `${label}: disk tier method`);
      } else if (event.tier === 'usage-violation, 3D-Nc') {
        assert(event.method.startsWith('3D-NC-'), `${label}: Nc tier method`);
      } else assert(event.method.startsWith('SDMC-'), `${label}: Monte Carlo tier method`);
    });
  }
  for (const value of [summary.wallMs, summary.timings?.loadMs, summary.timings?.gridMs, summary.timings?.refineMs]) {
    check(() => assert(Number.isFinite(value) && value >= 0, `${label}: stage timing missing`));
  }
  for (const phase of ['start', 'end']) check(() => {
    assert(summary.loadAverage?.[phase]?.length === 3 && summary.loadAverage[phase].every(Number.isFinite),
      `${label}: loadAverage.${phase} missing`);
    assert(summary.loadAverage[phase][0] <= 30,
      `${label}: loadAverage.${phase} one-minute load exceeds 30: ${summary.loadAverage[phase][0]}`);
  });
  return failures;
}

async function synthetic() {
  const [fb, sds, transport, catalog, helpers, reporting] = await Promise.all([
    import('flatbuffers'), import('spacedatastandards.org/lib/js/CQR/main.js'),
    import('./lib/conjunctionCommandHarness.mjs'), import('./lib/syntheticCatalog.mjs'),
    import('./lib/cqr.mjs'), import('../gpu/catalogScreen.mjs'),
  ]);
  const { CQR, CDM, OMM, cqrProbabilityAlgorithm: algorithm, cqrUncertaintyOrigin: uncertainty,
    cqrCovarianceBasis: basis } = sds;
  const { encodeCqr, initCqrFlatc, gpRecord, gpSource, publishedSchema, screeningControls, earthFrame } = helpers;
  const flatc = await initCqrFlatc(), objects = catalog.syntheticGp();
  assert.equal(objects.length, 241, 'the public fixture has 240 crossing-orbit objects plus SYN-DOWN');
  const frames = objects.map((g) => ({ portId: 'catalog', payload:
    flatc.generateBinary(publishedSchema('OMM'), JSON.stringify(gpRecord(g)), { sizePrefix: false }) }));
  const model = { portId: 'uncertainty_model', payload: new Uint8Array(fs.readFileSync(await provisionModel())) };
  // Public invented elements, TEME/UTC, 2026-10-02T23:00Z, nearly two days
  // after their epoch. SYN-5-24/SYN-5-36 exercises the >=1e-4 gate even with
  // the higher catalog reporting floor. The 100 km admission threshold and
  // 10 m combined hard-body radius use no licensed encounter data.
  const controls = (on, workers = 4) => ({ ...screeningControls({ startJd: 2461316.4583333335,
    durationSeconds: 3600, thresholdKm: 100, combinedRadiusM: 10, coarseStepSec: 60, numThreads: workers }),
    ALGORITHM: on ? 'FOSTER' : 'ALFANO_MAXIMUM' });
  const instance = { MODULE_ID: 'conjunction-assessment', INSTANCE_ID: 'tiered-pc-synthetic', GENERATION: 1 };
  const h = await transport.createConjunctionCommandHarness({ runtimeKind: 'browser' });
  const port = (response, name) => response.outputs.find((f) => f.portId === name)?.payload;
  const decode = (bytes) => CQR.getRootAsCQR(new fb.ByteBuffer(bytes)).unpack();
  const count = (values) => Object.fromEntries([...values.reduce((m, value) => m.set(value, (m.get(value) ?? 0) + 1), new Map())]
    .sort(([a], [b]) => a.localeCompare(b)));
  const identity = (event) => [event.PRIMARY_ID, event.SECONDARY_ID, event.TCA.JULIAN_DATE,
    event.MISS_DISTANCE_M, event.RELATIVE_SPEED_M_S];
  const comparable = (event) => {
    const copy = structuredClone(event);
    // Each emission has its own message identity; scientific fields must agree.
    if (copy.CONJUNCTION_MESSAGE) {
      delete copy.CONJUNCTION_MESSAGE.CREATION_DATE;
      delete copy.CONJUNCTION_MESSAGE.MESSAGE_ID;
    }
    return copy;
  };
  async function call(methodId, inputs) {
    const response = await h.invoke({ methodId, inputs });
    assert.equal(response.statusCode, 0, `${methodId}: ${response.errorCode ?? ''} ${response.errorMessage ?? ''}`);
    return response;
  }
  async function drain(methodId, inputs, label) {
    await waitForLoad(label);
    const started = performance.now(), events = [], excluded = [];
    let chunks = 0;
    for (;;) {
      assert(chunks++ < 1000, `${label}: bounded result drain reaches FINAL_CHUNK`);
      const response = await call(methodId, inputs), bytes = port(response, 'result');
      assert(bytes, `${label}: result frame present`);
      const result = decode(bytes).CATALOG_RESULT;
      assert(result, `${label}: catalog result arm present`);
      assert.equal(Number(result.OBJECTS_PARSED), objects.length, `${label}: every catalog source accounted for`);
      assert.equal(Number(result.EVENT_OFFSET), events.length, `${label}: contiguous event chunks`);
      assert.equal(Number(result.STATISTICS.FAILED_PAIRS), 0, `${label}: no failed pair silently omitted`);
      events.push(...result.EVENTS);
      for (const frame of response.outputs.filter((f) => f.portId === 'excluded'))
        excluded.push(OMM.getRootAsOMM(new fb.ByteBuffer(frame.payload)).unpack());
      if (result.FINAL_CHUNK) {
        assert.equal(events.length, Number(result.CONJUNCTIONS_FOUND), `${label}: no dropped output event`);
        break;
      }
    }
    assert(events.length > 0, `${label}: conjunctions present`);
    assert.deepEqual(excluded.map((x) => x.OBJECT_NAME), ['SYN-DOWN'], `${label}: refused SGP4 source is explicitly excluded`);
    assert.match(excluded[0].COMMENT, /Excluded from conjunction screening:.*First failure at .*Satellite has decayed/);
    const summaries = events.map(reporting.eventSummary);
    const methodCounts = count(summaries.map((e) => e.method)), tierCounts = count(summaries.map((e) => e.tier));
    console.log(`${label}: status=200 statusCode=0; objects=${objects.length}; events=${events.length}; chunks=${chunks}; total=${((performance.now() - started) / 1000).toFixed(3)} s`);
    console.log(`methodCounts=${JSON.stringify(methodCounts)}; tierCounts=${JSON.stringify(tierCounts)}; excluded=${JSON.stringify(excluded.map((x) => ({ name: x.OBJECT_NAME, norad: x.NORAD_CAT_ID, reason: x.COMMENT })))}`);
    return { events, summaries, excluded };
  }
  function checkPair(off, on, label) {
    assert.deepEqual(on.events.map(identity), off.events.map(identity), `${label}: Pc preserves every event and its input order`);
    assert.deepEqual(on.excluded, off.excluded, `${label}: Pc preserves exclusion evidence`);
    const fallbacks = [], unavailable = [], skippedCurvature = [];
    for (const [i, event] of on.events.entries()) {
      const p = event.PROBABILITY, cdm = event.CONJUNCTION_MESSAGE, summary = on.summaries[i];
      const comments = [cdm?.COMMENT, cdm?.OBJECT1?.COMMENT, cdm?.OBJECT2?.COMMENT].filter(Boolean).join('\n');
      assert.equal(event.COMBINED_RADIUS_M, 10, `${label}: requested combined HBR`);
      assert(Number.isFinite(summary.pc) && summary.pc >= 0 && summary.pc <= 1, `${label}: finite Pc`);
      assert(!event.error && !event.errorCode && !event.errorMessage, `${label}: no event error`);
      if (comments.includes('curvature not evaluated: Pc2D far below the reporting floor')) {
        assert.equal(summary.method, 'FOSTER-2D', `${label}: disclosed curvature skip retains Foster Pc`);
        assert(['FOSTER-2D', 'usage-violation, below floor'].includes(summary.tier),
          `${label}: a curvature-skipped event cannot enter an expensive fallback tier`);
        skippedCurvature.push({ primary: event.PRIMARY_NAME, secondary: event.SECONDARY_NAME,
          tier: summary.tier, pc: summary.pc });
      }
      if (summary.tier.startsWith('usage-violation,')) {
        assert(cdm, `${label}: usage violation carries a CDM`);
        assert(comments.includes(summary.tier), `${label}: exact machine tier retained in comment`);
        assert.match(comments, /grade=Screening/, `${label}: screening numerical grade visible`);
        assert.match(comments, /(?:tolerance|relative error budget|sample_cap)=/, `${label}: numerical policy visible`);
        assert.equal(summary.pc, cdm.COLLISION_PROBABILITY, `${label}: consumer reads CDM Pc`);
      }
      if (['usage-violation, 3D-Nc', 'usage-violation, Monte Carlo'].includes(summary.tier)) {
        assert.match(cdm.COLLISION_PROBABILITY_METHOD, /^(?:3D-NC-|SDMC-)/, `${label}: actual fallback method in CDM`);
        assert.equal(summary.method, cdm.COLLISION_PROBABILITY_METHOD, `${label}: consumer preserves actual method name`);
        assert.equal(p.ALGORITHM, algorithm.ALFANO_MAXIMUM, `${label}: no fallback masquerades as an SDS method`);
        assert.equal(p.UNCERTAINTY_SOURCE, uncertainty.MAXIMUM_PROBABILITY_ONLY);
        assert.equal(p.PROBABILITY, 0, `${label}: absent covariance probability remains the schema default`);
        assert.equal(p.HAS_MAXIMUM_PROBABILITY, true);
        assert.equal(p.MAXIMUM_PROBABILITY, off.events[i].PROBABILITY.MAXIMUM_PROBABILITY, `${label}: CQR retains the same Alfano maximum`);
        for (const side of ['PRIMARY', 'SECONDARY']) {
          assert.equal(event[`${side}_COVARIANCE_BASIS`], basis.NONE, `${label}: maximum-only covariance basis`);
          assert.equal(event[`${side}_SIGMA_RTN_M`], null, `${label}: no sigma on maximum-only CQR`);
        }
        fallbacks.push({ primary: event.PRIMARY_NAME, secondary: event.SECONDARY_NAME,
          method: summary.method, tier: summary.tier, pc: summary.pc });
      } else if (summary.tier !== 'maximum-only') {
        assert.equal(p.ALGORITHM, algorithm.FOSTER, `${label}: representable Foster stays in CQR`);
        assert.equal(summary.method, 'FOSTER-2D', `${label}: SANA Foster alias maps to engine method`);
        assert.equal(p.UNCERTAINTY_SOURCE, uncertainty.SYNTHESIZED_COVARIANCE);
        assert.equal(summary.pc, p.PROBABILITY, `${label}: representable CQR and CDM agree`);
      } else {
        // Far-tail Foster quadrature may be unavailable under its unchanged
        // error budget. It is a disclosed unavailable result, never a made-up
        // covariance Pc or a reason to remove the conjunction.
        assert(!cdm?.COLLISION_PROBABILITY_METHOD, `${label}: unavailable Pc has no invented CDM method`);
        assert.match(comments, /method=PC-UNAVAILABLE/, `${label}: unavailable covariance Pc identified`);
        assert.match(comments, /Collision probability calculation failed:/, `${label}: unavailable reason visible`);
        assert.equal(p.ALGORITHM, algorithm.ALFANO_MAXIMUM);
        assert.equal(p.UNCERTAINTY_SOURCE, uncertainty.MAXIMUM_PROBABILITY_ONLY);
        assert.equal(p.MAXIMUM_PROBABILITY, off.events[i].PROBABILITY.MAXIMUM_PROBABILITY);
        unavailable.push({ primary: event.PRIMARY_NAME, secondary: event.SECONDARY_NAME, reason: cdm.COMMENT });
      }
    }
    assert(fallbacks.length > 0, `${label}: fixture must exercise an unrepresentable Nc/MC fallback`);
    assert(skippedCurvature.length > 0, `${label}: fixture must expose the Screening curvature policy in its CDMs`);
    console.log(`${label}: labelled fallback CDMs=${JSON.stringify(fallbacks)}; all ${on.events.length} events retained`);
    console.log(`${label}: disclosed curvature skips=${skippedCurvature.length}; example=${JSON.stringify(skippedCurvature[0])}`);
    if (unavailable.length) console.log(`${label}: Pc unavailable, maximum-only retained=${JSON.stringify(unavailable)}`);
  }
  let handle;
  try {
    const catalogInputs = (on) => [{ portId: 'request', payload: encodeCqr(flatc, { CATALOG_REQUEST: {
      CONTROLS: controls(on), EVALUATION_FRAME: earthFrame('TEME') } }) }, ...frames, model];
    const off = await drain('screen_catalog', catalogInputs(false), 'Synthetic screen_catalog Pc off');
    const on = await drain('screen_catalog', catalogInputs(true), 'Synthetic screen_catalog Pc on');
    checkPair(off, on, 'Synthetic screen_catalog');
    const selected = on.events.find((e) => /^(?:3D-NC-|SDMC-)/.test(e.CONJUNCTION_MESSAGE?.COLLISION_PROBABILITY_METHOD ?? ''));
    const pairControls = { ...controls(true, 1),
      START_EPOCH: helpers.utcJd(selected.TCA.JULIAN_DATE - 60 / 86400), DURATION_SECONDS: 120 };
    const pairRequest = { PAIR_REQUEST: {
      PRIMARY: gpSource(objects.find((g) => g.NORAD_CAT_ID === selected.PRIMARY_NORAD_ID)),
      SECONDARY: gpSource(objects.find((g) => g.NORAD_CAT_ID === selected.SECONDARY_NORAD_ID)),
      CONTROLS: pairControls, PRIMARY_RADIUS_M: 5, SECONDARY_RADIUS_M: 5, EVALUATION_FRAME: earthFrame('TEME') } };
    const pairInputs = [{ portId: 'request', payload: encodeCqr(flatc, pairRequest) }, model];
    await waitForLoad('Synthetic Reference pair');
    const assessed = decode(port(await call('assess_conjunction', pairInputs), 'result')).EVENT_RESULT;
    const emitted = CDM.getRootAsCDM(new fb.ByteBuffer(port(await call('emit_cdm', pairInputs), 'cdm'))).unpack();
    assert.match(assessed.CONJUNCTION_MESSAGE?.COLLISION_PROBABILITY_METHOD ?? '', /^(?:3D-NC-|SDMC-)/,
      'Synthetic pair retains a genuine unrepresentable fallback');
    const message = (cdm) => { const { CREATION_DATE, MESSAGE_ID, ...scientific } = cdm; return scientific; };
    assert.deepEqual(message(assessed.CONJUNCTION_MESSAGE), message(emitted),
      'Synthetic Reference pair assess_conjunction and emit_cdm have identical scientific CDM fields');
    const pairComments = [emitted.COMMENT, emitted.OBJECT1?.COMMENT, emitted.OBJECT2?.COMMENT].filter(Boolean).join('\n');
    assert(!pairComments.includes('grade=Screening') && !pairComments.includes('Screening grade'),
      'pair assessments and emit_cdm retain Reference grade');
    assert.equal(assessed.PROBABILITY.ALGORITHM, algorithm.ALFANO_MAXIMUM);
    assert.equal(assessed.PROBABILITY.UNCERTAINTY_SOURCE, uncertainty.MAXIMUM_PROBABILITY_ONLY);
    const maximum = decode(port(await call('alfano_max_probability', [{ portId: 'request', payload: encodeCqr(flatc, {
      ALFANO_REQUEST: { MISS_DISTANCE_M: assessed.MISS_DISTANCE_M, COMBINED_RADIUS_M: 10 } }) }]), 'result')).ALFANO_RESULT.MAXIMUM_PROBABILITY;
    // Same native Alfano formula at this pair's assessed miss, with only the
    // published m/km serialization round trip permitted to change rounding.
    assert(Math.abs(assessed.PROBABILITY.MAXIMUM_PROBABILITY - maximum) <= 1e-12 * maximum,
      'Synthetic fallback pair CQR retains the native Alfano maximum, not the fallback value or zero');
    console.log(`Synthetic Reference pair: status=200 statusCode=0; method=${emitted.COLLISION_PROBABILITY_METHOD}; Pc=${emitted.COLLISION_PROBABILITY}; maximum=${maximum}; assess/emit CDMs agree; Reference grade retained`);
    const prepared = await call('prepare_screening_index', [{ portId: 'request', payload: encodeCqr(flatc, { INDEX_REQUEST: {
      INSTANCE: instance, INDEX_CONTENT: 'SOURCE_DESCRIPTIONS', REFINEMENT_MODE: 'EXACT_ONLY',
      SOURCES: objects.map((g, i) => ({ ...gpSource(g), SOURCE_HANDLE: i + 1 })) } }) }]);
    handle = decode(port(prepared, 'result')).INDEX_RESULT.SCREENING_INDEX_HANDLE;
    const windowInputs = (on, workers = 4) => [{ portId: 'request', payload: encodeCqr(flatc, { WINDOW_REQUEST: {
      INSTANCE: instance, SCREENING_INDEX_HANDLE: handle, CONTROLS: controls(on, workers), EVALUATION_FRAME: earthFrame('TEME') } }) }, model];
    for (const method of ['screen_window', 'refine_candidates']) {
      const residentOff = await drain(method, windowInputs(false), `Synthetic ${method} Pc off`);
      const residentOn = await drain(method, windowInputs(true), `Synthetic ${method} Pc on`);
      checkPair(residentOff, residentOn, `Synthetic ${method}`);
      if (method === 'refine_candidates') {
        const serial = await drain(method, windowInputs(true, 1), 'Synthetic refine_candidates Pc on, one worker');
        assert.deepEqual(serial.events.map(comparable), residentOn.events.map(comparable),
          'Synthetic resident refinement: all event scientific fields are independent of worker count');
        console.log('Synthetic resident refinement: 1/4 workers agree on every event scientific field and output order');
      }
    }
    console.log('Synthetic stage PASS: 241 public objects; no fallback abort; catalog/window/refine preserve events, CDM truth and exclusions');
  } finally {
    try {
      if (handle) await call('destroy_screening_index', [{ portId: 'request', payload: encodeCqr(flatc, { DESTROY_REQUEST: {
        INSTANCE: instance, SCREENING_INDEX_HANDLE: handle } }) }]);
    } finally { await h.destroy?.(); }
  }
}

async function screens() {
  const { catalog, model } = await provision();
  // JSON summaries contain catalog identifiers: keep them in the ignored data
  // directory too, never the system temporary directory.
  const scratch = fs.mkdtempSync(path.join(data, 'pc-tiered-screen-'));
  const results = [];
  const failures = [];
  for (const [index, on] of [false, true, false, true].entries()) {
    const label = `Screen ${index + 1} Pc ${on ? 'on' : 'off'}`;
    await waitForLoad(label);
    const output = path.join(scratch, `${index + 1}-${on ? 'on' : 'off'}.json`);
    await run(process.execPath, ['scripts/run-all-vs-all-cpu.mjs', '--runtime', 'node', '--catalog', catalog,
      '--start', '2461314.5', '--days', '3', '--out', output,
      ...(on ? ['--algorithm', 'FOSTER', '--uncertainty-model', model] : [])]);
    const summary = JSON.parse(fs.readFileSync(output, 'utf8'));
    // Complete all four measurements even when a completed run fails acceptance.
    // A failed child or trapped WASI worker still rejects immediately above.
    const runFailures = verifyScreen(summary, label);
    failures.push(...runFailures);
    results.push(summary);
    const t = summary.timings ?? {}, seconds = (ms) => (ms / 1000).toFixed(3);
    console.log(`${label}: total=${seconds(summary.wallMs)} s load=${seconds(t.loadMs)} s search=${seconds(t.gridMs)} s refine=${seconds(t.refineMs)} s; conjunctions=${summary.events?.length ?? 'unavailable'}`);
    console.log(`methodCounts=${JSON.stringify(summary.methodCounts)}; tierCounts=${JSON.stringify(summary.tierCounts)}; loadAverage=${JSON.stringify(summary.loadAverage)}`);
    const eventErrors = (Array.isArray(summary.events) ? summary.events : []).filter((event) => event?.error || event?.errorCode || event?.errorMessage);
    console.log(`${label}: event errors=${eventErrors.length}; acceptance failures=${runFailures.length}`);
    for (const event of eventErrors) console.error(`${label}: event error ${JSON.stringify(event)}`);
  }
  collectAssertion(failures, () => assert.deepEqual(results[1].methodCounts, results[3].methodCounts, 'Pc-on method counts must be schedule independent'));
  collectAssertion(failures, () => assert.deepEqual(results[1].tierCounts, results[3].tierCounts, 'Pc-on tier counts must be schedule independent'));
  for (const result of results) collectAssertion(failures, () => assert.equal(result.conjunctions, results[0].conjunctions, 'Pc must not hide conjunctions'));
  const off = (results[0].wallMs + results[2].wallMs) / 2;
  const on = (results[1].wallMs + results[3].wallMs) / 2;
  console.log(`Pc-on/Pc-off mean total ratio=${(on / off).toFixed(4)}; off=${(off / 1000).toFixed(3)} s; on=${(on / 1000).toFixed(3)} s; limit=2.0`);
  collectAssertion(failures, () => assert(on <= 2 * off, `Pc-on mean total exceeds 2.0 x Pc-off: ${on / off}`));
  assert.equal(failures.length, 0, `Screen acceptance failures (${failures.length}):\n${failures.join('\n')}`);
  console.log('Screen stage PASS: four completed runs, identical Pc-on counts, no event errors');
}

try {
  if (!options.only || options.only === 'native') await native();
  if (!options.only || options.only === 'synthetic') await synthetic();
  if (!options.only || options.only === 'screen') await screens();
  console.log(`Tiered Pc E2E PASS (${options.only ?? 'native + synthetic + screen'})`);
} catch (error) {
  console.error(`Tiered Pc E2E FAIL: ${error.message}`);
  process.exitCode = 1;
}
