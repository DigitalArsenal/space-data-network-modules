/*
 * files/ccsds-messages — CCSDS 504.0-B-2 Attitude Comprehensive Message, bound to $ACM.
 *
 * An ACM is a header, a metadata block (META_START), and then any of: attitude
 * state time histories (ATT_START), one physical characteristics block
 * (PHYS_START), covariance time histories (COV_START), maneuvers (MAN_START), one
 * attitude determination block with its sensors (AD_START, SENSOR_START) and one
 * user-defined block (USER_START).
 *
 * A time history's data lines have no keyword: a line is a time tag (elapsed
 * seconds from EPOCH_TZERO, or an epoch) and numbers. The record keeps the time
 * tags as the text they were written in (TIMES) and the numbers in one array
 * (VALUES), row by row; every line must have the same number of numbers, and an
 * attitude line has NUMBER_STATES of them. A message that breaks that is refused.
 */

#ifndef CCSDS_MESSAGES_NDM_ACM_HPP
#define CCSDS_MESSAGES_NDM_ACM_HPP

#include "ndm_common.hpp"
#include "ndm_core.hpp"

namespace ndm {
namespace acm {

/* One data line <-> (TIMES[i], VALUES[i*width .. (i+1)*width)). `width` is what
 * the block states (NUMBER_STATES) or, for a covariance, what its first line has. */
template <class B>
inline bool line_take(B& b, const std::string& text, size_t stated_width, std::string* e) {
    const std::vector<std::string> tok = tokens(text);
    if (tok.size() < 2) {
        *e = "a data line is a time tag and at least one number";
        return false;
    }
    const size_t width = tok.size() - 1;
    if (stated_width != 0 && width != stated_width) {
        *e = "a data line has " + std::to_string(width) + " values, the block states " +
             std::to_string(stated_width);
        return false;
    }
    if (!b.TIMES.empty() && b.VALUES.size() != b.TIMES.size() * width) {
        *e = "data lines differ in length";
        return false;
    }
    b.TIMES.push_back(tok[0]);
    for (size_t i = 1; i < tok.size(); ++i) {
        double v = 0;
        if (!parse_double(tok[i], &v)) {
            *e = "not a decimal number: " + tok[i];
            return false;
        }
        b.VALUES.push_back(v);
    }
    return true;
}

template <class B>
inline void line_give(const B& b, std::vector<std::string>* out) {
    if (b.TIMES.empty()) return;
    const size_t width = b.VALUES.size() / b.TIMES.size();
    for (size_t i = 0; i < b.TIMES.size(); ++i) {
        std::string line = b.TIMES[i];
        for (size_t k = 0; k < width; ++k) {
            line += ' ';
            line += format_double(b.VALUES[i * width + k]);
        }
        out->push_back(line);
    }
}

template <class B>
inline bool lines_consistent(const B& b) {
    return b.TIMES.empty() ? b.VALUES.empty()
                           : (b.VALUES.size() % b.TIMES.size() == 0 && !b.VALUES.empty());
}

inline Leaf att_line() {
    Leaf l = custom_leaf<ACMAttitudeBlockT>(
        "attLine", nullptr, true,
        [](ACMAttitudeBlockT& b, const std::string& t, std::string* e) {
            return line_take(b, t, b.NUMBER_STATES, e);
        },
        [](const ACMAttitudeBlockT& b, bool, std::vector<std::string>* out) { line_give(b, out); });
    l.bare = true;
    return l;
}

inline Leaf cov_line() {
    Leaf l = custom_leaf<ACMCovarianceBlockT>(
        "covLine", nullptr, true,
        [](ACMCovarianceBlockT& b, const std::string& t, std::string* e) {
            return line_take(b, t, 0, e);
        },
        [](const ACMCovarianceBlockT& b, bool, std::vector<std::string>* out) { line_give(b, out); });
    l.bare = true;
    return l;
}

inline Leaf cp_leaf() {
    using P = attPhysicalPropertiesT;
    return custom_leaf<P>(
        "CP", "m", false,
        [](P& o, const std::string& t, std::string* e) {
            std::vector<double> v;
            if (!Conv<std::vector<double>>::take(v, t, e)) return false;
            if (v.size() != 3) { *e = "CP is three numbers"; return false; }
            o.CP_X = v[0]; o.CP_Y = v[1]; o.CP_Z = v[2];
            return true;
        },
        [](const P& o, bool, std::vector<std::string>* out) {
            if (o.CP_X != 0.0 || o.CP_Y != 0.0 || o.CP_Z != 0.0) {
                out->push_back(format_double(o.CP_X) + " " + format_double(o.CP_Y) + " " + format_double(o.CP_Z));
            }
        });
}

inline Leaf stddev_leaf() {
    return custom_leaf<ACMSensorT>(
        "SENSOR_NOISE_STDDEV", "deg", false,
        [](ACMSensorT& o, const std::string& t, std::string* e) {
            return Conv<std::vector<double>>::take(o.SENSOR_NOISE_STDDEV, t, e);
        },
        [](const ACMSensorT& o, bool, std::vector<std::string>* out) {
            Conv<std::vector<double>>::give(o.SENSOR_NOISE_STDDEV, o.SENSOR_NOISE_STDDEV, false, out);
        });
}

inline SectionOptions repeated_block(const char* start, const char* stop) {
    SectionOptions o = block(start, stop);
    o.repeat = true;
    o.optional = true;
    return o;
}

inline std::shared_ptr<Message> build() {
    using M = ACMT;
    using A = ACMAttitudeBlockT;
    using V = ACMCovarianceBlockT;
    using N = ACMManeuverBlockT;
    using D = ACMDeterminationT;
    using S = ACMSensorT;
    using P = attPhysicalPropertiesT;
    auto msg = std::make_shared<Message>();
    msg->type = "ACM";
    msg->root = "acm";
    msg->version_key = "CCSDS_ACM_VERS";
    msg->version = "2.0";
    msg->take_version = [](Obj* o, const std::string& t, std::string*) {
        static_cast<M*>(o)->CCSDS_ACM_VERS = t;
        return true;
    };
    msg->check_record = [](const Obj* o) {
        const M& m = *static_cast<const M*>(o);
        for (size_t i = 0; i < m.ATT_BLOCKS.size(); ++i) {
            const A& b = *m.ATT_BLOCKS[i];
            if (!lines_consistent(b)) {
                return "attitude block " + std::to_string(i + 1) + " holds " +
                       std::to_string(b.VALUES.size()) + " values for " +
                       std::to_string(b.TIMES.size()) + " time tags, not a whole number of lines.";
            }
            if (!b.TIMES.empty() && b.NUMBER_STATES != 0 &&
                b.VALUES.size() != b.TIMES.size() * b.NUMBER_STATES) {
                return "attitude block " + std::to_string(i + 1) + " states NUMBER_STATES " +
                       std::to_string(b.NUMBER_STATES) + " but its lines hold " +
                       std::to_string(b.VALUES.size() / b.TIMES.size()) + " values.";
            }
        }
        for (size_t i = 0; i < m.COV_BLOCKS.size(); ++i) {
            if (!lines_consistent(*m.COV_BLOCKS[i])) {
                return "covariance block " + std::to_string(i + 1) +
                       " does not hold a whole number of lines.";
            }
        }
        return std::string();
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
        NDM_LEAF_AS(M, "INTERNATIONAL_DESIGNATOR", OBJECT_ID, nullptr, false),
        NDM_LEAF(M, CATALOG_NAME, nullptr, false),
        NDM_LEAF(M, OBJECT_DESIGNATOR, nullptr, false),
        NDM_LEAF(M, ORIGINATOR_POC, nullptr, false),
        NDM_LEAF(M, ORIGINATOR_POSITION, nullptr, false),
        NDM_LEAF(M, ORIGINATOR_PHONE, nullptr, false),
        NDM_LEAF(M, ORIGINATOR_EMAIL, nullptr, false),
        NDM_LEAF(M, ORIGINATOR_ADDRESS, nullptr, false),
        NDM_LEAF(M, ODM_MSG_LINK, nullptr, false),
        NDM_LEAF(M, CENTER_NAME, nullptr, false),
        NDM_LEAF(M, TIME_SYSTEM, nullptr, true),
        NDM_LEAF_AS(M, "EPOCH_TZERO", EPOCH, nullptr, true),
        NDM_LEAF(M, ACM_DATA_ELEMENTS, nullptr, false),
        NDM_LEAF(M, START_TIME, nullptr, false),
        NDM_LEAF(M, STOP_TIME, nullptr, false),
        NDM_LEAF(M, TAIMUTC_AT_TZERO, "s", false),
        NDM_LEAF(M, NEXT_LEAP_EPOCH, nullptr, false),
        NDM_LEAF(M, NEXT_LEAP_TAIMUTC, "s", false),
    }, block("META_START", "META_STOP"));

