#include "hpop/plugin_runtime.h"

#include "astrodynamics.h"
#include "astrodynamics_types.h"
#include "integrators.h"
#include "variational.h"
#include "finite_burn.h"
#include "force_models.h"
#include "coords.h"
#include "ephemeris.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>

// Real NRLMSISE-00 (public-domain Brodowski C port, vendored in
// third_party/nrlmsise00/).
extern "C" {
#include "nrlmsise-00.h"
}

namespace hpop {

using json = nlohmann::json;

namespace {

std::string version() { return "0.1.0"; }

PluginInvokeResult make_error_result(
    std::string error_code,
    std::string error_message) {
    PluginInvokeResult result{};
    result.ok = false;
    result.error_code = std::move(error_code);
    result.error_message = std::move(error_message);
    result.json = json({
        {"error", result.error_message},
        {"errorCode", result.error_code},
    }).dump();
    return result;
}

astro::IntegrationMethod parse_integration_method(const std::string& raw_name) {
    std::string name = raw_name;
    std::transform(
        name.begin(),
        name.end(),
        name.begin(),
        [](unsigned char ch) { return static_cast<char>(std::toupper(ch)); });

    if (name == "RK4") {
        return astro::IntegrationMethod::RK4;
    }
    if (name == "RKF45") {
        return astro::IntegrationMethod::RKF45;
    }
    if (name == "RKF78") {
        return astro::IntegrationMethod::RKF78;
    }
    if (name == "RK78") {
        return astro::IntegrationMethod::RK78;
    }
    if (name == "RKDP87") return astro::IntegrationMethod::RKDP87;
    if (name == "ABM") {
        return astro::IntegrationMethod::ABM;
    }
    if (name == "BS") {
        return astro::IntegrationMethod::BS;
    }
    if (name == "COWELL") {
        return astro::IntegrationMethod::Cowell;
    }
    if (name == "ENCKE") {
        return astro::IntegrationMethod::Encke;
    }
    if (name == "EQUINOCTIALVOP") {
        return astro::IntegrationMethod::EquinoctialVOP;
    }
    throw std::runtime_error("Unknown integrator method: " + raw_name);
}

void configure_integrator(
    const json& params,
    astro::IntegratorConfig& config) {
    if (!params.contains("integrator")) {
        return;
    }

    const auto& integrator = params.at("integrator");
    if (integrator.contains("method")) {
        config.method =
            parse_integration_method(integrator.at("method").get<std::string>());
    }
    if (integrator.contains("initialStep")) {
        config.initialStep = integrator.at("initialStep").get<double>();
    }
    if (integrator.contains("minStep")) {
        config.minStep = integrator.at("minStep").get<double>();
    }
    if (integrator.contains("maxStep")) {
        config.maxStep = integrator.at("maxStep").get<double>();
    }
    if (integrator.contains("absTolerance")) {
        config.absTolerance = integrator.at("absTolerance").get<double>();
    }
    if (integrator.contains("relTolerance")) {
        config.relTolerance = integrator.at("relTolerance").get<double>();
    }
    if (integrator.contains("tolerance")) {
        const double tolerance = integrator.at("tolerance").get<double>();
        config.absTolerance = tolerance;
        config.relTolerance = tolerance;
    }
    if (integrator.contains("maxSteps")) {
        const auto& value=integrator.at("maxSteps");
        if(!value.is_number_integer()||value.get<double>()<1||
           value.get<double>()>std::numeric_limits<uint32_t>::max()/10)
            throw std::runtime_error("maxSteps must be an integer between 1 and 429496729.");
        config.maxSteps = value.get<uint32_t>();
    }
}

double read_optional_double(
    const json& value,
    const char* first_key,
    const char* second_key,
    double fallback) {
    if (value.contains(first_key)) {
        return value.at(first_key).get<double>();
    }
    if (second_key != nullptr && value.contains(second_key)) {
        return value.at(second_key).get<double>();
    }
    return fallback;
}

bool read_optional_bool(
    const json& value,
    const char* first_key,
    const char* second_key,
    bool fallback) {
    if (value.contains(first_key)) {
        return value.at(first_key).get<bool>();
    }
    if (second_key != nullptr && value.contains(second_key)) {
        return value.at(second_key).get<bool>();
    }
    return fallback;
}

void configure_force_models(
    const json& params,
    double epoch_jd,
    astro::ForceModel::ForceModelSet& forces) {
    using namespace astro;

    forces.usePointMass = true;
    forces.mu = MU_EARTH;
    forces.useSphericalHarmonics = true;
    forces.sphericalHarmonics.includeJ2 = true;
    forces.sphericalHarmonics.includeJ3 = false;
    forces.sphericalHarmonics.includeJ4 = false;
    forces.weather.epoch = epoch_jd;

    double mass = 1000.0;
    double area = 10.0;
    if (params.contains("spacecraft")) {
        const auto& spacecraft = params.at("spacecraft");
        mass = read_optional_double(spacecraft, "massKg", "mass", mass);
        area = read_optional_double(spacecraft, "areaM2", "area", area);
    }

    if (!params.contains("forces")) {
        forces.srp.mass = mass;
        forces.srp.area = area;
        forces.drag.mass = mass;
        forces.drag.area = area;
        return;
    }

    const auto& requested = params.at("forces");

    forces.usePointMass =
        read_optional_bool(requested, "centralBody", "pointMass", forces.usePointMass);
    forces.mu = read_optional_double(requested, "mu", nullptr, forces.mu);

    const bool use_j2 = read_optional_bool(requested, "j2", nullptr, true);
    const bool use_j3 = read_optional_bool(requested, "j3", nullptr, false);
    const bool use_j4 = read_optional_bool(requested, "j4", nullptr, false);
    forces.useSphericalHarmonics = use_j2 || use_j3 || use_j4;
    forces.sphericalHarmonics.includeJ2 = use_j2;
    forces.sphericalHarmonics.includeJ3 = use_j3;
    forces.sphericalHarmonics.includeJ4 = use_j4;
    forces.sphericalHarmonics.mu = forces.mu;
    if (requested.contains("higherZonals"))
        forces.sphericalHarmonics.includeHigherZonals = requested.at("higherZonals").get<bool>();
    if(requested.value("higherZonals",false)) forces.useSphericalHarmonics=true;
    if (requested.contains("gravityMode")) {
        const std::string mode=requested.at("gravityMode").get<std::string>();
        if(mode=="POINT_MASS") forces.gravityMode=ForceModel::GravityMode::PointMass;
        else if(mode=="J2") forces.gravityMode=ForceModel::GravityMode::J2Only;
        else if(mode=="J2_J4") forces.gravityMode=ForceModel::GravityMode::J2J4;
        else if(mode=="SPHERICAL_HARMONICS") forces.gravityMode=ForceModel::GravityMode::SphericalHarmonics;
        else if(mode=="EGM2008") forces.gravityMode=ForceModel::GravityMode::EGM2008;
        else throw std::runtime_error("Unknown gravityMode: "+mode);
    }
    if(requested.contains("maxDegree")) forces.egm2008.truncationDegree=requested.at("maxDegree").get<uint16_t>();
    if(requested.contains("maxOrder")) forces.egm2008.truncationOrder=requested.at("maxOrder").get<uint16_t>();
    if (requested.contains("maxDegree")) {
        forces.sphericalHarmonics.maxDegree =
            requested.at("maxDegree").get<uint16_t>();
    }
    if (requested.contains("maxOrder")) {
        forces.sphericalHarmonics.maxOrder =
            requested.at("maxOrder").get<uint16_t>();
    }

    forces.useThirdBody =
        read_optional_bool(requested, "thirdBody", nullptr, forces.useThirdBody);
    forces.thirdBody.includeSun =
        read_optional_bool(requested, "thirdBodySun", "sun", forces.thirdBody.includeSun);
    forces.thirdBody.includeMoon =
        read_optional_bool(requested, "thirdBodyMoon", "moon", forces.thirdBody.includeMoon);
    forces.thirdBody.includeMercury = read_optional_bool(requested, "thirdBodyMercury", "mercury", forces.thirdBody.includeMercury);
    forces.thirdBody.includeVenus = read_optional_bool(requested, "thirdBodyVenus", "venus", forces.thirdBody.includeVenus);
    forces.thirdBody.includeMars = read_optional_bool(requested, "thirdBodyMars", "mars", forces.thirdBody.includeMars);
    forces.thirdBody.includeJupiter = read_optional_bool(requested, "thirdBodyJupiter", "jupiter", forces.thirdBody.includeJupiter);
    forces.thirdBody.includeSaturn = read_optional_bool(requested, "thirdBodySaturn", "saturn", forces.thirdBody.includeSaturn);
    forces.thirdBody.includeUranus = read_optional_bool(requested, "thirdBodyUranus", "uranus", forces.thirdBody.includeUranus);
    forces.thirdBody.includeNeptune = read_optional_bool(requested, "thirdBodyNeptune", "neptune", forces.thirdBody.includeNeptune);

    forces.useSRP = read_optional_bool(requested, "srp", nullptr, forces.useSRP);
    forces.useDrag = read_optional_bool(requested, "drag", nullptr, forces.useDrag);

    mass = read_optional_double(requested, "massKg", "mass", mass);
    area = read_optional_double(requested, "areaM2", "area", area);

    forces.srp.mass = mass;
    forces.srp.area = area;
    forces.srp.Cr = read_optional_double(requested, "cr", "Cr", forces.srp.Cr);

    forces.drag.mass = mass;
    forces.drag.area = area;
    forces.drag.Cd = read_optional_double(requested, "cd", "Cd", forces.drag.Cd);
    if(requested.contains("dragModel")) {
        const std::string model=requested.at("dragModel").get<std::string>();
        if(model=="NRLMSISE00")forces.dragModel=ForceModel::DragModelType::NRLMSISE00;
        else if(model=="EXPONENTIAL")forces.dragModel=ForceModel::DragModelType::Exponential;
        else if(model=="USSA1976")forces.dragModel=ForceModel::DragModelType::USSA1976;
        else if(model=="HARRIS_PRIESTER")forces.dragModel=ForceModel::DragModelType::HarrisPriester;
        else throw std::runtime_error("Unknown supported dragModel: "+model);
        forces.drag.model=forces.dragModel;
    }
}

void configure_weather(
    const json& params,
    double epoch_jd,
    astro::ForceModel::ForceModelSet& forces) {
    forces.weather.epoch = epoch_jd;
    if (!params.contains("weather")) {
        return;
    }

    const auto& weather = params.at("weather");
    forces.weather.F107 = read_optional_double(weather, "F107", "f107", forces.weather.F107);
    forces.weather.F107a = read_optional_double(weather, "F107a", "f107a", forces.weather.F107a);
    forces.weather.Ap = read_optional_double(weather, "Ap", "ap", forces.weather.Ap);
    forces.weather.Kp = read_optional_double(weather, "Kp", "kp", forces.weather.Kp);
}

double finite_number(const json& value, const std::string& field) {
    if (!value.is_number()) throw std::runtime_error(field + " must be a finite number.");
    const double number = value.get<double>();
    if (!std::isfinite(number)) throw std::runtime_error(field + " must be a finite number.");
    return number;
}

astro::Vec3 finite_vector(const json& value, const std::string& field) {
    if (!value.is_array() || value.size() != 3)
        throw std::runtime_error(field + " must contain exactly three finite components.");
    return astro::Vec3(finite_number(value.at(0), field),
                       finite_number(value.at(1), field),
                       finite_number(value.at(2), field));
}

astro::Integrator::BurnEvent parse_burn_event(const json& value) {
    using namespace astro::Integrator;
    if (!value.is_object()) throw std::runtime_error("Burn event must be an object.");
    BurnEvent event;
    const auto kind = value.at("kind").get<std::string>();
    if (kind == "RADIUS") event.kind = BurnEventKind::Radius;
    else if (kind == "SPEED") event.kind = BurnEventKind::Speed;
    else if (kind == "RADIAL_VELOCITY") event.kind = BurnEventKind::RadialVelocity;
    else if (kind == "NODE") event.kind = BurnEventKind::Node;
    else if (kind == "MASS") event.kind = BurnEventKind::Mass;
    else throw std::runtime_error("Burn event kind must be RADIUS, SPEED, RADIAL_VELOCITY, NODE, or MASS.");
    event.goal = finite_number(value.at("goal"), "Burn event goal");
    if (value.contains("direction")) {
        const auto& direction = value.at("direction");
        if (!direction.is_number_integer() || direction.get<double>() < -1 || direction.get<double>() > 1)
            throw std::runtime_error("Burn event direction must be -1, 0, or 1.");
        event.direction = direction.get<int>();
    }
    if ((event.kind == BurnEventKind::Radius || event.kind == BurnEventKind::Mass) && event.goal <= 0)
        throw std::runtime_error("Radius and mass event goals must be positive.");
    if (event.kind == BurnEventKind::Speed && event.goal < 0)
        throw std::runtime_error("Speed event goal must be nonnegative.");
    return event;
}

// Scheduled times and throttle/steering clocks stay relative to epochJD even
// when evaluating an intermediate sample or a burn starts on an event.
std::vector<astro::Integrator::FiniteBurn> parse_finite_burns(
    const json& input, double epoch_jd, double target_seconds) {
    using namespace astro::Integrator;
    if (!input.is_array() || input.size() > MaxFiniteBurns)
        throw std::runtime_error("finiteBurns must be an array of at most 16 burns.");
    std::vector<FiniteBurn> burns;
    for (const auto& item : input) {
        if (!item.is_object()) throw std::runtime_error("Each finite burn must be an object.");
        FiniteBurn burn;
        auto edge = [&](const char* seconds_key, const char* jd_key, const char* epoch_key,
                        const char* event_key, double fallback) {
            const int count = int(item.contains(seconds_key)) + int(item.contains(jd_key)) + int(item.contains(epoch_key));
            if (count > 1) throw std::runtime_error(std::string("Specify only one of ") + seconds_key + ", " + jd_key + ", or " + epoch_key + ".");
            if (item.contains(seconds_key)) return finite_number(item.at(seconds_key), seconds_key);
            if (item.contains(jd_key)) return (finite_number(item.at(jd_key), jd_key) - epoch_jd) * 86400.0;
            if (item.contains(epoch_key)) return (finite_number(item.at(epoch_key), epoch_key) - epoch_jd) * 86400.0;
            if (!item.contains(event_key)) throw std::runtime_error(std::string("Finite burn requires ") + seconds_key + ", " + jd_key + ", or " + event_key + ".");
            return fallback;
        };
        burn.startSeconds = edge("startSeconds", "startJD", "startEpochJD", "startEvent", 0.0);
        burn.stopSeconds = edge("stopSeconds", "stopJD", "stopEpochJD", "stopEvent", target_seconds);
        if (!std::isfinite(burn.startSeconds) || !std::isfinite(burn.stopSeconds) ||
            burn.startSeconds < 0 || burn.stopSeconds <= burn.startSeconds)
            throw std::runtime_error("Finite burn requires 0 <= startSeconds < stopSeconds.");
        if (item.contains("startEvent")) burn.startEvent = parse_burn_event(item.at("startEvent"));
        if (item.contains("stopEvent")) burn.stopEvent = parse_burn_event(item.at("stopEvent"));
        if (item.contains("thrustNewtons") == item.contains("accelerationKmS2"))
            throw std::runtime_error("Finite burn requires exactly one of thrustNewtons or accelerationKmS2.");
        if (item.contains("thrustNewtons")) burn.thrustNewtons = finite_number(item.at("thrustNewtons"), "thrustNewtons");
        else burn.accelerationKmS2 = finite_number(item.at("accelerationKmS2"), "accelerationKmS2");
        if (burn.thrustNewtons < 0 || burn.accelerationKmS2 < 0 ||
            (burn.thrustNewtons == 0 && burn.accelerationKmS2 == 0))
            throw std::runtime_error("Finite burn thrust or acceleration must be positive.");
        burn.ispSeconds = finite_number(item.at("ispSeconds"), "ispSeconds");
        if (burn.ispSeconds <= 0) throw std::runtime_error("ispSeconds must be positive.");
        const auto frame = item.value("frame", std::string("INERTIAL"));
        if (frame == "INERTIAL") burn.frame = BurnFrame::Inertial;
        else if (frame == "RTN" || frame == "LVLH") burn.frame = BurnFrame::RTN;
        else if (frame == "VNC") burn.frame = BurnFrame::VNC;
        else if (frame == "VELOCITY") burn.frame = BurnFrame::Velocity;
        else if (frame == "ANTI_VELOCITY") burn.frame = BurnFrame::AntiVelocity;
        else throw std::runtime_error("Finite burn frame must be INERTIAL, RTN, LVLH, VNC, VELOCITY, or ANTI_VELOCITY.");
        if (item.contains("direction")) burn.direction = finite_vector(item.at("direction"), "direction");
        if (item.contains("steeringRate")) burn.steeringRate = finite_vector(item.at("steeringRate"), "steeringRate");
        if (burn.direction.x == 0 && burn.direction.y == 0 && burn.direction.z == 0)
            throw std::runtime_error("Finite burn direction must be nonzero.");
        if ((burn.frame == BurnFrame::Velocity || burn.frame == BurnFrame::AntiVelocity) &&
            (item.contains("direction") || item.contains("steeringRate")))
            throw std::runtime_error("VELOCITY and ANTI_VELOCITY frames define their direction and do not accept direction or steeringRate.");
        if (item.contains("throttle")) {
            const auto& table = item.at("throttle");
            if (!table.is_array() || table.size() > 10000)
                throw std::runtime_error("throttle must be an array of at most 10000 points.");
            double last_seconds = -1;
            for (const auto& point : table) {
                if (!point.is_object()) throw std::runtime_error("Throttle point must be an object.");
                ThrottlePoint entry;
                entry.seconds = finite_number(point.at("seconds"), "Throttle seconds");
                entry.throttle = finite_number(point.at("throttle"), "Throttle value");
                if (entry.seconds < 0 || entry.seconds <= last_seconds || entry.throttle < 0 || entry.throttle > 1)
                    throw std::runtime_error("Throttle points require increasing nonnegative seconds and throttle in [0,1].");
                last_seconds = entry.seconds;
                burn.throttle.push_back(entry);
            }
        }
        burns.push_back(std::move(burn));
    }
    return burns;
}

std::string propagate_json(const json& params, std::string& operation_error) {
    using namespace astro;

    // Parse initial state
    const double epoch_jd = params.at("epochJD").get<double>();
    const double target_jd = params.at("targetJD").get<double>();

    const auto& pos = params.at("position");
    const auto& vel = params.at("velocity");

    StateVector sv;
    sv.position.x = pos.at(0).get<double>();
    sv.position.y = pos.at(1).get<double>();
    sv.position.z = pos.at(2).get<double>();
    sv.velocity.x = vel.at(0).get<double>();
    sv.velocity.y = vel.at(1).get<double>();
    sv.velocity.z = vel.at(2).get<double>();
    sv.epoch = epoch_jd;

    IntegratorConfig config;
    configure_integrator(params, config);

    ForceModel::ForceModelSet forces;
    configure_force_models(params, epoch_jd, forces);
    configure_weather(params, epoch_jd, forces);

    // Check the requested force bodies at both ends before integration. A
    // missing/out-of-coverage kernel must not integrate a partial force model.
    if (Ephemeris::selectedEphemerisSource() != Ephemeris::EphemerisSource::Analytical) {
        const auto& third = forces.thirdBody;
        const std::pair<int, bool> bodies[] = {
            {10, forces.useSRP || (forces.useThirdBody && third.includeSun)},
            {301, forces.useThirdBody && third.includeMoon},
            {1, forces.useThirdBody && third.includeMercury},
            {2, forces.useThirdBody && third.includeVenus},
            {4, forces.useThirdBody && third.includeMars},
            {5, forces.useThirdBody && third.includeJupiter},
            {6, forces.useThirdBody && third.includeSaturn},
            {7, forces.useThirdBody && third.includeUranus},
            {8, forces.useThirdBody && third.includeNeptune},
        };
        for (const auto& body : bodies) if (body.second) {
            if (!Ephemeris::getKernelState(body.first, 399, epoch_jd).valid ||
                !Ephemeris::getKernelState(body.first, 399, target_jd).valid) return "{}";
        }
    }

    const double dt_sec = (target_jd - epoch_jd) * 86400.0;
    const bool with_finite_burns = params.contains("finiteBurns");
    if (params.contains("covariance7") && !with_finite_burns)
        throw std::runtime_error("covariance7 requires finiteBurns (an empty array is allowed).");
    // State-only requests retain their existing cost. A requested STM or
    // covariance defaults to the coupled analytical variational equations.
    const bool with_stm=params.value("includeSTM",false)||params.contains("STM_METHOD")||
        params.contains("covariance")||params.contains("sampleEpochsJD")||params.contains("maneuvers")||with_finite_burns;
    if(with_stm) {
        const std::string method_name=params.value("STM_METHOD",std::string("ANALYTIC"));
        Integrator::STMMethod method;
        if(method_name=="ANALYTIC")method=Integrator::STMMethod::Analytic;
        else if(method_name=="FINITE_DIFFERENCE")method=Integrator::STMMethod::FiniteDifference;
        else throw std::runtime_error("STM_METHOD must be ANALYTIC or FINITE_DIFFERENCE.");
        if(with_finite_burns && method != Integrator::STMMethod::Analytic)
            throw std::runtime_error("finiteBurns requires STM_METHOD ANALYTIC.");
        const std::string density_name=params.value("DENSITY_GRADIENT",std::string("NEGLECTED"));
        ForceModel::DensityGradient density;
        if(density_name=="NEGLECTED")density=ForceModel::DensityGradient::Neglected;
        else if(density_name=="FINITE_DIFFERENCE")density=ForceModel::DensityGradient::FiniteDifference;
        else throw std::runtime_error("DENSITY_GRADIENT must be NEGLECTED or FINITE_DIFFERENCE.");
        std::vector<ForceModel::ImpulsiveManeuverDef> burns;
        if(params.contains("maneuvers") && !params.at("maneuvers").is_array())
            throw std::runtime_error("maneuvers must be an array.");
        if(params.contains("maneuvers")) for(const auto& item:params.at("maneuvers")) {
            ForceModel::ImpulsiveManeuverDef burn;
            burn.epoch=item.at("epochJD").get<double>();
            const auto& dv=item.at("deltaV");
            if(dv.size()!=3)throw std::runtime_error("Maneuver deltaV must contain three km/s components.");
            burn.deltaV=Vec3(dv.at(0).get<double>(),dv.at(1).get<double>(),dv.at(2).get<double>());
            const auto frame=item.value("frame",std::string("INERTIAL"));
            if(frame!="INERTIAL"&&frame!="RTN")throw std::runtime_error("Maneuver frame must be INERTIAL or RTN.");
            burn.inRTN=frame=="RTN"; burns.push_back(burn);
        }
        Mat6 covariance{};
        const bool has_covariance=params.contains("covariance");
        if(has_covariance) {
            const auto& input=params.at("covariance");
            if(!input.is_array()||input.size()!=36)throw std::runtime_error("covariance must be a row-major array of 36 km/km-s entries.");
            for(int i=0;i<6;++i)for(int j=0;j<6;++j) {
                covariance.m[i][j]=input.at(i*6+j).get<double>();
                if(!std::isfinite(covariance.m[i][j]))throw std::runtime_error("covariance must be finite.");
            }
        }
        auto flat=[](const Mat6& m) {
            json a=json::array();for(int i=0;i<6;++i)for(int j=0;j<6;++j)a.push_back(m.m[i][j]);return a;
        };
        std::vector<Integrator::FiniteBurn> finite_burns;
        double mass_kg = forces.drag.mass;
        Integrator::Matrix7 covariance7{};
        const bool has_covariance7 = params.contains("covariance7");
        if(with_finite_burns) {
            if(!std::isfinite(epoch_jd) || !std::isfinite(target_jd) || !std::isfinite(dt_sec) || dt_sec < 0)
                throw std::runtime_error("Finite burns require finite epochs and forward propagation.");
            if(params.contains("massKg")) mass_kg = finite_number(params.at("massKg"), "massKg");
            if(!std::isfinite(mass_kg) || mass_kg <= 0)
                throw std::runtime_error("Finite-burn initial massKg must be positive and finite.");
            finite_burns = parse_finite_burns(params.at("finiteBurns"), epoch_jd, dt_sec);
            if(has_covariance7) {
                const auto& input = params.at("covariance7");
                if(!input.is_array() || input.size() != 49)
                    throw std::runtime_error("covariance7 must be a row-major array of 49 entries for [x,y,z,vx,vy,vz,massKg].");
                for(int i = 0; i < 49; ++i) covariance7[i] = finite_number(input.at(i), "covariance7");
            }
        }
        auto evaluate=[&](double jd) {
            if(!std::isfinite(jd))throw std::runtime_error("Sample epoch must be finite.");
            if(with_finite_burns) {
                if(jd < epoch_jd) throw std::runtime_error("Finite-burn sample epochs must not precede epochJD.");
                auto result = Integrator::PropagateFiniteBurns(sv, mass_kg, (jd-epoch_jd)*86400.0,
                    config, forces, finite_burns, density, burns);
                if(!result.success) {
                    operation_error = result.errorMessage;
                    return json::object();
                }
                Mat6 stm{};
                for(int i = 0; i < 6; ++i) for(int j = 0; j < 6; ++j) stm.m[i][j] = result.stm[i*7+j];
                json value = {{"epochJD",jd},
                    {"position",{result.finalState.position.x,result.finalState.position.y,result.finalState.position.z}},
                    {"velocity",{result.finalState.velocity.x,result.finalState.velocity.y,result.finalState.velocity.z}},
                    {"massKg",result.massKg}, {"stm",flat(stm)}, {"stm7",result.stm},
                    {"integrationSteps",result.steps}, {"integrationRejections",result.rejections}};
                if(has_covariance) value["covariance"] = flat(Integrator::TransportCovariance(stm,covariance));
                if(has_covariance7) value["covariance7"] = Integrator::TransportFiniteCovariance(result.stm,covariance7);
                value["burnSummary"] = json::array();
                for(size_t i = 0; i < result.burns.size(); ++i) {
                    const auto& burn = result.burns[i];
                    json summary = {{"index",i}, {"deltaVKmS",burn.deltaVKmS}, {"propellantKg",burn.propellantKg},
                        {"started",burn.started}, {"stopped",burn.stopped},
                        {"startByEvent",burn.startByEvent}, {"stopByEvent",burn.stopByEvent}};
                    summary["startSeconds"] = burn.started ? json(burn.startSeconds) : json(nullptr);
                    summary["stopSeconds"] = burn.stopped ? json(burn.stopSeconds) : json(nullptr);
                    summary["startEpochJD"] = burn.started ? json(epoch_jd + burn.startSeconds/86400.0) : json(nullptr);
                    summary["stopEpochJD"] = burn.stopped ? json(epoch_jd + burn.stopSeconds/86400.0) : json(nullptr);
                    value["burnSummary"].push_back(std::move(summary));
                }
                return value;
            }
            auto result=Integrator::PropagateWithSTM(sv,(jd-epoch_jd)*86400.0,config,forces,method,density,burns);
            if(!result.success) {
                operation_error=result.errorMessage;
                return json::object();
            }
            json value={{"epochJD",jd},
                {"position",{result.finalState.position.x,result.finalState.position.y,result.finalState.position.z}},
                {"velocity",{result.finalState.velocity.x,result.finalState.velocity.y,result.finalState.velocity.z}},
                {"stm",flat(result.stm)},{"integrationSteps",result.steps},{"integrationRejections",result.rejections}};
            if(has_covariance)value["covariance"]=flat(Integrator::TransportCovariance(result.stm,covariance));
            return value;
        };
        json output=evaluate(target_jd);
        if(!operation_error.empty())return "{}";
        output["STM_METHOD"]=method_name;output["DENSITY_GRADIENT"]=density_name;
        output["propagatedDeltaSeconds"]=dt_sec;output["epochTimeScale"]="TDB";
        output["frame"]="GCRF";output["positionUnits"]="km";output["velocityUnits"]="km/s";
        if(with_finite_burns) output["massUnits"]="kg";
        output["ephemerisSource"]=Ephemeris::ephemerisSourceName(Ephemeris::selectedEphemerisSource());
        if(params.contains("sampleEpochsJD")) {
            if(!params.at("sampleEpochsJD").is_array()||params.at("sampleEpochsJD").size()>10000)
                throw std::runtime_error("sampleEpochsJD must be an array of at most 10000 epochs.");
            output["samples"]=json::array();
            // Each STM is cumulative from epochJD, as estimation expects.
            for(const auto& epoch:params.at("sampleEpochsJD")) {
                auto sample=evaluate(epoch.get<double>());
                if(!operation_error.empty())return "{}";
                output["samples"].push_back(std::move(sample));
            }
        }
        return output.dump();
    }
    if (std::abs(dt_sec) < 1e-12) {
        return json({
            {"epochJD", target_jd},
            {"position", {sv.position.x, sv.position.y, sv.position.z}},
            {"velocity", {sv.velocity.x, sv.velocity.y, sv.velocity.z}},
            {"propagatedDeltaSeconds", 0.0},
            {"integrationSteps", 0},
            {"ephemerisSource", Ephemeris::ephemerisSourceName(Ephemeris::selectedEphemerisSource())},
            {"epochTimeScale", "TDB"},
        }).dump();
    }

    const auto result = Integrator::PropagateWithResult(sv, dt_sec, config, forces);
    if (!Ephemeris::ephemerisError().empty()) return "{}";
    if (!result.success) {
        operation_error = result.errorMessage.empty()
            ? "Integration failed to reach target epoch." : result.errorMessage;
        return "{}";
    }

    json output = {
        {"epochJD", target_jd},
        {"position", {
            result.finalState.position.x,
            result.finalState.position.y,
            result.finalState.position.z,
        }},
        {"velocity", {
            result.finalState.velocity.x,
            result.finalState.velocity.y,
            result.finalState.velocity.z,
        }},
        {"propagatedDeltaSeconds", dt_sec},
        {"integrationSteps", result.steps},
        {"ephemerisSource", Ephemeris::ephemerisSourceName(Ephemeris::selectedEphemerisSource())},
        {"epochTimeScale", "TDB"},
    };

    return output.dump();
}

// Direct atmosphere query against the same model implementations used by the
// HPOP drag force path. Honest model names:
//   "NRLMSISE00"     — real NRLMSISE-00 (vendored Picone/Hedin/Drob C port)
//   "USSA1976"       — US Standard Atmosphere 1976, 0-86 km geometric
//   "EXPONENTIAL"    — Vallado piecewise-exponential model (Table 8-4)
// The simplified JB2008/DTM2020 approximations are intentionally NOT exposed
// here; they are crude approximations, not the published coefficient models.
std::string atmosphere_json(const json& params) {
    const auto model = params.value("model", std::string("NRLMSISE00"));

    if (model == "USSA1976") {
        const double alt_km = params.at("altitudeKm").get<double>();
        const auto atm = astro::computeUSSA1976(alt_km);
        return json({
            {"model", "USSA1976"},
            {"altitudeKm", alt_km},
            {"densityKgM3", atm.density},
            {"temperatureK", atm.temperature},
            {"scaleHeightKm", atm.scaleHeight},
        }).dump();
    }

    if (model == "EXPONENTIAL") {
        const double alt_km = params.at("altitudeKm").get<double>();
        return json({
            {"model", "EXPONENTIAL"},
            {"altitudeKm", alt_km},
            {"densityKgM3", astro::exponentialAtmosphereDensity(alt_km)},
        }).dump();
    }

    if (model != "NRLMSISE00") {
        throw std::runtime_error(
            "Unknown atmosphere model \"" + model +
            "\". Supported: NRLMSISE00, USSA1976, EXPONENTIAL.");
    }

    nrlmsise_input input;
    nrlmsise_flags flags;
    nrlmsise_output output;
    std::memset(&input, 0, sizeof(input));
    std::memset(&flags, 0, sizeof(flags));
    std::memset(&output, 0, sizeof(output));

    flags.switches[0] = 0;
    for (int i = 1; i < 24; ++i) {
        flags.switches[i] = 1;
    }

    input.year = params.value("year", 0);
    input.doy = params.value("dayOfYear", 172);
    input.sec = params.value("secondOfDay", 29000.0);
    input.alt = params.at("altitudeKm").get<double>();
    input.g_lat = params.value("latitudeDeg", 0.0);
    input.g_long = params.value("longitudeDeg", 0.0);
    if (params.contains("localSolarTimeHours")) {
        input.lst = params.at("localSolarTimeHours").get<double>();
    } else {
        // Recommended consistency relation (NRLMSISE-00 package notes).
        double lst = input.sec / 3600.0 + input.g_long / 15.0;
        lst = std::fmod(lst, 24.0);
        if (lst < 0.0) lst += 24.0;
        input.lst = lst;
    }
    input.f107A = params.value("f107a", 150.0);
    input.f107 = params.value("f107", 150.0);
    input.ap = params.value("ap", 4.0);
    input.ap_a = nullptr;

    // gtd7: total mass density excludes anomalous oxygen (canonical test
    // vectors). gtd7d: includes anomalous oxygen (drag-effective density,
    // what the HPOP drag path uses).
    const bool includeAnomalousOxygen = params.value("includeAnomalousOxygen", false);
    if (includeAnomalousOxygen) {
        gtd7d(&input, &flags, &output);
    } else {
        gtd7(&input, &flags, &output);
    }

    return json({
        {"model", "NRLMSISE00"},
        {"variant", includeAnomalousOxygen ? "gtd7d" : "gtd7"},
        {"altitudeKm", input.alt},
        {"densityKgM3", output.d[5] * 1000.0},
        {"densityGCm3", output.d[5]},
        {"temperatureK", output.t[1]},
        {"exosphericTemperatureK", output.t[0]},
        {"numberDensitiesCm3", {
            {"He", output.d[0]},
            {"O", output.d[1]},
            {"N2", output.d[2]},
            {"O2", output.d[3]},
            {"Ar", output.d[4]},
            {"H", output.d[6]},
            {"N", output.d[7]},
            {"anomalousO", output.d[8]},
        }},
    }).dump();
}

std::string dispatch_operation(const std::string& operation, const json& params, std::string& operation_error) {
    if (operation == "version") {
        return json({{"version", version()}, {"plugin", "hpop-propagator"}}).dump();
    }
    if (operation == "propagate") {
        return propagate_json(params, operation_error);
    }
    if (operation == "ephemeris") {
        using namespace astro::Ephemeris;
        const double jd = params.at("epochTDBJD").get<double>();
        const int target = params.at("target").get<int>();
        const int center = params.value("center", 399);

        const auto state = getKernelState(target, center, jd);
        if (!state.valid) return "{}"; // invoke reports ephemerisError as a named failure.
        return json({{"epochTDBJD", jd}, {"target", target}, {"center", center},
                     {"frame", "ICRF/J2000"}, {"positionUnits", "km"},
                     {"velocityUnits", "km/s"},
                     {"ephemerisSource", ephemerisSourceName(state.source)},
                     {"position", {state.position.x, state.position.y, state.position.z}},
                     {"velocity", {state.velocity.x, state.velocity.y, state.velocity.z}}}).dump();
    }
    if (operation == "atmosphere") {
        return atmosphere_json(params);
    }

    throw std::runtime_error("Unknown HPOP operation: " + operation);
}

}  // namespace

PluginInvokeResult invoke_json_request(std::string_view request_json) {
    try {
        const auto request = json::parse(request_json);
        const auto operation = request.at("operation").get<std::string>();
        const auto params =
            request.contains("params") ? request.at("params") : json::object();

        using namespace astro::Ephemeris;
        const auto source = params.value("ephemerisSource", "");
        if (!source.empty()) {
            if (source == "Analytical") selectEphemerisSource(EphemerisSource::Analytical);
            else if (source != ephemerisSourceName(selectedEphemerisSource()))
                return make_error_result("ephemeris-source", "Requested ephemeris source does not match the supplied kernel.");
        }
        if (operation == "propagate" && params.value("epochTimeScale", "TDB") != "TDB")
            return make_error_result("epoch-time-scale", "JSON propagation epochs must be JD TDB.");
        if (operation == "ephemeris" && selectedEphemerisSource() == EphemerisSource::Analytical)
            return make_error_result("missing-kernel", "NAIF ephemeris query requires a kernel input.");
        // Expected integration failures travel as statuses. In particular, do
        // not throw while a VariationalResult is alive: WasmEdge 0.16.4 can
        // corrupt destructor pointers during native-Wasm exception unwinding.
        std::string operation_error;
        auto output = dispatch_operation(operation, params, operation_error);
        if (!ephemerisError().empty()) return make_error_result("ephemeris-failed", ephemerisError());
        if (!operation_error.empty()) return make_error_result("invoke-failed", operation_error);
        PluginInvokeResult result{};
        result.ok = true;
        result.json = std::move(output);
        return result;
    } catch (const std::exception& ex) {
        return make_error_result("invoke-failed", ex.what());
    } catch (...) {
        return make_error_result("invoke-failed", "Unknown plugin error.");
    }
}

}  // namespace hpop
