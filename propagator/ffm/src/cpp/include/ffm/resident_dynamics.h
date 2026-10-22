// FFM Fast fork base: propagator/ffm/src/cpp/include/ffm/resident_dynamics.h
// Fork base sha256: f33c228e632a58feaf29618319e7a946c7328d71952c01edc423d185b68bcf05
#pragma once
// A resident catalog propagated under an execution request's dynamics. The
// instance is configured once (ingest_state): one PRW EXECUTION_REQUEST is
// the template, and its kernel and environment inputs are verified once and
// kept. Each resident object is that request with its own state and
// coefficients. Fast's internal orbit policy selects the resident runner;
// sample/export epochs do not restart it. Selected-object preparation uses
// bounded cohorts, with Chebyshev fitting and dense-history trimming kept
// interleaved. The standard PRW contract and covariance path stay shared.
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
    void clearObjects();
    // UTC-Julian-date host bridge; state vectors remain GCRF km and km/s.
    bool addCatalogState(const astro::StateVector& state, double cdAm, double crAm, bool valid, std::string& error);
    bool earthFixed(const TTEpoch& at, const astro::StateVector& in, astro::StateVector& out,
                    bool inverse, std::string& error);
    size_t size() const { return objects_.size(); }
    // The instance's kernel as the active ephemeris, at the start of each call.
    bool activate(std::string& error);

    // The state at `at` (TT) from the dense output; epoch TDB.
    bool state(size_t object, const TTEpoch& at, astro::StateVector& out, std::string& error);
    // Evaluate the prepared PPE coefficients without advancing integration.
    // Optional clamping preserves the entity renderer's coverage-edge contract.
    bool evaluate(size_t object, const TTEpoch& at, astro::StateVector& out, bool clamp = false) const;
    // The state and P = Phi P0 Phi^T + Q at `at`, integrated with the
    // template's STM technique and density treatment from the object's epoch,
    // as an execution request with this INITIAL_COVARIANCE and PROCESS_NOISE.
    bool covariance(size_t object, const TTEpoch& at, const astro::Mat6& p0, const astro::Integrator::ProcessNoise& noise,
                    astro::StateVector& state, astro::Mat6& p, std::string& error);
    // Segments covering [start, end] (TT) fitted and kept; earlier ones dropped.
    bool prepare(size_t object, const TTEpoch& start, const TTEpoch& end, std::string& error);
    // Prepare exactly the selected objects; report the failing slot for the
    // resident port's existing per-object stop/error handling.
    bool prepareBatch(const std::vector<size_t>& selected, const TTEpoch& start, const TTEpoch& end,
                      size_t& failedObject, std::string& error);
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
