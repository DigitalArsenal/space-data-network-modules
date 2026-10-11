/*
 * files/ccsds-messages — CCSDS 502.0-B-3 Orbit Mean-Elements Message, bound to $OMM.
 *
 * The record is flat; the message is not. Header, metadata and every data group
 * (mean elements, spacecraft parameters, TLE parameters, covariance, user
 * defined) are sections here and all bind to members of the one OMMT. The
 * choices the Blue Book leaves to the data are made from the record:
 *
 *   SEMI_MAJOR_AXIS or MEAN_MOTION   mean motion for the SGP4 family (its
 *                                    mean elements are defined by it), else
 *                                    the semi-major axis; whichever the record
 *                                    holds when only one is set.
 *   BSTAR or BTERM, MEAN_MOTION_DDOT or AGOM
 *                                    SGP4-XP states the drag and SRP terms as
 *                                    BTERM and AGOM; the record keeps them in
 *                                    BSTAR and MEAN_MOTION_DDOT (its comments
 *                                    say so), and MEAN_ELEMENT_THEORY picks the
 *                                    keyword name.
 *   EPHEMERIS_TYPE                   the TLE ephemeris-type digit; the record
 *                                    holds the theory it names (0 and 2 are
 *                                    both SGP4/SDP4 and read as SGP4).
 *   REV_AT_EPOCH                     a non-negative integer in the message, a
 *                                    double in the record.
 *
 * What the record cannot say, and the engine therefore reports: COMMENT lines in
 * the metadata and data groups (the record has one COMMENT field; a message
 * written from it states them together in its header), and EPHEMERIS_TYPE = 0
 * (the default theory; a message written from the record leaves it out).
 */

#ifndef CCSDS_MESSAGES_NDM_OMM_HPP
#define CCSDS_MESSAGES_NDM_OMM_HPP

#include <cmath>

#include "ndm_common.hpp"
#include "ndm_core.hpp"
#include "ndm_enums.hpp"
#include "ndm_frames.hpp"

