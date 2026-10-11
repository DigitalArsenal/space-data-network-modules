/*
 * files/ccsds-messages — CCSDS 508.1-B-1 Re-entry Data Message, bound to $RDM.
 *
 * An RDM has no block markers in KVN at all: the metadata keywords follow the
 * header, then the data groups follow one another (atmospheric re-entry
 * parameters, ground impact, state vector, covariance, spacecraft parameters,
 * OD parameters, user-defined). The record is flat, with the keywords of the
 * message under their own names; the five that the placeholder record spelled
 * otherwise are bound to the field that held them (OBJECT_ID is
 * INTERNATIONAL_DESIGNATOR, REENTRY_EPOCH is NOMINAL_REENTRY_EPOCH,
 * PREV_PREDICTION_EPOCH is PREVIOUS_MESSAGE_EPOCH, MASS is WET_MASS, and
 * INITIAL_STATE is the state vector). A value the message leaves out is NaN in
 * the record, so a stated zero (PROBABILITY_OF_IMPACT = 0.0) is a stated zero.
 */

#ifndef CCSDS_MESSAGES_NDM_RDM_HPP
#define CCSDS_MESSAGES_NDM_RDM_HPP

#include <cmath>

#include "ndm_common.hpp"
#include "ndm_core.hpp"

