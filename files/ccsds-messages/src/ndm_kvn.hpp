/*
 * files/ccsds-messages — keyword-value notation, read into and written from the
 * pivot tree by a message's Spec.
 *
 * KVN has no hierarchy of its own: a message is a run of `KEYWORD = value`
 * lines in which a few block markers (META_START ... META_STOP) delimit what the
 * XML calls elements. Everything else about the structure lives in the Spec, so
 * reading is "place each line where the Spec says its keyword belongs":
 *
 *   - a keyword belongs to the open section if that section has it, otherwise to
 *     the first FLAT child section (one with no markers) that has it, which is
 *     opened on demand. The XML wrappers KVN never spells (body, segment, data)
 *     are such flat sections.
 *   - a marker line opens the child section that starts with it and closes with
 *     its stop marker.
 *   - a FLAT repeatable section ends, and the next instance begins, when a
 *     keyword it already holds comes round again (the second maneuver of an
 *     OPM) or when its explicit child starts again (the second META_START of an
 *     OEM). CDM's OBJECT = OBJECT2 is that same rule.
 *   - a line that is not a keyword or a marker is DATA: a row of an OEM state
 *     vector, a row of a covariance lower triangle, a bare line of an OCM trajectory.
 *
 * COMMENT is a keyword like any other and belongs to whichever section the
 * rule above gives it.
 *
 * Writing needs no Spec: `emit_section` stamped the markers and row hints on
 * the nodes.
 */

#ifndef CCSDS_MESSAGES_NDM_KVN_HPP
#define CCSDS_MESSAGES_NDM_KVN_HPP

#include "ndm_core.hpp"

