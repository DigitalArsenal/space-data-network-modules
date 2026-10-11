/*
 * files/ccsds-messages — CCSDS 508.0-B-1 Conjunction Data Message, bound to $CDM.
 *
 * A CDM is a header, the relative metadata and data of the encounter, and two
 * segments, one per object, each a metadata group and a data group. The record
 * holds the two objects as OBJECT1 and OBJECT2, so the segment section selects its
 * instance by the OBJECT keyword and labels the one it writes by position.
 *
 * UNITS. The message states metres; the record, as analysis/conjunction-assessment
 * has always written it, holds kilometres (and the first 21 covariance cells in
 * km**2, km**2/s and km**2/s**2; the drag, solar radiation pressure and thrust
 * cells as the message states them). The shift is made on the digits, so a value
 * reads back as exactly the text it came from. A message that annotates a length
 * [km] is read as kilometres.
 *
 * WHAT THE RECORD CANNOT SAY. A boolean parameter it holds as false is the same
 * bytes as one never stated, so SOLAR_RAD_PRESSURE = NO is left out; a CDM with no
 * covariance is written without one (the message requires it; none is invented).
 */

#ifndef CCSDS_MESSAGES_NDM_CDM_HPP
#define CCSDS_MESSAGES_NDM_CDM_HPP

#include "ndm_common.hpp"
#include "ndm_core.hpp"
#include "ndm_enums.hpp"
#include "ndm_frames.hpp"