namespace ndm {

NDM_ENUM(meanElementSource);

namespace omm {

inline bool sgp4_family(const OMMT& o) {
    return o.MEAN_ELEMENT_THEORY == meanElementSource::SGP4 ||
           o.MEAN_ELEMENT_THEORY == meanElementSource::SGP4XP;
}

inline bool theory_take(OMMT& o, const std::string& t, std::string* e) {
    const std::string u = upper(trim(t));
    if (u == "SGP/SGP4" || u == "SGP4" || u == "SGP") {
        o.MEAN_ELEMENT_THEORY = meanElementSource::SGP4;
    } else if (u == "SGP4-XP" || u == "SGP4XP") {
        o.MEAN_ELEMENT_THEORY = meanElementSource::SGP4XP;
    } else if (u == "DSST") {
        o.MEAN_ELEMENT_THEORY = meanElementSource::DSST;
    } else if (u == "USM") {
        o.MEAN_ELEMENT_THEORY = meanElementSource::USM;
    } else {
        *e = "MEAN_ELEMENT_THEORY is SGP/SGP4, SGP4-XP, DSST or USM";
        return false;
    }
    return true;
}

inline void theory_give(const OMMT& o, bool, std::vector<std::string>* out) {
    switch (o.MEAN_ELEMENT_THEORY) {
        case meanElementSource::SGP4: out->push_back("SGP/SGP4"); break;
        case meanElementSource::SGP4XP: out->push_back("SGP4-XP"); break;
        case meanElementSource::DSST: out->push_back("DSST"); break;
        case meanElementSource::USM: out->push_back("USM"); break;
    }
}

/* TLE ephemeris type digit <-> theory: 0 and 2 SGP4/SDP4, 1 SGP, 3 SDP4, 4 SGP8, 5 SDP8. */
inline bool ephemeris_type_take(OMMT& o, const std::string& t, std::string* e) {
    long long v = 0;
    if (!parse_i64(t, &v) || v < 0 || v > 5) {
        *e = "EPHEMERIS_TYPE is a digit from 0 to 5";
        return false;
    }
    static const ephemerisFormat by_digit[6] = {ephemerisFormat::SGP4, ephemerisFormat::SGP,
                                                ephemerisFormat::SGP4, ephemerisFormat::SDP4,
                                                ephemerisFormat::SGP8, ephemerisFormat::SDP8};
    o.EPHEMERIS_TYPE = by_digit[v];
    return true;
}

inline void ephemeris_type_give(const OMMT& o, bool, std::vector<std::string>* out) {
    switch (o.EPHEMERIS_TYPE) {
        case ephemerisFormat::SGP: out->push_back("1"); break;
        case ephemerisFormat::SGP4: break;  /* the default: not stated */
        case ephemerisFormat::SDP4: out->push_back("3"); break;
        case ephemerisFormat::SGP8: out->push_back("4"); break;
        case ephemerisFormat::SDP8: out->push_back("5"); break;
    }
}

inline void rev_give(const OMMT& o, bool, std::vector<std::string>* out) {
    if (o.REV_AT_EPOCH != 0.0) out->push_back(std::to_string(std::llround(o.REV_AT_EPOCH)));
}

inline bool rev_take(OMMT& o, const std::string& t, std::string* e) {
    double v = 0;
    if (!parse_double(t, &v) || v < 0.0) {
        *e = "REV_AT_EPOCH is a non-negative integer";
        return false;
    }
    o.REV_AT_EPOCH = v;
    return true;
}

inline bool tle_present(const OMMT& o) {
    return sgp4_family(o) || o.NORAD_CAT_ID != 0 || o.ELEMENT_SET_NO != 0 ||
           o.REV_AT_EPOCH != 0.0 || o.BSTAR != 0.0 || o.MEAN_MOTION_DOT != 0.0 ||
           o.MEAN_MOTION_DDOT != 0.0 || !o.CLASSIFICATION_TYPE.empty();
}

/* The five dedicated USER_DEFINED_* members; any other parameter goes to the list. */
inline bool user_take(OMMT& o, const std::string& name, const std::string& value, std::string* e) {
    if (name == "BIP_0044_TYPE") return Conv<uint32_t>::take(o.USER_DEFINED_BIP_0044_TYPE, value, e);
    if (name == "OBJECT_DESIGNATOR") { o.USER_DEFINED_OBJECT_DESIGNATOR = value; return true; }
    if (name == "EARTH_MODEL") { o.USER_DEFINED_EARTH_MODEL = value; return true; }
    if (name == "EPOCH_TIMESTAMP") return Conv<double>::take(o.USER_DEFINED_EPOCH_TIMESTAMP, value, e);
    if (name == "MICROSECONDS") return Conv<double>::take(o.USER_DEFINED_MICROSECONDS, value, e);
    auto p = std::make_unique<OMMUserDefinedParameterT>();
    p->PARAM_NAME = name;
    p->PARAM_VALUE = value;
    o.USER_DEFINED_PARAMETERS.push_back(std::move(p));
    return true;
}

inline void user_give(const OMMT& o, std::vector<std::pair<std::string, std::string>>* out) {
    std::vector<std::string> v;
    if (o.USER_DEFINED_BIP_0044_TYPE != 0) out->push_back({"BIP_0044_TYPE", std::to_string(o.USER_DEFINED_BIP_0044_TYPE)});
    if (!o.USER_DEFINED_OBJECT_DESIGNATOR.empty()) out->push_back({"OBJECT_DESIGNATOR", o.USER_DEFINED_OBJECT_DESIGNATOR});
    if (!o.USER_DEFINED_EARTH_MODEL.empty()) out->push_back({"EARTH_MODEL", o.USER_DEFINED_EARTH_MODEL});
    if (o.USER_DEFINED_EPOCH_TIMESTAMP != 0.0) out->push_back({"EPOCH_TIMESTAMP", format_double(o.USER_DEFINED_EPOCH_TIMESTAMP)});
    if (o.USER_DEFINED_MICROSECONDS != 0.0) out->push_back({"MICROSECONDS", format_double(o.USER_DEFINED_MICROSECONDS)});
    for (const auto& p : o.USER_DEFINED_PARAMETERS) out->push_back({p->PARAM_NAME, p->PARAM_VALUE});
}

inline std::shared_ptr<Message> build() {
    using M = OMMT;
    auto msg = std::make_shared<Message>();
    msg->type = "OMM";
    msg->root = "omm";
    msg->version_key = "CCSDS_OMM_VERS";
    msg->version = "3.0";
    msg->take_version = [](Obj* o, const std::string& t, std::string* e) {
        return Conv<double>::take(static_cast<M*>(o)->CCSDS_OMM_VERS, t, e);
    };

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
        NDM_LEAF_AS(M, "REF_FRAME", REFERENCE_FRAME, nullptr, true),
        NDM_LEAF_AS(M, "REF_FRAME_EPOCH", REFERENCE_FRAME_EPOCH, nullptr, false),
        NDM_LEAF(M, TIME_SYSTEM, nullptr, true),
        custom_leaf<M>("MEAN_ELEMENT_THEORY", nullptr, true, theory_take, theory_give),
    }, tolerate("META_START", "META_STOP"));