    auto att = section("att", NDM_NAV_MANY(M, ATT_BLOCKS), {
        NDM_COMMENT(A, COMMENT, true),
        NDM_LEAF(A, ATT_ID, nullptr, false),
        NDM_LEAF(A, ATT_PREV_ID, nullptr, false),
        NDM_LEAF(A, ATT_BASIS, nullptr, false),
        NDM_LEAF(A, ATT_BASIS_ID, nullptr, false),
        NDM_LEAF(A, REF_FRAME_A, nullptr, true),
        NDM_LEAF(A, REF_FRAME_B, nullptr, true),
        NDM_LEAF(A, NUMBER_STATES, nullptr, true),
        NDM_LEAF(A, ATT_TYPE, nullptr, true),
        NDM_LEAF(A, EULER_ROT_SEQ, nullptr, false),
        NDM_LEAF(A, RATE_TYPE, nullptr, false),
        att_line(),
    }, repeated_block("ATT_START", "ATT_STOP"));

    auto phys = section("phys", NDM_NAV_ONE(M, PHYS_PROPERTIES), {
        NDM_COMMENT(P, COMMENT, true),
        NDM_LEAF(P, DRAG_COEFF, nullptr, false),
        NDM_LEAF(P, WET_MASS, "kg", false),
        NDM_LEAF(P, DRY_MASS, "kg", false),
        NDM_LEAF(P, CP_REF_FRAME, nullptr, false),
        cp_leaf(),
        NDM_LEAF(P, INERTIA_REF_FRAME, nullptr, false),
        NDM_LEAF(P, IXX, "kg*m**2", false),
        NDM_LEAF(P, IYY, "kg*m**2", false),
        NDM_LEAF(P, IZZ, "kg*m**2", false),
        NDM_LEAF(P, IXY, "kg*m**2", false),
        NDM_LEAF(P, IXZ, "kg*m**2", false),
        NDM_LEAF(P, IYZ, "kg*m**2", false),
    }, repeated_block("PHYS_START", "PHYS_STOP"));
    phys->repeat = false;

