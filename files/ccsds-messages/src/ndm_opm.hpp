/*
 * files/ccsds-messages — CCSDS 502.0-B-3 Orbit Parameter Message, bound to $OPM.
 *
 * One state vector, optionally the same orbit as Keplerian elements, spacecraft
 * parameters, a covariance matrix, any number of maneuvers, user-defined
 * parameters. The record is flat; the maneuvers and user-defined parameters are
 * its two lists. TRUE_ANOMALY or MEAN_ANOMALY is a choice in the message; the
 * record holds both fields, and the message states MEAN_ANOMALY only when that is
 * the one the record set.
 */

#ifndef CCSDS_MESSAGES_NDM_OPM_HPP
#define CCSDS_MESSAGES_NDM_OPM_HPP

#include "ndm_common.hpp"
#include "ndm_core.hpp"

namespace ndm {
namespace opm {

inline bool by_mean_anomaly(const OPMT& o) { return o.MEAN_ANOMALY != 0.0 && o.TRUE_ANOMALY == 0.0; }

inline std::shared_ptr<Message> build() {
    using M = OPMT;
    using N = OPMManeuverT;
    auto msg = std::make_shared<Message>();
    msg->type = "OPM";
    msg->root = "opm";
    msg->version_key = "CCSDS_OPM_VERS";
    msg->version = "3.0";
    msg->take_version = [v = msg->version](Obj* o, const std::string&, std::string*) {
        static_cast<M*>(o)->CCSDS_OPM_VERS = v;
        return true;
    };

    SectionOptions optional;
    optional.optional = true;

    auto header = section("header", nav_same(), {
        NDM_COMMENT(M, COMMENT, true),
        NDM_LEAF(M, CLASSIFICATION, nullptr, false),
        NDM_LEAF(M, CREATION_DATE, nullptr, true),
        NDM_LEAF(M, ORIGINATOR, nullptr, true),
        NDM_LEAF(M, MESSAGE_ID, nullptr, false),
    });

    auto metadata = section("metadata", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        NDM_LEAF(M, OBJECT_NAME, nullptr, true),
        NDM_LEAF(M, OBJECT_ID, nullptr, true),
        NDM_LEAF(M, CENTER_NAME, nullptr, true),
        NDM_LEAF(M, REF_FRAME, nullptr, true),
        NDM_LEAF(M, REF_FRAME_EPOCH, nullptr, false),
        NDM_LEAF(M, TIME_SYSTEM, nullptr, true),
    }, tolerate("META_START", "META_STOP"));

    auto state_vector = section("stateVector", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        NDM_LEAF(M, EPOCH, nullptr, true),
        NDM_LEAF(M, X, "km", true),
        NDM_LEAF(M, Y, "km", true),
        NDM_LEAF(M, Z, "km", true),
        NDM_LEAF(M, X_DOT, "km/s", true),
        NDM_LEAF(M, Y_DOT, "km/s", true),
        NDM_LEAF(M, Z_DOT, "km/s", true),
    });

    SectionOptions kepler_options;
    kepler_options.present = [](const Obj* o) { return static_cast<const M*>(o)->SEMI_MAJOR_AXIS != 0.0; };
    auto keplerian = section("keplerianElements", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        NDM_LEAF(M, SEMI_MAJOR_AXIS, "km", true),
        NDM_LEAF(M, ECCENTRICITY, nullptr, true),
        NDM_LEAF(M, INCLINATION, "deg", true),
        NDM_LEAF(M, RA_OF_ASC_NODE, "deg", true),
        NDM_LEAF(M, ARG_OF_PERICENTER, "deg", true),
        custom_leaf<M>("TRUE_ANOMALY", "deg", false,
            [](M& o, const std::string& t, std::string* e) { return Conv<double>::take(o.TRUE_ANOMALY, t, e); },
            [](const M& o, bool, std::vector<std::string>* out) {
                if (!by_mean_anomaly(o)) out->push_back(format_double(o.TRUE_ANOMALY));
            }),
        custom_leaf<M>("MEAN_ANOMALY", "deg", false,
            [](M& o, const std::string& t, std::string* e) { return Conv<double>::take(o.MEAN_ANOMALY, t, e); },
            [](const M& o, bool, std::vector<std::string>* out) {
                if (by_mean_anomaly(o)) out->push_back(format_double(o.MEAN_ANOMALY));
            }),
        NDM_LEAF(M, GM, "km**3/s**2", true),
    }, kepler_options);

    auto spacecraft = section("spacecraftParameters", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        NDM_LEAF(M, MASS, "kg", false),
        NDM_LEAF(M, SOLAR_RAD_AREA, "m**2", false),
        NDM_LEAF(M, SOLAR_RAD_COEFF, nullptr, false),
        NDM_LEAF(M, DRAG_AREA, "m**2", false),
        NDM_LEAF(M, DRAG_COEFF, nullptr, false),
    }, optional);

    std::vector<Item> covariance_items;
    covariance_items.push_back(Item(read_only(NDM_COMMENT(M, COMMENT, false))));
    covariance_items.push_back(Item(NDM_LEAF(M, COV_REF_FRAME, nullptr, false)));
    add_covariance_leaves<M, &M::COVARIANCE>(&covariance_items, false);
    SectionOptions covariance_options;
    covariance_options.present = [](const Obj* o) { return static_cast<const M*>(o)->COVARIANCE.size() == 21; };
    auto covariance = section("covarianceMatrix", nav_same(), covariance_items, covariance_options);

    SectionOptions maneuver_options;
    maneuver_options.repeat = true;
    maneuver_options.optional = true;
    auto maneuver = section("maneuverParameters", NDM_NAV_MANY(M, MANEUVERS), {
        NDM_COMMENT(N, COMMENT, true),
        NDM_LEAF(N, MAN_EPOCH_IGNITION, nullptr, true),
        NDM_LEAF(N, MAN_DURATION, "s", true),
        NDM_LEAF(N, MAN_DELTA_MASS, "kg", true),
        NDM_LEAF(N, MAN_REF_FRAME, nullptr, true),
        NDM_LEAF(N, MAN_DV_1, "km/s", true),
        NDM_LEAF(N, MAN_DV_2, "km/s", true),
        NDM_LEAF(N, MAN_DV_3, "km/s", true),
    }, maneuver_options);

    auto user_defined = section("userDefinedParameters", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        user_defined_leaf<M, OPMUserDefinedParameterT, &M::USER_DEFINED_PARAMETERS>(),
    }, optional);

    auto data = section("data", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        state_vector, keplerian, spacecraft, covariance, maneuver, user_defined,
    });
    auto segment = section("segment", nav_same(), {metadata, data});
    auto body = section("body", nav_same(), {segment});
    msg->top = section("opm", nav_same(), {header, body});
    return msg;
}

inline const Message& message() {
    static const std::shared_ptr<Message> m = build();
    return *m;
}

}  // namespace opm
}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_OPM_HPP
