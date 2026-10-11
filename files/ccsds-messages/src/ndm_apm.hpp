/*
 * files/ccsds-messages — CCSDS 504.0-B-2 Attitude Parameter Message, bound to $APM.
 *
 * An APM has no META_START: after the header come the metadata keywords, EPOCH and
 * then any number of state blocks, each a QUAT_START, EULER_START, ANGVEL_START,
 * SPIN_START, INERTIA_START or MAN_START block. The record holds each kind as a
 * list in message order (the order between kinds is not kept). Q1..QC on the
 * record itself are the single frameless quaternion of its earlier form; a
 * message is read into and written from the lists. Optional values the message
 * leaves out are NaN in the record, so a stated zero is a stated zero.
 */

#ifndef CCSDS_MESSAGES_NDM_APM_HPP
#define CCSDS_MESSAGES_NDM_APM_HPP

#include "ndm_common.hpp"
#include "ndm_core.hpp"

namespace ndm {
namespace apm {

inline SectionOptions state_block(const char* start, const char* stop) {
    SectionOptions o = block(start, stop);
    o.repeat = true;
    o.optional = true;
    return o;
}

inline std::shared_ptr<Message> build() {
    using M = APMT;
    using Q = APMQuaternionStateT;
    using E = APMEulerAngleStateT;
    using W = APMAngularVelocityT;
    using S = APMSpinStateT;
    using I = APMInertiaT;
    using N = APMManeuverT;
    auto msg = std::make_shared<Message>();
    msg->type = "APM";
    msg->root = "apm";
    msg->version_key = "CCSDS_APM_VERS";
    msg->version = "2.0";
    msg->take_version = [v = msg->version](Obj* o, const std::string&, std::string*) {
        static_cast<M*>(o)->CCSDS_APM_VERS = v;
        return true;
    };

    auto header = section("header", nav_same(), {
        NDM_COMMENT(M, COMMENT, true),
        NDM_LEAF(M, CLASSIFICATION, nullptr, false),
        NDM_LEAF(M, CREATION_DATE, nullptr, true),
        NDM_LEAF(M, ORIGINATOR, nullptr, true),
        NDM_LEAF(M, MESSAGE_ID, nullptr, false),
    });

    /* KVN states the metadata with no markers: flat. */
    auto metadata = section("metadata", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        NDM_LEAF(M, OBJECT_NAME, nullptr, true),
        NDM_LEAF(M, OBJECT_ID, nullptr, true),
        NDM_LEAF(M, CENTER_NAME, nullptr, false),
        NDM_LEAF(M, TIME_SYSTEM, nullptr, true),
    });

    SectionOptions dot_options;
    dot_options.optional = true;
    dot_options.present = [](const Obj* o) { return !std::isnan(static_cast<const Q*>(o)->Q1_DOT); };
    auto quaternion_dot = section("quaternionDot", nav_same(), {
        NDM_LEAF(Q, Q1_DOT, "1/s", true),
        NDM_LEAF(Q, Q2_DOT, "1/s", true),
        NDM_LEAF(Q, Q3_DOT, "1/s", true),
        NDM_LEAF(Q, QC_DOT, "1/s", true),
    }, dot_options);
    auto quaternion = section("quaternion", nav_same(), {
        NDM_LEAF(Q, Q1, nullptr, true),
        NDM_LEAF(Q, Q2, nullptr, true),
        NDM_LEAF(Q, Q3, nullptr, true),
        NDM_LEAF(Q, QC, nullptr, true),
    });
    auto quaternion_state = section("quaternionState", NDM_NAV_MANY(M, QUATERNION_STATES), {
        NDM_COMMENT(Q, COMMENT, true),
        NDM_LEAF(Q, REF_FRAME_A, nullptr, true),
        NDM_LEAF(Q, REF_FRAME_B, nullptr, true),
        quaternion, quaternion_dot,
    }, state_block("QUAT_START", "QUAT_STOP"));

    auto euler_state = section("eulerAngleState", NDM_NAV_MANY(M, EULER_ANGLE_STATES), {
        NDM_COMMENT(E, COMMENT, true),
        NDM_LEAF(E, REF_FRAME_A, nullptr, true),
        NDM_LEAF(E, REF_FRAME_B, nullptr, true),
        NDM_LEAF(E, EULER_ROT_SEQ, nullptr, true),
        NDM_LEAF(E, ANGLE_1, "deg", true),
        NDM_LEAF(E, ANGLE_2, "deg", true),
        NDM_LEAF(E, ANGLE_3, "deg", true),
        NDM_LEAF(E, ANGLE_1_DOT, "deg/s", false),
        NDM_LEAF(E, ANGLE_2_DOT, "deg/s", false),
        NDM_LEAF(E, ANGLE_3_DOT, "deg/s", false),
    }, [] {
        SectionOptions o = state_block("EULER_START", "EULER_STOP");
        Choice rates;  /* the three rates, or none */
        rates.alternatives.push_back({"ANGLE_1_DOT", "ANGLE_2_DOT", "ANGLE_3_DOT"});
        rates.required = false;
        o.choices.push_back(rates);
        return o;
    }());

