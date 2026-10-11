/*
 * files/ccsds-messages — the NDM engine core: one tree, two syntaxes, typed records.
 *
 * WHAT THIS IS
 *
 * The Blue Books define every Navigation Data Message twice: as keyword-value
 * notation (KVN) and as NDM/XML. Both syntaxes carry the SAME keywords in the
 * SAME structure (header, body, segment, metadata, data, ...); KVN flattens
 * the structure into lines and block markers, XML spells it as elements. So the
 * engine has ONE pivot, the tree of `Node`s below, shaped like the XML. Each
 * syntax is a reader and a writer for that tree (ndm_xml.hpp, ndm_kvn.hpp), and
 * a message is a `Spec`: the same tree shape, written once in C++, in which
 * every keyword is bound to a member of the generated SDS object-API record.
 *
 *     KVN text ─┐                          ┌─ $OMM / $OEM / ... record
 *               ├─ Node tree ── Spec ──────┤
 *     XML text ─┘   (pivot)    (typed)     └─ (generated object API)
 *
 * A keyword is bound by a MEMBER POINTER into the generated type, so a keyword
 * whose SDS field is misspelled or does not exist is a compile error, not a
 * silent drop; nothing here is a string key into a record.
 *
 * WHAT IT DOES NOT DO
 *
 * No time-scale conversion and no unit conversion: an epoch is the string the
 * file wrote, a value is the number the file wrote. Converting needs the
 * leap-second table foundation/time owns (see kvn.hpp), and CCSDS fixes the
 * unit of every keyword, so the unit on the line is informational.
 *
 * WHAT IS LOST IS NAMED. The records are what they are: a keyword with no
 * field, a comment in a section that has no comment carrier, a value equal to
 * its field's default, a repeated keyword the record keeps once. Every such
 * case lands in the `Report` rather than disappearing.
 */

#ifndef CCSDS_MESSAGES_NDM_CORE_HPP
#define CCSDS_MESSAGES_NDM_CORE_HPP

#include <cctype>
#include <cerrno>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <functional>
#include <limits>
#include <memory>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace ndm {

/* ------------------------------------------------------------------------ */
/* Text                                                                      */
/* ------------------------------------------------------------------------ */

inline bool is_space(char c) {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\v' || c == '\f';
}

inline std::string trim(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && is_space(s[b])) ++b;
    while (e > b && is_space(s[e - 1])) --e;
    return s.substr(b, e - b);
}

inline std::string upper(std::string s) {
    for (char& c : s) {
        if (c >= 'a' && c <= 'z') c = static_cast<char>(c - 'a' + 'A');
    }
    return s;
}

inline bool starts_with(const std::string& s, const char* prefix) {
    const size_t n = std::strlen(prefix);
    return s.size() >= n && s.compare(0, n, prefix) == 0;
}

inline std::vector<std::string> split_lines(const std::string& s) {
    std::vector<std::string> out;
    size_t b = 0;
    while (b <= s.size()) {
        size_t e = s.find('\n', b);
        if (e == std::string::npos) e = s.size();
        out.push_back(s.substr(b, e - b));
        b = e + 1;
    }
    return out;
}

inline std::string join_lines(const std::vector<std::string>& v) {
    std::string out;
    for (size_t i = 0; i < v.size(); ++i) {
        if (i) out += '\n';
        out += v[i];
    }
    return out;
}

inline std::vector<std::string> tokens(const std::string& s) {
    std::vector<std::string> out;
    size_t i = 0;
    while (i < s.size()) {
        while (i < s.size() && is_space(s[i])) ++i;
        if (i >= s.size()) break;
        const size_t b = i;
        while (i < s.size() && !is_space(s[i])) ++i;
        out.push_back(s.substr(b, i - b));
    }
    return out;
}

/* ------------------------------------------------------------------------ */
/* Numbers                                                                   */
/* ------------------------------------------------------------------------ */

/* A CCSDS real is decimal text: sign, digits, point, exponent. No hex floats,
 * no inf or nan words, no Fortran D exponents: strtod would take them and the
 * Blue Books do not define them. */
