#pragma once
// A resident catalog propagated under an execution request's dynamics. The
// instance is configured once (ingest_state): one PRW EXECUTION_REQUEST is
// the template, and its kernel and environment inputs are verified once and
// kept. Each resident object is that request with its own state and
// coefficients, integrated forward from its epoch exactly as the execution
// path integrates it (the same steps, through the same space-weather
// restarts), without restarting at sample or export epochs. Chebyshev
// segments are fitted from the integration's dense output.
#include "ffm/prw_dynamics.h"
#include "ffm/chebyshev.h"
#include "ffm/kernel_store.h"
#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <string>
#include <vector>

namespace ffm {

class ResidentDynamics {
public:
    struct Inputs {
        const uint8_t* configuration = nullptr; size_t configurationSize = 0;
        const uint8_t* kernel = nullptr; size_t kernelSize = 0;
        PrwEnvironment environment;
    };
    // The template and its inputs, verified; nullptr with `error` on refusal.
    static std::unique_ptr<ResidentDynamics> configure(const Inputs& inputs, KernelStore& kernels, std::string& error);
    ~ResidentDynamics();

    // One resident object: its GCRF state and epoch, mass and coefficients
    // (Cd*A/m, Cr*A/m) applied to the template's spacecraft.
    bool add(const PRWResidentState* record, std::string& error);
    size_t size() const { return objects_.size(); }
    // The instance's kernel as the active ephemeris, at the start of each call.
    bool activate(std::string& error);

    // The state at `at` (TT) from the dense output; epoch TDB.
    bool state(size_t object, const TTEpoch& at, astro::StateVector& out, std::string& error);
    // The state and P = Phi P0 Phi^T + Q at `at`, integrated with the
    // template's STM technique and density treatment from the object's epoch,
    // as an execution request with this INITIAL_COVARIANCE and PROCESS_NOISE.
    bool covariance(size_t object, const TTEpoch& at, const astro::Mat6& p0, const astro::Integrator::ProcessNoise& noise,
                    astro::StateVector& state, astro::Mat6& p, std::string& error);
    // Segments covering [start, end] (TT) fitted and kept; earlier ones dropped.
    bool prepare(size_t object, const TTEpoch& start, const TTEpoch& end, std::string& error);
    // The kept segments covering [start, end] as PPE position records (km,
    // km/s, TT) with their measured fit residuals.
    bool describe(size_t object, const TTEpoch& start, const TTEpoch& end, PPET& ppe,
                  std::vector<std::unique_ptr<PRWFitQualityT>>& quality, std::string& error);
    // The largest residuals of the segments covering [start, end] (m, m/s).
    bool residuals(size_t object, const TTEpoch& start, const TTEpoch& end, double& positionM, double& velocityMS, std::string& error);
    // The PPE source name: the module identity.
    static std::string sourceName();
    // The SAMPLED_RESIDUAL quality of a prepared set (m, m/s), with the method.
    static std::unique_ptr<PRWFitQualityT> quality(double positionM, double velocityMS);

    struct Object;
private:
    ResidentDynamics() = default;
    dynamics::Execution template_;
    dynamics::Environment environment_;
    std::shared_ptr<const std::vector<uint8_t>> kernel_;
    bool requestWeather_ = false, cannonball_ = false;
    double gravitationalParameter_ = 0;   // the configuration's, m^3/s^2
    std::vector<std::unique_ptr<Object>> objects_;
};

} // namespace ffm
