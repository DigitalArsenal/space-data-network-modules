// One end-to-end acceptance runner for tiered Pc: the native engine and the
// four full-catalog screens. All probability mathematics stays in C++/WASM.
// usage: node tests/pcTieredScreen.e2e.mjs [--only native|screen]
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
assert(!options.only || ['native', 'screen'].includes(options.only), '--only must be native or screen');

async function run(command, args = [], { echo = true } = {}) {
  if (echo) console.log(`$ ${[command, ...args].join(' ')}`);
  const temporary = path.join(build, 'tmp');
  fs.mkdirSync(temporary, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: { ...process.env, TMPDIR: temporary }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; if (echo) process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { output += chunk; if (echo) process.stderr.write(chunk); });
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 ? resolve(output) :
      reject(new Error(`${path.basename(command)} ${args.join(' ')} failed (${signal ?? `exit ${code}`})${echo ? '' : `\n${output}`}`)));
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
    a.pc.converged == b.pc.converged && a.pc.usage_reason == b.pc.usage_reason &&
    a.pc.sample_count == b.pc.sample_count && a.pc.collision_count == b.pc.collision_count &&
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
    optimized_hall_oracle();
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
  const evidence = /(?:CARA cases:|20-geometry dblquad comparison:|CARA\/oracle assertions:|Engine assertions:|Pc fallback tests:|[Mm]aximum.*(?:passed|error)|[Mm]onte.*(?:passed|failed)|CARA Hall max relative error=|Optimized Hall CARA:|Tiered engine E2E:|Tier evidence:)/;
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
  const catalog = path.join(data, 'catalog.omm.bin'), model = path.join(data, 'model.erm');
  if (!fs.existsSync(catalog)) {
    const gp = path.join(data, 'gp.json');
    if (!fs.existsSync(gp)) {
      const archive = '/opt/data/sdn-archive/spacetrack/gp/2026/2026-09-30.json.gz';
      assert(fs.existsSync(archive), `Catalog missing; neither ${gp} nor offline archive ${archive} exists. Network provisioning is forbidden.`);
      await pipeline(fs.createReadStream(archive), createGunzip(), fs.createWriteStream(gp, { flags: 'wx' }));
    }
    await run(process.execPath, ['scripts/make-omm-catalog.mjs', gp, catalog]);
  }
  if (!fs.existsSync(model)) {
    const modelJson = path.resolve(root, '../gp-error-model/docs/model-2026-08-scaled.json');
    const calibration = path.resolve(root, '../gp-error-model/docs/calibration-2026-08.json');
    assert(fs.existsSync(modelJson) && fs.existsSync(calibration), `Offline uncertainty model inputs missing: ${modelJson}, ${calibration}`);
    await run(process.execPath, ['scripts/uncertainty-model.mjs', modelJson, calibration, model]);
  }
  return { catalog, model };
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