inline bool parse_double(const std::string& raw, double* out) {
    const std::string s = trim(raw);
    if (s.empty()) return false;
    for (char c : s) {
        const bool ok = (c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.' || c == 'e' ||
                        c == 'E';
        if (!ok) return false;
    }
    char* end = nullptr;
    const double v = std::strtod(s.c_str(), &end);
    if (end != s.c_str() + s.size() || !std::isfinite(v)) return false;
    *out = v;
    return true;
}

inline bool parse_i64(const std::string& raw, long long* out) {
    const std::string s = trim(raw);
    if (s.empty()) return false;
    size_t i = (s[0] == '+' || s[0] == '-') ? 1 : 0;
    if (i >= s.size()) return false;
    for (size_t k = i; k < s.size(); ++k) {
        if (s[k] < '0' || s[k] > '9') return false;
    }
    errno = 0;
    char* end = nullptr;
    const long long v = std::strtoll(s.c_str(), &end, 10);
    if (errno != 0 || end != s.c_str() + s.size()) return false;
    *out = v;
    return true;
}

inline bool parse_u64(const std::string& raw, unsigned long long* out) {
    const std::string s = trim(raw);
    if (s.empty() || s[0] == '-') return false;
    size_t i = (s[0] == '+') ? 1 : 0;
    if (i >= s.size()) return false;
    for (size_t k = i; k < s.size(); ++k) {
        if (s[k] < '0' || s[k] > '9') return false;
    }
    errno = 0;
    char* end = nullptr;
    const unsigned long long v = std::strtoull(s.c_str(), &end, 10);
    if (errno != 0 || end != s.c_str() + s.size()) return false;
    *out = v;
    return true;
}

/* Shortest decimal text that reads back to exactly the same double, in fixed
 * notation for magnitudes a person writes by hand (7000.0, 0.0003331349) and in
 * scientific notation beyond that (2.607014375594646e-10). */
inline std::string format_double(double v) {
    if (v == 0.0) return std::signbit(v) ? "-0.0" : "0.0";
    char buf[64];
    int significant = 1;
    for (; significant <= 17; ++significant) {
        std::snprintf(buf, sizeof(buf), "%.*e", significant - 1, v);
        if (std::strtod(buf, nullptr) == v) break;
    }
    if (significant > 17) significant = 17;
    /* The decimal exponent of the shortest form: after the 'e' in %e output. */
    const char* e = std::strchr(buf, 'e');
    const int exponent = e ? std::atoi(e + 1) : 0;
    if (exponent >= -5 && exponent < 16) {
        const int decimals = std::max(0, significant - 1 - exponent);
        std::snprintf(buf, sizeof(buf), "%.*f", decimals, v);
        std::string s = buf;
        if (s.find('.') == std::string::npos) s += ".0";
        return s;
    }
    std::string s = buf;
    return s;
}

/* Move the decimal point of a decimal number's text `places` to the right
 * (negative: left), exactly: no arithmetic, so 1234.5678 and 1.2345678 are the
 * same number a thousand apart with no rounding in between. Text that is not a
 * plain decimal comes back unchanged. */
inline std::string shift_decimal(const std::string& raw, int places) {
    const std::string t = trim(raw);
    size_t i = 0;
    std::string sign;
    if (i < t.size() && (t[i] == '+' || t[i] == '-')) {
        if (t[i] == '-') sign = "-";
        ++i;
    }
    std::string digits;
    long long point = 0;  /* digits before the point */
    bool seen_point = false, any = false;
    for (; i < t.size(); ++i) {
        const char c = t[i];
        if (c >= '0' && c <= '9') {
            digits += c;
            any = true;
            if (!seen_point) ++point;
        } else if (c == '.' && !seen_point) {
            seen_point = true;
        } else {
            break;
        }
    }
    long long exponent = 0;
    if (i < t.size()) {
        if (t[i] != 'e' && t[i] != 'E') return t;
        long long e = 0;
        if (!parse_i64(t.substr(i + 1), &e)) return t;
        exponent = e;
    }
    if (!any) return t;
    long long position = point + exponent + places;  /* digits before the new point */
    size_t lead = 0;
    while (lead + 1 < digits.size() && digits[lead] == '0') {
        ++lead;
        --position;
    }
    digits.erase(0, lead);
    if (digits.find_first_not_of('0') == std::string::npos) return "0.0";
    std::string out;
    if (position <= 0) {
        out = "0." + std::string(static_cast<size_t>(-position), '0') + digits;
    } else if (static_cast<size_t>(position) >= digits.size()) {
        out = digits + std::string(static_cast<size_t>(position) - digits.size(), '0') + ".0";
    } else {
        out = digits.substr(0, static_cast<size_t>(position)) + "." +
              digits.substr(static_cast<size_t>(position));
    }
    /* Trailing zeros of the fraction are not significant. */
    const size_t dot = out.find('.');
    size_t end = out.size();
    while (end > dot + 2 && out[end - 1] == '0') --end;
    out.erase(end);
    if (out.size() > 40) {  /* an absurd magnitude: scientific rather than a wall of zeros */
        std::string mant = digits.substr(0, 1);
        if (digits.size() > 1) mant += "." + digits.substr(1);
        const long long e10 = position - 1;
        return sign + mant + "e" + (e10 < 0 ? "-" : "+") + (std::llabs(e10) < 10 ? "0" : "") +
               std::to_string(std::llabs(e10));
    }
    return sign + out;
}

/* ------------------------------------------------------------------------ */
/* The pivot tree                                                            */
/* ------------------------------------------------------------------------ */

struct Node {
    std::string name;   /* XML element name, which is the KVN keyword for a leaf */
    std::string text;   /* a leaf's value as written; the root's is the version  */
    std::string units;  /* KVN [units] / XML units attribute; empty when none     */
    std::string param;  /* USER_DEFINED parameter name (XML attribute / KVN suffix) */
    std::vector<Node> kids;
    bool group = false;

    /* Syntax hints a Spec stamps on the nodes it emits so the KVN writer needs
     * no Spec of its own. */
    const char* kvn_start = nullptr;
    const char* kvn_stop = nullptr;
    int rows = 0;       /* 1: this group is one KVN line of its leaves' texts    */
    bool matrix = false; /* leaf is a member of a lower-triangle matrix block     */
    bool bare = false;   /* leaf is a bare KVN text line (no KEYWORD =)           */
    bool head = false;   /* KVN states this leaf before the group's COMMENT lines  */
    int line = 0;        /* source line, KVN reader only */

    static Node leaf(const std::string& name, const std::string& text,
                     const std::string& units = std::string()) {
        Node n;
        n.name = name;
        n.text = text;
        n.units = units;
        return n;
    }
    static Node container(const std::string& name) {
        Node n;
        n.name = name;
        n.group = true;
        return n;
    }
    const Node* find(const std::string& child) const {
        for (const Node& k : kids) {
            if (k.name == child) return &k;
        }
        return nullptr;
    }
};

/* ------------------------------------------------------------------------ */
/* What was not carried                                                      */
/* ------------------------------------------------------------------------ */

enum class IssueKind : int {
    UnknownKeyword = 0,   /* no binding in this message's spec                     */
    UnknownStructure = 1, /* an element or marker the spec has no place for         */
    Duplicate = 2,        /* a keyword the record can hold once, read again         */
    Relocated = 3,        /* carried, but into a different section than it came from */
    DefaultValued = 4,    /* optional keyword whose value equals the field default  */
    MissingRequired = 5,  /* a mandatory keyword the message did not state          */
};

struct Issue {
    IssueKind kind = IssueKind::UnknownKeyword;
    std::string where;  /* section path */
    std::string key;
    std::string detail;
    int line = 0;
};

struct Report {
    std::vector<Issue> issues;
    void add(IssueKind kind, const std::string& where, const std::string& key,
             const std::string& detail = std::string(), int line = 0) {
        Issue i;
        i.kind = kind;
        i.where = where;
        i.key = key;
        i.detail = detail;
        i.line = line;
        issues.push_back(i);
    }
    size_t count(IssueKind kind) const {
        size_t n = 0;
        for (const Issue& i : issues) n += (i.kind == kind) ? 1u : 0u;
        return n;
    }
};

inline const char* issue_name(IssueKind k) {
    switch (k) {
        case IssueKind::UnknownKeyword: return "unknown-keyword";
        case IssueKind::UnknownStructure: return "unknown-structure";
        case IssueKind::Duplicate: return "duplicate";
        case IssueKind::Relocated: return "relocated";
        case IssueKind::DefaultValued: return "default-valued";
        case IssueKind::MissingRequired: return "missing-required";
    }
    return "unknown";
}

/* ------------------------------------------------------------------------ */
/* Value conversion: text <-> record member, chosen by the member's type     */
/* ------------------------------------------------------------------------ */

/* take: read text into the member; false + *err on a value the type refuses.
 * give: append the member's text to *out, zero or more values; a REQUIRED
 *       keyword is stated even when it holds the field's default, an optional
 *       one only when it differs from `def`, the value a default-constructed
 *       record holds (a FlatBuffers table cannot tell absent from default, so a
 *       default-valued optional keyword cannot be stated). */
template <class T, class = void>
struct Conv;

template <>
struct Conv<std::string> {
    static bool take(std::string& m, const std::string& t, std::string*) {
        m = t;
        return true;
    }
    static bool same(const std::string& a, const std::string& b) { return a == b; }
    static void give(const std::string& m, const std::string& def, bool required,
                     std::vector<std::string>* out) {
        if (required || m != def) out->push_back(m);
    }
};

template <>
struct Conv<double> {
    static bool take(double& m, const std::string& t, std::string* err) {
        if (!parse_double(t, &m)) {
            *err = "not a decimal number";
            return false;
        }
        return true;
    }
    static bool same(double a, double b) { return a == b || (std::isnan(a) && std::isnan(b)); }
    static void give(const double& m, const double& def, bool required,
                     std::vector<std::string>* out) {
        if (std::isnan(m)) return;
        if (required || !same(m, def)) out->push_back(format_double(m));
    }
};

template <>
struct Conv<float> {
    static bool take(float& m, const std::string& t, std::string* err) {
        double v = 0;
        if (!parse_double(t, &v)) {
            *err = "not a decimal number";
            return false;
        }
        m = static_cast<float>(v);
        return true;
    }
    static bool same(float a, float b) { return a == b || (std::isnan(a) && std::isnan(b)); }
    static void give(const float& m, const float& def, bool required,
                     std::vector<std::string>* out) {
        if (std::isnan(m)) return;
        if (required || !same(m, def)) {
            /* The shortest text that reads back to the same FLOAT. */
            char buf[48];
            for (int precision = 1; precision <= 9; ++precision) {
                std::snprintf(buf, sizeof(buf), "%.*g", precision, static_cast<double>(m));
                if (static_cast<float>(std::strtod(buf, nullptr)) == m) break;
            }
            std::string s = buf;
            if (s.find_first_of(".eEnN") == std::string::npos) s += ".0";
            out->push_back(s);
        }
    }
};

template <>
struct Conv<bool> {
    static bool take(bool& m, const std::string& t, std::string* err) {
        const std::string u = upper(trim(t));
        if (u == "YES" || u == "TRUE") { m = true; return true; }
        if (u == "NO" || u == "FALSE") { m = false; return true; }
        *err = "not YES or NO";
        return false;
    }
    static bool same(bool a, bool b) { return a == b; }
    static void give(const bool& m, const bool& def, bool required,
                     std::vector<std::string>* out) {
        if (required || m != def) out->push_back(m ? "YES" : "NO");
    }
};

template <class T>
struct Conv<T, std::enable_if_t<std::is_integral_v<T> && !std::is_same_v<T, bool>>> {
    static bool take(T& m, const std::string& t, std::string* err) {
        if constexpr (std::is_signed_v<T>) {
            long long v = 0;
            if (!parse_i64(t, &v) || v < static_cast<long long>(std::numeric_limits<T>::min()) ||
                v > static_cast<long long>(std::numeric_limits<T>::max())) {
                *err = "not an integer in range";
                return false;
            }
            m = static_cast<T>(v);
        } else {
            unsigned long long v = 0;
            if (!parse_u64(t, &v) ||
                v > static_cast<unsigned long long>(std::numeric_limits<T>::max())) {
                *err = "not an unsigned integer in range";
                return false;
            }
            m = static_cast<T>(v);
        }
        return true;
    }
    static bool same(T a, T b) { return a == b; }
    static void give(const T& m, const T& def, bool required, std::vector<std::string>* out) {
        if (required || m != def) {
            if constexpr (std::is_signed_v<T>) {
                out->push_back(std::to_string(static_cast<long long>(m)));
            } else {
                out->push_back(std::to_string(static_cast<unsigned long long>(m)));
            }
        }
    }
};

/* A repeated leaf (COMMENT, a list the record keeps as strings). */
template <>
struct Conv<std::vector<std::string>> {
    static bool take(std::vector<std::string>& m, const std::string& t, std::string*) {
        m.push_back(t);
        return true;
    }
    static bool same(const std::vector<std::string>& a, const std::vector<std::string>& b) {
        return a == b;
    }
    static void give(const std::vector<std::string>& m, const std::vector<std::string>&, bool,
                     std::vector<std::string>* out) {
        for (const std::string& s : m) out->push_back(s);
    }
};

/* An enumeration, by the identifier the SDS schema gives its members. The
 * generated header has EnumNameX / EnumValuesX for each one; the macro
 * NDM_ENUM(X) in the message headers instantiates the traits. */
template <class E>
struct EnumTraits;

template <class E>
struct Conv<E, std::enable_if_t<std::is_enum_v<E>>> {
    static bool take(E& m, const std::string& t, std::string* err) {
        const std::string s = upper(trim(t));  /* the XML schemas accept either case */
        const E* values = EnumTraits<E>::values();
        for (size_t i = 0; i < EnumTraits<E>::count(); ++i) {
            const char* name = EnumTraits<E>::name(values[i]);
            if (name && s == upper(name)) {
                m = values[i];
                return true;
            }
        }
        *err = "not a member of the enumeration";
        return false;
    }
    static bool same(E a, E b) { return a == b; }
    static void give(const E& m, const E& def, bool required, std::vector<std::string>* out) {
        if (required || m != def) {
            const char* name = EnumTraits<E>::name(m);
            if (name && *name) out->push_back(name);
        }
    }
};

#define NDM_ENUM(E)                                                                          \
    template <>                                                                              \
    struct EnumTraits<E> {                                                                   \
        static const E* values() { return EnumValues##E(); }                                 \
        static size_t count() {                                                              \
            return std::extent<std::remove_reference_t<decltype(EnumValues##E())>>::value;   \
        }                                                                                    \
        static const char* name(E v) { return EnumName##E(v); }                              \
    }

/* ------------------------------------------------------------------------ */
/* Bound keywords and sections                                               */
/* ------------------------------------------------------------------------ */

using Obj = void;
using TakeFn = std::function<bool(Obj*, const std::string&, std::string*)>;
using GiveFn = std::function<void(const Obj*, bool, std::vector<std::string>*)>;
using TakeParamFn =
    std::function<bool(Obj*, const std::string&, const std::string&, std::string*)>;
using GiveParamFn =
    std::function<void(const Obj*, std::vector<std::pair<std::string, std::string>>*)>;

/* One keyword. `take` is null for a keyword that is only ever written, `give`
 * null for one that is only ever read (a comment relocated into the section
 * that owns the record's single comment field, say). */
struct Leaf {
    std::string name;
    const char* units = nullptr;
    bool required = false;
    TakeFn take;
    GiveFn give;
    std::function<bool(const Obj*)> at_default;  /* after take: still the field default? */
    bool user_defined = false;  /* USER_DEFINED_x / <USER_DEFINED parameter="x"> */
    TakeParamFn take_param;
    GiveParamFn give_param;
    bool matrix = false;        /* a member of the section's lower-triangle matrix */
    bool bare = false;          /* a bare KVN text line (OCM/ACM data lines) */
    bool relocated = false;     /* read here but written elsewhere: declare it */
    /* Units a message may annotate this keyword with besides `units`, and how many
     * places the decimal point moves to reach `units` (km for m: +3). */
    std::vector<std::pair<std::string, int>> unit_shifts;
};

struct Nav {
    std::function<size_t(const Obj*)> count;
    std::function<const Obj*(const Obj*, size_t)> at;
    std::function<Obj*(Obj*)> make;
};

struct Section;

struct Item {
    bool is_section = false;
    Leaf leaf;
    std::shared_ptr<Section> sec;
    Item(Leaf l) : is_section(false), leaf(std::move(l)) {}
    Item(std::shared_ptr<Section> s) : is_section(true), sec(std::move(s)) {}
};

struct Section {
    std::string name;            /* XML element name */
    const char* kvn_start = nullptr;
    const char* kvn_stop = nullptr;
    bool repeat = false;         /* may occur many times */
    bool optional = false;       /* dropped from the output when it holds nothing */
    int rows = 0;                /* 1: each instance is one KVN data line */
    bool has_matrix = false;     /* KVN lower-triangle rows for the matrix leaves */
    std::function<bool(const Obj*)> present;  /* null: always; else only when this holds */
    /* Reading: which instance of the parent this node is, when position is not
     * enough (CDM's OBJECT1 and OBJECT2). Null: the next one, via nav.make. */
    std::function<Obj*(Obj*, const Node&)> select;
    /* Writing: touch up the node built for instance `index`. */
    std::function<void(Node&, size_t)> decorate;
    Nav nav;
    std::vector<Item> items;

    const Leaf* leaf_named(const std::string& n) const {
        for (const Item& it : items) {
            if (!it.is_section && it.leaf.name == n) return &it.leaf;
        }
        return nullptr;
    }
    const Section* section_named(const std::string& n) const {
        for (const Item& it : items) {
            if (it.is_section && it.sec->name == n) return it.sec.get();
        }
        return nullptr;
    }
    const Leaf* user_defined_leaf() const {
        for (const Item& it : items) {
            if (!it.is_section && it.leaf.user_defined) return &it.leaf;
        }
        return nullptr;
    }
    bool has_bare_leaf() const {
        for (const Item& it : items) {
            if (!it.is_section && it.leaf.bare) return true;
        }
        return false;
    }
    const Leaf* bare_leaf() const {
        for (const Item& it : items) {
            if (!it.is_section && it.leaf.bare) return &it.leaf;
        }
        return nullptr;
    }
};

/* One message: its root element, the keyword that states its version, and the
 * section tree (header, body) below the root. */
struct Message {
    std::string type;          /* "OMM" */
    std::string root;          /* "omm" */
    std::string version_key;   /* "CCSDS_OMM_VERS" */
    std::string version;       /* "3.0": what this engine writes */
    TakeFn take_version;       /* version text -> record */
    GiveFn give_version;       /* record -> version text (empty: use `version`) */
    std::shared_ptr<Section> top; /* name == root; items: header, body */
    /* A record the message cannot state at all: the reason, or empty when it can. */
    std::function<std::string(const Obj*)> check_record;
};

/* ------------------------------------------------------------------------ */
/* Spec builders                                                             */
/* ------------------------------------------------------------------------ */

template <class C, class M, M C::*P>
inline Leaf make_leaf(const char* name, const char* units, bool required) {
    Leaf l;
    l.name = name;
    l.units = units;
    l.required = required;
    l.take = [](Obj* o, const std::string& t, std::string* e) {
        return Conv<M>::take(static_cast<C*>(o)->*P, t, e);
    };
    l.give = [](const Obj* o, bool req, std::vector<std::string>* out) {
        static const C defaults{};
        Conv<M>::give(static_cast<const C*>(o)->*P, defaults.*P, req, out);
    };
    l.at_default = [](const Obj* o) {
        static const C defaults{};
        return Conv<M>::same(static_cast<const C*>(o)->*P, defaults.*P);
    };
    return l;
}

/* Bind a keyword to a member of the same name. */
#define NDM_LEAF(C, MEMBER, UNITS, REQ) \
    ::ndm::make_leaf<C, decltype(C::MEMBER), &C::MEMBER>(#MEMBER, UNITS, REQ)
/* Bind a keyword to a member of another name. */
#define NDM_LEAF_AS(C, KEYWORD, MEMBER, UNITS, REQ) \
    ::ndm::make_leaf<C, decltype(C::MEMBER), &C::MEMBER>(KEYWORD, UNITS, REQ)

/* A real keyword the record holds in other units than the message states: the
 * message's `units` text against the record's, `shift` decimal places apart (the
 * message states metres, the record kilometres: shift -3). The shift is made on
 * the digits, not by multiplying, so a value reads back as exactly the text it
 * came from. `alt_units` names the one other units the message may annotate it
 * with, already in the record's. */
template <class C, double C::*P>
inline Leaf scaled_leaf(const char* name, const char* units, int shift, const char* alt_units,
                        bool required) {
    Leaf l;
    l.name = name;
    l.units = units;
    l.required = required;
    l.take = [shift](Obj* o, const std::string& t, std::string* e) {
        return Conv<double>::take(static_cast<C*>(o)->*P, shift_decimal(t, shift), e);
    };
    l.give = [shift](const Obj* o, bool req, std::vector<std::string>* out) {
        static const C defaults{};
        std::vector<std::string> v;
        Conv<double>::give(static_cast<const C*>(o)->*P, defaults.*P, req, &v);
        for (const std::string& s : v) out->push_back(shift_decimal(s, -shift));
    };
    l.at_default = [](const Obj* o) {
        static const C defaults{};
        return Conv<double>::same(static_cast<const C*>(o)->*P, defaults.*P);
    };
    if (alt_units) l.unit_shifts.push_back(std::make_pair(std::string(alt_units), -shift));
    return l;
}

/* A keyword whose conversion is written out: take(C&, text, err) and
 * give(const C&, required, out). */
template <class C, class TakeF, class GiveF>
inline Leaf custom_leaf(const char* name, const char* units, bool required, TakeF take,
                        GiveF give) {
    Leaf l;
    l.name = name;
    l.units = units;
    l.required = required;
    l.take = [take](Obj* o, const std::string& t, std::string* e) {
        return take(*static_cast<C*>(o), t, e);
    };
    l.give = [give](const Obj* o, bool req, std::vector<std::string>* out) {
        give(*static_cast<const C*>(o), req, out);
    };
    return l;
}

/* The same, for an optional keyword whose default the record cannot state:
 * `at_default(const C&)` says whether the record still holds it after a read. */
template <class C, class TakeF, class GiveF, class DefaultF>
inline Leaf custom_leaf(const char* name, const char* units, bool required, TakeF take,
                        GiveF give, DefaultF at_default) {
    Leaf l = custom_leaf<C>(name, units, required, take, give);
    l.at_default = [at_default](const Obj* o) { return at_default(*static_cast<const C*>(o)); };
    return l;
}

/* A keyword that is read into the record and never written back from it. */
inline Leaf read_only(Leaf l) {
    l.give = nullptr;
    l.relocated = true;
    return l;
}

/* A string member holding LF-joined comment lines. */
template <class C, std::string C::*P>
inline Leaf comment_leaf(bool carried) {
    Leaf l;
    l.name = "COMMENT";
    l.take = [](Obj* o, const std::string& t, std::string*) {
        std::string& m = static_cast<C*>(o)->*P;
        if (!m.empty()) m += '\n';
        m += t;
        return true;
    };
    if (carried) {
        l.give = [](const Obj* o, bool, std::vector<std::string>* out) {
            const std::string& m = static_cast<const C*>(o)->*P;
            if (!m.empty()) {
                for (const std::string& line : split_lines(m)) out->push_back(line);
            }
        };
    } else {
        l.relocated = true;
    }
    return l;
}
#define NDM_COMMENT(C, MEMBER, CARRIED) ::ndm::comment_leaf<C, &C::MEMBER>(CARRIED)

/* A vector<string> member of COMMENT lines. */
template <class C, std::vector<std::string> C::*P>
inline Leaf comment_list_leaf(bool carried) {
    Leaf l;
    l.name = "COMMENT";
    l.take = [](Obj* o, const std::string& t, std::string*) {
        (static_cast<C*>(o)->*P).push_back(t);
        return true;
    };
    if (carried) {
        l.give = [](const Obj* o, bool, std::vector<std::string>* out) {
            for (const std::string& s : static_cast<const C*>(o)->*P) out->push_back(s);
        };
    } else {
        l.relocated = true;
    }
    return l;
}
#define NDM_COMMENTS(C, MEMBER, CARRIED) ::ndm::comment_list_leaf<C, &C::MEMBER>(CARRIED)

inline Nav nav_same() {
    Nav n;
    n.count = [](const Obj*) -> size_t { return 1; };
    n.at = [](const Obj* p, size_t) -> const Obj* { return p; };
    n.make = [](Obj* p) -> Obj* { return p; };
    return n;
}

template <class P, class C, std::unique_ptr<C> P::*M>
inline Nav nav_one() {
    Nav n;
    n.count = [](const Obj* p) -> size_t { return (static_cast<const P*>(p)->*M) ? 1u : 0u; };
    n.at = [](const Obj* p, size_t) -> const Obj* { return (static_cast<const P*>(p)->*M).get(); };
    n.make = [](Obj* p) -> Obj* {
        std::unique_ptr<C>& slot = static_cast<P*>(p)->*M;
        if (!slot) slot = std::make_unique<C>();
        return slot.get();
    };
    return n;
}
#define NDM_NAV_ONE(P, MEMBER) \
    ::ndm::nav_one<P, decltype(P::MEMBER)::element_type, &P::MEMBER>()

template <class P, class C, std::vector<std::unique_ptr<C>> P::*M>
inline Nav nav_many() {
    Nav n;
    n.count = [](const Obj* p) -> size_t { return (static_cast<const P*>(p)->*M).size(); };
    n.at = [](const Obj* p, size_t i) -> const Obj* {
        return (static_cast<const P*>(p)->*M)[i].get();
    };
    n.make = [](Obj* p) -> Obj* {
        std::vector<std::unique_ptr<C>>& v = static_cast<P*>(p)->*M;
        v.push_back(std::make_unique<C>());
        return v.back().get();
    };
    return n;
}
#define NDM_NAV_MANY(P, MEMBER) \
    ::ndm::nav_many<P, decltype(P::MEMBER)::value_type::element_type, &P::MEMBER>()

struct SectionOptions {
    const char* kvn_start = nullptr;
    const char* kvn_stop = nullptr;
    bool repeat = false;
    bool optional = false;
    int rows = 0;
    std::function<bool(const Obj*)> present;
    std::function<Obj*(Obj*, const Node&)> select;
    std::function<void(Node&, size_t)> decorate;
};

inline SectionOptions block(const char* start, const char* stop) {
    SectionOptions o;
    o.kvn_start = start;
    o.kvn_stop = stop;
    return o;
}

inline std::shared_ptr<Section> section(const char* name, Nav nav, std::vector<Item> items,
                                        SectionOptions o = SectionOptions()) {
    auto s = std::make_shared<Section>();
    s->name = name;
    s->nav = std::move(nav);
    s->items = std::move(items);
    s->kvn_start = o.kvn_start;
    s->kvn_stop = o.kvn_stop;
    s->repeat = o.repeat;
    s->optional = o.optional;
    s->rows = o.rows;
    s->present = std::move(o.present);
    s->select = std::move(o.select);
    s->decorate = std::move(o.decorate);
    for (const Item& it : s->items) {
        if (!it.is_section && it.leaf.matrix) s->has_matrix = true;
    }
    return s;
}

/* ------------------------------------------------------------------------ */
/* Node -> record                                                            */
/* ------------------------------------------------------------------------ */

struct FillResult {
    bool ok = true;
    std::string error;  /* the first value the record refused */
    int line = 0;
};

inline void fill_section(const Section& s, const Node& n, Obj* parent, const std::string& path,
                         Report* rep, FillResult* res);

inline void fill_leaf(const Section& s, const Leaf& leaf, const Node& kid, Obj* self,
                      const std::string& path, Report* rep, FillResult* res) {
    if (kid.group) {
        rep->add(IssueKind::UnknownStructure, path, kid.name, "a group where a keyword belongs",
                 kid.line);
        return;
    }
    std::string err;
    bool ok = true;
    std::string text = kid.text;
    if (!kid.units.empty() && !leaf.unit_shifts.empty() && (!leaf.units || kid.units != leaf.units)) {
        for (const auto& shift : leaf.unit_shifts) {
            if (kid.units == shift.first) text = shift_decimal(text, shift.second);
        }
    }
    if (leaf.user_defined) {
        if (leaf.take_param) ok = leaf.take_param(self, kid.param, kid.text, &err);
    } else if (leaf.take) {
        ok = leaf.take(self, text, &err);
    }
    if (ok && !leaf.required && leaf.at_default && leaf.at_default(self)) {
        rep->add(IssueKind::DefaultValued, path, kid.name,
                 "equals the field default, so the record cannot state it", kid.line);
    }
    if (leaf.relocated) {
        rep->add(IssueKind::Relocated, path, kid.name, "carried in the record's single field",
                 kid.line);
    }
    if (!ok && res->ok) {
        res->ok = false;
        res->error = kid.name + " = " + kid.text + ": " + err;
        res->line = kid.line;
    }
    (void)s;
}

inline void fill_section(const Section& s, const Node& n, Obj* parent, const std::string& path,
                         Report* rep, FillResult* res) {
    Obj* self = s.select ? s.select(parent, n) : (s.nav.make ? s.nav.make(parent) : parent);
    for (const Node& kid : n.kids) {
        const Leaf* leaf = nullptr;
        if (kid.name == "USER_DEFINED") {
            leaf = s.user_defined_leaf();
        } else {
            leaf = s.leaf_named(kid.name);
        }
        if (leaf) {
            fill_leaf(s, *leaf, kid, self, path, rep, res);
            continue;
        }
        const Section* child = s.section_named(kid.name);
        if (child && kid.group) {
            fill_section(*child, kid, self, path + "/" + kid.name, rep, res);
            continue;
        }
        rep->add(IssueKind::UnknownKeyword, path, kid.name, kid.group ? "group" : kid.text,
                 kid.line);
    }
}

/* ------------------------------------------------------------------------ */
/* record -> Node                                                            */
/* ------------------------------------------------------------------------ */

inline void emit_section(const Section& s, const Obj* parent, std::vector<Node>* out) {
    const size_t count = s.nav.count ? s.nav.count(parent) : 1u;
    for (size_t i = 0; i < count; ++i) {
        const Obj* self = s.nav.at ? s.nav.at(parent, i) : parent;
        if (s.present && !s.present(self)) continue;
        Node n = Node::container(s.name);
        n.kvn_start = s.kvn_start;
        n.kvn_stop = s.kvn_stop;
        n.rows = s.rows;
        for (const Item& it : s.items) {
            if (it.is_section) {
                emit_section(*it.sec, self, &n.kids);
                continue;
            }
            const Leaf& leaf = it.leaf;
            if (leaf.user_defined) {
                std::vector<std::pair<std::string, std::string>> params;
                if (leaf.give_param) leaf.give_param(self, &params);
                for (const auto& p : params) {
                    Node k = Node::leaf("USER_DEFINED", p.second);
                    k.param = p.first;
                    n.kids.push_back(k);
                }
                continue;
            }
            if (!leaf.give) continue;
            std::vector<std::string> values;
            leaf.give(self, leaf.required, &values);
            for (const std::string& v : values) {
                Node k = Node::leaf(leaf.name, v, leaf.units ? leaf.units : "");
                k.matrix = leaf.matrix;
                k.bare = leaf.bare;
                n.kids.push_back(k);
            }
        }
        if (s.decorate) s.decorate(n, i);
        if (s.optional && n.kids.empty()) continue;
        out->push_back(n);
    }
}

}  // namespace ndm

#endif  // CCSDS_MESSAGES_NDM_CORE_HPP