    auto mean_elements = section("meanElements", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        NDM_LEAF(M, EPOCH, nullptr, true),
        custom_leaf<M>("SEMI_MAJOR_AXIS", "km", false,
            [](M& o, const std::string& t, std::string* e) { return Conv<double>::take(o.SEMI_MAJOR_AXIS, t, e); },
            [](const M& o, bool, std::vector<std::string>* out) {
                const bool by_motion = (sgp4_family(o) && o.MEAN_MOTION != 0.0) ||
                                       (o.MEAN_MOTION != 0.0 && o.SEMI_MAJOR_AXIS == 0.0);
                if (!by_motion && o.SEMI_MAJOR_AXIS != 0.0) out->push_back(format_double(o.SEMI_MAJOR_AXIS));
            }),
        custom_leaf<M>("MEAN_MOTION", "rev/day", false,
            [](M& o, const std::string& t, std::string* e) { return Conv<double>::take(o.MEAN_MOTION, t, e); },
            [](const M& o, bool, std::vector<std::string>* out) {
                const bool by_motion = (sgp4_family(o) && o.MEAN_MOTION != 0.0) ||
                                       (o.MEAN_MOTION != 0.0 && o.SEMI_MAJOR_AXIS == 0.0);
                const bool neither = o.MEAN_MOTION == 0.0 && o.SEMI_MAJOR_AXIS == 0.0;
                if (by_motion || neither) out->push_back(format_double(o.MEAN_MOTION));
            }),
        NDM_LEAF(M, ECCENTRICITY, nullptr, true),
        NDM_LEAF(M, INCLINATION, "deg", true),
        NDM_LEAF(M, RA_OF_ASC_NODE, "deg", true),
        NDM_LEAF(M, ARG_OF_PERICENTER, "deg", true),
        NDM_LEAF(M, MEAN_ANOMALY, "deg", true),
        NDM_LEAF(M, GM, "km**3/s**2", false),
    });

    SectionOptions optional;
    optional.optional = true;

    auto spacecraft = section("spacecraftParameters", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        NDM_LEAF(M, MASS, "kg", false),
        NDM_LEAF(M, SOLAR_RAD_AREA, "m**2", false),
        NDM_LEAF(M, SOLAR_RAD_COEFF, nullptr, false),
        NDM_LEAF(M, DRAG_AREA, "m**2", false),
        NDM_LEAF(M, DRAG_COEFF, nullptr, false),
    }, optional);

    SectionOptions tle_options;
    tle_options.present = [](const Obj* o) { return tle_present(*static_cast<const M*>(o)); };
    auto tle = section("tleParameters", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        custom_leaf<M>("EPHEMERIS_TYPE", nullptr, false, ephemeris_type_take, ephemeris_type_give,
                       [](const M& o) { return o.EPHEMERIS_TYPE == ephemerisFormat::SGP4; }),
        NDM_LEAF(M, CLASSIFICATION_TYPE, nullptr, false),
        NDM_LEAF(M, NORAD_CAT_ID, nullptr, false),
        NDM_LEAF(M, ELEMENT_SET_NO, nullptr, false),
        custom_leaf<M>("REV_AT_EPOCH", nullptr, false, rev_take, rev_give),
        custom_leaf<M>("BSTAR", "1/ER", false,
            [](M& o, const std::string& t, std::string* e) { return Conv<double>::take(o.BSTAR, t, e); },
            [](const M& o, bool, std::vector<std::string>* out) {
                if (o.MEAN_ELEMENT_THEORY != meanElementSource::SGP4XP) out->push_back(format_double(o.BSTAR));
            }),
        custom_leaf<M>("BTERM", "m**2/kg", false,
            [](M& o, const std::string& t, std::string* e) { return Conv<double>::take(o.BSTAR, t, e); },
            [](const M& o, bool, std::vector<std::string>* out) {
                if (o.MEAN_ELEMENT_THEORY == meanElementSource::SGP4XP) out->push_back(format_double(o.BSTAR));
            }),
        NDM_LEAF(M, MEAN_MOTION_DOT, "rev/day**2", true),
        custom_leaf<M>("MEAN_MOTION_DDOT", "rev/day**3", false,
            [](M& o, const std::string& t, std::string* e) { return Conv<double>::take(o.MEAN_MOTION_DDOT, t, e); },
            [](const M& o, bool, std::vector<std::string>* out) {
                if (o.MEAN_ELEMENT_THEORY != meanElementSource::SGP4XP) out->push_back(format_double(o.MEAN_MOTION_DDOT));
            }),
        custom_leaf<M>("AGOM", "m**2/kg", false,
            [](M& o, const std::string& t, std::string* e) { return Conv<double>::take(o.MEAN_MOTION_DDOT, t, e); },
            [](const M& o, bool, std::vector<std::string>* out) {
                if (o.MEAN_ELEMENT_THEORY == meanElementSource::SGP4XP) out->push_back(format_double(o.MEAN_MOTION_DDOT));
            }),
    }, tle_options);

    std::vector<Item> covariance_items;
    covariance_items.push_back(Item(read_only(NDM_COMMENT(M, COMMENT, false))));
    covariance_items.push_back(Item(NDM_LEAF_AS(M, "COV_REF_FRAME", COV_REFERENCE_FRAME, nullptr, false)));
    add_covariance_leaves<M, &M::COVARIANCE>(&covariance_items, false);
    SectionOptions covariance_options;
    covariance_options.present = [](const Obj* o) { return static_cast<const M*>(o)->COVARIANCE.size() == 21; };
    auto covariance = section("covarianceMatrix", nav_same(), covariance_items, covariance_options);

    Leaf user;
    user.name = "USER_DEFINED";
    user.user_defined = true;
    user.take_param = [](Obj* o, const std::string& n, const std::string& v, std::string* e) {
        return user_take(*static_cast<M*>(o), n, v, e);
    };
    user.give_param = [](const Obj* o, std::vector<std::pair<std::string, std::string>>* out) {
        user_give(*static_cast<const M*>(o), out);
    };
    auto user_defined = section("userDefinedParameters", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        user,
    }, optional);

    auto data = section("data", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        mean_elements, spacecraft, tle, covariance, user_defined,
    });
    auto segment = section("segment", nav_same(), {metadata, data});
    auto body = section("body", nav_same(), {segment});
    msg->top = section("omm", nav_same(), {header, body});
    return msg;
}

inline const Message& message() {
    static const std::shared_ptr<Message> m = build();
    return *m;
}

}  // namespace omm
}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_OMM_HPP
