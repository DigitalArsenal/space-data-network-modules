#pragma once
// common/ocm_fb_builder.hpp - the shared SDS $OCM (Orbit Comprehensive Message) FlatBuffer builder. One place
// that assembles an OCM from a plain description, for every module that writes one: analysis/od (an SGP4 fit's
// epoch state and covariance) and analysis/vcm-adapter (a VCM, or a propagation result, with its covariance of
// any size, its dynamical-model parameters and its force model).
//
// Plain C++ in, a size-prefixed `$OCM` out ([u32le length][OCM], the payload plugin_push_output_ex takes). A
// field the description leaves empty (an empty string or vector, an absent optional) is absent in the record.
//
// REQUIRES the generated SDS $OCM object-API types in scope BEFORE this header (flatc --cpp --gen-object-api
// --preserve-case): OCMT, HeaderT, MetadataT, PerturbationsT, OrbitDeterminationT, OCMDynamicParameterT,
// UserDefinedParametersT, RFMT, CelestialFrameWrapperT, CelestialFrame, trajectoryType, covarianceOrdering,
// OCM::Pack, FinishSizePrefixedOCMBuffer and flatbuffers::FlatBufferBuilder. The covariance layout fields
// (COV_TYPE, COV_ORDERING, COV_SIZE, COV_PARAMETERS, COV_UNITS, OD_DYNAMIC_PARAMETERS) are SDS 1.244.0.
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace ocm_fb {

struct DynamicParameter {
    std::string name;   // DRAG_AREA_OVER_MASS, DRAG_AREA_OVER_MASS_RATE, SRP_AREA_OVER_MASS, IN_TRACK_ACCELERATION ...
    double value = 0.0;
    std::string units;  // m**2/kg, m**2/kg/s, m/s**2
    bool solvedFor = false;
};

struct Record {
    // HEADER
    std::string version = "3.0";
    std::string classification, creationDate, originator;

    // METADATA
    std::string objectName, internationalDesignator, catalogName, objectDesignator;
    std::string timeSystem;                  // of every absolute time below, "UTC"
    std::string epoch;                       // START_TIME, STOP_TIME and EPOCH_TZERO of a single-epoch state
    std::optional<double> taiMinusUtc, ut1MinusUtc;  // at the epoch, seconds
    std::string nextLeapEpoch;
    std::optional<double> nextLeapTaiMinusUtc;
    std::string eopSource;

    // TRAJECTORY: one epoch, position (km) and velocity (km/s) in `frame`
    std::vector<double> state;               // 6 values, or empty
    std::string frame;                       // EME2000, GCRF, J2000 ... or empty (then say it in `user`)
    std::string centerName;
    std::optional<uint32_t> revolution;      // ORB_REVNUM

    // COVARIANCE of the state (and the parameter rows after it), at the same epoch and in `covarianceFrame`
    std::vector<double> covariance;          // per `ordering`, N = covSize
    std::string covarianceFrame;
    std::string covType;                     // CARTPV when empty
    int covSize = 6;
    std::string ordering = "LTM";            // LTM, UTM, FULL, LTMWCC, UTMWCC
    std::vector<std::string> covParameters, covUnits;

    // PERTURBATIONS (the force model)
    struct ForceModel {
        bool present = false;
        std::string gravityModel, geopotentialModel, atmosphericDrag, solarRadPressure, solidTidesModel;
        std::optional<int> gravityDegree, gravityOrder;
        std::optional<double> gm, f10p7, f10p7Mean, geomagAp;
        std::vector<std::string> nBody;
    } force;

    // ORBIT_DETERMINATION
    struct Solution {
        bool present = false;
        std::string method, algorithm, epoch, covReduction, convergenceCriteria, residuals;
        std::optional<int> observationsUsed;
        std::optional<double> weightedRms, sedr;
        std::vector<DynamicParameter> dynamicParameters;
    } od;

    // USER_DEFINED_PARAMETERS, in order
    std::vector<std::pair<std::string, std::string>> user;
};

namespace detail {
inline CelestialFrame celestialFrame(const std::string& name, bool* known) {
    *known = true;
    if (name == "EME2000") return CelestialFrame::EME2000;
    if (name == "J2000") return CelestialFrame::J2000;
    if (name == "GCRF") return CelestialFrame::GCRF;
    if (name == "ICRF") return CelestialFrame::ICRF;
    if (name == "TEME" || name == "TEMEOFDATE") return CelestialFrame::TEMEOFDATE;
    if (name == "ITRF") return CelestialFrame::FIXED_EARTH;
    *known = false;
    return CelestialFrame::EME2000;
}

inline std::unique_ptr<RFMT> frameOf(const std::string& name) {
    bool known = false;
    const CelestialFrame frame = celestialFrame(name, &known);
    if (!known) return nullptr;
    auto rfm = std::make_unique<RFMT>();
    rfm->NAME = name;
    CelestialFrameWrapperT wrapper;
    wrapper.frame = frame;
    rfm->REFERENCE_FRAME.Set(std::move(wrapper));
    return rfm;
}

inline covarianceOrdering orderingOf(const std::string& name) {
    if (name == "UTM") return covarianceOrdering::UTM;
    if (name == "FULL") return covarianceOrdering::FULL;
    if (name == "LTMWCC") return covarianceOrdering::LTMWCC;
    if (name == "UTMWCC") return covarianceOrdering::UTMWCC;
    return covarianceOrdering::LTM;
}
}  // namespace detail

inline std::vector<uint8_t> build(const Record& r) {
    OCMT ocm;

    ocm.HEADER = std::make_unique<HeaderT>();
    ocm.HEADER->CCSDS_OCM_VERS = r.version;
    ocm.HEADER->CLASSIFICATION = r.classification;
    ocm.HEADER->CREATION_DATE = r.creationDate;
    ocm.HEADER->ORIGINATOR = r.originator;

    ocm.METADATA = std::make_unique<MetadataT>();
    auto& m = *ocm.METADATA;
    m.OBJECT_NAME = r.objectName;
    m.INTERNATIONAL_DESIGNATOR = r.internationalDesignator;
    m.CATALOG_NAME = r.catalogName;
    m.OBJECT_DESIGNATOR = r.objectDesignator;
    m.TIME_SYSTEM = r.timeSystem;
    m.START_TIME = r.epoch;
    m.STOP_TIME = r.epoch;
    m.EPOCH_TZERO = r.epoch;
    if (r.taiMinusUtc) m.TAIMUTC_AT_TZERO = *r.taiMinusUtc;
    if (r.ut1MinusUtc) m.UT1MUTC_AT_TZERO = *r.ut1MinusUtc;
    m.NEXT_LEAP_EPOCH = r.nextLeapEpoch;
    if (r.nextLeapTaiMinusUtc) m.NEXT_LEAP_TAIMUTC = *r.nextLeapTaiMinusUtc;
    m.EOP_SOURCE = r.eopSource;

    ocm.TRAJ_TYPE = trajectoryType::CARTESIAN_PV;
    ocm.STATE_VECTOR_SIZE = 6;
    ocm.STATE_DATA = r.state;
    ocm.CENTER_NAME = r.centerName;
    if (!r.frame.empty()) ocm.TRAJ_REF_FRAME = detail::frameOf(r.frame);
    if (r.revolution) ocm.ORB_REVNUM = *r.revolution;

    ocm.COVARIANCE_DATA = r.covariance;
    if (!r.covarianceFrame.empty()) ocm.COV_REF_FRAME = detail::frameOf(r.covarianceFrame);
    ocm.COV_TYPE = r.covType;
    ocm.COV_ORDERING = detail::orderingOf(r.ordering);
    ocm.COV_SIZE = static_cast<uint8_t>(r.covSize);
    ocm.COV_PARAMETERS = r.covParameters;
    ocm.COV_UNITS = r.covUnits;

    if (r.force.present) {
        const auto& p = r.force;
        ocm.PERTURBATIONS = std::make_unique<PerturbationsT>();
        auto& out = *ocm.PERTURBATIONS;
        out.GRAVITY_MODEL = p.gravityModel;
        out.GEOPOTENTIAL_MODEL = p.geopotentialModel;
        out.ATMOSPHERIC_DRAG = p.atmosphericDrag;
        out.SOLAR_RAD_PRESSURE = p.solarRadPressure;
        out.SOLID_TIDES_MODEL = p.solidTidesModel;
        if (p.gravityDegree) out.GRAVITY_DEGREE = *p.gravityDegree;
        if (p.gravityOrder) out.GRAVITY_ORDER = *p.gravityOrder;
        if (p.gm) out.GM = *p.gm;
        if (p.f10p7) out.FIXED_F10P7 = *p.f10p7;
        if (p.f10p7Mean) out.FIXED_F10P7_MEAN = *p.f10p7Mean;
        if (p.geomagAp) out.FIXED_GEOMAG_AP = *p.geomagAp;
        out.N_BODY_PERTURBATIONS = p.nBody;
    }

    if (r.od.present) {
        const auto& d = r.od;
        ocm.ORBIT_DETERMINATION = std::make_unique<OrbitDeterminationT>();
        auto& out = *ocm.ORBIT_DETERMINATION;
        out.OD_METHOD = d.method;
        out.OD_ALGORITHM = d.algorithm;
        out.OD_EPOCH = d.epoch;
        out.OD_COV_REDUCTION = d.covReduction;
        out.OD_CONVERGENCE_CRITERIA = d.convergenceCriteria;
        out.OD_RESIDUALS = d.residuals;
        if (d.observationsUsed) out.OD_OBSERVATIONS_USED = *d.observationsUsed;
        if (d.weightedRms) out.WEIGHTED_RMS = *d.weightedRms;
        if (d.sedr) out.SEDR = *d.sedr;
        for (const auto& p : d.dynamicParameters) {
            auto parameter = std::make_unique<OCMDynamicParameterT>();
            parameter->NAME = p.name;
            parameter->VALUE = p.value;
            parameter->UNITS = p.units;
            parameter->SOLVED_FOR = p.solvedFor;
            out.OD_DYNAMIC_PARAMETERS.push_back(std::move(parameter));
        }
    }

    for (const auto& [name, value] : r.user) {
        auto parameter = std::make_unique<UserDefinedParametersT>();
        parameter->PARAM_NAME = name;
        parameter->PARAM_VALUE = value;
        ocm.USER_DEFINED_PARAMETERS.push_back(std::move(parameter));
    }

    flatbuffers::FlatBufferBuilder fbb(4096);
    FinishSizePrefixedOCMBuffer(fbb, OCM::Pack(fbb, &ocm));
    const uint8_t* bytes = fbb.GetBufferPointer();
    return std::vector<uint8_t>(bytes, bytes + fbb.GetSize());
}

}  // namespace ocm_fb
