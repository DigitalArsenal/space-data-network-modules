/*
 * files/ccsds-messages — the CCSDS keyword-value notation document model.
 *
 * WHY A DOCUMENT MODEL AND NOT A STRUCT PER MESSAGE
 *
 * The acceptance for this package is "every KVN keyword round-trips exactly"
 * against the published Blue Book example messages. That property belongs to
 * the DOCUMENT, not to any record we project it into: the moment a reader
 * parses into a fixed struct, every keyword the struct does not name is gone,
 * and the round trip can only be exact for the subset somebody remembered.
 * The published corpus proves how sharp that edge is — CCSDS 503.0-B-2 Annex E
 * uses 70 distinct keywords across 18 example messages, and the pinned SDS
 * $TDM has no carrier at all for RANGE, the single most important observable
 * in the format.
 *
 * So: parse to an ORDERED list of keyword/value/units/comment entries that
 * preserves everything the file said, in the order it said it, and serialize
 * from that. Exactness becomes a property of the model rather than a promise
 * about coverage. Projecting into $AEM/$TDM is then a lossy-by-declaration
 * step on top, and what it drops is visible instead of silent.
 *
 * WHAT THIS MODEL PRESERVES, DELIBERATELY
 *
 *  - Key order within every block. CCSDS fixes the order of some keywords and
 *    leaves others free; re-emitting in a canonical order of our choosing
 *    would produce a file that is semantically equal and textually different,
 *    which fails a byte round trip for no reason.
 *  - The units annotation (`MAN_DURATION = 3 [s]`). It is part of the line.
 *  - COMMENT lines and their position. A comment between two metadata keys is
 *    attached to the key that follows it, because that is where a reader
 *    expects it back.
 *  - Repeated keywords. `COMMENT` repeats freely, `CLOCK_BIAS` repeats once
 *    per observation, and a map keyed by name would collapse them.
 *  - The value as WRITTEN, as text, alongside any parse. `-1.767e-6` and
 *    `-0.000001767` are the same number and different files; the writer emits
 *    what it was given.
 *
 * WHAT IT DOES NOT DO
 *
 * No time-scale conversion and no unit conversion. An epoch is the string the
 * file carried; TIME_SYSTEM is a keyword like any other. Converting needs the
 * leap-second table `foundation/time` owns, and a second copy of that table
 * here is the drift this stack keeps paying for.
 */

#ifndef CCSDS_MESSAGES_KVN_HPP
#define CCSDS_MESSAGES_KVN_HPP

#include <cctype>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace kvn {

enum class Status : int32_t {
    Ok = 0,
    Malformed = -1,      /* a line that is neither blank, a marker, nor KEY = VALUE */
    UnknownMessage = -2, /* no recognised CCSDS_*_VERS on the first non-blank line  */
    BadStructure = -3,   /* META_START without META_STOP, DATA_STOP without a start */
};

inline const char* status_name(Status s) {
    switch (s) {
        case Status::Ok: return "ok";
        case Status::Malformed: return "malformed";
        case Status::UnknownMessage: return "unknown-message";
        case Status::BadStructure: return "bad-structure";
    }
    return "unknown";
}

/* ------------------------------------------------------------------------ */
/* One line                                                                  */
/* ------------------------------------------------------------------------ */

struct Entry {
    std::string key;
    std::string value; /* verbatim, trimmed of surrounding whitespace only */
    std::string units; /* the [..] annotation, WITHOUT the brackets; empty if none */

    /* COMMENT lines that immediately preceded this entry, in order. Held here
     * rather than as their own entries so that a consumer walking metadata
     * keys does not have to filter them, while a writer can still put them
     * back exactly where they were. */
    std::vector<std::string> comments_before;

    /* True for a line that is itself a COMMENT with nothing following it in
     * the block — a trailing comment has no host entry to attach to. */
    bool is_standalone_comment = false;
};

/* ------------------------------------------------------------------------ */
/* A data line                                                               */
/* ------------------------------------------------------------------------ */