function verifyScreen(summary, label) {
  assert(Array.isArray(summary.events) && summary.events.length > 0, `${label}: no conjunctions`);
  assert.equal(summary.conjunctions, summary.events.length, `${label}: conjunction count`);
  for (const field of ['methodCounts', 'tierCounts']) {
    const counts = summary[field];
    assert(counts && typeof counts === 'object' && !Array.isArray(counts), `${label}: ${field} missing`);
    assert.deepEqual(Object.keys(counts), Object.keys(counts).sort(), `${label}: ${field} must be sorted`);
    assert(Object.values(counts).every((count) => Number.isInteger(count) && count >= 0), `${label}: invalid ${field}`);
    assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), summary.events.length, `${label}: ${field} sum`);
    const eventField = field === 'methodCounts' ? 'method' : 'tier';
    const actual = {};
    for (const event of summary.events) actual[event[eventField]] = (actual[event[eventField]] ?? 0) + 1;
    assert.deepEqual(counts, Object.fromEntries(Object.entries(actual).sort(([a], [b]) => a.localeCompare(b))), `${label}: ${field} event agreement`);
  }
  const tiers = new Set(['FOSTER-2D', 'usage-violation, below floor', 'usage-violation, 3D-Nc', 'usage-violation, Monte Carlo', 'maximum-only']);
  const methods = new Set(['FOSTER-2D', '3D-NC-HALL', '3D-NC-CARTESIAN', 'SDMC-TWO-BODY', 'SDMC-RECTILINEAR', 'ALFANO-SPHERICAL-SMALL-HBR-MAX']);
  for (const event of summary.events) {
    assert(!event.error && !event.errorCode && !event.errorMessage, `${label}: event error`);
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
  }
  for (const value of [summary.wallMs, summary.timings?.loadMs, summary.timings?.gridMs, summary.timings?.refineMs]) {
    assert(Number.isFinite(value) && value >= 0, `${label}: stage timing missing`);
  }
  for (const phase of ['start', 'end']) assert(summary.loadAverage?.[phase]?.length === 3 &&
    summary.loadAverage[phase].every(Number.isFinite), `${label}: loadAverage.${phase} missing`);
}

async function screens() {
  const { catalog, model } = await provision();
  // JSON summaries contain catalog identifiers: keep them in the ignored data
  // directory too, never the system temporary directory.
  const scratch = fs.mkdtempSync(path.join(data, 'pc-tiered-screen-'));
  const results = [];
  for (const [index, on] of [false, true, false, true].entries()) {
    const label = `Screen ${index + 1} Pc ${on ? 'on' : 'off'}`;
    await waitForLoad(label);
    const output = path.join(scratch, `${index + 1}-${on ? 'on' : 'off'}.json`);
    await run(process.execPath, ['scripts/run-all-vs-all-cpu.mjs', '--runtime', 'node', '--catalog', catalog,
      '--start', '2461314.5', '--days', '3', '--out', output,
      ...(on ? ['--algorithm', 'FOSTER', '--uncertainty-model', model] : [])]);
    const summary = JSON.parse(fs.readFileSync(output, 'utf8'));
    verifyScreen(summary, label);
    results.push(summary);
    const t = summary.timings, seconds = (ms) => (ms / 1000).toFixed(3);
    console.log(`${label}: total=${seconds(summary.wallMs)} s load=${seconds(t.loadMs)} s search=${seconds(t.gridMs)} s refine=${seconds(t.refineMs)} s; conjunctions=${summary.events.length}`);
    console.log(`methodCounts=${JSON.stringify(summary.methodCounts)}; tierCounts=${JSON.stringify(summary.tierCounts)}; loadAverage=${JSON.stringify(summary.loadAverage)}`);
  }
  assert.deepEqual(results[1].methodCounts, results[3].methodCounts, 'Pc-on method counts must be schedule independent');
  assert.deepEqual(results[1].tierCounts, results[3].tierCounts, 'Pc-on tier counts must be schedule independent');
  for (const result of results) assert.equal(result.conjunctions, results[0].conjunctions, 'Pc must not hide conjunctions');
  const off = (results[0].wallMs + results[2].wallMs) / 2;
  const on = (results[1].wallMs + results[3].wallMs) / 2;
  console.log(`Pc-on/Pc-off mean total ratio=${(on / off).toFixed(4)}; off=${(off / 1000).toFixed(3)} s; on=${(on / 1000).toFixed(3)} s; limit=2.0`);
  assert(on <= 2 * off, `Pc-on mean total exceeds 2.0 x Pc-off: ${on / off}`);
  console.log('Screen stage PASS: four completed runs, identical Pc-on counts, no event errors');
}

try {
  if (options.only !== 'screen') await native();
  if (options.only !== 'native') await screens();
  console.log(`Tiered Pc E2E PASS (${options.only ?? 'native + screen'})`);
} catch (error) {
  console.error(`Tiered Pc E2E FAIL: ${error.message}`);
  process.exitCode = 1;
}