    auto cov = section("cov", NDM_NAV_MANY(M, COV_BLOCKS), {
        NDM_COMMENT(V, COMMENT, true),
        NDM_LEAF(V, COV_ID, nullptr, false),
        NDM_LEAF(V, COV_PREV_ID, nullptr, false),
        NDM_LEAF(V, COV_BASIS, nullptr, false),
        NDM_LEAF(V, COV_BASIS_ID, nullptr, false),
        NDM_LEAF(V, COV_REF_FRAME, nullptr, false),
        NDM_LEAF(V, COV_TYPE, nullptr, true),
        cov_line(),
    }, repeated_block("COV_START", "COV_STOP"));

    auto man = section("man", NDM_NAV_MANY(M, MAN_BLOCKS), {
        NDM_COMMENT(N, COMMENT, true),
        NDM_LEAF(N, MAN_ID, nullptr, false),
        NDM_LEAF(N, MAN_PREV_ID, nullptr, false),
        NDM_LEAF(N, MAN_PURPOSE, nullptr, true),
        NDM_LEAF(N, MAN_BEGIN_TIME, "s", true),
        /* The message states the end of the maneuver or its length, one of the two. */
        custom_leaf<N>("MAN_END_TIME", "s", false,
            [](N& o, const std::string& t, std::string* e) { return Conv<double>::take(o.MAN_END_TIME, t, e); },
            [](const N& o, bool, std::vector<std::string>* out) {
                if (!std::isnan(o.MAN_END_TIME)) out->push_back(format_double(o.MAN_END_TIME));
            }),
        custom_leaf<N>("MAN_DURATION", "s", false,
            [](N& o, const std::string& t, std::string* e) { return Conv<double>::take(o.MAN_DURATION, t, e); },
            [](const N& o, bool, std::vector<std::string>* out) {
                if (std::isnan(o.MAN_END_TIME)) out->push_back(format_double(std::isnan(o.MAN_DURATION) ? 0.0 : o.MAN_DURATION));
            }),
        NDM_LEAF(N, ACTUATOR_USED, nullptr, false),
        /* And one target: a momentum with its frame, an attitude, or a spin rate. */
        custom_leaf<N>("TARGET_MOMENTUM", "N*m*s", false,
            [](N& o, const std::string& t, std::string* e) { return Conv<std::vector<double>>::take(o.TARGET_MOMENTUM, t, e); },
            [](const N& o, bool, std::vector<std::string>* out) {
                if (!o.TARGET_MOMENTUM.empty()) Conv<std::vector<double>>::give(o.TARGET_MOMENTUM, o.TARGET_MOMENTUM, false, out);
            }),
        custom_leaf<N>("TARGET_MOM_FRAME", nullptr, false,
            [](N& o, const std::string& t, std::string*) { o.TARGET_MOM_FRAME = t; return true; },
            [](const N& o, bool, std::vector<std::string>* out) {
                if (!o.TARGET_MOMENTUM.empty() && !o.TARGET_MOM_FRAME.empty()) out->push_back(o.TARGET_MOM_FRAME);
            }),
        custom_leaf<N>("TARGET_ATTITUDE", nullptr, false,
            [](N& o, const std::string& t, std::string* e) { return Conv<std::vector<double>>::take(o.TARGET_ATTITUDE, t, e); },
            [](const N& o, bool, std::vector<std::string>* out) {
                if (o.TARGET_MOMENTUM.empty() && !o.TARGET_ATTITUDE.empty()) Conv<std::vector<double>>::give(o.TARGET_ATTITUDE, o.TARGET_ATTITUDE, false, out);
            }),
        custom_leaf<N>("TARGET_SPINRATE", "deg/s", false,
            [](N& o, const std::string& t, std::string* e) { return Conv<double>::take(o.TARGET_SPINRATE, t, e); },
            [](const N& o, bool, std::vector<std::string>* out) {
                if (o.TARGET_MOMENTUM.empty() && o.TARGET_ATTITUDE.empty() && !std::isnan(o.TARGET_SPINRATE)) out->push_back(format_double(o.TARGET_SPINRATE));
            }),
    }, repeated_block("MAN_START", "MAN_STOP"));