/*
 * CCSDS data sections come in two shapes and the difference is load-bearing.
 *
 *   AEM/OEM: whitespace-separated columns, the first of which is an epoch.
 *            `1996-11-28T21:29:07.2555 0.56748 0.03146 0.45689 0.68427`
 *   TDM:     KEYWORD = <epoch> <value> triples, one observable per line, with
 *            each keyword free to carry its own independent epoch — Figure
 *            E-17 has an RCS line whose epoch repeats an EARLIER one.
 *
 * A model that assumed a uniform grid across a block could represent neither.
 * Both shapes are carried here: `key` empty means a columnar row, `key` set
 * means a keyed observation.
 */
struct DataLine {
    std::string key;                  /* empty for columnar rows */
    std::string epoch;                /* verbatim epoch token, may be empty */
    std::vector<std::string> tokens;  /* remaining columns, verbatim */
    std::vector<std::string> comments_before;
    bool is_standalone_comment = false;
};

/* ------------------------------------------------------------------------ */
/* A segment                                                                 */
/* ------------------------------------------------------------------------ */

struct Segment {
    std::vector<Entry> metadata;    /* between META_START and META_STOP     */
    std::vector<DataLine> data;     /* between DATA_START and DATA_STOP     */
    bool has_data_block = false;    /* an AEM segment may legally have none */
};

struct Document {
    std::string message_type;       /* "AEM", "TDM", "OEM", ... from CCSDS_<X>_VERS */
    std::vector<Entry> header;      /* CCSDS_*_VERS, CREATION_DATE, ORIGINATOR, ... */
    std::vector<Segment> segments;
};

/* ------------------------------------------------------------------------ */
/* Lexing helpers                                                            */
/* ------------------------------------------------------------------------ */

inline bool is_space(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\v' || c == '\f'; }

inline std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && is_space(s[b])) ++b;
    while (e > b && is_space(s[e - 1])) --e;
    return s.substr(b, e - b);
}

inline std::vector<std::string> split_tokens(const std::string& s) {
    std::vector<std::string> out;
    size_t i = 0;
    while (i < s.size()) {
        while (i < s.size() && is_space(s[i])) ++i;
        if (i >= s.size()) break;
        const size_t start = i;
        while (i < s.size() && !is_space(s[i])) ++i;
        out.push_back(s.substr(start, i - start));
    }
    return out;
}

/*
 * Strip a trailing `[unit]` annotation off a value. CCSDS puts the unit in
 * square brackets after the value, and it is informational — but it is also
 * part of the line, so it is carried rather than discarded.
 */
inline void split_units(const std::string& raw, std::string* value, std::string* units) {
    const std::string v = trim(raw);
    if (!v.empty() && v.back() == ']') {
        const size_t open = v.rfind('[');
        if (open != std::string::npos) {
            *value = trim(v.substr(0, open));
            *units = trim(v.substr(open + 1, v.size() - open - 2));
            return;
        }
    }
    *value = v;
    units->clear();
}

/* ------------------------------------------------------------------------ */
/* Parse                                                                     */
/* ------------------------------------------------------------------------ */

/*
 * A KVN block marker. These are bare words on a line of their own; CCSDS also
 * permits `META_START`/`META_STOP` to appear with trailing whitespace, which
 * trimming already handles.
 */
inline bool is_marker(const std::string& line, const char* marker) {
    return line == marker;
}

