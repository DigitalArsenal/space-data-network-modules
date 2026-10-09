// GPS prediction accuracy with the radiation pressure models of lib/gnss_srp.h:
// HPOP's PRW execution path (src/cpp/src/prw_execution.cpp, compiled into this
// translation unit unchanged) on E3's requests, with the radiation model and
// an orbit fit varied around it. Evidence driver, not a unit test:
//   node tests/gps-srp-accuracy-build.mjs <work>      (host build of this file)
//   node tests/gps-srp-accuracy-prepare.mjs ...       (E3 inputs -> <out>/input.txt)
//   <work>/gps-srp-accuracy <out>/input.txt ABCDE > <out>/out.txt   (jobs split freely)
//   node tests/gps-srp-accuracy-score.mjs <out>       (statistics; result in
//     tests/evidence/gps-srp-accuracy/score-test-window.json)
//
// Per job (object, issue time T): the E3 HPOP-URA request (initial state the
// ESA ultra-rapid state at T; samples: the newest ultra-rapid issue's observed
// half, then the ESA final-orbit reference epochs at T + 1, 3, 7 d). Variants:
//   A  as E3: cannonball, the request's mass, area and Cr, from the URA state at T
//   B  as A with the GPS box-wing a priori (IIR, IIR-M, IIF; GPS III keeps A)
//   C  cannonball, initial state and Cr*A/m fitted to the observed half
//   D  box-wing a priori plus ECOM2 D2B1 (D0, Y0, B0, D2c, D2s, B1c, B1s),
//      initial state and the seven coefficients fitted to the observed half
//   E  ECOM2 D2B1 alone (no a priori), fitted the same way
// The fit: Gauss-Newton on the GCRF positions of the observed half (equal
// weights), partials from HPOP's variational equations (analytic STM and
// parameter sensitivities), from the URA state at the arc's start.
//
// Input (text): "kernel <PRW NATIVE_INPUT file>", then per job
//   job <id> <block IIR|IIR-M|IIF|III> <massKg> <request file> <eop file> <nObs> <nTargets>
//   o <x y z km>          nObs lines: the observed positions at SAMPLE_EPOCHS[0..nObs)
//   v <vx vy vz km/s>     the URA velocity at SAMPLE_EPOCHS[0]
// Output: "res <id> <variant> <k> <x y z km>" (the predicted GCRF position at
// target k = SAMPLE_EPOCHS[nObs + k]) and "fit <id> <variant> <iterations>
// <rms m> <parameters...>".
#include "../src/cpp/src/prw_execution.cpp"

#include <fstream>
#include <iostream>
#include <iterator>
#include <sstream>

using namespace astro;
namespace {

std::vector<uint8_t> readFile(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("cannot read " + path);
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(in)), {});
}
// A size-prefixed $PRW frame (the harness's payloads) as a verified root.
const PRW* root(const std::vector<uint8_t>& bytes) {
    const PRW* r = nullptr; std::string error;
    if (!hpop::verifyPrw(bytes.data(), bytes.size(), r, error)) throw std::runtime_error(error);
    return r;
}

// Solve the symmetric positive system N x = b (n <= 16) by Cholesky after
// scaling to unit diagonal.
std::vector<double> solve(std::vector<double> N, std::vector<double> b, int n) {
    std::vector<double> s(n);
    for (int i = 0; i < n; ++i) s[i] = N[i * n + i] > 0 ? 1 / std::sqrt(N[i * n + i]) : 1;
    for (int i = 0; i < n; ++i) { b[i] *= s[i]; for (int j = 0; j < n; ++j) N[i * n + j] *= s[i] * s[j]; }
    for (int j = 0; j < n; ++j) {
        double d = N[j * n + j];
        for (int k = 0; k < j; ++k) d -= N[j * n + k] * N[j * n + k];
        if (!(d > 1e-14)) throw std::runtime_error("singular normal matrix");
        N[j * n + j] = std::sqrt(d);
        for (int i = j + 1; i < n; ++i) {
            double v = N[i * n + j];
            for (int k = 0; k < j; ++k) v -= N[i * n + k] * N[j * n + k];
            N[i * n + j] = v / N[j * n + j];
        }
    }
    for (int i = 0; i < n; ++i) { for (int k = 0; k < i; ++k) b[i] -= N[i * n + k] * b[k]; b[i] /= N[i * n + i]; }
    for (int i = n - 1; i >= 0; --i) { for (int k = i + 1; k < n; ++k) b[i] -= N[k * n + i] * b[k]; b[i] /= N[i * n + i]; }
    for (int i = 0; i < n; ++i) b[i] *= s[i];
    return b;
}

struct Job {
    std::string id, block, requestFile, eopFile;
    double mass = 0;
    int nObs = 0, nTargets = 0;
    std::vector<Vec3> obs;
    Vec3 v0;
};

using ForceModel::DynamicParameter;
const std::vector<DynamicParameter> D2B1 = {DynamicParameter::Ecom2D0, DynamicParameter::Ecom2Y0, DynamicParameter::Ecom2B0,
    DynamicParameter::Ecom2D2c, DynamicParameter::Ecom2D2s, DynamicParameter::Ecom2B1c, DynamicParameter::Ecom2B1s};