namespace ndm {
namespace kvn {

/* ------------------------------------------------------------------------ */
/* Lines                                                                     */
/* ------------------------------------------------------------------------ */

enum class LineType { Blank, Key, Marker, Row };

struct Line {
    int no = 0;
    LineType type = LineType::Blank;
    std::string key;    /* Key and Marker */
    std::string value;  /* Key */
    std::string units;  /* Key */
    std::string raw;    /* the trimmed line */
    std::string text;   /* Key: the value as written, units suffix included */
};

inline bool is_keyword_text(const std::string& s) {
    if (s.empty() || !(s[0] >= 'A' && s[0] <= 'Z')) return false;
    for (char c : s) {
        if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_')) return false;
    }
    return true;
}

/* `3.0 [km]` -> value `3.0`, units `km`. A value that is only a bracketed list
 * (`[km, km, km/s]`, the OCM's TRAJ_UNITS, COV_UNITS and MAN_UNITS) is the value. */
inline void split_units(const std::string& raw, std::string* value, std::string* units) {
    const std::string v = trim(raw);
    if (!v.empty() && v.back() == ']') {
        const size_t open = v.rfind('[');
        if (open != std::string::npos) {
            const std::string head = trim(v.substr(0, open));
            if (head.empty()) {
                *value = v;
                units->clear();
                return;
            }
            *value = head;
            *units = trim(v.substr(open + 1, v.size() - open - 2));
            return;
        }
    }
    *value = v;
    units->clear();
}

inline std::vector<Line> lex(const char* data, size_t length) {
    std::vector<Line> out;
    size_t i = 0;
    int no = 0;
    while (i <= length) {
        size_t start = i;
        /* A line ends at LF, CRLF or a lone CR: a carriage return inside a value would otherwise be
         * kept in it and read back as something else. */
        while (i < length && data[i] != '\n' && data[i] != '\r') ++i;
        std::string text = trim(std::string(data + start, i - start));
        ++no;
        if (i + 1 < length && data[i] == '\r' && data[i + 1] == '\n') ++i;
        ++i;
        Line l;
        l.no = no;
        l.raw = text;
        if (text.empty()) {
            l.type = LineType::Blank;
        } else if (text.compare(0, 7, "COMMENT") == 0 && (text.size() == 7 || is_space(text[7]))) {
            l.type = LineType::Key;
            l.key = "COMMENT";
            l.value = trim(text.substr(7));
        } else {
            const size_t eq = text.find('=');
            const std::string head = eq == std::string::npos ? std::string() : trim(text.substr(0, eq));
            if (eq != std::string::npos && is_keyword_text(head)) {
                l.type = LineType::Key;
                l.key = head;
                l.text = trim(text.substr(eq + 1));
                split_units(text.substr(eq + 1), &l.value, &l.units);
            } else if (eq == std::string::npos && is_keyword_text(text)) {
                l.type = LineType::Marker;
                l.key = text;
            } else {
                l.type = LineType::Row;
            }
        }
        out.push_back(l);
        if (i > length) break;
    }
    return out;
}

/* ------------------------------------------------------------------------ */
/* Who owns a line                                                           */
/* ------------------------------------------------------------------------ */

inline bool is_user_defined_key(const std::string& key) {
    return starts_with(key, "USER_DEFINED_") && key.size() > 13;
}

/* The leaf of `s` this keyword is, exactly or as a USER_DEFINED_x. */
inline const Leaf* own_leaf(const Section& s, const std::string& key) {
    if (const Leaf* l = s.leaf_named(key)) return l;
    if (is_user_defined_key(key)) return s.user_defined_leaf();
    return nullptr;
}

inline bool claims_key(const Section& c, const std::string& key) {
    if (c.kvn_start) return false;
    if (own_leaf(c, key)) return true;
    for (const Item& it : c.items) {
        if (it.is_section && claims_key(*it.sec, key)) return true;
    }
    return false;
}

inline bool claims_marker(const Section& c, const std::string& marker) {
    if (c.kvn_start) return marker == c.kvn_start;
    if (c.kvn_accept_start && marker == c.kvn_accept_start) return true;
    for (const Item& it : c.items) {
        if (it.is_section && claims_marker(*it.sec, marker)) return true;
    }
    return false;
}

inline bool claims_row(const Section& c) {
    if (c.kvn_start) return false;
    if (c.rows == 1 || c.has_matrix || c.has_bare_leaf()) return true;
    for (const Item& it : c.items) {
        if (it.is_section && claims_row(*it.sec)) return true;
    }
    return false;
}

/* `prefer` is the repeated child this section opened last: a keyword it claims
 * begins its next instance, even if an earlier child has the keyword too (an OEM's
 * state vectors and covariance matrices both begin at an EPOCH). */
inline const Section* child_claiming(const Section& s, const Line& l,
                                     const Section* prefer = nullptr) {
    if (prefer && prefer->repeat && l.type == LineType::Key && claims_key(*prefer, l.key)) {
        return prefer;
    }
    for (const Item& it : s.items) {
        if (!it.is_section) continue;
        const Section& c = *it.sec;
        bool yes = false;
        switch (l.type) {
            case LineType::Key: yes = claims_key(c, l.key); break;
            case LineType::Marker: yes = claims_marker(c, l.key); break;
            case LineType::Row: yes = claims_row(c); break;
            default: break;
        }
        if (yes) return &c;
    }
    return nullptr;
}

/* ------------------------------------------------------------------------ */
/* Reading                                                                   */
/* ------------------------------------------------------------------------ */

struct Reader {
    std::vector<Line> lines;
    size_t pos = 0;
    Report* report = nullptr;
    std::string error;
    int error_line = 0;
};

inline bool is_repeatable_key(const std::string& key) {
    return key == "COMMENT" || is_user_defined_key(key);
}

inline const Leaf* leaf_at(const Section& s, size_t index) {
    size_t k = 0;
    for (const Item& it : s.items) {
        if (it.is_section) continue;
        if (it.leaf.user_defined || it.leaf.bare || it.leaf.matrix) continue;
        if (k++ == index) return &it.leaf;
    }
    return nullptr;
}

/* `marked`: the section is inside a tolerated marker pair (it was opened by the start
 * marker, or follows an instance that was), so the stop marker is its to take; without
 * a start, a stop marker is out of place. */
inline void parse_section(Reader& R, const Section& s, Node& n, const std::string& path,
                          bool marked = false);

/* A row section instance: one line, its tokens the section's leaves in order. */
inline void read_row_instance(Reader& R, const Section& c, Node& parent) {
    const Line& l = R.lines[R.pos];
    Node row = Node::container(c.name);
    row.line = l.no;
    const std::vector<std::string> tok = tokens(l.raw);
    for (size_t i = 0; i < tok.size(); ++i) {
        const Leaf* leaf = leaf_at(c, i);
        if (!leaf) {
            R.report->add(IssueKind::UnknownStructure, c.name, "column " + std::to_string(i + 1),
                          tok[i], l.no);
            continue;
        }
        Node k = Node::leaf(leaf->name, tok[i], leaf->units ? leaf->units : "");
        k.line = l.no;
        row.kids.push_back(k);
    }
    parent.kids.push_back(row);
    ++R.pos;
}

inline Node* open_child(Reader& R, const Section& s, Node& n, const Section& c,
                        const std::string& path, bool continuing = false) {
    Node* target = nullptr;
    if (!c.repeat) {
        for (Node& k : n.kids) {
            if (k.name == c.name && k.group) target = &k;
        }
    }
    if (!target) {
        n.kids.push_back(Node::container(c.name));
        target = &n.kids.back();
        target->line = R.lines[R.pos].no;
    }
    bool marked = continuing;
    if (R.lines[R.pos].type == LineType::Marker &&
        ((c.kvn_start && R.lines[R.pos].key == c.kvn_start) ||
         (c.kvn_accept_start && R.lines[R.pos].key == c.kvn_accept_start))) {
        marked = marked || (c.kvn_accept_start && R.lines[R.pos].key == c.kvn_accept_start);
        ++R.pos;  /* the start marker belongs to the section it opens */
    }
    parse_section(R, c, *target, path + "/" + c.name, marked);
    (void)s;
    return target;
}

inline bool child_started(const Node& n, const Section& c) {
    for (const Node& k : n.kids) {
        if (k.name == c.name && k.group) return true;
    }
    return false;
}

/* Can a comment that precedes `next` be stated in `c`, or in the child `next` opens? */
inline bool comment_fits(const Section& c, const Line& next) {
    if (c.leaf_named("COMMENT")) return true;
    if (const Section* d = child_claiming(c, next)) return comment_fits(*d, next);
    return false;
}

/* Does `n`, or anything below it, already hold this keyword? */
inline bool holds(const Node& n, const std::string& key) {
    for (const Node& k : n.kids) {
        if (k.group ? holds(k, key) : (k.name == key)) return true;
    }
    return false;
}

inline void parse_section(Reader& R, const Section& s, Node& n, const std::string& path,
                          bool marked) {
    const bool explicit_block = s.kvn_start != nullptr;
    /* A child opened by a tolerated start marker is closed by its stop marker or, the
     * markers being optional, by the first keyword that is not its own; but a start whose
     * stop never comes is a message that lost a line, and is said so. A run of repeated
     * children (an OEM's covariance matrices) is one pair of markers around all of them,
     * so the pair is open from the first instance to the one that takes the stop. */
    const Section* open_pair = nullptr;
    int open_pair_line = 0;
    struct PairCheck {
        Reader& R; const std::string& path; const Section*& open; int& line;
        ~PairCheck() {
            if (open && R.error.empty()) {
                R.report->add(IssueKind::UnknownStructure, path, open->kvn_accept_start,
                              std::string("not closed by ") + open->kvn_accept_stop, line);
            }
        }
    } pair_check{R, path, open_pair, open_pair_line};
    auto descend = [&](const Section* c) {
        const Line& at = R.lines[R.pos];
        const bool by_marker = at.type == LineType::Marker && c->kvn_accept_start &&
                               at.key == c->kvn_accept_start;
        const bool continuing = !by_marker && open_pair == c;
        const int line = at.no;
        open_child(R, s, n, *c, path, continuing);
        if (by_marker) {
            open_pair = c;
            open_pair_line = line;
        }
        if (open_pair == c && c->kvn_accept_stop && R.pos > 0 &&
            R.lines[R.pos - 1].type == LineType::Marker &&
            R.lines[R.pos - 1].key == c->kvn_accept_stop) {
            open_pair = nullptr;
        }
    };
    const Section* last_child = nullptr;
    size_t matrix_index = 0;
    std::vector<const Leaf*> matrix_leaves;
    for (const Item& it : s.items) {
        if (!it.is_section && it.leaf.matrix) matrix_leaves.push_back(&it.leaf);
    }
    while (R.pos < R.lines.size()) {
        if (!R.error.empty()) return;
        const Line& l = R.lines[R.pos];
        if (l.type == LineType::Blank) {
            ++R.pos;
            continue;
        }
        const size_t before = R.pos;

        if (l.type == LineType::Marker) {
            if ((s.kvn_stop && l.key == s.kvn_stop) ||
                (marked && s.kvn_accept_stop && l.key == s.kvn_accept_stop)) {
                ++R.pos;
                return;
            }
            if (const Section* c = child_claiming(s, l, last_child)) {
                if (!explicit_block && s.repeat && !c->repeat && child_started(n, *c)) return;
                last_child = c;
                descend(c);
                if (R.pos == before) ++R.pos;
                continue;
            }
            if (!explicit_block) return;
            R.report->add(IssueKind::UnknownStructure, path, l.key, "marker with no section", l.no);
            ++R.pos;
            continue;
        }

        if (l.type == LineType::Key && l.key == "COMMENT") {
            /* A comment belongs to the section the line after it belongs to: the
             * run of comments before MAN_EPOCH_IGNITION is that maneuver's, not
             * the data group's. */
            size_t j = R.pos;
            while (j < R.lines.size() &&
                   (R.lines[j].type == LineType::Blank ||
                    (R.lines[j].type == LineType::Key && R.lines[j].key == "COMMENT"))) {
                ++j;
            }
            if (j < R.lines.size() && R.lines[j].type == LineType::Key) {
                const Line& next = R.lines[j];
                if (!explicit_block && s.repeat && !is_repeatable_key(next.key) &&
                    holds(n, next.key) && (own_leaf(s, next.key) || child_claiming(s, next))) {
                    return;  /* the next instance of this section begins with them */
                }
                if (!own_leaf(s, next.key)) {
                    if (const Section* c = child_claiming(s, next, last_child)) {
                        if (comment_fits(*c, next)) {
                            last_child = c;
                            descend(c);
                            if (R.pos == before) ++R.pos;
                            continue;
                        }
                    } else if (!explicit_block) {
                        return;  /* the keyword after them is a later sibling's: so are they */
                    }
                }
            }
        }

        if (l.type == LineType::Key) {
            /* A flat repeatable section ends, and the next instance begins, when
             * a keyword this instance already holds comes round again. */
            if (!explicit_block && s.repeat && !is_repeatable_key(l.key) && holds(n, l.key) &&
                (own_leaf(s, l.key) || child_claiming(s, l))) {
                return;
            }
            if (const Leaf* leaf = own_leaf(s, l.key)) {
                Node k = Node::leaf(l.key, l.value, l.units);
                k.line = l.no;
                if (!l.units.empty()) k.raw = l.text;
                if (leaf->user_defined && is_user_defined_key(l.key)) {
                    k.name = "USER_DEFINED";
                    k.param = l.key.substr(13);
                }
                n.kids.push_back(k);
                ++R.pos;
                continue;
            }
            if (const Section* c = child_claiming(s, l, last_child)) {
                last_child = c;
                descend(c);
                if (R.pos == before) ++R.pos;
                continue;
            }
            if (!explicit_block) return;
            R.report->add(IssueKind::UnknownKeyword, path, l.key, l.value, l.no);
            ++R.pos;
            continue;
        }

        /* A data line. */
        if (s.has_matrix) {
            const std::vector<std::string> tok = tokens(l.raw);
            for (const std::string& t : tok) {
                if (matrix_index >= matrix_leaves.size()) {
                    R.report->add(IssueKind::UnknownStructure, path, "matrix",
                                  "more values than the matrix holds", l.no);
                    break;
                }
                Node k = Node::leaf(matrix_leaves[matrix_index]->name, t,
                                    matrix_leaves[matrix_index]->units ? matrix_leaves[matrix_index]->units : "");
                k.matrix = true;
                k.line = l.no;
                n.kids.push_back(k);
                ++matrix_index;
            }
            ++R.pos;
            continue;
        }
        if (const Leaf* bare = s.bare_leaf()) {
            Node k = Node::leaf(bare->name, l.raw);
            k.bare = true;
            k.line = l.no;
            n.kids.push_back(k);
            ++R.pos;
            continue;
        }
        if (const Section* c = child_claiming(s, l)) {
            if (c->rows == 1) {
                read_row_instance(R, *c, n);
            } else {
                descend(c);
                if (R.pos == before) ++R.pos;
            }
            continue;
        }
        if (!explicit_block) return;
        R.report->add(IssueKind::UnknownStructure, path, "data line", l.raw, l.no);
        ++R.pos;
    }
    if (explicit_block && R.pos >= R.lines.size() && R.error.empty()) {
        R.error = std::string(s.kvn_start) + " has no " + (s.kvn_stop ? s.kvn_stop : "end");
    }
}

/* Read `data` as the `msg` message. On failure returns false with *error. */
inline bool read(const char* data, size_t length, const Message& msg, Node* root, Report* report,
                 std::string* error) {
    Reader R;
    R.lines = lex(data, length);
    R.report = report;
    /* The first keyword states the message and its version. */
    while (R.pos < R.lines.size() &&
           (R.lines[R.pos].type == LineType::Blank ||
            (R.lines[R.pos].type == LineType::Key && R.lines[R.pos].key == "COMMENT"))) {
        ++R.pos;
    }
    if (R.pos >= R.lines.size() || R.lines[R.pos].type != LineType::Key ||
        !starts_with(R.lines[R.pos].key, "CCSDS_") || R.lines[R.pos].key.size() < 12 ||
        R.lines[R.pos].key.compare(R.lines[R.pos].key.size() - 5, 5, "_VERS") != 0) {
        *error = "the message does not open with a CCSDS_*_VERS keyword";
        return false;
    }
    if (R.lines[R.pos].key != msg.version_key) {
        *error = "the message opens with " + R.lines[R.pos].key + ", not " + msg.version_key;
        return false;
    }
    *root = Node::container(msg.root);
    root->text = R.lines[R.pos].value;
    root->line = R.lines[R.pos].no;
    /* Comments before the version line belong to the header; rewind over them. */
    const size_t version_at = R.pos;
    ++R.pos;
    Node& top = *root;
    for (size_t i = R.pos; i < R.lines.size(); ++i) {
        const Line& l = R.lines[i];
        if (l.type == LineType::Key && starts_with(l.key, "CCSDS_") && l.key.size() > 11 &&
            l.key.compare(l.key.size() - 5, 5, "_VERS") == 0) {
            *error = "the document holds more than one message (" + l.key + " again at line " +
                     std::to_string(l.no) + "); this reads one message per file (multiple-messages)";
            return false;
        }
    }
    while (R.pos < R.lines.size() && R.error.empty()) {
        const size_t before = R.pos;
        parse_section(R, *msg.top, top, std::string(msg.root));
        if (R.pos == before) {
            const Line& l = R.lines[R.pos];
            if (l.type == LineType::Key) {
                R.report->add(IssueKind::UnknownKeyword, msg.root, l.key, l.value, l.no);
            } else {
                R.report->add(IssueKind::UnknownStructure, msg.root, l.raw, "", l.no);
            }
            ++R.pos;
        }
    }
    (void)version_at;
    if (!R.error.empty()) {
        *error = R.error;
        return false;
    }
    return true;
}

/* ------------------------------------------------------------------------ */
/* Writing                                                                   */
/* ------------------------------------------------------------------------ */

/* One blank line between blocks, never two. */
inline void blank_line(std::string* out) {
    const size_t n = out->size();
    if (n == 0) return;
    if ((*out)[n - 1] == '\n' && n >= 2 && (*out)[n - 2] == '\n') return;
    if ((*out)[n - 1] != '\n') out->push_back('\n');
    out->push_back('\n');
}

inline void write_leaf(const Node& k, bool units, std::string* out) {
    if (k.bare) {
        *out += k.text;
        *out += '\n';
        return;
    }
    if (k.name == "COMMENT") {
        for (const std::string& line : split_lines(k.text)) {
            *out += "COMMENT ";
            *out += line;
            *out += '\n';
        }
        return;
    }
    *out += k.param.empty() ? k.name : "USER_DEFINED_" + k.param;
    *out += " = ";
    *out += k.text;
    if (units && !k.units.empty()) {
        *out += " [";
        *out += k.units;
        *out += ']';
    }
    *out += '\n';
}

inline void flush_matrix(const std::vector<const Node*>& cells, std::string* out) {
    if (cells.empty()) return;
    size_t n = 1;
    while (n * (n + 1) / 2 < cells.size()) ++n;
    size_t at = 0;
    for (size_t row = 1; row <= n && at < cells.size(); ++row) {
        std::string line;
        for (size_t c = 0; c < row && at < cells.size(); ++c, ++at) {
            if (c) line += ' ';
            line += cells[at]->text;
        }
        *out += line;
        *out += '\n';
    }
}

inline void write_group(const Node& g, bool units, std::string* out) {
    if (g.name == "segment" || g.name == "relativeMetadataData" || g.name == "data") blank_line(out);
    if (g.kvn_start) {
        blank_line(out);
        *out += g.kvn_start;
        *out += '\n';
    }
    if (g.rows == 1) {
        std::string line;
        for (size_t i = 0; i < g.kids.size(); ++i) {
            if (i) line += ' ';
            line += g.kids[i].text;
        }
        *out += line;
        *out += '\n';
    } else {
        std::vector<const Node*> matrix;
        for (const Node& k : g.kids) {
            if (k.head && !k.group) write_leaf(k, units, out);  /* CDM: OBJECT opens a segment */
        }
        for (size_t i = 0; i < g.kids.size(); ++i) {
            const Node& k = g.kids[i];
            if (k.head && !k.group) continue;
            if (k.matrix) {
                matrix.push_back(&k);
                continue;
            }
            flush_matrix(matrix, out);
            matrix.clear();
            if (k.group) {
                /* A run of repeated groups between one pair of markers. */
                const bool first = i == 0 || g.kids[i - 1].name != k.name;
                const bool last = i + 1 == g.kids.size() || g.kids[i + 1].name != k.name;
                if (k.kvn_run_start) {
                    blank_line(out);
                    if (first) {
                        *out += k.kvn_run_start;
                        *out += '\n';
                    }
                }
                write_group(k, units, out);
                if (k.kvn_run_stop && last) {
                    *out += k.kvn_run_stop;
                    *out += '\n';
                    blank_line(out);
                }
            } else {
                write_leaf(k, units, out);
            }
        }
        flush_matrix(matrix, out);
    }
    if (g.kvn_stop) {
        *out += g.kvn_stop;
        *out += '\n';
        blank_line(out);
    }
}

/* The version keyword, then everything below the root. `tree` is the root node
 * with the header and body groups as kids. */
inline void write(const std::string& version_key, const std::string& version, const Node& tree,
                  bool units, std::string* out) {
    out->clear();
    *out += version_key;
    *out += " = ";
    *out += version;
    *out += '\n';
    for (size_t i = 0; i < tree.kids.size(); ++i) {
        const Node& k = tree.kids[i];
        if (k.group) {
            write_group(k, units, out);
        } else {
            write_leaf(k, units, out);
        }
        if (i == 0) blank_line(out);  /* the header stands apart */
    }
    while (out->size() >= 2 && (*out)[out->size() - 1] == '\n' && (*out)[out->size() - 2] == '\n') {
        out->pop_back();
    }
}

}  // namespace kvn
}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_KVN_HPP