namespace ndm {
namespace rdm {

using M = RDMT;

inline Leaf designator_leaf() {
    return custom_leaf<M>(
        "OBJECT_DESIGNATOR", nullptr, false,
        [](M& o, const std::string& t, std::string*) {
            o.OBJECT_DESIGNATOR = t;
            unsigned long long id = 0;
            bool digits = !t.empty();
            for (char c : t) digits = digits && c >= '0' && c <= '9';
            if (digits && parse_u64(t, &id) && id <= 0xFFFFFFFFull) o.NORAD_CAT_ID = static_cast<uint32_t>(id);
            return true;
        },
        [](const M& o, bool, std::vector<std::string>* out) {
            if (!o.OBJECT_DESIGNATOR.empty()) out->push_back(o.OBJECT_DESIGNATOR);
            else if (o.NORAD_CAT_ID != 0) out->push_back(std::to_string(o.NORAD_CAT_ID));
        });
}

inline Leaf controlled_leaf() {
    return custom_leaf<M>(
        "CONTROLLED_REENTRY", nullptr, true,
        [](M& o, const std::string& t, std::string* e) {
            const std::string u = upper(trim(t));
            if (u == "YES") o.CONTROLLED_REENTRY = rdmControlledReentry::YES;
            else if (u == "NO") o.CONTROLLED_REENTRY = rdmControlledReentry::NO;
            else if (u == "UNKNOWN") o.CONTROLLED_REENTRY = rdmControlledReentry::UNKNOWN;
            else { *e = "CONTROLLED_REENTRY is YES, NO or UNKNOWN"; return false; }
            return true;
        },
        [](const M& o, bool, std::vector<std::string>* out) {
            switch (o.CONTROLLED_REENTRY) {
                case rdmControlledReentry::YES: out->push_back("YES"); break;
                case rdmControlledReentry::NO: out->push_back("NO"); break;
                default: out->push_back("UNKNOWN"); break;
            }
        });
}

inline bool any_set(std::initializer_list<double> v) {
    for (double d : v) {
        if (!std::isnan(d)) return true;
    }
    return false;
}

inline std::shared_ptr<Message> build() {
    using S = reentryStateVectorT;
    auto msg = std::make_shared<Message>();
    msg->type = "RDM";
    msg->root = "rdm";
    msg->version_key = "CCSDS_RDM_VERS";
    msg->version = "1.0";
    msg->take_version = [](Obj* o, const std::string& t, std::string*) {
        static_cast<M*>(o)->CCSDS_RDM_VERS = t;
        return true;
    };

    SectionOptions optional;
    optional.optional = true;

    auto header = section("header", nav_same(), {
        NDM_COMMENT(M, COMMENT, true),
        NDM_LEAF(M, CREATION_DATE, nullptr, true),
        NDM_LEAF(M, ORIGINATOR, nullptr, true),
        NDM_LEAF(M, MESSAGE_ID, nullptr, true),
    });

    auto metadata = section("metadata", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        NDM_LEAF(M, OBJECT_NAME, nullptr, true),
        NDM_LEAF_AS(M, "INTERNATIONAL_DESIGNATOR", OBJECT_ID, nullptr, true),
        NDM_LEAF(M, CATALOG_NAME, nullptr, false),
        designator_leaf(),
        NDM_LEAF(M, OBJECT_TYPE, nullptr, false),
        NDM_LEAF(M, OBJECT_OWNER, nullptr, false),
        NDM_LEAF(M, OBJECT_OPERATOR, nullptr, false),
        controlled_leaf(),
        NDM_LEAF(M, CENTER_NAME, nullptr, true),
        NDM_LEAF(M, TIME_SYSTEM, nullptr, true),
        NDM_LEAF(M, EPOCH_TZERO, nullptr, true),
        NDM_LEAF(M, REF_FRAME, nullptr, false),
        NDM_LEAF(M, REF_FRAME_EPOCH, nullptr, false),
        NDM_LEAF(M, EPHEMERIS_NAME, nullptr, false),
        NDM_LEAF(M, GRAVITY_MODEL, nullptr, false),
        NDM_LEAF(M, ATMOSPHERIC_MODEL, nullptr, false),
        NDM_LEAF(M, SOLAR_FLUX_PREDICTION, nullptr, false),
        NDM_LEAF(M, N_BODY_PERTURBATIONS, nullptr, false),
        NDM_LEAF(M, SOLAR_RAD_PRESSURE, nullptr, false),
        NDM_LEAF(M, EARTH_TIDES, nullptr, false),
        NDM_LEAF(M, INTRACK_THRUST, nullptr, false),
        NDM_LEAF(M, DRAG_PARAMETERS_SOURCE, nullptr, false),
        NDM_LEAF(M, DRAG_PARAMETERS_ALTITUDE, "km", false),
        NDM_LEAF(M, REENTRY_UNCERTAINTY_METHOD, nullptr, false),
        NDM_LEAF(M, REENTRY_DISINTEGRATION, nullptr, false),
        NDM_LEAF(M, IMPACT_UNCERTAINTY_METHOD, nullptr, false),
        NDM_LEAF(M, PREVIOUS_MESSAGE_ID, nullptr, false),
        NDM_LEAF_AS(M, "PREVIOUS_MESSAGE_EPOCH", PREV_PREDICTION_EPOCH, nullptr, false),
        NDM_LEAF(M, NEXT_MESSAGE_EPOCH, nullptr, false),
    });

    auto atmospheric = section("atmosphericReentryParameters", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        NDM_LEAF(M, ORBIT_LIFETIME, "d", true),
        NDM_LEAF(M, REENTRY_ALTITUDE, "km", true),
        NDM_LEAF(M, ORBIT_LIFETIME_WINDOW_START, "d", false),
        NDM_LEAF(M, ORBIT_LIFETIME_WINDOW_END, "d", false),
        NDM_LEAF_AS(M, "NOMINAL_REENTRY_EPOCH", REENTRY_EPOCH, nullptr, false),
        NDM_LEAF(M, REENTRY_WINDOW_START, nullptr, false),
        NDM_LEAF(M, REENTRY_WINDOW_END, nullptr, false),
        NDM_LEAF(M, ORBIT_LIFETIME_CONFIDENCE_LEVEL, "%", false),
    });