void run(const Job& job, const std::string& variants, const std::vector<uint8_t>& kernel) {
    const auto requestBytes = readFile(job.requestFile), eopBytes = readFile(job.eopFile);
    const auto* request = root(requestBytes)->EXECUTION_REQUEST();
    std::string error;
    auto earth = std::make_shared<hpop::EarthRotation>();
    const std::string reason = sdn::frames::eop::addRows(root(eopBytes)->EARTH_ORIENTATION()->ROWS(), earth->rows);
    if (!reason.empty()) throw std::runtime_error(reason);
    for (const char variant : variants) {
        hpop::Execution e;
        if (!hpop::parseExecution(request, true, e, error)) throw std::runtime_error(error);
        e.forces.earthFixedRotation = [earth](double jd, double m[3][3]) { earth->matrix(jd, m); };
        e.forces.jdUt1At = [earth](double jd) { return earth->ut1(jd); };
        const bool boxWing = job.block != "III" && (variant == 'B' || variant == 'D');
        if (boxWing) {
            e.forces.srp.model = ForceModel::SRPModelType::GnssBoxWing;
            e.forces.srp.gnssBoxWing = gnss_srp::GpsBoxWing(job.block == "IIF" ? gnss_srp::GpsBlock::IIF : gnss_srp::GpsBlock::IIR);
            e.forces.srp.mass = job.mass;
        }
        if (variant == 'D' || variant == 'E') e.forces.srp.ecom2.enabled = true;
        if (variant == 'E') e.forces.srp.Cr = 0;
        const bool fit = variant == 'C' || variant == 'D' || variant == 'E';
        if (variant == 'C') e.parameters = {DynamicParameter::SrpAreaOverMass};
        if (variant == 'D' || variant == 'E') e.parameters = D2B1;
        const int np = int(e.parameters.size()), n = 6 + np;
        hpop::Cursor start;
        int iterations = 0; double rms = 0;
        if (fit) {
            // From the URA state at the observed half's first epoch.
            StateVector x(job.obs[0], job.v0, timesys::ttToTdb(e.samplesTT[0].jdTt()));
            for (int it = 0; it < 12; ++it) {
                ++iterations;
                hpop::Cursor c; c.state = x; c.tt = e.samplesTT[0];
                c.phi.assign(n * n, 0.0); for (int i = 0; i < n; ++i) c.phi[i * n + i] = 1;
                std::vector<double> N(n * n, 0.0), b(n, 0.0); double sum = 0;
                for (int k = 0; k < job.nObs; ++k) {
                    if (!hpop::preflightKernel(e, timesys::ttToTdb(e.samplesTT[k].jdTt()), error) || !hpop::advance(e, c, e.samplesTT[k], error))
                        throw std::runtime_error(error);
                    const Vec3 r = c.state.position, d = job.obs[k] - r;
                    const double res[3] = {d.x, d.y, d.z};
                    sum += d.magnitudeSq();
                    for (int a = 0; a < 3; ++a) for (int i = 0; i < n; ++i) {
                        b[i] += c.phi[a * n + i] * res[a];
                        for (int j = 0; j < n; ++j) N[i * n + j] += c.phi[a * n + i] * c.phi[a * n + j];
                    }
                }
                rms = std::sqrt(sum / (3.0 * job.nObs)) * 1e3;
                const auto dz = solve(N, b, n);
                x.position = x.position + Vec3(dz[0], dz[1], dz[2]);
                x.velocity = x.velocity + Vec3(dz[3], dz[4], dz[5]);
                for (int q = 0; q < np; ++q) ForceModel::PerturbParameter(e.forces, e.parameters[q], dz[6 + q]);
                if (std::hypot(dz[0], dz[1], dz[2]) < 1e-7 && it > 0) break;  // 0.1 mm
            }
            start.state = x; start.tt = e.samplesTT[0];
        } else {
            start.state = e.initial; start.tt = e.initialTT;
        }
        // Prediction to the targets: state only.
        std::vector<ForceModel::DynamicParameter> fitted = e.parameters;
        e.parameters.clear();
        hpop::Cursor c = start; c.phi.assign(36, 0.0); for (int i = 0; i < 6; ++i) c.phi[i * 6 + i] = 1;
        for (int k = 0; k < job.nTargets; ++k) {
            const auto& tt = e.samplesTT[job.nObs + k];
            if (!hpop::preflightKernel(e, timesys::ttToTdb(tt.jdTt()), error) || !hpop::advance(e, c, tt, error)) throw std::runtime_error(error);
            std::printf("res %s %c %d %.9f %.9f %.9f\n", job.id.c_str(), variant, k, c.state.position.x, c.state.position.y, c.state.position.z);
        }
        std::printf("fit %s %c %d %.6f", job.id.c_str(), variant, iterations, rms);
        for (const auto p : fitted) std::printf(" %.6e", ForceModel::ParameterValue(e.forces, p));
        std::printf("\n");
        std::fflush(stdout);
    }
}
}  // namespace

int main(int argc, char** argv) {
    if (argc != 3) { std::cerr << "usage: gps-srp-accuracy <input> <variants, e.g. ABCDE>\n"; return 2; }
    std::ifstream in(argv[1]);
    std::string word, variants = argv[2];
    std::vector<uint8_t> kernel;
    while (in >> word) {
        if (word == "kernel") {
            std::string path; in >> path; kernel = readFile(path);
            std::string error; const auto* r = root(kernel);
            (void)r;
            // loadKernel takes the NATIVE_INPUT frame as the module receives it.
            if (!hpop::loadKernel(kernel.data(), kernel.size(), error)) { std::cerr << error << '\n'; return 1; }
        } else if (word == "job") {
            Job job; in >> job.id >> job.block >> job.mass >> job.requestFile >> job.eopFile >> job.nObs >> job.nTargets;
            for (int i = 0; i < job.nObs; ++i) { Vec3 p; in >> word >> p.x >> p.y >> p.z; job.obs.push_back(p); }
            in >> word >> job.v0.x >> job.v0.y >> job.v0.z;
            try { run(job, variants, kernel); }
            catch (const std::exception& x) { std::printf("error %s %s\n", job.id.c_str(), x.what()); std::fflush(stdout); }
        }
    }
    return 0;
}
