/*
 * files/ccsds-messages — CCSDS 502.0-B-3 Orbit Ephemeris Message, bound to $OEM.
 *
 * A segment is an `ephemerisDataBlock`: its metadata, its state vectors and its
 * covariance matrices. State vectors are always the VERBOSE form
 * (EPHEMERIS_DATA_LINES, one table per state with its own EPOCH), because that is
 * what the message states; a block that holds only the compact form (EPHEMERIS_DATA
 * with START_TIME and STEP_SIZE) is refused when written, as the AEM projection
 * refuses its own compact form: spelling its epochs is time arithmetic, and the
 * leap-second table that arithmetic needs belongs to foundation/time.
 *
 * KVN has no DATA_START: the state vectors follow META_STOP, one per line, and
 * each covariance matrix is a COVARIANCE_START block whose cells are the rows of
 * the lower triangle.
 */

#ifndef CCSDS_MESSAGES_NDM_OEM_HPP
#define CCSDS_MESSAGES_NDM_OEM_HPP

#include "ndm_common.hpp"
#include "ndm_core.hpp"
#include "ndm_enums.hpp"
#include "ndm_frames.hpp"

namespace ndm {


namespace oem {

#define NDM_COV21(X)                                                                          \
    X(CX_X) X(CY_X) X(CY_Y) X(CZ_X) X(CZ_Y) X(CZ_Z) X(CX_DOT_X) X(CX_DOT_Y) X(CX_DOT_Z)      \
    X(CX_DOT_X_DOT) X(CY_DOT_X) X(CY_DOT_Y) X(CY_DOT_Z) X(CY_DOT_X_DOT) X(CY_DOT_Y_DOT)       \
    X(CZ_DOT_X) X(CZ_DOT_Y) X(CZ_DOT_Z) X(CZ_DOT_X_DOT) X(CZ_DOT_Y_DOT) X(CZ_DOT_Z_DOT)

inline bool any_acceleration(const ephemerisDataLineT& l) {
    return l.X_DDOT != 0.0 || l.Y_DDOT != 0.0 || l.Z_DDOT != 0.0;
}

template <double ephemerisDataLineT::*P>
inline Leaf acceleration_leaf(const char* name) {
    return custom_leaf<ephemerisDataLineT>(
        name, "km/s**2", false,
        [](ephemerisDataLineT& l, const std::string& t, std::string* e) {
            return Conv<double>::take(l.*P, t, e);
        },
        [](const ephemerisDataLineT& l, bool, std::vector<std::string>* out) {
            if (any_acceleration(l)) out->push_back(format_double(l.*P));
        });
}

inline Leaf object_leaf(const char* keyword, bool name) {
    return custom_leaf<ephemerisDataBlockT>(
        keyword, nullptr, true,
        [name](ephemerisDataBlockT& b, const std::string& t, std::string*) {
            if (!b.OBJECT) b.OBJECT = std::make_unique<CATT>();
            (name ? b.OBJECT->OBJECT_NAME : b.OBJECT->OBJECT_ID) = t;
            return true;
        },
        [name](const ephemerisDataBlockT& b, bool, std::vector<std::string>* out) {
            out->push_back(b.OBJECT ? (name ? b.OBJECT->OBJECT_NAME : b.OBJECT->OBJECT_ID)
                                    : std::string());
        });
}

inline bool compact_form_only(const ephemerisDataBlockT& b) {
    return b.EPHEMERIS_DATA_LINES.empty() && !b.EPHEMERIS_DATA.empty();
}

inline std::shared_ptr<Message> build() {
    using M = OEMT;
    using B = ephemerisDataBlockT;
    using L = ephemerisDataLineT;
    using V = covarianceMatrixLineT;
    auto msg = std::make_shared<Message>();
    msg->type = "OEM";
    msg->root = "oem";
    msg->version_key = "CCSDS_OEM_VERS";
    msg->version = "3.0";
    msg->take_version = [](Obj* o, const std::string& t, std::string* e) {
        return Conv<double>::take(static_cast<M*>(o)->CCSDS_OEM_VERS, t, e);
    };
    msg->check_record = [](const Obj* o) {
        const M& m = *static_cast<const M*>(o);
        for (size_t i = 0; i < m.EPHEMERIS_DATA_BLOCK.size(); ++i) {
            if (m.EPHEMERIS_DATA_BLOCK[i] && compact_form_only(*m.EPHEMERIS_DATA_BLOCK[i])) {
                return "segment " + std::to_string(i + 1) +
                       " holds its states in the compact EPHEMERIS_DATA form (START_TIME and "
                       "STEP_SIZE); spelling their epochs is time arithmetic this module does "
                       "not do (compact-form-needs-time-math). Write it from EPHEMERIS_DATA_LINES.";
            }
        }
        return std::string();
    };

    auto header = section("header", nav_same(), {
        NDM_COMMENT(M, COMMENT, true),
        NDM_LEAF(M, CLASSIFICATION, nullptr, false),
        NDM_LEAF(M, CREATION_DATE, nullptr, true),
        NDM_LEAF(M, ORIGINATOR, nullptr, true),
        NDM_LEAF(M, MESSAGE_ID, nullptr, false),
    });

    auto metadata = section("metadata", nav_same(), {
        NDM_COMMENT(B, COMMENT, true),
        object_leaf("OBJECT_NAME", true),
        object_leaf("OBJECT_ID", false),
        NDM_LEAF(B, CENTER_NAME, nullptr, true),
        NDM_LEAF_AS(B, "REF_FRAME", REFERENCE_FRAME, nullptr, true),
        NDM_LEAF_AS(B, "REF_FRAME_EPOCH", REFERENCE_FRAME_EPOCH, nullptr, false),
        NDM_LEAF(B, TIME_SYSTEM, nullptr, true),
        NDM_LEAF(B, START_TIME, nullptr, true),
        NDM_LEAF(B, USEABLE_START_TIME, nullptr, false),
        NDM_LEAF(B, USEABLE_STOP_TIME, nullptr, false),
        NDM_LEAF(B, STOP_TIME, nullptr, true),
        NDM_LEAF(B, INTERPOLATION, nullptr, false),
        NDM_LEAF(B, INTERPOLATION_DEGREE, nullptr, false),
    }, block("META_START", "META_STOP"));

    SectionOptions row;
    row.repeat = true;
    row.rows = 1;
    auto state_vector = section("stateVector", NDM_NAV_MANY(B, EPHEMERIS_DATA_LINES), {
        NDM_LEAF(L, EPOCH, nullptr, true),
        NDM_LEAF(L, X, "km", true),
        NDM_LEAF(L, Y, "km", true),
        NDM_LEAF(L, Z, "km", true),
        NDM_LEAF(L, X_DOT, "km/s", true),
        NDM_LEAF(L, Y_DOT, "km/s", true),
        NDM_LEAF(L, Z_DOT, "km/s", true),
        acceleration_leaf<&L::X_DDOT>("X_DDOT"),
        acceleration_leaf<&L::Y_DDOT>("Y_DDOT"),
        acceleration_leaf<&L::Z_DDOT>("Z_DDOT"),
    }, row);

    std::vector<Item> cov_items;
    cov_items.push_back(Item(NDM_COMMENT(V, COMMENT, true)));
    cov_items.push_back(Item(NDM_LEAF(V, EPOCH, nullptr, true)));
    cov_items.push_back(Item(NDM_LEAF_AS(V, "COV_REF_FRAME", COV_REFERENCE_FRAME, nullptr, false)));
    {
        size_t index = 0;
#define NDM_CELL(NAME)                                                                       \
    {                                                                                        \
        Leaf cell = NDM_LEAF(V, NAME, covariance_units(index), true);                        \
        cell.matrix = true;                                                                  \
        cov_items.push_back(Item(cell));                                                     \
        ++index;                                                                             \
    }
        NDM_COV21(NDM_CELL)
#undef NDM_CELL
    }
    SectionOptions cov_options = block("COVARIANCE_START", "COVARIANCE_STOP");
    cov_options.repeat = true;
    cov_options.optional = true;
    auto covariance = section("covarianceMatrix", NDM_NAV_MANY(B, COVARIANCE_MATRIX_LINES),
                              cov_items, cov_options);

    auto data = section("data", nav_same(), {
        read_only(NDM_COMMENT(B, COMMENT, false)),
        state_vector,
        covariance,
    });

    SectionOptions segment_options;
    segment_options.repeat = true;
    auto segment = section("segment", NDM_NAV_MANY(M, EPHEMERIS_DATA_BLOCK), {metadata, data},
                           segment_options);
    auto body = section("body", nav_same(), {segment});
    msg->top = section("oem", nav_same(), {header, body});
    return msg;
}

inline const Message& message() {
    static const std::shared_ptr<Message> m = build();
    return *m;
}

}  // namespace oem
}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_OEM_HPP
