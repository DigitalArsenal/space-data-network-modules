/*
 * files/ccsds-messages — CCSDS 502.0-B-3 Orbit Comprehensive Message, bound to $OCM.
 *
 * An OCM is a header, a metadata block (META_START) and then any of: trajectory
 * state time histories (TRAJ_START), one physical characteristics block (PHYS_START),
 * covariance time histories (COV_START), maneuvers (MAN_START), one perturbations
 * block (PERT_START), one orbit determination block (OD_START) and one user-defined
 * block (USER_START). Data lines have no keyword: a time tag and numbers.
 *
 * TWO SHAPES FOR THE SAME FACT. The record states a message's trajectories and
 * covariances as lists of blocks that keep every keyword and every line as written
 * (OCMTrajectoryBlock, OCMCovarianceBlock). The modules that already write and read
 * $OCM (analysis/od, analysis/vcm-adapter) state ONE trajectory and ONE covariance in
 * the record's own fields (TRAJ_TYPE, STATE_DATA, COVARIANCE_DATA ...). So:
 *   - reading fills the lists, and ALSO the single fields from the first block when
 *     the block is a CARTPV or CARTPVA trajectory (or a one-line covariance) whose
 *     time tags the single fields can hold (one line at relative time 0, or absolute
 *     epochs);
 *   - writing uses the lists, and when there are none writes the single fields as one
 *     block, the time tag of a lone state being 0.0 (relative to EPOCH_TZERO).
 * No time arithmetic is done in either direction: a tag is the text it was written as.
 */

#ifndef CCSDS_MESSAGES_NDM_OCM_HPP
#define CCSDS_MESSAGES_NDM_OCM_HPP

#include <cmath>

#include "ndm_common.hpp"
#include "ndm_core.hpp"
#include "ndm_enums.hpp"
#include "ndm_frames.hpp"

