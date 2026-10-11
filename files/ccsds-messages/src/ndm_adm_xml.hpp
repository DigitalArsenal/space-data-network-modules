/*
 * files/ccsds-messages — NDM/XML for the two messages whose KVN has its own
 * document model (kvn.hpp): AEM and TDM.
 *
 * The views and projections that read and write $AEM and $TDM work on a
 * ::kvn::Document, and they stay as they are. NDM/XML reaches them the same way KVN
 * does: this file turns the XML tree into the Document the KVN parser would have
 * made from the same message (header entries, segments of metadata entries and
 * data lines, COMMENT lines kept where they stood), and turns a Document back
 * into the XML tree.
 *
 * AEM. A state is an `attitudeState` holding one of nine elements, chosen by the
 * segment's ATTITUDE_TYPE, whose children are the data line's columns: an epoch,
 * then the numbers in the order of the KVN line, some under a `quaternion`,
 * `quaternionDot` or `angVel` wrapper.
 * TDM. An `observation` holds an EPOCH and the one observable it states.
 *
 * XML names every metadata element in a fixed order; the Document keeps the order
 * of the file it came from, so metadata is written in the schema's order and a
 * keyword the schema does not have (a B-1 QUATERNION_TYPE, a bare EPHEMERIS_NAME)
 * is not written: XML has nowhere to put it.
 */

#ifndef CCSDS_MESSAGES_NDM_ADM_XML_HPP
#define CCSDS_MESSAGES_NDM_ADM_XML_HPP

#include "kvn.hpp"
#include "aem.hpp"
#include "ndm_core.hpp"