    SectionOptions ground_options;
    ground_options.present = [](const Obj* o) {
        const M& m = *static_cast<const M*>(o);
        return any_set({m.PROBABILITY_OF_IMPACT, m.PROBABILITY_OF_BURN_UP, m.PROBABILITY_OF_BREAK_UP,
                        m.PROBABILITY_OF_LAND_IMPACT, m.PROBABILITY_OF_CASUALTY, m.NOMINAL_IMPACT_LON,
                        m.NOMINAL_IMPACT_LAT, m.NOMINAL_IMPACT_ALT, m.IMPACT_1_CONFIDENCE,
                        m.IMPACT_1_START_LON, m.IMPACT_1_START_LAT, m.IMPACT_1_STOP_LON,
                        m.IMPACT_1_STOP_LAT, m.IMPACT_1_CROSS_TRACK, m.IMPACT_2_CONFIDENCE,
                        m.IMPACT_2_START_LON, m.IMPACT_2_START_LAT, m.IMPACT_2_STOP_LON,
                        m.IMPACT_2_STOP_LAT, m.IMPACT_2_CROSS_TRACK, m.IMPACT_3_CONFIDENCE,
                        m.IMPACT_3_START_LON, m.IMPACT_3_START_LAT, m.IMPACT_3_STOP_LON,
                        m.IMPACT_3_STOP_LAT, m.IMPACT_3_CROSS_TRACK}) ||
               !m.NOMINAL_IMPACT_EPOCH.empty() || !m.IMPACT_WINDOW_START.empty() ||
               !m.IMPACT_WINDOW_END.empty() || !m.IMPACT_REF_FRAME.empty();
    };
    auto ground = section("groundImpactParameters", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        NDM_LEAF(M, PROBABILITY_OF_IMPACT, nullptr, false),
        NDM_LEAF(M, PROBABILITY_OF_BURN_UP, nullptr, false),
        NDM_LEAF(M, PROBABILITY_OF_BREAK_UP, nullptr, false),
        NDM_LEAF(M, PROBABILITY_OF_LAND_IMPACT, nullptr, false),
        NDM_LEAF(M, PROBABILITY_OF_CASUALTY, nullptr, false),
        NDM_LEAF(M, NOMINAL_IMPACT_EPOCH, nullptr, false),
        NDM_LEAF(M, IMPACT_WINDOW_START, nullptr, false),
        NDM_LEAF(M, IMPACT_WINDOW_END, nullptr, false),
        NDM_LEAF(M, IMPACT_REF_FRAME, nullptr, false),
        NDM_LEAF(M, NOMINAL_IMPACT_LON, "deg", false),
        NDM_LEAF(M, NOMINAL_IMPACT_LAT, "deg", false),
        NDM_LEAF(M, NOMINAL_IMPACT_ALT, "m", false),
        NDM_LEAF(M, IMPACT_1_CONFIDENCE, "%", false),
        NDM_LEAF(M, IMPACT_1_START_LON, "deg", false),
        NDM_LEAF(M, IMPACT_1_START_LAT, "deg", false),
        NDM_LEAF(M, IMPACT_1_STOP_LON, "deg", false),
        NDM_LEAF(M, IMPACT_1_STOP_LAT, "deg", false),
        NDM_LEAF(M, IMPACT_1_CROSS_TRACK, "km", false),
        NDM_LEAF(M, IMPACT_2_CONFIDENCE, "%", false),
        NDM_LEAF(M, IMPACT_2_START_LON, "deg", false),
        NDM_LEAF(M, IMPACT_2_START_LAT, "deg", false),
        NDM_LEAF(M, IMPACT_2_STOP_LON, "deg", false),
        NDM_LEAF(M, IMPACT_2_STOP_LAT, "deg", false),
        NDM_LEAF(M, IMPACT_2_CROSS_TRACK, "km", false),
        NDM_LEAF(M, IMPACT_3_CONFIDENCE, "%", false),
        NDM_LEAF(M, IMPACT_3_START_LON, "deg", false),
        NDM_LEAF(M, IMPACT_3_START_LAT, "deg", false),
        NDM_LEAF(M, IMPACT_3_STOP_LON, "deg", false),
        NDM_LEAF(M, IMPACT_3_STOP_LAT, "deg", false),
        NDM_LEAF(M, IMPACT_3_CROSS_TRACK, "km", false),
    }, ground_options);

    auto state_vector = section("stateVector", NDM_NAV_ONE(M, INITIAL_STATE), {
        NDM_LEAF(S, EPOCH, nullptr, true),
        NDM_LEAF(S, X, "km", true),
        NDM_LEAF(S, Y, "km", true),
        NDM_LEAF(S, Z, "km", true),
        NDM_LEAF(S, X_DOT, "km/s", true),
        NDM_LEAF(S, Y_DOT, "km/s", true),
        NDM_LEAF(S, Z_DOT, "km/s", true),
    }, optional);

    std::vector<Item> covariance_items;
    covariance_items.push_back(Item(read_only(NDM_COMMENT(M, COMMENT, false))));
    covariance_items.push_back(Item(NDM_LEAF(M, COV_REF_FRAME, nullptr, false)));
    add_covariance_leaves<M, &M::COVARIANCE>(&covariance_items, false);
    SectionOptions covariance_options;
    covariance_options.present = [](const Obj* o) { return static_cast<const M*>(o)->COVARIANCE.size() == 21; };
    auto covariance = section("covarianceMatrix", nav_same(), covariance_items, covariance_options);

    auto spacecraft = section("spacecraftParameters", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        NDM_LEAF_AS(M, "WET_MASS", MASS, "kg", false),
        NDM_LEAF(M, DRY_MASS, "kg", false),
        NDM_LEAF(M, HAZARDOUS_SUBSTANCES, nullptr, false),
        NDM_LEAF(M, SOLAR_RAD_AREA, "m**2", false),
        NDM_LEAF(M, SOLAR_RAD_COEFF, nullptr, false),
        NDM_LEAF(M, DRAG_AREA, "m**2", false),
        NDM_LEAF(M, DRAG_COEFF, nullptr, false),
        NDM_LEAF(M, RCS, "m**2", false),
        NDM_LEAF(M, BALLISTIC_COEFF, "kg/m**2", false),
        NDM_LEAF(M, THRUST_ACCELERATION, "m/s**2", false),
    }, optional);

    auto od = section("odParameters", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        NDM_LEAF(M, TIME_LASTOB_START, nullptr, false),
        NDM_LEAF(M, TIME_LASTOB_END, nullptr, false),
        NDM_LEAF(M, RECOMMENDED_OD_SPAN, "d", false),
        NDM_LEAF(M, ACTUAL_OD_SPAN, "d", false),
        NDM_LEAF(M, OBS_AVAILABLE, nullptr, false),
        NDM_LEAF(M, OBS_USED, nullptr, false),
        NDM_LEAF(M, TRACKS_AVAILABLE, nullptr, false),
        NDM_LEAF(M, TRACKS_USED, nullptr, false),
        NDM_LEAF(M, RESIDUALS_ACCEPTED, "%", false),
        NDM_LEAF(M, WEIGHTED_RMS, nullptr, false),
    }, optional);

    auto user_defined = section("userDefinedParameters", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        user_defined_leaf<M, RDMUserDefinedParameterT, &M::USER_DEFINED_PARAMETERS>(),
    }, optional);

    auto data = section("data", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        atmospheric, ground, state_vector, covariance, spacecraft, od, user_defined,
    });
    auto segment = section("segment", nav_same(), {metadata, data});
    auto body = section("body", nav_same(), {segment});
    msg->top = section("rdm", nav_same(), {header, body});
    return msg;
}

inline const Message& message() {
    static const std::shared_ptr<Message> m = build();
    return *m;
}

}  // namespace rdm
}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_RDM_HPP