namespace ndm {

NDM_ENUM(covarianceAlgorithm);
NDM_ENUM(screeningVolumeShape);
NDM_ENUM(spaceObjectClass);

namespace cdm {

using O = CDMObjectT;

inline CATT& cat(O& o) {
    if (!o.OBJECT) o.OBJECT = std::make_unique<CATT>();
    return *o.OBJECT;
}
inline EPMT& poc(O& o) {
    if (!o.POC) o.POC = std::make_unique<EPMT>();
    return *o.POC;
}

inline bool all_digits(const std::string& s) {
    if (s.empty()) return false;
    for (char c : s) {
        if (c < '0' || c > '9') return false;
    }
    return true;
}

template <std::string CATT::*P>
inline Leaf cat_string(const char* name, bool required) {
    return custom_leaf<O>(
        name, nullptr, required,
        [](O& o, const std::string& t, std::string*) { cat(o).*P = t; return true; },
        [](const O& o, bool req, std::vector<std::string>* out) {
            const std::string v = o.OBJECT ? (*o.OBJECT).*P : std::string();
            if (req || !v.empty()) out->push_back(v);
        });
}

inline Leaf designator_leaf() {
    return custom_leaf<O>(
        "OBJECT_DESIGNATOR", nullptr, true,
        [](O& o, const std::string& t, std::string*) {
            o.OBJECT_DESIGNATOR = t;
            unsigned long long id = 0;
            if (all_digits(t) && parse_u64(t, &id) && id <= 0xFFFFFFFFull) {
                cat(o).NORAD_CAT_ID = static_cast<uint32_t>(id);
            }
            return true;
        },
        [](const O& o, bool, std::vector<std::string>* out) {
            if (!o.OBJECT_DESIGNATOR.empty()) {
                out->push_back(o.OBJECT_DESIGNATOR);
            } else if (o.OBJECT && o.OBJECT->NORAD_CAT_ID != 0) {
                out->push_back(std::to_string(o.OBJECT->NORAD_CAT_ID));
            } else {
                out->push_back(std::string());
            }
        });
}

inline Leaf object_type_leaf() {
    return custom_leaf<O>(
        "OBJECT_TYPE", nullptr, false,
        [](O& o, const std::string& t, std::string* e) {
            const std::string u = upper(trim(t));
            if (u == "PAYLOAD") cat(o).OBJECT_TYPE = spaceObjectClass::PAYLOAD;
            else if (u == "ROCKET BODY" || u == "ROCKET_BODY") cat(o).OBJECT_TYPE = spaceObjectClass::ROCKET_BODY;
            else if (u == "DEBRIS") cat(o).OBJECT_TYPE = spaceObjectClass::DEBRIS;
            else if (u == "UNKNOWN" || u == "OTHER") cat(o).OBJECT_TYPE = spaceObjectClass::UNKNOWN;
            else { *e = "OBJECT_TYPE is PAYLOAD, ROCKET BODY, DEBRIS or UNKNOWN"; return false; }
            return true;
        },
        [](const O& o, bool, std::vector<std::string>* out) {
            if (!o.OBJECT) return;
            switch (o.OBJECT->OBJECT_TYPE) {
                case spaceObjectClass::PAYLOAD: out->push_back("PAYLOAD"); break;
                case spaceObjectClass::ROCKET_BODY: out->push_back("ROCKET BODY"); break;
                case spaceObjectClass::DEBRIS: out->push_back("DEBRIS"); break;
                case spaceObjectClass::UNKNOWN: break;
            }
        });
}

inline Leaf maneuverable_leaf() {
    return custom_leaf<O>(
        "MANEUVERABLE", nullptr, true,
        [](O& o, const std::string& t, std::string* e) {
            const std::string u = upper(trim(t));
            if (u == "YES") { o.MANEUVERABLE = cdmManeuverable::YES; cat(o).MANEUVERABLE = true; }
            else if (u == "NO") { o.MANEUVERABLE = cdmManeuverable::NO; cat(o).MANEUVERABLE = false; }
            else if (u == "N/A") { o.MANEUVERABLE = cdmManeuverable::NOT_APPLICABLE; }
            else { *e = "MANEUVERABLE is YES, NO or N/A"; return false; }
            return true;
        },
        [](const O& o, bool, std::vector<std::string>* out) {
            switch (o.MANEUVERABLE) {
                case cdmManeuverable::YES: out->push_back("YES"); return;
                case cdmManeuverable::NO: out->push_back("NO"); return;
                case cdmManeuverable::NOT_APPLICABLE: out->push_back("N/A"); return;
                case cdmManeuverable::UNSPECIFIED: break;
            }
            out->push_back(o.OBJECT && o.OBJECT->MANEUVERABLE ? "YES" : "NO");
        });
}

inline Leaf mass_leaf() {
    return custom_leaf<O>(
        "MASS", "kg", false,
        [](O& o, const std::string& t, std::string* e) { return Conv<double>::take(cat(o).MASS, t, e); },
        [](const O& o, bool, std::vector<std::string>* out) {
            if (o.OBJECT && o.OBJECT->MASS != 0.0) out->push_back(format_double(o.OBJECT->MASS));
        });
}

inline Leaf poc_leaf(const char* name, bool phone) {
    return custom_leaf<O>(
        name, nullptr, false,
        [phone](O& o, const std::string& t, std::string*) {
            (phone ? poc(o).TELEPHONE : poc(o).EMAIL) = t;
            return true;
        },
        [phone](const O& o, bool, std::vector<std::string>* out) {
            if (!o.POC) return;
            const std::string& v = phone ? o.POC->TELEPHONE : o.POC->EMAIL;
            if (!v.empty()) out->push_back(v);
        });
}

inline Leaf orbit_center_leaf() {
    return custom_leaf<O>(
        "ORBIT_CENTER", nullptr, false,
        [](O& o, const std::string& t, std::string*) { cat(o).ORBIT_CENTER = t; return true; },
        [](const O& o, bool, std::vector<std::string>* out) {
            if (o.OBJECT && !o.OBJECT->ORBIT_CENTER.empty()) out->push_back(o.OBJECT->ORBIT_CENTER);
        });
}

/* The covariance keywords, in the order the record holds them (CCSDS 508.0-B-1
 * Table 3-5): the 6x6 position/velocity triangle, then drag, solar radiation
 * pressure and thrust. */
inline const char* const* covariance_cell_names() {
    static const char* const names[45] = {
        "CR_R", "CT_R", "CT_T", "CN_R", "CN_T", "CN_N", "CRDOT_R", "CRDOT_T", "CRDOT_N",
        "CRDOT_RDOT", "CTDOT_R", "CTDOT_T", "CTDOT_N", "CTDOT_RDOT", "CTDOT_TDOT", "CNDOT_R",
        "CNDOT_T", "CNDOT_N", "CNDOT_RDOT", "CNDOT_TDOT", "CNDOT_NDOT", "CDRG_R", "CDRG_T",
        "CDRG_N", "CDRG_RDOT", "CDRG_TDOT", "CDRG_NDOT", "CDRG_DRG", "CSRP_R", "CSRP_T", "CSRP_N",
        "CSRP_RDOT", "CSRP_TDOT", "CSRP_NDOT", "CSRP_DRG", "CSRP_SRP", "CTHR_R", "CTHR_T",
        "CTHR_N", "CTHR_RDOT", "CTHR_TDOT", "CTHR_NDOT", "CTHR_DRG", "CTHR_SRP", "CTHR_THR"};
    return names;
}

inline const char* covariance_cell_units(size_t i) {
    static const char* const units[45] = {
        "m**2", "m**2", "m**2", "m**2", "m**2", "m**2", "m**2/s", "m**2/s", "m**2/s",
        "m**2/s**2", "m**2/s", "m**2/s", "m**2/s", "m**2/s**2", "m**2/s**2", "m**2/s", "m**2/s",
        "m**2/s", "m**2/s**2", "m**2/s**2", "m**2/s**2", "m**3/kg", "m**3/kg", "m**3/kg",
        "m**3/(kg*s)", "m**3/(kg*s)", "m**3/(kg*s)", "m**4/kg**2", "m**3/kg", "m**3/kg", "m**3/kg",
        "m**3/(kg*s)", "m**3/(kg*s)", "m**3/(kg*s)", "m**4/kg**2", "m**4/kg**2", "m**2/s**2",
        "m**2/s**2", "m**2/s**2", "m**2/s**3", "m**2/s**3", "m**2/s**3", "m**3/(kg*s**2)",
        "m**3/(kg*s**2)", "m**2/s**4"};
    return units[i];
}

/* The cells a message may state: 21, then +7 (drag), +8 (solar radiation
 * pressure), +9 (thrust). */
inline bool covariance_size_ok(size_t n) { return n == 21 || n == 28 || n == 36 || n == 45; }

inline void add_covariance_cells(std::vector<Item>* items) {
    for (size_t i = 0; i < 45; ++i) {
        Leaf l;
        l.name = covariance_cell_names()[i];
        l.units = covariance_cell_units(i);
        l.required = i < 21;
        const int shift = i < 21 ? -6 : 0;  /* m**2 -> km**2 for the position/velocity block */
        l.take = [i, shift](Obj* o, const std::string& t, std::string* e) {
            std::vector<double>& v = static_cast<O*>(o)->COVARIANCE;
            if (v.size() <= i) v.resize(i + 1, 0.0);
            return Conv<double>::take(v[i], shift_decimal(t, shift), e);
        };
        l.give = [i, shift](const Obj* o, bool, std::vector<std::string>* out) {
            const std::vector<double>& v = static_cast<const O*>(o)->COVARIANCE;
            if (v.size() > i) out->push_back(shift_decimal(format_double(v[i]), -shift));
        };
        items->push_back(Item(l));
    }
}

inline std::shared_ptr<Message> build() {
    using M = CDMT;
    auto msg = std::make_shared<Message>();
    msg->type = "CDM";
    msg->root = "cdm";
    msg->version_key = "CCSDS_CDM_VERS";
    msg->version = "1.0";
    msg->take_version = [v = msg->version](Obj* o, const std::string&, std::string* e) {
        return Conv<double>::take(static_cast<M*>(o)->CCSDS_CDM_VERS, v, e);
    };
    msg->check_tree = [](const Node& root) {
        const Node* body = root.find("body");
        if (!body) return std::string();  /* what is missing is named as missing */
        size_t first = 0, second = 0, total = 0;
        for (const Node& segment : body->kids) {
            if (!segment.group || segment.name != "segment") continue;
            ++total;
            const Node* meta = segment.find("metadata");
            const Node* label = meta ? meta->find("OBJECT") : nullptr;
            const std::string v = label ? upper(trim(label->text)) : std::string();
            if (v == "OBJECT1") ++first;
            else if (v == "OBJECT2") ++second;
            else return "a CDM names its objects OBJECT1 and OBJECT2 (OBJECT = " + v + ")";
        }
        if (total != 2 || first != 1 || second != 1) {
            return std::string("a CDM holds two objects, OBJECT1 and OBJECT2, once each");
        }
        return std::string();
    };
    msg->check_record = [](const Obj* o) {
        const M& m = *static_cast<const M*>(o);
        for (int k = 0; k < 2; ++k) {
            const auto& obj = k == 0 ? m.OBJECT1 : m.OBJECT2;
            if (obj && !obj->COVARIANCE.empty() && !covariance_size_ok(obj->COVARIANCE.size())) {
                return "OBJECT" + std::to_string(k + 1) +
                       " holds a covariance of " + std::to_string(obj->COVARIANCE.size()) +
                       " values; a CDM states 21, 28, 36 or 45 (the 6x6 position/velocity "
                       "triangle, then the drag, solar radiation pressure and thrust rows).";
            }
        }
        return std::string();
    };

    SectionOptions optional;
    optional.optional = true;

    auto header = section("header", nav_same(), {
        NDM_COMMENT(M, COMMENT, true),
        NDM_LEAF(M, CREATION_DATE, nullptr, true),
        NDM_LEAF(M, ORIGINATOR, nullptr, true),
        NDM_LEAF(M, MESSAGE_FOR, nullptr, false),
        NDM_LEAF(M, MESSAGE_ID, nullptr, true),
    });

    SectionOptions relative_state_options;
    relative_state_options.present = [](const Obj* o) {
        const M& m = *static_cast<const M*>(o);
        return m.RELATIVE_POSITION_R != 0.0 || m.RELATIVE_POSITION_T != 0.0 ||
               m.RELATIVE_POSITION_N != 0.0 || m.RELATIVE_VELOCITY_R != 0.0 ||
               m.RELATIVE_VELOCITY_T != 0.0 || m.RELATIVE_VELOCITY_N != 0.0;
    };
    auto relative_state = section("relativeStateVector", nav_same(), {
        scaled_leaf<M, &M::RELATIVE_POSITION_R>("RELATIVE_POSITION_R", "m", -3, "km", true),
        scaled_leaf<M, &M::RELATIVE_POSITION_T>("RELATIVE_POSITION_T", "m", -3, "km", true),
        scaled_leaf<M, &M::RELATIVE_POSITION_N>("RELATIVE_POSITION_N", "m", -3, "km", true),
        scaled_leaf<M, &M::RELATIVE_VELOCITY_R>("RELATIVE_VELOCITY_R", "m/s", -3, "km/s", true),
        scaled_leaf<M, &M::RELATIVE_VELOCITY_T>("RELATIVE_VELOCITY_T", "m/s", -3, "km/s", true),
        scaled_leaf<M, &M::RELATIVE_VELOCITY_N>("RELATIVE_VELOCITY_N", "m/s", -3, "km/s", true),
    }, relative_state_options);

    auto relative = section("relativeMetadataData", nav_same(), {
        NDM_COMMENT(M, COMMENT, false),
        NDM_LEAF(M, TCA, nullptr, true),
        scaled_leaf<M, &M::MISS_DISTANCE>("MISS_DISTANCE", "m", -3, "km", true),
        scaled_leaf<M, &M::RELATIVE_SPEED>("RELATIVE_SPEED", "m/s", -3, "km/s", false),
        relative_state,
        NDM_LEAF(M, START_SCREEN_PERIOD, nullptr, false),
        NDM_LEAF(M, STOP_SCREEN_PERIOD, nullptr, false),
        NDM_LEAF(M, SCREEN_VOLUME_FRAME, nullptr, false),
        custom_leaf<M>("SCREEN_VOLUME_SHAPE", nullptr, false,
            [](M& o, const std::string& t, std::string* e) { return Conv<screeningVolumeShape>::take(o.SCREEN_VOLUME_SHAPE, t, e); },
            [](const M& o, bool, std::vector<std::string>* out) {
                /* ELLIPSOID is the record's zero value: state it whenever a volume is. */
                if (o.SCREEN_VOLUME_X != 0.0 || o.SCREEN_VOLUME_Y != 0.0 || o.SCREEN_VOLUME_Z != 0.0 ||
                    o.SCREEN_VOLUME_SHAPE != screeningVolumeShape::ELLIPSOID) {
                    Conv<screeningVolumeShape>::give(o.SCREEN_VOLUME_SHAPE, o.SCREEN_VOLUME_SHAPE, true, out);
                }
            }),
        scaled_leaf<M, &M::SCREEN_VOLUME_X>("SCREEN_VOLUME_X", "m", -3, "km", false),
        scaled_leaf<M, &M::SCREEN_VOLUME_Y>("SCREEN_VOLUME_Y", "m", -3, "km", false),
        scaled_leaf<M, &M::SCREEN_VOLUME_Z>("SCREEN_VOLUME_Z", "m", -3, "km", false),
        NDM_LEAF(M, SCREEN_ENTRY_TIME, nullptr, false),
        NDM_LEAF(M, SCREEN_EXIT_TIME, nullptr, false),
        NDM_LEAF(M, COLLISION_PROBABILITY, nullptr, false),
        NDM_LEAF(M, COLLISION_PROBABILITY_METHOD, nullptr, false),
    });

    auto metadata = section("metadata", nav_same(), {
        NDM_COMMENT(O, COMMENT, true),
        custom_leaf<O>("OBJECT", nullptr, true,
            [](O&, const std::string&, std::string*) { return true; },
            [](const O&, bool, std::vector<std::string>*) {}),
        designator_leaf(),
        NDM_LEAF(O, CATALOG_NAME, nullptr, true),
        cat_string<&CATT::OBJECT_NAME>("OBJECT_NAME", true),
        cat_string<&CATT::OBJECT_ID>("INTERNATIONAL_DESIGNATOR", true),
        object_type_leaf(),
        NDM_LEAF(O, OPERATOR_CONTACT_POSITION, nullptr, false),
        NDM_LEAF(O, OPERATOR_ORGANIZATION, nullptr, false),
        poc_leaf("OPERATOR_PHONE", true),
        poc_leaf("OPERATOR_EMAIL", false),
        NDM_LEAF(O, EPHEMERIS_NAME, nullptr, true),
        NDM_LEAF(O, COVARIANCE_METHOD, nullptr, true),
        maneuverable_leaf(),
        orbit_center_leaf(),
        NDM_LEAF_AS(O, "REF_FRAME", REFERENCE_FRAME, nullptr, true),
        NDM_LEAF(O, GRAVITY_MODEL, nullptr, false),
        NDM_LEAF(O, ATMOSPHERIC_MODEL, nullptr, false),
        NDM_LEAF(O, N_BODY_PERTURBATIONS, nullptr, false),
        NDM_LEAF(O, SOLAR_RAD_PRESSURE, nullptr, false),
        NDM_LEAF(O, EARTH_TIDES, nullptr, false),
        NDM_LEAF(O, INTRACK_THRUST, nullptr, false),
    });

    auto od_parameters = section("odParameters", nav_same(), {
        read_only(NDM_COMMENT(O, COMMENT, false)),
        NDM_LEAF(O, TIME_LASTOB_START, nullptr, false),
        NDM_LEAF(O, TIME_LASTOB_END, nullptr, false),
        NDM_LEAF(O, RECOMMENDED_OD_SPAN, "d", false),
        NDM_LEAF(O, ACTUAL_OD_SPAN, "d", false),
        NDM_LEAF(O, OBS_AVAILABLE, nullptr, false),
        NDM_LEAF(O, OBS_USED, nullptr, false),
        NDM_LEAF(O, TRACKS_AVAILABLE, nullptr, false),
        NDM_LEAF(O, TRACKS_USED, nullptr, false),
        NDM_LEAF(O, RESIDUALS_ACCEPTED, "%", false),
        NDM_LEAF(O, WEIGHTED_RMS, nullptr, false),
    }, optional);

    auto additional = section("additionalParameters", nav_same(), {
        read_only(NDM_COMMENT(O, COMMENT, false)),
        NDM_LEAF(O, AREA_PC, "m**2", false),
        NDM_LEAF(O, AREA_DRG, "m**2", false),
        NDM_LEAF(O, AREA_SRP, "m**2", false),
        mass_leaf(),
        NDM_LEAF(O, CD_AREA_OVER_MASS, "m**2/kg", false),
        NDM_LEAF(O, CR_AREA_OVER_MASS, "m**2/kg", false),
        NDM_LEAF(O, THRUST_ACCELERATION, "m/s**2", false),
        NDM_LEAF(O, SEDR, "W/kg", false),
    }, optional);

    auto state_vector = section("stateVector", nav_same(), {
        read_only(NDM_COMMENT(O, COMMENT, false)),
        NDM_LEAF(O, X, "km", true),
        NDM_LEAF(O, Y, "km", true),
        NDM_LEAF(O, Z, "km", true),
        NDM_LEAF(O, X_DOT, "km/s", true),
        NDM_LEAF(O, Y_DOT, "km/s", true),
        NDM_LEAF(O, Z_DOT, "km/s", true),
    });

    std::vector<Item> covariance_items;
    covariance_items.push_back(Item(read_only(NDM_COMMENT(O, COMMENT, false))));
    add_covariance_cells(&covariance_items);
    /* The 21 position/velocity cells are mandatory (508.0-B-1 table 3-5); the drag, solar
     * radiation pressure and thrust rows follow when the record holds them. */
    auto covariance = section("covarianceMatrix", nav_same(), covariance_items);

    auto data = section("data", nav_same(), {
        read_only(NDM_COMMENT(O, COMMENT, false)),
        od_parameters, additional, state_vector, covariance,
    });

    /* The two objects: the segment names itself by OBJECT on the way in, and is
     * labelled by its position on the way out. */
    Nav objects;
    objects.count = [](const Obj*) -> size_t { return 2; };
    objects.at = [](const Obj* p, size_t i) -> const Obj* {
        static const O empty{};
        const M& m = *static_cast<const M*>(p);
        const auto& slot = i == 0 ? m.OBJECT1 : m.OBJECT2;
        return slot ? static_cast<const Obj*>(slot.get()) : static_cast<const Obj*>(&empty);
    };
    objects.make = [](Obj* p) -> Obj* {
        M& m = *static_cast<M*>(p);
        auto& slot = m.OBJECT1 ? m.OBJECT2 : m.OBJECT1;
        if (!slot) slot = std::make_unique<O>();
        return slot.get();
    };
    SectionOptions segment_options;
    segment_options.repeat = true;
    segment_options.select = [](Obj* p, const Node& n) -> Obj* {
        M& m = *static_cast<M*>(p);
        std::string label;
        if (const Node* meta = n.find("metadata")) {
            if (const Node* o = meta->find("OBJECT")) label = upper(o->text);
        }
        auto& slot = label == "OBJECT2" ? m.OBJECT2 : label == "OBJECT1" ? m.OBJECT1
                                                    : (m.OBJECT1 ? m.OBJECT2 : m.OBJECT1);
        if (!slot) slot = std::make_unique<O>();
        return slot.get();
    };
    segment_options.decorate = [](Node& n, size_t index) {
        for (Node& k : n.kids) {
            if (k.name != "metadata") continue;
            for (Node& leaf : k.kids) {
                if (!leaf.group && leaf.name == "OBJECT") leaf.text = index == 0 ? "OBJECT1" : "OBJECT2";
            }
            bool have = false;
            for (const Node& leaf : k.kids) have = have || (!leaf.group && leaf.name == "OBJECT");
            if (!have) {
                size_t at = 0;  /* after the COMMENT lines, before everything else */
                while (at < k.kids.size() && !k.kids[at].group && k.kids[at].name == "COMMENT") ++at;
                Node label = Node::leaf("OBJECT", index == 0 ? "OBJECT1" : "OBJECT2");
                label.head = true;  /* KVN: the keyword that opens the segment */
                k.kids.insert(k.kids.begin() + static_cast<std::ptrdiff_t>(at), label);
            }
        }
    };
    auto segment = section("segment", objects, {metadata, data}, segment_options);
    auto body = section("body", nav_same(), {relative, segment});
    msg->top = section("cdm", nav_same(), {header, body});
    return msg;
}

inline const Message& message() {
    static const std::shared_ptr<Message> m = build();
    return *m;
}

}  // namespace cdm
}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_CDM_HPP