    auto angular_velocity = section("angularVelocity", NDM_NAV_MANY(M, ANGULAR_VELOCITIES), {
        NDM_COMMENT(W, COMMENT, true),
        NDM_LEAF(W, REF_FRAME_A, nullptr, true),
        NDM_LEAF(W, REF_FRAME_B, nullptr, true),
        NDM_LEAF(W, ANGVEL_FRAME, nullptr, true),
        NDM_LEAF(W, ANGVEL_X, "deg/s", true),
        NDM_LEAF(W, ANGVEL_Y, "deg/s", true),
        NDM_LEAF(W, ANGVEL_Z, "deg/s", true),
    }, state_block("ANGVEL_START", "ANGVEL_STOP"));

    auto spin = section("spin", NDM_NAV_MANY(M, SPIN_STATES), {
        NDM_COMMENT(S, COMMENT, true),
        NDM_LEAF(S, REF_FRAME_A, nullptr, true),
        NDM_LEAF(S, REF_FRAME_B, nullptr, true),
        NDM_LEAF(S, SPIN_ALPHA, "deg", true),
        NDM_LEAF(S, SPIN_DELTA, "deg", true),
        NDM_LEAF(S, SPIN_ANGLE, "deg", true),
        NDM_LEAF(S, SPIN_ANGLE_VEL, "deg/s", true),
        NDM_LEAF(S, NUTATION, "deg", false),
        NDM_LEAF(S, NUTATION_PER, "s", false),
        NDM_LEAF(S, NUTATION_PHASE, "deg", false),
        NDM_LEAF(S, MOMENTUM_ALPHA, "deg", false),
        NDM_LEAF(S, MOMENTUM_DELTA, "deg", false),
        NDM_LEAF(S, NUTATION_VEL, "deg/s", false),
    }, [] {
        SectionOptions o = state_block("SPIN_START", "SPIN_STOP");
        Choice nutation;  /* nutation about the spin axis, or about the momentum vector, or neither */
        nutation.alternatives.push_back({"NUTATION", "NUTATION_PER", "NUTATION_PHASE"});
        nutation.alternatives.push_back({"MOMENTUM_ALPHA", "MOMENTUM_DELTA", "NUTATION_VEL"});
        nutation.required = false;
        o.choices.push_back(nutation);
        return o;
    }());

    auto inertia = section("inertia", NDM_NAV_MANY(M, INERTIAS), {
        NDM_COMMENT(I, COMMENT, true),
        NDM_LEAF(I, INERTIA_REF_FRAME, nullptr, true),
        NDM_LEAF(I, IXX, "kg*m**2", true),
        NDM_LEAF(I, IYY, "kg*m**2", true),
        NDM_LEAF(I, IZZ, "kg*m**2", true),
        NDM_LEAF(I, IXY, "kg*m**2", true),
        NDM_LEAF(I, IXZ, "kg*m**2", true),
        NDM_LEAF(I, IYZ, "kg*m**2", true),
    }, state_block("INERTIA_START", "INERTIA_STOP"));

    auto maneuver = section("maneuverParameters", NDM_NAV_MANY(M, MANEUVERS), {
        NDM_COMMENT(N, COMMENT, true),
        NDM_LEAF(N, MAN_EPOCH_START, nullptr, true),
        NDM_LEAF(N, MAN_DURATION, "s", true),
        NDM_LEAF(N, MAN_REF_FRAME, nullptr, true),
        NDM_LEAF(N, MAN_TOR_X, "N*m", true),
        NDM_LEAF(N, MAN_TOR_Y, "N*m", true),
        NDM_LEAF(N, MAN_TOR_Z, "N*m", true),
        NDM_LEAF(N, MAN_DELTA_MASS, "kg", false),
    }, state_block("MAN_START", "MAN_STOP"));

    auto data = section("data", nav_same(), {
        read_only(NDM_COMMENT(M, COMMENT, false)),
        NDM_LEAF(M, EPOCH, nullptr, true),
        quaternion_state, euler_state, angular_velocity, spin, inertia, maneuver,
    });
    auto segment = section("segment", nav_same(), {metadata, data});
    auto body = section("body", nav_same(), {segment});
    msg->top = section("apm", nav_same(), {header, body});
    return msg;
}

inline const Message& message() {
    static const std::shared_ptr<Message> m = build();
    return *m;
}

}  // namespace apm
}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_APM_HPP