    SectionOptions sensor_options = block("SENSOR_START", "SENSOR_STOP");
    sensor_options.repeat = true;
    sensor_options.optional = true;
    auto sensor = section("sensorData", NDM_NAV_MANY(D, SENSORS), {
        NDM_LEAF(S, SENSOR_NUMBER, nullptr, false),
        NDM_LEAF(S, SENSOR_USED, nullptr, false),
        NDM_LEAF(S, NUMBER_SENSOR_NOISE_COVARIANCE, nullptr, false),
        stddev_leaf(),
        NDM_LEAF(S, SENSOR_FREQUENCY, "Hz", false),
    }, sensor_options);

    auto ad = section("ad", NDM_NAV_ONE(M, DETERMINATION), {
        NDM_COMMENT(D, COMMENT, true),
        NDM_LEAF(D, AD_ID, nullptr, false),
        NDM_LEAF(D, AD_PREV_ID, nullptr, false),
        NDM_LEAF(D, AD_METHOD, nullptr, false),
        NDM_LEAF(D, ATTITUDE_SOURCE, nullptr, false),
        NDM_LEAF(D, NUMBER_STATES, nullptr, false),
        NDM_LEAF(D, ATTITUDE_STATES, nullptr, true),
        NDM_LEAF(D, EULER_ROT_SEQ, nullptr, false),
        NDM_LEAF(D, COV_TYPE, nullptr, false),
        NDM_LEAF(D, REF_FRAME_A, nullptr, true),
        NDM_LEAF(D, REF_FRAME_B, nullptr, true),
        NDM_LEAF(D, RATE_STATES, nullptr, false),
        NDM_LEAF(D, SIGMA_U, "deg/s**1.5", false),
        NDM_LEAF(D, SIGMA_V, "deg/s**0.5", false),
        NDM_LEAF(D, RATE_PROCESS_NOISE_STDDEV, "deg/s**1.5", false),
        sensor,
    }, block("AD_START", "AD_STOP"));
    ad->optional = true;

    auto user = section("user", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        user_defined_leaf<M, ACMUserDefinedParameterT, &M::USER_DEFINED_PARAMETERS>(),
    }, [] { SectionOptions o = block("USER_START", "USER_STOP"); o.optional = true; return o; }());

    auto data = section("data", nav_same(), {att, phys, cov, man, ad, user});
    auto segment = section("segment", nav_same(), {metadata, data});
    auto body = section("body", nav_same(), {segment});
    msg->top = section("acm", nav_same(), {header, body});
    return msg;
}

inline const Message& message() {
    static const std::shared_ptr<Message> m = build();
    return *m;
}

}  // namespace acm
}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_ACM_HPP