namespace ndm {
namespace admxml {

struct Column {
    const char* wrapper;  /* element the column sits in, or "" for none */
    const char* name;
};

struct StateShape {
    ccsds::aem::AttitudeType type;
    const char* element;          /* the attitudeState child */
    const char* type_text;        /* the ATTITUDE_TYPE the schema enumerates */
    std::vector<Column> columns;  /* after EPOCH, in KVN order */
};

inline const std::vector<StateShape>& state_shapes() {
    using T = ccsds::aem::AttitudeType;
    static const std::vector<StateShape> shapes = {
        {T::Quaternion, "quaternionEphemeris", "QUATERNION",
         {{"quaternion", "Q1"}, {"quaternion", "Q2"}, {"quaternion", "Q3"}, {"quaternion", "QC"}}},
        {T::QuaternionDerivative, "quaternionDerivative", "QUATERNION/DERIVATIVE",
         {{"quaternion", "Q1"}, {"quaternion", "Q2"}, {"quaternion", "Q3"}, {"quaternion", "QC"},
          {"quaternionDot", "Q1_DOT"}, {"quaternionDot", "Q2_DOT"}, {"quaternionDot", "Q3_DOT"},
          {"quaternionDot", "QC_DOT"}}},
        {T::QuaternionRate, "quaternionDerivative", "QUATERNION/DERIVATIVE",
         {{"quaternion", "Q1"}, {"quaternion", "Q2"}, {"quaternion", "Q3"}, {"quaternion", "QC"},
          {"quaternionDot", "Q1_DOT"}, {"quaternionDot", "Q2_DOT"}, {"quaternionDot", "Q3_DOT"},
          {"quaternionDot", "QC_DOT"}}},
        {T::QuaternionAngvel, "quaternionAngVel", "QUATERNION/ANGVEL",
         {{"quaternion", "Q1"}, {"quaternion", "Q2"}, {"quaternion", "Q3"}, {"quaternion", "QC"},
          {"angVel", "ANGVEL_X"}, {"angVel", "ANGVEL_Y"}, {"angVel", "ANGVEL_Z"}}},
        {T::EulerAngle, "eulerAngle", "EULER_ANGLE",
         {{"", "ANGLE_1"}, {"", "ANGLE_2"}, {"", "ANGLE_3"}}},
        {T::EulerAngleRate, "eulerAngleDerivative", "EULER_ANGLE/DERIVATIVE",
         {{"", "ANGLE_1"}, {"", "ANGLE_2"}, {"", "ANGLE_3"}, {"", "ANGLE_1_DOT"},
          {"", "ANGLE_2_DOT"}, {"", "ANGLE_3_DOT"}}},
        {T::EulerAngleAngvel, "eulerAngleAngVel", "EULER_ANGLE/ANGVEL",
         {{"", "ANGLE_1"}, {"", "ANGLE_2"}, {"", "ANGLE_3"}, {"", "ANGVEL_X"}, {"", "ANGVEL_Y"},
          {"", "ANGVEL_Z"}}},
        {T::Spin, "spin", "SPIN",
         {{"", "SPIN_ALPHA"}, {"", "SPIN_DELTA"}, {"", "SPIN_ANGLE"}, {"", "SPIN_ANGLE_VEL"}}},
        {T::SpinNutation, "spinNutation", "SPIN/NUTATION",
         {{"", "SPIN_ALPHA"}, {"", "SPIN_DELTA"}, {"", "SPIN_ANGLE"}, {"", "SPIN_ANGLE_VEL"},
          {"", "NUTATION"}, {"", "NUTATION_PER"}, {"", "NUTATION_PHASE"}}},
        {T::SpinNutationMomentum, "spinNutationMom", "SPIN/NUTATION_MOM",
         {{"", "SPIN_ALPHA"}, {"", "SPIN_DELTA"}, {"", "SPIN_ANGLE"}, {"", "SPIN_ANGLE_VEL"},
          {"", "MOMENTUM_ALPHA"}, {"", "MOMENTUM_DELTA"}, {"", "NUTATION_VEL"}}},
    };
    return shapes;
}

inline const char* const* aem_metadata_order() {
    static const char* const order[] = {
        "OBJECT_NAME", "OBJECT_ID", "CENTER_NAME", "REF_FRAME_A", "REF_FRAME_B", "TIME_SYSTEM",
        "START_TIME", "USEABLE_START_TIME", "USEABLE_STOP_TIME", "STOP_TIME", "ATTITUDE_TYPE",
        "EULER_ROT_SEQ", "ANGVEL_FRAME", "INTERPOLATION_METHOD", "INTERPOLATION_DEGREE", nullptr};
    return order;
}

inline const char* const* tdm_metadata_order() {
    static const char* const order[] = {
        "TRACK_ID", "DATA_TYPES", "TIME_SYSTEM", "START_TIME", "STOP_TIME", "PARTICIPANT_1",
        "PARTICIPANT_2", "PARTICIPANT_3", "PARTICIPANT_4", "PARTICIPANT_5", "MODE", "PATH", "PATH_1",
        "PATH_2", "EPHEMERIS_NAME_1", "EPHEMERIS_NAME_2", "EPHEMERIS_NAME_3", "EPHEMERIS_NAME_4",
        "EPHEMERIS_NAME_5", "TRANSMIT_BAND", "RECEIVE_BAND", "TURNAROUND_NUMERATOR",
        "TURNAROUND_DENOMINATOR", "TIMETAG_REF", "INTEGRATION_INTERVAL", "INTEGRATION_REF",
        "FREQ_OFFSET", "RANGE_MODE", "RANGE_MODULUS", "RANGE_UNITS", "ANGLE_TYPE",
        "REFERENCE_FRAME", "INTERPOLATION", "INTERPOLATION_DEGREE", "DOPPLER_COUNT_BIAS",
        "DOPPLER_COUNT_SCALE", "DOPPLER_COUNT_ROLLOVER", "TRANSMIT_DELAY_1", "TRANSMIT_DELAY_2",
        "TRANSMIT_DELAY_3", "TRANSMIT_DELAY_4", "TRANSMIT_DELAY_5", "RECEIVE_DELAY_1",
        "RECEIVE_DELAY_2", "RECEIVE_DELAY_3", "RECEIVE_DELAY_4", "RECEIVE_DELAY_5", "DATA_QUALITY",
        "CORRECTION_ANGLE_1", "CORRECTION_ANGLE_2", "CORRECTION_DOPPLER", "CORRECTION_MAG",
        "CORRECTION_RANGE", "CORRECTION_RCS", "CORRECTION_RECEIVE", "CORRECTION_TRANSMIT",
        "CORRECTION_ABERRATION_YEARLY", "CORRECTION_ABERRATION_DIURNAL", "CORRECTIONS_APPLIED",
        nullptr};
    return order;
}

/* ------------------------------------------------------------------------ */
/* XML tree -> Document                                                      */
/* ------------------------------------------------------------------------ */

/* The leaves of `group` in order, COMMENT leaves held for the next entry. */
inline void entries_from(const Node& group, std::vector<::kvn::Entry>* out) {
    std::vector<std::string> pending;
    for (const Node& k : group.kids) {
        if (k.group) continue;
        if (k.name == "COMMENT") {
            pending.push_back(k.text);
            continue;
        }
        ::kvn::Entry e;
        e.key = k.name;
        e.value = k.text;
        e.units = k.units;
        e.comments_before = pending;
        pending.clear();
        out->push_back(e);
    }
    for (const std::string& c : pending) {
        ::kvn::Entry e;
        e.key = "COMMENT";
        e.value = c;
        e.is_standalone_comment = true;
        out->push_back(e);
    }
}

inline void flatten_leaves(const Node& n, std::vector<std::string>* values) {
    for (const Node& k : n.kids) {
        if (k.group) flatten_leaves(k, values);
        else values->push_back(k.text);
    }
}

inline bool document_from_xml(const Node& root, const char* type, const char* version_key,
                              ::kvn::Document* out, std::string* error) {
    *out = ::kvn::Document{};
    out->message_type = type;
    ::kvn::Entry version;
    version.key = version_key;
    version.value = root.text;
    out->header.push_back(version);
    if (const Node* header = root.find("header")) entries_from(*header, &out->header);
    const Node* body = root.find("body");
    if (!body) {
        *error = "the message has no <body>";
        return false;
    }
    const bool is_aem = std::string(type) == "AEM";
    for (const Node& seg : body->kids) {
        if (seg.name != "segment" || !seg.group) continue;
        ::kvn::Segment s;
        if (const Node* meta = seg.find("metadata")) entries_from(*meta, &s.metadata);
        if (const Node* data = seg.find("data")) {
            s.has_data_block = true;
            for (const Node& k : data->kids) {
                if (!k.group && k.name == "COMMENT") {
                    ::kvn::DataLine d;
                    d.key = "COMMENT";
                    d.epoch = k.text;
                    d.is_standalone_comment = true;
                    s.data.push_back(d);
                    continue;
                }
                if (!k.group) continue;
                if (is_aem && k.name == "attitudeState") {
                    for (const Node& state : k.kids) {
                        if (!state.group) continue;
                        std::vector<std::string> values;
                        flatten_leaves(state, &values);
                        if (values.empty()) continue;
                        ::kvn::DataLine d;
                        d.epoch = values[0];
                        d.tokens.assign(values.begin() + 1, values.end());
                        s.data.push_back(d);
                    }
                } else if (!is_aem && k.name == "observation") {
                    const Node* epoch = k.find("EPOCH");
                    for (const Node& obs : k.kids) {
                        if (obs.group || obs.name == "EPOCH") continue;
                        ::kvn::DataLine d;
                        d.key = obs.name;
                        d.epoch = epoch ? epoch->text : std::string();
                        d.tokens.push_back(obs.text);
                        s.data.push_back(d);
                    }
                }
            }
        }
        out->segments.push_back(s);
    }
    return true;
}

/* ------------------------------------------------------------------------ */
/* Document -> XML tree                                                      */
/* ------------------------------------------------------------------------ */

inline void leaf_into(Node* group, const ::kvn::Entry& e, bool units) {
    Node k = Node::leaf(e.key, e.value, units ? e.units : std::string());
    group->kids.push_back(k);
}

inline void header_to_xml(const ::kvn::Document& doc, Node* header) {
    *header = Node::container("header");
    for (const ::kvn::Entry& e : doc.header) {
        for (const std::string& c : e.comments_before) header->kids.push_back(Node::leaf("COMMENT", c));
        if (e.is_standalone_comment) header->kids.push_back(Node::leaf("COMMENT", e.value));
    }
    static const char* const order[] = {"CLASSIFICATION", "CREATION_DATE", "ORIGINATOR", "MESSAGE_ID", nullptr};
    for (size_t i = 0; order[i]; ++i) {
        if (const ::kvn::Entry* e = ::kvn::find(doc.header, order[i])) header->kids.push_back(Node::leaf(order[i], e->value));
    }
}

inline const StateShape* shape_for(const std::string& attitude_type) {
    const ccsds::aem::AttitudeType t = ccsds::aem::attitude_type_from_text(attitude_type);
    for (const StateShape& s : state_shapes()) {
        if (s.type == t) return &s;
    }
    return nullptr;
}

inline bool document_to_xml(const ::kvn::Document& doc, const char* type, bool units, Node* tree,
                            std::string* error) {
    const bool is_aem = std::string(type) == "AEM";
    *tree = Node::container(is_aem ? "aem" : "tdm");
    tree->text = "2.0";
    Node header;
    header_to_xml(doc, &header);
    tree->kids.push_back(header);
    Node body = Node::container("body");
    const char* const* order = is_aem ? aem_metadata_order() : tdm_metadata_order();
    for (const ::kvn::Segment& seg : doc.segments) {
        Node segment = Node::container("segment");
        Node metadata = Node::container("metadata");
        for (const ::kvn::Entry& e : seg.metadata) {
            if (e.is_standalone_comment) metadata.kids.push_back(Node::leaf("COMMENT", e.value));
            for (const std::string& c : e.comments_before) metadata.kids.push_back(Node::leaf("COMMENT", c));
        }
        const StateShape* shape = nullptr;
        if (is_aem) {
            const ::kvn::Entry* at = ::kvn::find(seg.metadata, "ATTITUDE_TYPE");
            shape = at ? shape_for(at->value) : nullptr;
            if (!shape) {
                *error = "the segment's ATTITUDE_TYPE is not one NDM/XML states";
                return false;
            }
        }
        for (size_t i = 0; order[i]; ++i) {
            if (const ::kvn::Entry* e = ::kvn::find(seg.metadata, order[i])) {
                ::kvn::Entry copy = *e;
                if (is_aem && std::string(order[i]) == "ATTITUDE_TYPE") copy.value = shape->type_text;
                leaf_into(&metadata, copy, units);
            }
        }
        segment.kids.push_back(metadata);
        Node data = Node::container("data");
        for (const ::kvn::DataLine& d : seg.data) {
            if (d.is_standalone_comment) data.kids.push_back(Node::leaf("COMMENT", d.epoch));
            for (const std::string& c : d.comments_before) data.kids.push_back(Node::leaf("COMMENT", c));
        }
        for (const ::kvn::DataLine& d : seg.data) {
            if (d.is_standalone_comment) continue;
            if (is_aem) {
                if (d.tokens.size() != shape->columns.size()) {
                    *error = "an attitude line has " + std::to_string(d.tokens.size()) +
                             " values, the segment's ATTITUDE_TYPE has " +
                             std::to_string(shape->columns.size());
                    return false;
                }
                Node state = Node::container("attitudeState");
                Node element = Node::container(shape->element);
                element.kids.push_back(Node::leaf("EPOCH", d.epoch));
                Node* open = nullptr;
                std::string open_name;
                for (size_t i = 0; i < shape->columns.size(); ++i) {
                    const Column& c = shape->columns[i];
                    if (c.wrapper[0] == '\0') {
                        element.kids.push_back(Node::leaf(c.name, d.tokens[i]));
                        open = nullptr;
                        open_name.clear();
                        continue;
                    }
                    if (!open || open_name != c.wrapper) {
                        element.kids.push_back(Node::container(c.wrapper));
                        open = &element.kids.back();
                        open_name = c.wrapper;
                    }
                    open->kids.push_back(Node::leaf(c.name, d.tokens[i]));
                }
                state.kids.push_back(element);
                data.kids.push_back(state);
            } else {
                if (d.tokens.size() != 1) {
                    *error = "an observation of " + d.key + " has " + std::to_string(d.tokens.size()) +
                             " values, NDM/XML states one";
                    return false;
                }
                Node obs = Node::container("observation");
                obs.kids.push_back(Node::leaf("EPOCH", d.epoch));
                obs.kids.push_back(Node::leaf(d.key, d.tokens[0]));
                data.kids.push_back(obs);
            }
        }
        segment.kids.push_back(data);
        body.kids.push_back(segment);
    }
    tree->kids.push_back(body);
    return true;
}

}  // namespace admxml
}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_ADM_XML_HPP
