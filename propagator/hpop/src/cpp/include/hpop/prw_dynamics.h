#pragma once
// The dynamics of a PRW execution request, shared by the execution path
// (prw_execution.cpp) and the resident instance: the parsed force set and
// integrator, the environment wired into the force set, and the integration
// of the state (and its transition matrix) through the space-weather
// restarts.
#include "hpop/prw_environment.h"
#include "hpop/prw_covariance.h"
#include "integrators.h"
#include "variational.h"
#include "finite_burn.h"
#include "force_partials.h"
#include "ephemeris.h"
#include <array>
#include <memory>
#include <string>
#include <vector>

namespace hpop {
namespace dynamics {

struct Execution {
    StateVector initial;
    double target = 0, mass = 1000;
    IntegratorConfig integrator;
    ForceModel::ForceModelSet forces;
    Integrator::STMMethod technique = Integrator::STMMethod::Analytic;
    ForceModel::DensityGradient density = ForceModel::DensityGradient::Neglected;
    bool massDynamics = false, variational = false, covariance = false, massCovariance = false;
    // Sampled, without STM, covariance, parameters, impulses or burns: the
    // 6-state equations only (evaluateStatesInOrder).
    bool stateOnly = false;
    Mat6 p{};
    Integrator::Matrix7 p7{};
    std::vector<double> samples;
    // The integration clock (TT), exact; the doubles above are TDB Julian
    // dates kept for ephemeris lookups and the legacy integrator interfaces.
    TTEpoch initialTT, targetTT;
    std::vector<TTEpoch> samplesTT;
    std::vector<ForceModel::ImpulsiveManeuverDef> impulses;
    std::vector<Integrator::FiniteBurn> burns;
    Integrator::ProcessNoise noise;
    // The request's axes are EME2000 (mean equator and equinox of J2000.0):
    // HPOP integrates in GCRF and rotates inputs and outputs by the IAU 2000
    // frame bias (ERFA eraBp00 rb, GCRF -> EME2000; constant).
    bool meanJ2000 = false;
    double bias[3][3] = {{1,0,0},{0,1,0},{0,0,1}};
    // DYNAMIC_PARAMETERS, and the (6 + parameters)^2 initial covariance in km
    // units when they are given with one.
    std::vector<ForceModel::DynamicParameter> parameters;
    std::vector<double> pParameters;
    // The space_weather table's change epochs (TT, ascending) for drag models
    // that read it as published, piecewise constant: NRLMSISE-00 and
    // Jacchia-Roberts take daily F10.7, F10.7a and Ap and 3-hourly Kp
    // (Jacchia-Roberts 6.7 h earlier). The integration restarts at each, as
    // at a sample epoch, and while a span is integrated the table is read
    // inside that span (driverSpan, UTC Julian dates), so no step mixes two
    // days' or two slots' indices. Without this, integrations whose steps
    // fall differently across a change differ by about a centimetre a day in
    // LEO. Finite burns are integrated without these restarts.
    std::vector<TTEpoch> breaks;
    std::shared_ptr<std::array<double,2>> driverSpan;
};
// The variational path without mass dynamics visits the request's epochs in
// time order, forward and backward of the initial epoch separately, and
// integrates each span between consecutive epochs once. The state, the
// (6 + parameters) transition matrix and the covariance carry from one epoch to
// the next: Phi(t_k, t_0) = Phi(t_k, t_k-1) Phi(t_k-1, t_0), and P is
// transported span by span with process noise added on each span as on a
// single arc. The work grows with the arc, not with the arc times the samples.
// A request without samples is one span, computed as before.
struct Cursor {
    StateVector state;
    TTEpoch tt;
    std::vector<double> phi, p;  // n x n, n = 6 + parameters
    uint32_t steps = 0, rejections = 0;
};

// GCRF <-> request axes.
Vec3 toRequestAxes(const Execution& e,const Vec3& v);
Vec3 toGcrf(const Execution& e,const Vec3& v);
// M <- R M R^T for an n x n row-major covariance or STM on [r, v, rest].
void rotateMatrix(const Execution& e,double* m,unsigned n,bool toRequest);
bool parseIntegrator(const PRWIntegratorSettings* in, bool mass, IntegratorConfig& out, std::string& error);
bool parseForces(const PRWForceConfiguration* in,double epoch,bool hasEarthOrientation,ForceModel::ForceModelSet& out,std::string& error);
bool parseExecution(const PRWExecutionRequest* in,bool hasEarthOrientation,Execution& out,std::string& error);
// The kernel holds every body the force set reads at both ends of the arc.
bool preflightKernel(const Execution& in,double target,std::string& error);
double utcJd(const TTEpoch& tt);
// The space_weather table's change epochs strictly inside the arc (initial,
// target and samples), ascending.
std::vector<TTEpoch> driverBreaks(const Execution& e);
// The change epochs strictly inside (lo, hi), ascending.
std::vector<TTEpoch> driverBreaks(const Execution& e,const TTEpoch& lo,const TTEpoch& hi);
// The breaks strictly between from and to, in the direction of travel.
std::vector<TTEpoch> breaksBetween(const Execution& e,const TTEpoch& from,const TTEpoch& to);
// The span the table is read in while [from, to] is integrated.
void setDriverSpan(Execution& e,const TTEpoch& from,const TTEpoch& to);
// The 6-state equations from (state, at) to `to` through the breaks.
bool propagateState(Execution& execution,StateVector& state,TTEpoch& at,const TTEpoch& to,uint32_t& steps,uint32_t& rejections,std::string& error);
bool advanceSpan(Execution& execution,Cursor& c,const TTEpoch& to,std::string& error);
bool advance(Execution& execution,Cursor& c,const TTEpoch& to,std::string& error);
// The environment wired into the execution's force set (drivers, Earth
// orientation); requestWeather: its force configuration carries WEATHER.
bool attachEnvironment(Execution& execution,const Environment& environment,bool requestWeather,std::string& error);
// The environment covers the arc [first, last] (TDB Julian dates).
bool environmentCovers(const Execution& execution,const Environment& environment,double first,double last,std::string& error);

} // namespace dynamics
} // namespace hpop