inline Status parse(const char* text, size_t len, Document* out) {
    if (!text || !out) return Status::Malformed;
    *out = Document{};

    /* Split into lines without allocating a copy of the whole document per
     * line: the corpus includes multi-megabyte ephemeris bodies. */
    std::vector<std::string> pending_comments;
    Segment current;
    bool in_meta = false;
    bool in_data = false;
    bool segment_open = false;
    bool header_done = false;

    size_t i = 0;
    while (i <= len) {
        size_t start = i;
        while (i < len && text[i] != '\n') ++i;
        std::string line = trim(std::string(text + start, i - start));
        const bool at_end = (i >= len);
        ++i;

        if (!line.empty()) {
            if (is_marker(line, "META_START")) {
                if (in_meta || in_data) return Status::BadStructure;
                /* A new metadata block starts a new segment, unless the
                 * previous one never got data — CCSDS permits back-to-back
                 * META blocks only across segments. */
                if (segment_open) {
                    out->segments.push_back(current);
                    current = Segment{};
                }
                segment_open = true;
                in_meta = true;
                header_done = true;
                for (const std::string& c : pending_comments) {
                    Entry e;
                    e.key = "COMMENT";
                    e.value = c;
                    e.is_standalone_comment = true;
                    current.metadata.push_back(e);
                }
                pending_comments.clear();
            } else if (is_marker(line, "META_STOP")) {
                if (!in_meta) return Status::BadStructure;
                for (const std::string& c : pending_comments) {
                    Entry e;
                    e.key = "COMMENT";
                    e.value = c;
                    e.is_standalone_comment = true;
                    current.metadata.push_back(e);
                }
                pending_comments.clear();
                in_meta = false;
            } else if (is_marker(line, "DATA_START")) {
                if (in_data) return Status::BadStructure;
                in_data = true;
                current.has_data_block = true;
                segment_open = true;
            } else if (is_marker(line, "DATA_STOP")) {
                if (!in_data) return Status::BadStructure;
                for (const std::string& c : pending_comments) {
                    DataLine d;
                    d.key = "COMMENT";
                    d.epoch = c;
                    d.is_standalone_comment = true;
                    current.data.push_back(d);
                }
                pending_comments.clear();
                in_data = false;
                out->segments.push_back(current);
                current = Segment{};
                segment_open = false;
            } else {
                const size_t eq = line.find('=');
                const bool is_comment = line.rfind("COMMENT", 0) == 0 &&
                                        (line.size() == 7 || is_space(line[7]));

                if (is_comment) {
                    pending_comments.push_back(trim(line.substr(7)));
                } else if (in_data && (eq == std::string::npos || !std::isupper(
                                           static_cast<unsigned char>(line[0])))) {
                    /* Columnar data row: an epoch followed by numbers. */
                    DataLine d;
                    d.comments_before = pending_comments;
                    pending_comments.clear();
                    std::vector<std::string> tok = split_tokens(line);
                    if (!tok.empty()) {
                        d.epoch = tok[0];
                        d.tokens.assign(tok.begin() + 1, tok.end());
                    }
                    current.data.push_back(d);
                } else if (in_data) {
                    /* Keyed observation: KEYWORD = <epoch> <value...> */
                    DataLine d;
                    d.comments_before = pending_comments;
                    pending_comments.clear();
                    d.key = trim(line.substr(0, eq));
                    std::vector<std::string> tok = split_tokens(line.substr(eq + 1));
                    if (!tok.empty()) {
                        d.epoch = tok[0];
                        d.tokens.assign(tok.begin() + 1, tok.end());
                    }
                    current.data.push_back(d);
                } else if (eq != std::string::npos) {
                    Entry e;
                    e.comments_before = pending_comments;
                    pending_comments.clear();
                    e.key = trim(line.substr(0, eq));
                    split_units(line.substr(eq + 1), &e.value, &e.units);
                    if (!header_done) {
                        if (out->message_type.empty() && e.key.rfind("CCSDS_", 0) == 0 &&
                            e.key.size() > 11) {
                            /* CCSDS_<TYPE>_VERS — the type is what sits between. */
                            out->message_type = e.key.substr(6, e.key.size() - 6 - 5);
                        }
                        out->header.push_back(e);
                    } else if (in_meta) {
                        current.metadata.push_back(e);
                    } else {
                        /* A keyword outside every block after the header. The
                         * corpus does not produce these; carrying it on the
                         * open segment's metadata is the least destructive
                         * place, and refusing would reject a file CCSDS did
                         * not forbid. */
                        current.metadata.push_back(e);
                        segment_open = true;
                    }
                } else {
                    return Status::Malformed;
                }
            }
        }

        if (at_end) break;
    }

    if (in_meta || in_data) return Status::BadStructure;
    if (segment_open) out->segments.push_back(current);
    if (out->message_type.empty()) return Status::UnknownMessage;
    return Status::Ok;
}

