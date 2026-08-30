/*
 * files/orbit-products — the ephemeris spine.
 *
 * ONE in-memory state series that every container reader writes into and every
 * container writer reads out of, so SPK, Code-500, STK ephemeris and SP3 cannot
 * disagree about what a state history IS. The $OEM projection is built from
 * this and nothing else.
 *
 * TIME: this layer performs NO time-scale conversion, deliberately. Every
 * container declares its own time system (SPK is ET/TDB seconds past J2000,
 * SP3 is GPS, an STK ephemeris counts seconds from its own ScenarioEpoch, a
 * CCSDS OEM names TIME_SYSTEM outright), and converting between them needs a
 * leap-second table that `foundation/time` already owns and measures. A second
 * copy of that table living here is exactly the drift this stack keeps paying
 * for, so a Series carries epochs in the scale its container declared plus the
 * NAME of that scale, and a caller that needs another scale routes through the
 * time module. Round-tripping a container therefore never touches a leap
 * second, which is also why the round-trip tolerances below are honest.
 *
 * UNITS: kilometres and kilometres/second throughout, because that is what
 * $OEM's IDL fixes (schema/OEM/main.fbs, EPHEMERIS_DATA in km / km*s^-1). A
 * container that speaks metres (an STK file declaring `DistanceUnit Meters`)
 * is normalised on the way in, never on the way out of the spine.
 *
 * NaN IS NEVER A VALUE HERE. A container that cannot produce a number produces
 * a refusal with a code. Two WASM runtimes may hold different bit patterns for
 * "a NaN", so a NaN that escapes into a series is a value that compares unequal
 * to itself across lanes — a byte-parity failure on a semantically empty cell.
 */