namespace ndm {

NDM_ENUM(covarianceOrdering);
NDM_ENUM(trajectoryType);

namespace ocm {

using M = OCMT;
using H = HeaderT;
using MD = MetadataT;
using TB = OCMTrajectoryBlockT;
using PP = PhysicalPropertiesT;
using CB = OCMCovarianceBlockT;
using MN = ManeuverT;
using PT = PerturbationsT;
using OD = OrbitDeterminationT;

/* The text of a bracketed list without its brackets: `[km, km/s]` is `km, km/s`. */
inline std::string unbracket(const std::string& text) {
    const std::string t = trim(text);
    if (t.size() >= 2 && t.front() == '[' && t.back() == ']') return trim(t.substr(1, t.size() - 2));
    return t;
}

/* A comma-separated list in the message, a list of strings in the record. `Bracketed`: the
 * message encloses the list in square brackets (MAN_UNITS) and the record holds the items. */
template <class C, std::vector<std::string> C::*P, bool Bracketed = false>
inline Leaf csv_leaf(const char* name, const char* units, bool required) {
    return custom_leaf<C>(
        name, units, required,
        [](C& o, const std::string& raw, std::string* err) {
            if (Bracketed) {
                const std::string r = trim(raw);
                if (!r.empty() && (r.front() == '[') != (r.back() == ']')) {
                    *err = "a units list is enclosed in square brackets: [a, b, c]";
                    return false;
                }
            }
            const std::string t = Bracketed ? unbracket(raw) : raw;
            std::vector<std::string>& v = o.*P;
            v.clear();
            size_t b = 0;
            while (b <= t.size()) {
                size_t e = t.find(',', b);
                if (e == std::string::npos) e = t.size();
                const std::string item = trim(t.substr(b, e - b));
                if (!item.empty()) v.push_back(item);
                b = e + 1;
            }
            return true;
        },
        [](const C& o, bool req, std::vector<std::string>* out) {
            const std::vector<std::string>& v = o.*P;
            if (v.empty() && !req) return;
            std::string s;
            for (size_t i = 0; i < v.size(); ++i) {
                if (i) s += ", ";
                s += v[i];
            }
            out->push_back(Bracketed ? "[" + s + "]" : s);
        });
}

template <class C, std::vector<double> C::*P>
inline Leaf vec_leaf(const char* name) {
    return custom_leaf<C>(
        name, nullptr, false,
        [](C& o, const std::string& t, std::string* e) { return Conv<std::vector<double>>::take(o.*P, t, e); },
        [](const C& o, bool, std::vector<std::string>* out) {
            Conv<std::vector<double>>::give(o.*P, o.*P, false, out);
        });
}

/* A data line: one string of the record's list per line. */
template <class C, std::vector<std::string> C::*P>
inline Leaf lines_leaf(const char* name) {
    Leaf l = custom_leaf<C>(
        name, nullptr, true,
        [](C& o, const std::string& t, std::string*) { (o.*P).push_back(trim(t)); return true; },
        [](const C& o, bool, std::vector<std::string>* out) {
            for (const std::string& s : o.*P) out->push_back(s);
        });
    l.bare = true;
    return l;
}

template <bool Min>
inline Leaf cycles_leaf(const char* name) {
    return custom_leaf<MN>(
        name, nullptr, false,
        [](MN& o, const std::string& t, std::string* e) {
            if (Min) { o.HAS_DC_MIN_CYCLES = true; return Conv<uint32_t>::take(o.DC_MIN_CYCLES, t, e); }
            o.HAS_DC_MAX_CYCLES = true;
            return Conv<uint32_t>::take(o.DC_MAX_CYCLES, t, e);
        },
        [](const MN& o, bool, std::vector<std::string>* out) {
            if (Min && o.HAS_DC_MIN_CYCLES) out->push_back(std::to_string(o.DC_MIN_CYCLES));
            if (!Min && o.HAS_DC_MAX_CYCLES) out->push_back(std::to_string(o.DC_MAX_CYCLES));
        });
}

inline Leaf atmospheric_model_leaf() {
    return custom_leaf<PT>(
        "ATMOSPHERIC_MODEL", nullptr, false,
        [](PT& o, const std::string& t, std::string*) { o.ATMOSPHERIC_MODEL_NAME = t; return true; },
        [](const PT& o, bool, std::vector<std::string>* out) {
            if (!o.ATMOSPHERIC_MODEL_NAME.empty()) out->push_back(o.ATMOSPHERIC_MODEL_NAME);
            else if (o.ATMOSPHERIC_MODEL) out->push_back(EnumNameAtmosphericModelFamily(o.ATMOSPHERIC_MODEL->MODEL));
        });
}

/* COMMENT lines into the header's comment list, for sections whose table has none. */
inline Leaf comment_to_header() {
    Leaf l;
    l.name = "COMMENT";
    l.relocated = true;
    l.take = [](Obj* o, const std::string& t, std::string*) {
        M& m = *static_cast<M*>(o);
        if (!m.HEADER) m.HEADER = std::make_unique<H>();
        m.HEADER->COMMENT.push_back(t);
        return true;
    };
    return l;
}

/* ------------------------------------------------------------------------ */
/* The single-trajectory fields and the lists                                */
/* ------------------------------------------------------------------------ */

inline bool looks_absolute(const std::string& tag) {
    return tag.find('T') != std::string::npos || tag.find(':') != std::string::npos;
}

inline bool traj_type_from_text(const std::string& t, trajectoryType* out, size_t* width) {
    const std::string u = upper(trim(t));
    if (u == "CARTPV") { *out = trajectoryType::CARTESIAN_PV; *width = 6; return true; }
    if (u == "CARTPVA") { *out = trajectoryType::CARTESIAN_PVA; *width = 9; return true; }
    return false;
}

inline const char* traj_type_text(trajectoryType t) {
    switch (t) {
        case trajectoryType::CARTESIAN_PV: return "CARTPV";
        case trajectoryType::CARTESIAN_PVA: return "CARTPVA";
        default: return nullptr;
    }
}

/* tag + numbers; false when the line is not that or the numbers are not reals. */
inline bool split_line(const std::string& line, std::string* tag, std::vector<double>* values) {
    const std::vector<std::string> tok = tokens(line);
    if (tok.size() < 2) return false;
    *tag = tok[0];
    values->clear();
    for (size_t i = 1; i < tok.size(); ++i) {
        double v = 0;
        if (!parse_double(tok[i], &v)) return false;
        values->push_back(v);
    }
    return true;
}

inline void mirror_trajectory(M& m) {
    if (m.TRAJECTORY_BLOCKS.empty() || !m.TRAJECTORY_BLOCKS[0]) return;
    const TB& b = *m.TRAJECTORY_BLOCKS[0];
    trajectoryType type = trajectoryType::CARTESIAN_PV;
    size_t width = 0;
    if (b.LINES.empty() || !traj_type_from_text(b.TRAJ_TYPE, &type, &width)) return;
    std::vector<std::string> tags;
    std::vector<double> data;
    for (const std::string& line : b.LINES) {
        std::string tag;
        std::vector<double> v;
        if (!split_line(line, &tag, &v) || v.size() != width) return;
        tags.push_back(tag);
        data.insert(data.end(), v.begin(), v.end());
    }
    bool absolute = true;
    for (const std::string& tag : tags) absolute = absolute && looks_absolute(tag);
    double first = 1.0;
    const bool lone_zero = tags.size() == 1 && parse_double(tags[0], &first) && first == 0.0;
    if (!absolute && !lone_zero) return;  /* relative tags beyond one state: the blocks hold them */
    m.TRAJ_TYPE = type;
    m.STATE_VECTOR_SIZE = static_cast<uint8_t>(width);
    m.STATE_DATA = data;
    m.STATE_EPOCHS.clear();
    if (absolute) m.STATE_EPOCHS = tags;
    m.CENTER_NAME = b.CENTER_NAME;
    if (!b.TRAJ_REF_FRAME.empty()) {
        m.TRAJ_REF_FRAME = std::make_unique<RFMT>();
        frames::set(*m.TRAJ_REF_FRAME, b.TRAJ_REF_FRAME);
    }
    m.TRAJ_FRAME_EPOCH = b.TRAJ_FRAME_EPOCH;
    if (!std::isnan(b.ORB_REVNUM) && b.ORB_REVNUM >= 0.0) m.ORB_REVNUM = static_cast<uint32_t>(b.ORB_REVNUM);
    m.ORB_AVERAGING = b.ORB_AVERAGING;
}

inline void synthesize_trajectory(M& m) {
    if (!m.TRAJECTORY_BLOCKS.empty() || m.STATE_DATA.empty()) return;
    const char* type = traj_type_text(m.TRAJ_TYPE);
    const size_t width = m.STATE_VECTOR_SIZE ? m.STATE_VECTOR_SIZE : 6;
    if (!type || m.STATE_DATA.size() % width != 0) return;  /* check_record names why */
    const size_t n = m.STATE_DATA.size() / width;
    if (!m.STATE_EPOCHS.empty() && m.STATE_EPOCHS.size() != n) return;
    if (m.STATE_EPOCHS.empty() && n > 1 && !(m.STATE_STEP_SIZE > 0.0)) return;
    auto b = std::make_unique<TB>();
    b->TRAJ_TYPE = type;
    b->CENTER_NAME = m.CENTER_NAME;
    if (m.TRAJ_REF_FRAME) b->TRAJ_REF_FRAME = frames::name_of(*m.TRAJ_REF_FRAME);
    b->TRAJ_FRAME_EPOCH = m.TRAJ_FRAME_EPOCH;
    if (m.ORB_REVNUM != 0) b->ORB_REVNUM = static_cast<double>(m.ORB_REVNUM);
    b->ORB_AVERAGING = m.ORB_AVERAGING;
    for (size_t i = 0; i < n; ++i) {
        std::string line = !m.STATE_EPOCHS.empty() ? m.STATE_EPOCHS[i]
                           : (n == 1 ? std::string("0.0") : format_double(static_cast<double>(i) * m.STATE_STEP_SIZE));
        for (size_t k = 0; k < width; ++k) line += " " + format_double(m.STATE_DATA[i * width + k]);
        b->LINES.push_back(line);
    }
    m.TRAJECTORY_BLOCKS.push_back(std::move(b));
}

inline size_t matrix_size(covarianceOrdering ordering, size_t count) {
    if (ordering == covarianceOrdering::FULL) {
        const size_t n = static_cast<size_t>(std::llround(std::sqrt(static_cast<double>(count))));
        return n * n == count ? n : 0;
    }
    const size_t n = static_cast<size_t>(std::llround((std::sqrt(8.0 * static_cast<double>(count) + 1.0) - 1.0) / 2.0));
    return n * (n + 1) / 2 == count ? n : 0;
}

inline void mirror_covariance(M& m) {
    if (m.COVARIANCE_BLOCKS.empty() || !m.COVARIANCE_BLOCKS[0]) return;
    const CB& b = *m.COVARIANCE_BLOCKS[0];
    if (b.LINES.size() != 1) return;
    std::string tag;
    std::vector<double> v;
    if (!split_line(b.LINES[0], &tag, &v)) return;
    const size_t n = matrix_size(b.COV_ORDERING, v.size());
    if (n == 0) return;
    m.COVARIANCE_DATA = v;
    m.COV_TYPE = b.COV_TYPE;
    m.COV_ORDERING = b.COV_ORDERING;
    m.COV_SIZE = static_cast<uint8_t>(n);
    if (!b.COV_REF_FRAME.empty()) {
        m.COV_REF_FRAME = std::make_unique<RFMT>();
        frames::set(*m.COV_REF_FRAME, b.COV_REF_FRAME);
    }
    m.COV_UNITS.clear();
    const std::string units = unbracket(b.COV_UNITS);
    size_t at = 0;
    while (at <= units.size() && !units.empty()) {
        size_t e = units.find(',', at);
        if (e == std::string::npos) e = units.size();
        const std::string u = trim(units.substr(at, e - at));
        if (!u.empty()) m.COV_UNITS.push_back(u);
        at = e + 1;
    }
}

inline void synthesize_covariance(M& m) {
    if (!m.COVARIANCE_BLOCKS.empty() || m.COVARIANCE_DATA.empty()) return;
    auto b = std::make_unique<CB>();
    b->COV_TYPE = m.COV_TYPE.empty() ? std::string("CARTPV") : m.COV_TYPE;
    b->COV_ORDERING = m.COV_ORDERING;
    if (m.COV_REF_FRAME) b->COV_REF_FRAME = frames::name_of(*m.COV_REF_FRAME);
    if (!m.COV_UNITS.empty()) {
        b->COV_UNITS = "[";
        for (size_t i = 0; i < m.COV_UNITS.size(); ++i) b->COV_UNITS += (i ? ", " : "") + m.COV_UNITS[i];
        b->COV_UNITS += "]";
    }
    std::string line = "0.0";
    for (double d : m.COVARIANCE_DATA) line += " " + format_double(d);
    b->LINES.push_back(line);
    m.COVARIANCE_BLOCKS.push_back(std::move(b));
}

inline std::shared_ptr<Message> build() {
    auto msg = std::make_shared<Message>();
    msg->type = "OCM";
    msg->root = "ocm";
    msg->version_key = "CCSDS_OCM_VERS";
    msg->version = "3.0";
    msg->take_version = [v = msg->version](Obj* o, const std::string&, std::string*) {
        M& m = *static_cast<M*>(o);
        if (!m.HEADER) m.HEADER = std::make_unique<H>();
        m.HEADER->CCSDS_OCM_VERS = v;
        return true;
    };
    msg->after_read = [](Obj* o) {
        M& m = *static_cast<M*>(o);
        mirror_trajectory(m);
        mirror_covariance(m);
    };
    msg->before_write = [](Obj* o) {
        M& m = *static_cast<M*>(o);
        synthesize_trajectory(m);
        synthesize_covariance(m);
    };
    msg->check_record = [](const Obj* o) {
        const M& m = *static_cast<const M*>(o);
        if (m.TRAJECTORY_BLOCKS.empty() && !m.STATE_DATA.empty()) {
            const size_t width = m.STATE_VECTOR_SIZE ? m.STATE_VECTOR_SIZE : 6;
            if (!traj_type_text(m.TRAJ_TYPE)) {
                return std::string("the single-trajectory fields hold a TRAJ_TYPE this message states only as a TRAJECTORY_BLOCK (CARTPV and CARTPVA are the ones it can write from STATE_DATA).");
            }
            if (m.STATE_DATA.size() % width != 0) {
                return "STATE_DATA holds " + std::to_string(m.STATE_DATA.size()) + " values, not a whole number of " + std::to_string(width) + "-value states.";
            }
            const size_t n = m.STATE_DATA.size() / width;
            if (!m.STATE_EPOCHS.empty() && m.STATE_EPOCHS.size() != n) {
                return std::string("STATE_EPOCHS and STATE_DATA disagree on the number of states.");
            }
            if (m.STATE_EPOCHS.empty() && n > 1 && !(m.STATE_STEP_SIZE > 0.0)) {
                return std::string("STATE_DATA holds several states with neither STATE_EPOCHS nor a STATE_STEP_SIZE to time them.");
            }
        }
        return std::string();
    };

    SectionOptions optional;
    optional.optional = true;
    auto repeated = [](const char* start, const char* stop) {
        SectionOptions o = block(start, stop);
        o.repeat = true;
        o.optional = true;
        return o;
    };
    auto single = [](const char* start, const char* stop) {
        SectionOptions o = block(start, stop);
        o.optional = true;
        return o;
    };

    auto header = section("header", NDM_NAV_ONE(M, HEADER), {
        NDM_COMMENTS(H, COMMENT, true),
        NDM_LEAF(H, CLASSIFICATION, nullptr, false),
        NDM_LEAF(H, CREATION_DATE, nullptr, true),
        NDM_LEAF(H, ORIGINATOR, nullptr, true),
        NDM_LEAF(H, MESSAGE_ID, nullptr, false),
    });
    header->optional = false;

    auto metadata = section("metadata", NDM_NAV_ONE(M, METADATA), {
        NDM_COMMENTS(MD, COMMENT, true),
        NDM_LEAF(MD, OBJECT_NAME, nullptr, false),
        NDM_LEAF(MD, INTERNATIONAL_DESIGNATOR, nullptr, false),
        NDM_LEAF(MD, CATALOG_NAME, nullptr, false),
        NDM_LEAF(MD, OBJECT_DESIGNATOR, nullptr, false),
        csv_leaf<MD, &MD::ALTERNATE_NAMES>("ALTERNATE_NAMES", nullptr, false),
        NDM_LEAF(MD, ORIGINATOR_POC, nullptr, false),
        NDM_LEAF(MD, ORIGINATOR_POSITION, nullptr, false),
        NDM_LEAF(MD, ORIGINATOR_PHONE, nullptr, false),
        NDM_LEAF(MD, ORIGINATOR_EMAIL, nullptr, false),
        NDM_LEAF(MD, ORIGINATOR_ADDRESS, nullptr, false),
        NDM_LEAF(MD, TECH_ORG, nullptr, false),
        NDM_LEAF(MD, TECH_POC, nullptr, false),
        NDM_LEAF(MD, TECH_POSITION, nullptr, false),
        NDM_LEAF(MD, TECH_PHONE, nullptr, false),
        NDM_LEAF(MD, TECH_EMAIL, nullptr, false),
        NDM_LEAF(MD, TECH_ADDRESS, nullptr, false),
        NDM_LEAF(MD, PREVIOUS_MESSAGE_ID, nullptr, false),
        NDM_LEAF(MD, NEXT_MESSAGE_ID, nullptr, false),
        NDM_LEAF(MD, ADM_MSG_LINK, nullptr, false),
        NDM_LEAF(MD, CDM_MSG_LINK, nullptr, false),
        NDM_LEAF(MD, PRM_MSG_LINK, nullptr, false),
        NDM_LEAF(MD, RDM_MSG_LINK, nullptr, false),
        csv_leaf<MD, &MD::TDM_MSG_LINK>("TDM_MSG_LINK", nullptr, false),
        NDM_LEAF(MD, OPERATOR, nullptr, false),
        NDM_LEAF(MD, OWNER, nullptr, false),
        NDM_LEAF(MD, COUNTRY, nullptr, false),
        NDM_LEAF(MD, CONSTELLATION, nullptr, false),
        NDM_LEAF(MD, OBJECT_TYPE, nullptr, false),
        NDM_LEAF(MD, TIME_SYSTEM, nullptr, true),
        NDM_LEAF(MD, EPOCH_TZERO, nullptr, true),
        NDM_LEAF(MD, OPS_STATUS, nullptr, false),
        NDM_LEAF(MD, ORBIT_CATEGORY, nullptr, false),
        csv_leaf<MD, &MD::OCM_DATA_ELEMENTS>("OCM_DATA_ELEMENTS", nullptr, false),
        NDM_LEAF(MD, SCLK_OFFSET_AT_EPOCH, "s", false),
        NDM_LEAF(MD, SCLK_SEC_PER_SI_SEC, "s", false),
        NDM_LEAF(MD, PREVIOUS_MESSAGE_EPOCH, nullptr, false),
        NDM_LEAF(MD, NEXT_MESSAGE_EPOCH, nullptr, false),
        NDM_LEAF(MD, START_TIME, nullptr, false),
        NDM_LEAF(MD, STOP_TIME, nullptr, false),
        NDM_LEAF(MD, TIME_SPAN, "d", false),
        NDM_LEAF(MD, TAIMUTC_AT_TZERO, "s", false),
        NDM_LEAF(MD, NEXT_LEAP_EPOCH, nullptr, false),
        NDM_LEAF(MD, NEXT_LEAP_TAIMUTC, "s", false),
        NDM_LEAF(MD, UT1MUTC_AT_TZERO, "s", false),
        NDM_LEAF(MD, EOP_SOURCE, nullptr, false),
        NDM_LEAF(MD, INTERP_METHOD_EOP, nullptr, false),
        NDM_LEAF(MD, CELESTIAL_SOURCE, nullptr, false),
    }, block("META_START", "META_STOP"));

    auto traj = section("traj", NDM_NAV_MANY(M, TRAJECTORY_BLOCKS), {
        NDM_COMMENT(TB, COMMENT, true),
        NDM_LEAF(TB, TRAJ_ID, nullptr, false),
        NDM_LEAF(TB, TRAJ_PREV_ID, nullptr, false),
        NDM_LEAF(TB, TRAJ_NEXT_ID, nullptr, false),
        NDM_LEAF(TB, TRAJ_BASIS, nullptr, false),
        NDM_LEAF(TB, TRAJ_BASIS_ID, nullptr, false),
        NDM_LEAF(TB, INTERPOLATION, nullptr, false),
        NDM_LEAF(TB, INTERPOLATION_DEGREE, nullptr, false),
        NDM_LEAF(TB, PROPAGATOR, nullptr, false),
        NDM_LEAF(TB, CENTER_NAME, nullptr, true),
        NDM_LEAF(TB, TRAJ_REF_FRAME, nullptr, true),
        NDM_LEAF(TB, TRAJ_FRAME_EPOCH, nullptr, false),
        NDM_LEAF(TB, USEABLE_START_TIME, nullptr, false),
        NDM_LEAF(TB, USEABLE_STOP_TIME, nullptr, false),
        NDM_LEAF(TB, ORB_REVNUM, nullptr, false),
        NDM_LEAF(TB, ORB_REVNUM_BASIS, nullptr, false),
        NDM_LEAF(TB, TRAJ_TYPE, nullptr, true),
        NDM_LEAF(TB, ORB_AVERAGING, nullptr, false),
        NDM_LEAF(TB, TRAJ_UNITS, nullptr, false),
        lines_leaf<TB, &TB::LINES>("trajLine"),
    }, repeated("TRAJ_START", "TRAJ_STOP"));

    auto phys = section("phys", NDM_NAV_ONE(M, PHYSICAL_PROPERTIES), {
        NDM_COMMENTS(PP, COMMENT, true),
        NDM_LEAF(PP, MANUFACTURER, nullptr, false),
        NDM_LEAF(PP, BUS_MODEL, nullptr, false),
        NDM_LEAF(PP, DOCKED_WITH, nullptr, false),
        NDM_LEAF(PP, DRAG_CONST_AREA, "m**2", false),
        NDM_LEAF(PP, DRAG_COEFF_NOM, nullptr, false),
        NDM_LEAF(PP, DRAG_UNCERTAINTY, "%", false),
        NDM_LEAF(PP, INITIAL_WET_MASS, "kg", false),
        NDM_LEAF(PP, WET_MASS, "kg", false),
        NDM_LEAF(PP, DRY_MASS, "kg", false),
        NDM_LEAF(PP, OEB_PARENT_FRAME, nullptr, false),
        NDM_LEAF(PP, OEB_PARENT_FRAME_EPOCH, nullptr, false),
        NDM_LEAF(PP, OEB_Q1, nullptr, false),
        NDM_LEAF(PP, OEB_Q2, nullptr, false),
        NDM_LEAF(PP, OEB_Q3, nullptr, false),
        NDM_LEAF(PP, OEB_QC, nullptr, false),
        NDM_LEAF(PP, OEB_MAX, "m", false),
        NDM_LEAF(PP, OEB_INT, "m", false),
        NDM_LEAF(PP, OEB_MIN, "m", false),
        NDM_LEAF(PP, AREA_ALONG_OEB_MAX, "m**2", false),
        NDM_LEAF(PP, AREA_ALONG_OEB_INT, "m**2", false),
        NDM_LEAF(PP, AREA_ALONG_OEB_MIN, "m**2", false),
        NDM_LEAF(PP, AREA_MIN_FOR_PC, "m**2", false),
        NDM_LEAF(PP, AREA_MAX_FOR_PC, "m**2", false),
        NDM_LEAF(PP, AREA_TYP_FOR_PC, "m**2", false),
        NDM_LEAF(PP, RCS, "m**2", false),
        NDM_LEAF(PP, RCS_MIN, "m**2", false),
        NDM_LEAF(PP, RCS_MAX, "m**2", false),
        NDM_LEAF(PP, SRP_CONST_AREA, "m**2", false),
        NDM_LEAF(PP, SOLAR_RAD_COEFF, nullptr, false),
        NDM_LEAF_AS(PP, "SOLAR_RAD_UNCERTAINTY", SRP_UNCERTAINTY, "%", false),
        NDM_LEAF(PP, VM_ABSOLUTE, nullptr, false),
        NDM_LEAF(PP, VM_APPARENT_MIN, nullptr, false),
        NDM_LEAF(PP, VM_APPARENT, nullptr, false),
        NDM_LEAF(PP, VM_APPARENT_MAX, nullptr, false),
        NDM_LEAF(PP, REFLECTANCE, nullptr, false),
        NDM_LEAF(PP, ATT_CONTROL_MODE, nullptr, false),
        NDM_LEAF(PP, ATT_ACTUATOR_TYPE, nullptr, false),
        NDM_LEAF(PP, ATT_KNOWLEDGE, "deg", false),
        NDM_LEAF(PP, ATT_CONTROL, "deg", false),
        NDM_LEAF(PP, ATT_POINTING, "deg", false),
        NDM_LEAF(PP, AVG_MANEUVER_FREQ, "#/yr", false),
        NDM_LEAF(PP, MAX_THRUST, "N", false),
        NDM_LEAF(PP, DV_BOL, "km/s", false),
        NDM_LEAF(PP, DV_REMAINING, "km/s", false),
        NDM_LEAF(PP, IXX, "kg*m**2", false),
        NDM_LEAF(PP, IYY, "kg*m**2", false),
        NDM_LEAF(PP, IZZ, "kg*m**2", false),
        NDM_LEAF(PP, IXY, "kg*m**2", false),
        NDM_LEAF(PP, IXZ, "kg*m**2", false),
        NDM_LEAF(PP, IYZ, "kg*m**2", false),
    }, single("PHYS_START", "PHYS_STOP"));

    auto cov = section("cov", NDM_NAV_MANY(M, COVARIANCE_BLOCKS), {
        NDM_COMMENT(CB, COMMENT, true),
        NDM_LEAF(CB, COV_ID, nullptr, false),
        NDM_LEAF(CB, COV_PREV_ID, nullptr, false),
        NDM_LEAF(CB, COV_NEXT_ID, nullptr, false),
        NDM_LEAF(CB, COV_BASIS, nullptr, false),
        NDM_LEAF(CB, COV_BASIS_ID, nullptr, false),
        NDM_LEAF(CB, COV_REF_FRAME, nullptr, true),
        NDM_LEAF(CB, COV_FRAME_EPOCH, nullptr, false),
        NDM_LEAF(CB, COV_SCALE_MIN, nullptr, false),
        NDM_LEAF(CB, COV_SCALE_MAX, nullptr, false),
        NDM_LEAF(CB, COV_CONFIDENCE, "%", false),
        NDM_LEAF(CB, COV_TYPE, nullptr, true),
        NDM_LEAF(CB, COV_ORDERING, nullptr, true),
        NDM_LEAF(CB, COV_UNITS, nullptr, false),
        lines_leaf<CB, &CB::LINES>("covLine"),
    }, repeated("COV_START", "COV_STOP"));

    auto man = section("man", NDM_NAV_MANY(M, MANEUVER_DATA), {
        NDM_COMMENTS(MN, MAN_COMMENT, true),
        NDM_LEAF(MN, MAN_ID, nullptr, true),
        NDM_LEAF(MN, MAN_PREV_ID, nullptr, false),
        NDM_LEAF(MN, MAN_NEXT_ID, nullptr, false),
        NDM_LEAF(MN, MAN_BASIS, nullptr, false),
        NDM_LEAF(MN, MAN_BASIS_ID, nullptr, false),
        NDM_LEAF(MN, MAN_DEVICE_ID, nullptr, true),
        NDM_LEAF(MN, MAN_PREV_EPOCH, nullptr, false),
        NDM_LEAF(MN, MAN_NEXT_EPOCH, nullptr, false),
        NDM_LEAF(MN, MAN_PURPOSE, nullptr, false),
        NDM_LEAF(MN, MAN_PRED_SOURCE, nullptr, false),
        NDM_LEAF(MN, MAN_REF_FRAME, nullptr, true),
        NDM_LEAF(MN, MAN_FRAME_EPOCH, nullptr, false),
        NDM_LEAF(MN, GRAV_ASSIST_NAME, nullptr, false),
        NDM_LEAF(MN, DC_TYPE, nullptr, true),
        NDM_LEAF(MN, DC_WIN_OPEN, nullptr, false),
        NDM_LEAF(MN, DC_WIN_CLOSE, nullptr, false),
        cycles_leaf<true>("DC_MIN_CYCLES"),
        cycles_leaf<false>("DC_MAX_CYCLES"),
        NDM_LEAF(MN, DC_EXEC_START, nullptr, false),
        NDM_LEAF(MN, DC_EXEC_STOP, nullptr, false),
        NDM_LEAF(MN, DC_REF_TIME, nullptr, false),
        NDM_LEAF(MN, DC_TIME_PULSE_DURATION, "s", false),
        NDM_LEAF(MN, DC_TIME_PULSE_PERIOD, "s", false),
        vec_leaf<MN, &MN::DC_REF_DIR>("DC_REF_DIR"),
        NDM_LEAF(MN, DC_BODY_FRAME, nullptr, false),
        vec_leaf<MN, &MN::DC_BODY_TRIGGER>("DC_BODY_TRIGGER"),
        NDM_LEAF(MN, DC_PA_START_ANGLE, "deg", false),
        NDM_LEAF(MN, DC_PA_STOP_ANGLE, "deg", false),
        csv_leaf<MN, &MN::MAN_COMPOSITION>("MAN_COMPOSITION", nullptr, true),
        csv_leaf<MN, &MN::MAN_UNITS, true>("MAN_UNITS", nullptr, false),
        lines_leaf<MN, &MN::DATA>("manLine"),
    }, repeated("MAN_START", "MAN_STOP"));

    auto pert = section("pert", NDM_NAV_ONE(M, PERTURBATIONS), {
        NDM_COMMENTS(PT, COMMENT, true),
        atmospheric_model_leaf(),
        NDM_LEAF(PT, GRAVITY_MODEL, nullptr, false),
        NDM_LEAF(PT, EQUATORIAL_RADIUS, "km", false),
        NDM_LEAF(PT, GM, "km**3/s**2", false),
        csv_leaf<PT, &PT::N_BODY_PERTURBATIONS>("N_BODY_PERTURBATIONS", nullptr, false),
        NDM_LEAF(PT, CENTRAL_BODY_ROTATION, "deg/s", false),
        NDM_LEAF(PT, OBLATE_FLATTENING, nullptr, false),
        NDM_LEAF(PT, OCEAN_TIDES_MODEL, nullptr, false),
        NDM_LEAF(PT, SOLID_TIDES_MODEL, nullptr, false),
        NDM_LEAF(PT, REDUCTION_THEORY, nullptr, false),
        NDM_LEAF_AS(PT, "ALBEDO_MODEL", ALBEDO, nullptr, false),
        NDM_LEAF(PT, ALBEDO_GRID_SIZE, nullptr, false),
        NDM_LEAF(PT, SHADOW_MODEL, nullptr, false),
        NDM_LEAF(PT, SHADOW_BODIES, nullptr, false),
        NDM_LEAF_AS(PT, "SRP_MODEL", SOLAR_RAD_PRESSURE, nullptr, false),
        NDM_LEAF(PT, SW_DATA_SOURCE, nullptr, false),
        NDM_LEAF(PT, SW_DATA_EPOCH, nullptr, false),
        NDM_LEAF(PT, SW_INTERP_METHOD, nullptr, false),
        NDM_LEAF(PT, FIXED_GEOMAG_KP, "nT", false),
        NDM_LEAF(PT, FIXED_GEOMAG_AP, "nT", false),
        NDM_LEAF(PT, FIXED_GEOMAG_DST, "nT", false),
        NDM_LEAF(PT, FIXED_F10P7, "SFU", false),
        NDM_LEAF(PT, FIXED_F10P7_MEAN, "SFU", false),
        NDM_LEAF(PT, FIXED_M10P7, "SFU", false),
        NDM_LEAF(PT, FIXED_M10P7_MEAN, "SFU", false),
        NDM_LEAF(PT, FIXED_S10P7, "SFU", false),
        NDM_LEAF(PT, FIXED_S10P7_MEAN, "SFU", false),
        NDM_LEAF(PT, FIXED_Y10P7, "SFU", false),
        NDM_LEAF(PT, FIXED_Y10P7_MEAN, "SFU", false),
    }, single("PERT_START", "PERT_STOP"));

    auto od = section("od", NDM_NAV_ONE(M, ORBIT_DETERMINATION), {
        NDM_COMMENTS(OD, COMMENT, true),
        NDM_LEAF(OD, OD_ID, nullptr, true),
        NDM_LEAF(OD, OD_PREV_ID, nullptr, false),
        NDM_LEAF(OD, OD_METHOD, nullptr, true),
        NDM_LEAF(OD, OD_EPOCH, nullptr, true),
        NDM_LEAF(OD, DAYS_SINCE_FIRST_OBS, "d", false),
        NDM_LEAF(OD, DAYS_SINCE_LAST_OBS, "d", false),
        NDM_LEAF(OD, RECOMMENDED_OD_SPAN, "d", false),
        NDM_LEAF(OD, ACTUAL_OD_SPAN, "d", false),
        NDM_LEAF(OD, OBS_AVAILABLE, nullptr, false),
        NDM_LEAF_AS(OD, "OBS_USED", OD_OBSERVATIONS_USED, nullptr, false),
        NDM_LEAF(OD, TRACKS_AVAILABLE, nullptr, false),
        NDM_LEAF_AS(OD, "TRACKS_USED", OD_TRACKS_USED, nullptr, false),
        NDM_LEAF(OD, MAXIMUM_OBS_GAP, "d", false),
        NDM_LEAF(OD, OD_EPOCH_EIGMAJ, "m", false),
        NDM_LEAF(OD, OD_EPOCH_EIGINT, "m", false),
        NDM_LEAF(OD, OD_EPOCH_EIGMIN, "m", false),
        NDM_LEAF(OD, OD_MAX_PRED_EIGMAJ, "m", false),
        NDM_LEAF(OD, OD_MIN_PRED_EIGMIN, "m", false),
        NDM_LEAF(OD, OD_CONFIDENCE, "%", false),
        NDM_LEAF(OD, GDOP, nullptr, false),
        NDM_LEAF(OD, SOLVE_N, nullptr, false),
        NDM_LEAF(OD, SOLVE_STATES, nullptr, false),
        NDM_LEAF(OD, CONSIDER_N, nullptr, false),
        NDM_LEAF(OD, CONSIDER_PARAMS, nullptr, false),
        NDM_LEAF(OD, SEDR, "W/kg", false),
        NDM_LEAF(OD, SENSORS_N, nullptr, false),
        NDM_LEAF(OD, SENSORS, nullptr, false),
        NDM_LEAF(OD, WEIGHTED_RMS, nullptr, false),
        csv_leaf<OD, &OD::OD_OBSERVATIONS_TYPE>("DATA_TYPES", nullptr, false),
    }, single("OD_START", "OD_STOP"));

    auto user = section("user", nav_same(), {
        comment_to_header(),
        user_defined_leaf<M, UserDefinedParametersT, &M::USER_DEFINED_PARAMETERS>(),
    }, single("USER_START", "USER_STOP"));

    auto data = section("data", nav_same(), {traj, phys, cov, man, pert, od, user});
    auto segment = section("segment", nav_same(), {metadata, data});
    auto body = section("body", nav_same(), {segment});
    msg->top = section("ocm", nav_same(), {header, body});
    return msg;
}

inline const Message& message() {
    static const std::shared_ptr<Message> m = build();
    return *m;
}

}  // namespace ocm
}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_OCM_HPP