/* ------------------------------------------------------------------------ */
/* Serialize                                                                 */
/* ------------------------------------------------------------------------ */

/*
 * Alignment is a WRITER choice, not a parse fact: the published examples pad
 * `=` into a column and readers must not care. `key_column` reproduces that
 * habit when a caller wants a file that looks like the Blue Book; zero emits
 * `KEY = VALUE` with single spaces. Either way the parse of the output is
 * identical to the parse of the input, which is the round trip the acceptance
 * measures — a byte-identical re-emission of an arbitrary input would require
 * storing each line's original whitespace, which buys nothing a reader can use.
 */
struct WriteOptions {
    size_t key_column = 0;
    const char* newline = "\n";
};

inline void emit_entry(std::string* out, const Entry& e, const WriteOptions& o) {
    for (const std::string& c : e.comments_before) {
        *out += "COMMENT " + c;
        *out += o.newline;
    }
    if (e.is_standalone_comment) {
        *out += "COMMENT " + e.value;
        *out += o.newline;
        return;
    }
    std::string key = e.key;
    if (o.key_column > key.size()) key.append(o.key_column - key.size(), ' ');
    *out += key + " = " + e.value;
    if (!e.units.empty()) *out += " [" + e.units + "]";
    *out += o.newline;
}

inline void emit_data_line(std::string* out, const DataLine& d, const WriteOptions& o) {
    for (const std::string& c : d.comments_before) {
        *out += "COMMENT " + c;
        *out += o.newline;
    }
    if (d.is_standalone_comment) {
        *out += "COMMENT " + d.epoch;
        *out += o.newline;
        return;
    }
    if (!d.key.empty()) {
        *out += d.key + " = " + d.epoch;
    } else {
        *out += d.epoch;
    }
    for (const std::string& t : d.tokens) {
        *out += " " + t;
    }
    *out += o.newline;
}

inline Status serialize(const Document& doc, std::string* out,
                        const WriteOptions& o = WriteOptions{}) {
    if (!out) return Status::Malformed;
    out->clear();
    for (const Entry& e : doc.header) emit_entry(out, e, o);
    for (const Segment& s : doc.segments) {
        *out += o.newline;
        *out += "META_START";
        *out += o.newline;
        for (const Entry& e : s.metadata) emit_entry(out, e, o);
        *out += "META_STOP";
        *out += o.newline;
        if (s.has_data_block) {
            *out += o.newline;
            *out += "DATA_START";
            *out += o.newline;
            for (const DataLine& d : s.data) emit_data_line(out, d, o);
            *out += "DATA_STOP";
            *out += o.newline;
        }
    }
    return Status::Ok;
}

/* ------------------------------------------------------------------------ */
/* Lookup                                                                    */
/* ------------------------------------------------------------------------ */

/*
 * Returns nullptr for an absent key rather than an empty string, because
 * "the file did not say" and "the file said nothing" are different facts and
 * collapsing them is how a defaulted CENTER_NAME becomes indistinguishable
 * from a declared one three layers downstream.
 */
inline const Entry* find(const std::vector<Entry>& entries, const char* key) {
    for (const Entry& e : entries) {
        if (!e.is_standalone_comment && e.key == key) return &e;
    }
    return nullptr;
}

inline double to_double(const std::string& s, bool* ok) {
    if (s.empty()) { if (ok) *ok = false; return 0.0; }
    char* end = nullptr;
    const double v = std::strtod(s.c_str(), &end);
    const bool good = end && end != s.c_str();
    if (ok) *ok = good;
    return good ? v : 0.0;
}

}  // namespace kvn

#endif  // CCSDS_MESSAGES_KVN_HPP