#ifndef ORBIT_PRODUCTS_EPHEMERIS_SERIES_HPP
#define ORBIT_PRODUCTS_EPHEMERIS_SERIES_HPP

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace ephem {

/* ------------------------------------------------------------------------ */
/* Result codes                                                              */
/* ------------------------------------------------------------------------ */

/*
 * Every failure gets its OWN code. A reader that returns one generic error for
 * everything cannot tell a truncated file from an unsupported segment type, so
 * the caller cannot decide whether to retry, skip or refuse. Values are stable:
 * they cross the module boundary in error payloads.
 */
enum class Status : int32_t {
    Ok = 0,
    Truncated = -1,          /* the container ends inside a record it declared */
    BadMagic = -2,           /* leading bytes are not this container           */
    UnsupportedVariant = -3, /* a real member of the format we do not evaluate */
    Malformed = -4,          /* structurally invalid beyond truncation         */
    OutOfRange = -5,         /* epoch outside every segment/record             */
    NotEnoughStates = -6,    /* fewer states than the interpolation needs      */
    Unsupported = -7,        /* the operation is not defined for this series   */
};

inline const char* status_name(Status s) {
    switch (s) {
        case Status::Ok: return "ok";
        case Status::Truncated: return "truncated";
        case Status::BadMagic: return "bad-magic";
        case Status::UnsupportedVariant: return "unsupported-variant";
        case Status::Malformed: return "malformed";
        case Status::OutOfRange: return "out-of-range";
        case Status::NotEnoughStates: return "not-enough-states";
        case Status::Unsupported: return "unsupported";
    }
    return "unknown";
}

/* ------------------------------------------------------------------------ */
/* Interpolation                                                             */
/* ------------------------------------------------------------------------ */

/*
 * The rule the CONTAINER declared, not a rule we picked. An SPK segment type
 * fixes it (8 and 9 are Lagrange, 13 is Hermite), an OEM says INTERPOLATION
 * outright, an STK ephemeris says InterpolationMethod. A reader that
 * substitutes its own rule is not reading the file, it is fitting one — which
 * is why this is carried on the series rather than chosen at evaluation time.
 */
enum class Interp : uint8_t {
    Unknown = 0,
    Linear = 1,
    Lagrange = 2,
    Hermite = 3,
    Chebyshev = 4,
};

inline const char* interp_name(Interp i) {
    switch (i) {
        case Interp::Linear: return "Linear";
        case Interp::Lagrange: return "Lagrange";
        case Interp::Hermite: return "Hermite";
        case Interp::Chebyshev: return "Chebyshev";
        case Interp::Unknown: break;
    }
    return "Unknown";
}

/* ------------------------------------------------------------------------ */
/* A state row                                                               */
/* ------------------------------------------------------------------------ */

struct StateRow {
    /* Epoch in the series' declared time scale. Seconds; the zero point is
     * Series::epoch_zero_iso when that is set, otherwise the container's own
     * (SPK: seconds past the J2000 epoch on the TDB scale). */
    double epoch = 0.0;
    double pos[3] = {0.0, 0.0, 0.0}; /* km */
    double vel[3] = {0.0, 0.0, 0.0}; /* km/s */
    double acc[3] = {0.0, 0.0, 0.0}; /* km/s^2 */
    bool has_vel = false;
    bool has_acc = false;

    /* Clock bias / drift, carried because SP3 has columns for them and
     * dropping a column on the way in is a silent lossy read. `has_clock`
     * distinguishes "absent" from "zero"; SP3's own absent sentinel is
     * translated here rather than propagated as a magic number. */
    double clock_bias = 0.0;  /* microseconds  */
    double clock_rate = 0.0;  /* 1e-4 us/s (SP3 native) */
    bool has_clock = false;
};

/* ------------------------------------------------------------------------ */
/* The series                                                                */
/* ------------------------------------------------------------------------ */

struct Series {
    /* Identity, verbatim from the container. Empty means the container did not
     * say — never a substituted default, because a guessed centre or frame is
     * indistinguishable downstream from a declared one. */
    std::string object_name;
    std::string object_id;
    std::string center_name;
    std::string frame_name;
    std::string time_system;

    /* ISO-8601 zero point for `StateRow::epoch`, when the container carries one
     * (STK's ScenarioEpoch, an OEM's START_TIME). Empty for containers whose
     * epochs are already absolute in their own scale (SPK). */
    std::string epoch_zero_iso;

    /* The zero point expressed as seconds past the J2000 epoch ON THE
     * CONTAINER'S OWN SCALE, so a caller holding a Julian date can reach this
     * series' epoch axis without a leap-second table:
     *
     *     row_epoch = (julian_date - 2451545.0) * 86400 - epoch_zero_offset_sec
     *
     * Zero for containers whose rows are already absolute on that axis (SPK
     * stores ET seconds past J2000 directly). Computed once at load rather
     * than per sample, because a propagator evaluates this on every frame. */
    double epoch_zero_offset_sec = 0.0;

    Interp interp = Interp::Unknown;
    int interp_degree = 0;

    /* NAIF integer codes, present only when the container carries them. Zero is
     * a legal NAIF id (the solar-system barycentre), so presence is a flag. */
    int32_t naif_target = 0;
    int32_t naif_center = 0;
    bool has_naif_ids = false;

    std::vector<StateRow> rows;

    bool uniform_step(double* step_out, double tol = 1e-9) const {
        if (rows.size() < 2) return false;
        const double step = rows[1].epoch - rows[0].epoch;
        if (!(step > 0.0)) return false;
        for (size_t i = 2; i < rows.size(); ++i) {
            const double d = rows[i].epoch - rows[i - 1].epoch;
            const double diff = d > step ? d - step : step - d;
            if (diff > tol * (step > 1.0 ? step : 1.0)) return false;
        }
        if (step_out) *step_out = step;
        return true;
    }

    bool all_have_velocity() const {
        for (const StateRow& r : rows) {
            if (!r.has_vel) return false;
        }
        return !rows.empty();
    }
};

/* ------------------------------------------------------------------------ */
/* Containers                                                                */
/* ------------------------------------------------------------------------ */

/*
 * The container discriminator, value-identical to `OrbProEphemerisFormat` in
 * the module SDK's generated propagator ABI header. It is restated here rather
 * than included because this header is also compiled natively, outside any
 * WASM toolchain, by the acceptance tests — and `containers.hpp` carries a
 * static assertion tying the two together wherever the ABI header IS present,
 * so the restatement cannot drift silently.
 */
enum class Format : uint32_t {
    Auto = 0,
    CcsdsOemKvn = 1,
    SpkDaf = 2,
    Code500 = 3,
    StkEphemeris = 4,
    Sp3d = 5,
};

/* ------------------------------------------------------------------------ */
/* Interpolation kernels                                                     */
/* ------------------------------------------------------------------------ */

/*
 * ACCUMULATION ORDER IS FIXED AND DELIBERATE. No reassociation, no fast-math,
 * no Horner rewrite that "should be the same": the last ULP is allowed to move
 * between browser, native WasmEdge and Docker WasmEdge only if it moves for a
 * reason we chose. Byte-identical tri-runtime output is an owned property of
 * this stack, and floating-point reassociation is the cheapest way to lose it.
 *
 * These are the same two families BatchInterpolator already implements
 * (Linear / Hermite / Lagrange). They live here because a WASM module cannot
 * call into the engine's interpolator, NOT because the engine's is wrong — and
 * the acceptance measures them against each other rather than trusting that.
 */

/* Largest window this evaluator will assemble. NAIF's MAXDEG is 27 for SPK
 * types 8, 9 and 13 (spkw08/09/13), so 32 covers every legal segment with room
 * to spare. Anything past it is REFUSED rather than silently truncated,
 * because a quietly-lowered degree is a wrong answer that looks right. */
static constexpr size_t kMaxWindow = 32;

/* Index of the first element of an n-wide window centred on `t`, clamped into
 * the array. Bisection, not a linear scan: a Code-500 file is millions of rows
 * and a per-sample linear scan turns an O(1) lookup into the module's whole
 * runtime cost. */
inline size_t window_start(const std::vector<StateRow>& rows, double t, size_t n) {
    if (rows.size() <= n) return 0;
    size_t lo = 0, hi = rows.size() - 1;
    while (hi - lo > 1) {
        const size_t mid = lo + (hi - lo) / 2;
        if (rows[mid].epoch <= t) lo = mid; else hi = mid;
    }
    /* Centre the window on the bracketing interval. */
    const size_t half = n / 2;
    size_t start = lo >= half ? lo - half + 1 : 0;
    if (start + n > rows.size()) start = rows.size() - n;
    return start;
}

/*
 * Lagrange interpolation of an arbitrary component over a window. `stride`
 * selects pos/vel/acc and `comp` the axis, so one kernel serves every column
 * and there is no per-column copy of the arithmetic to drift.
 */
inline double lagrange_at(const StateRow* w, size_t n, double t,
                          double (*get)(const StateRow&, int), int comp) {
    double sum = 0.0;
    for (size_t j = 0; j < n; ++j) {
        double term = get(w[j], comp);
        for (size_t k = 0; k < n; ++k) {
            if (k == j) continue;
            term *= (t - w[k].epoch) / (w[j].epoch - w[k].epoch);
        }
        sum += term;
    }
    return sum;
}

/*
 * Hermite interpolation using values AND derivatives on the same nodes, by
 * divided differences over the doubled node list — the classic construction,
 * chosen because it is the one SPK type 13 and type 12 are defined by, so a
 * type-13 read is evaluating the segment's own rule rather than a lookalike.
 */
inline double hermite_at(const StateRow* w, size_t n, double t,
                         double (*get)(const StateRow&, int),
                         double (*getd)(const StateRow&, int), int comp) {
    const size_t m = 2 * n;
    double z[2 * kMaxWindow];
    double q[2 * kMaxWindow];
    for (size_t i = 0; i < n; ++i) {
        z[2 * i] = w[i].epoch;
        z[2 * i + 1] = w[i].epoch;
        q[2 * i] = get(w[i], comp);
        q[2 * i + 1] = get(w[i], comp);
    }
    /* First divided differences: the derivative on a repeated node. */
    double prev[2 * kMaxWindow];
    for (size_t i = 0; i < m; ++i) prev[i] = q[i];
    double coeff[2 * kMaxWindow];
    coeff[0] = prev[0];
    double cur[2 * kMaxWindow];
    for (size_t order = 1; order < m; ++order) {
        for (size_t i = 0; i + order < m; ++i) {
            const double dz = z[i + order] - z[i];
            if (dz == 0.0) {
                /* Repeated node: the divided difference IS the derivative. */
                cur[i] = getd(w[i / 2], comp);
            } else {
                cur[i] = (prev[i + 1] - prev[i]) / dz;
            }
        }
        coeff[order] = cur[0];
        for (size_t i = 0; i + order < m; ++i) prev[i] = cur[i];
    }
    /* Newton form, evaluated in declared order. */
    double result = coeff[m - 1];
    for (size_t i = m - 1; i-- > 0;) {
        result = result * (t - z[i]) + coeff[i];
    }
    return result;
}

inline double row_pos(const StateRow& r, int c) { return r.pos[c]; }
inline double row_vel(const StateRow& r, int c) { return r.vel[c]; }
inline double row_acc(const StateRow& r, int c) { return r.acc[c]; }

/*
 * Evaluate a series at `t`, by the rule the series declares.
 *
 * `degree` overrides the series' own degree when > 0. That override exists for
 * exactly one legitimate caller — the acceptance that asserts Hermite and
 * Lagrange error ORDERING on a known-analytic arc — and not so a consumer can
 * quietly re-fit somebody's ephemeris.
 */
inline Status evaluate(const Series& s, double t, StateRow* out, int degree = 0) {
    if (!out) return Status::Malformed;
    if (s.rows.empty()) return Status::NotEnoughStates;
    if (t < s.rows.front().epoch || t > s.rows.back().epoch) return Status::OutOfRange;

    *out = StateRow{};
    out->epoch = t;

    Interp rule = s.interp;
    int deg = degree > 0 ? degree : s.interp_degree;

    /* A series of one is a constant; a series of two under an unnamed rule is
     * linear. Neither is an error and neither is silently upgraded. */
    if (s.rows.size() == 1) {
        *out = s.rows[0];
        out->epoch = t;
        return Status::Ok;
    }
    if (rule == Interp::Unknown) rule = s.all_have_velocity() ? Interp::Hermite : Interp::Lagrange;
    if (deg <= 0) deg = rule == Interp::Linear ? 1 : 7;

    size_t n = static_cast<size_t>(deg) + 1;
    if (rule == Interp::Hermite) {
        /* A Hermite window of n nodes reaches polynomial degree 2n-1, so the
         * node count for a requested degree is half what Lagrange needs. */
        n = static_cast<size_t>(deg + 1) / 2;
        if (n < 2) n = 2;
    }
    if (n > kMaxWindow) return Status::UnsupportedVariant;
    if (n > s.rows.size()) n = s.rows.size();
    if (n < 2) return Status::NotEnoughStates;

    const size_t start = window_start(s.rows, t, n);
    const StateRow* w = &s.rows[start];

    if (rule == Interp::Linear) {
        const size_t i = window_start(s.rows, t, 2);
        const StateRow& a = s.rows[i];
        const StateRow& b = s.rows[i + 1];
        const double span = b.epoch - a.epoch;
        const double f = span == 0.0 ? 0.0 : (t - a.epoch) / span;
        for (int c = 0; c < 3; ++c) {
            out->pos[c] = a.pos[c] + (b.pos[c] - a.pos[c]) * f;
            out->vel[c] = a.vel[c] + (b.vel[c] - a.vel[c]) * f;
        }
        out->has_vel = a.has_vel && b.has_vel;
        return Status::Ok;
    }

    if (rule == Interp::Hermite) {
        if (!s.all_have_velocity()) return Status::Unsupported;
        for (int c = 0; c < 3; ++c) {
            out->pos[c] = hermite_at(w, n, t, row_pos, row_vel, c);
            /* Velocity from the SAME construction on (velocity, acceleration)
             * when the container carries acceleration; otherwise Lagrange on the
             * velocity column. Differentiating the position polynomial instead
             * would answer a question the file did not ask. */
            out->vel[c] = w[0].has_acc ? hermite_at(w, n, t, row_vel, row_acc, c)
                                       : lagrange_at(w, n, t, row_vel, c);
        }
        out->has_vel = true;
        return Status::Ok;
    }

    for (int c = 0; c < 3; ++c) {
        out->pos[c] = lagrange_at(w, n, t, row_pos, c);
        out->vel[c] = lagrange_at(w, n, t, row_vel, c);
    }
    out->has_vel = s.all_have_velocity();
    return Status::Ok;
}

/* ------------------------------------------------------------------------ */
/* Byte helpers                                                              */
/* ------------------------------------------------------------------------ */

/*
 * Endianness through memcpy on an integer, NEVER a union or a pointer cast.
 * Type-punning a double through a union is undefined behaviour that clang has
 * been observed to fold differently at -O2 — a divergence that shows up as a
 * wrong number in one runtime and in no diff at all.
 */
inline uint64_t bswap64(uint64_t v) {
    return ((v & 0x00000000000000FFull) << 56) | ((v & 0x000000000000FF00ull) << 40) |
           ((v & 0x0000000000FF0000ull) << 24) | ((v & 0x00000000FF000000ull) << 8) |
           ((v & 0x000000FF00000000ull) >> 8) | ((v & 0x0000FF0000000000ull) >> 24) |
           ((v & 0x00FF000000000000ull) >> 40) | ((v & 0xFF00000000000000ull) >> 56);
}

inline uint32_t bswap32(uint32_t v) {
    return ((v & 0x000000FFu) << 24) | ((v & 0x0000FF00u) << 8) | ((v & 0x00FF0000u) >> 8) |
           ((v & 0xFF000000u) >> 24);
}

inline double read_f64(const uint8_t* p, bool big_endian) {
    uint64_t bits;
    std::memcpy(&bits, p, 8);
    if (big_endian) bits = bswap64(bits);
    double out;
    std::memcpy(&out, &bits, 8);
    return out;
}

inline int32_t read_i32(const uint8_t* p, bool big_endian) {
    uint32_t bits;
    std::memcpy(&bits, p, 4);
    if (big_endian) bits = bswap32(bits);
    int32_t out;
    std::memcpy(&out, &bits, 4);
    return out;
}

inline void write_f64(uint8_t* p, double v, bool big_endian) {
    uint64_t bits;
    std::memcpy(&bits, &v, 8);
    if (big_endian) bits = bswap64(bits);
    std::memcpy(p, &bits, 8);
}

inline void write_i32(uint8_t* p, int32_t v, bool big_endian) {
    uint32_t bits;
    std::memcpy(&bits, &v, 4);
    if (big_endian) bits = bswap32(bits);
    std::memcpy(p, &bits, 4);
}

/* A finite check that does not depend on <cmath> classification macros
 * behaving identically across the three toolchain configurations. */
inline bool is_finite(double v) {
    uint64_t bits;
    std::memcpy(&bits, &v, 8);
    return (bits & 0x7FF0000000000000ull) != 0x7FF0000000000000ull;
}

inline bool row_is_finite(const StateRow& r) {
    if (!is_finite(r.epoch)) return false;
    for (int c = 0; c < 3; ++c) {
        if (!is_finite(r.pos[c]) || !is_finite(r.vel[c]) || !is_finite(r.acc[c])) return false;
    }
    return true;
}

}  // namespace ephem

#endif  // ORBIT_PRODUCTS_EPHEMERIS_SERIES_HPP
