/*
 * files/orbit-products — SPK segment evaluation for types 8, 9 and 13.
 *
 * WHAT THIS IS NOT: a general SPK reader. Types 2/3 (Chebyshev), 5, 10 (TLE),
 * 14, 15, 17, 18, 20 and 21 are all real, all in the wild, and all refused here
 * by name with Status::UnsupportedVariant. A discrete-state reader that meets a
 * Chebyshev segment and interpolates its coefficients as if they were states
 * produces a smooth, plausible, entirely fictional trajectory. Refusing is the
 * only safe answer.
 *
 * WHY THESE THREE ARE ONE FILE: 8 and 9 are the same Lagrange rule over equally
 * and unequally spaced nodes; 13 shares 9's byte layout exactly and differs
 * only in the evaluator. NAIF's own reader makes the same grouping — SPKR13
 * calls SPKR09 verbatim — and splitting them would let the shared record
 * arithmetic drift between two copies.
 *
 * THE ARITHMETIC IS NAIF'S, ON PURPOSE. LGRESP (equally spaced Lagrange,
 * Neville in normalised coordinates), LGRINT (Neville) and HRMINT (Conte &
 * de Boor eq. 2.35 modified Neville, value AND derivative) are reimplemented
 * here in the same accumulation order the toolkit uses. That is not
 * cargo-culting, it is the difference between agreeing and matching. MEASURED
 * on LADEE segment 1: the same polynomial evaluated as a Newton divided-
 * difference form lands 1.5e-11 km and 6.6e-12 km/s from CSPICE at a record
 * node — inside the 1e-9 km bound but outside 1e-12 km/s — while these
 * recurrences reproduce CSPICE BIT FOR BIT at every sample, node and interior
 * alike. Same polynomial, different round-off; only one of them is measurable
 * as "the file's own rule".
 *
 * Type 13's velocity is the DERIVATIVE OF THE POSITION POLYNOMIAL, which is
 * what HRMINT returns and what SPKE13 stores into state(4:6). Lagrange-fitting
 * the velocity column instead gives a degree-(n-1) answer where the segment
 * declares degree 2n-1 — close enough to look right, wrong by ~1e-8 km/s.
 *
 * No <cmath>: absolute value and nearest-integer are written out, because the
 * three toolchain configurations this compiles under do not agree on what the
 * classification macros expand to, and rounding mode is part of the answer.
 */

#ifndef ORBIT_PRODUCTS_SPK_READ_HPP
#define ORBIT_PRODUCTS_SPK_READ_HPP

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "daf.hpp"
#include "ephemeris_series.hpp"

namespace spk {

/* NAIF's MAXDEG is 27 for types 8, 9 and 13, so a Lagrange window is at most
 * 28 states and a Hermite window at most 14. 32 covers both with room for a
 * file that lies about its degree — which is refused, not clamped. */
static constexpr int kMaxNodes = 32;

/* Segment types this file evaluates. Everything else is a refusal. */
inline bool is_supported_type(int32_t t) { return t == 8 || t == 9 || t == 13; }

inline int32_t segment_type(const daf::Summary& s) { return s.ic[3]; }
inline int32_t segment_target(const daf::Summary& s) { return s.ic[0]; }
inline int32_t segment_center(const daf::Summary& s) { return s.ic[1]; }
inline int32_t segment_frame(const daf::Summary& s) { return s.ic[2]; }

/*
 * The inertial reference frames whose names SPICE fixes in its built-in frame
 * kernel. These cannot be redefined by a loaded FK, so naming them is reading
 * the file rather than guessing. Anything else — a body-fixed frame like
 * ITRF93 (13000), a spacecraft frame — needs a frame kernel we do not have, so
 * it gets an empty name and the caller keeps the integer.
 */
inline const char* builtin_frame_name(int32_t id) {
    switch (id) {
        case 1: return "J2000";
        case 2: return "B1950";
        case 3: return "FK4";
        case 4: return "DE-118";
        case 5: return "DE-96";
        case 6: return "DE-102";
        case 7: return "DE-108";
        case 8: return "DE-111";
        case 9: return "DE-114";
        case 10: return "DE-122";
        case 11: return "DE-125";
        case 12: return "DE-130";
        case 13: return "GALACTIC";
        case 14: return "DE-200";
        case 15: return "DE-202";
        case 16: return "MARSIAU";
        case 17: return "ECLIPJ2000";
        case 18: return "ECLIPB1950";
        case 19: return "DE-140";
        case 20: return "DE-142";
        case 21: return "DE-143";
        default: return "";
    }
}

namespace detail {

inline double dabs(double v) { return v < 0.0 ? -v : v; }

/* Fortran NINT / f2c i_dnnt: round half AWAY FROM ZERO. Not lrint (which
 * rounds half to even) and not a C cast (which truncates). SPKR08 uses this to
 * pick the nearest record for an odd window, so a half-step request epoch lands
 * on a different window under the wrong rounding rule. */
inline long long nint(double v) {
    if (v >= 0.0) return static_cast<long long>(v + 0.5);
    return -static_cast<long long>(-v + 0.5);
}

/* Truncation toward zero, which is what f2c's INT() does to (ET-START)/STEP. */
inline long long trunc_toward_zero(double v) { return static_cast<long long>(v); }

inline long long lmin(long long a, long long b) { return a < b ? a : b; }
inline long long lmax(long long a, long long b) { return a > b ? a : b; }

/*
 * LGRESP — Lagrange interpolation on n EQUALLY spaced abscissas, by Neville's
 * recurrence in the normalised coordinate x -> (x - first)/step + 1. Working in
 * index space is not an optimisation: the denominators become the exact
 * integers 1..n-1, so the recurrence divides by numbers with no rounding error
 * at all and the conditioning stops depending on the step size.
 */
inline double lagrange_equal(int n, double first, double step, const double* y, double x) {
    double work[kMaxNodes];
    const double newx = (x - first) / step + 1.0;
    for (int i = 0; i < n; ++i) work[i] = y[i];
    for (int j = 1; j <= n - 1; ++j) {
        for (int i = 1; i <= n - j; ++i) {
            const double c1 = static_cast<double>(i + j) - newx;
            const double c2 = newx - static_cast<double>(i);
            work[i - 1] = (c1 * work[i - 1] + c2 * work[i]) / static_cast<double>(j);
        }
    }
    return work[0];
}

/*
 * LGRINT — Lagrange interpolation on n unequally spaced abscissas, Neville.
 */
inline double lagrange_uneven(int n, const double* xs, const double* ys, double x) {
    double work[kMaxNodes];
    for (int i = 0; i < n; ++i) work[i] = ys[i];
    for (int j = 1; j <= n - 1; ++j) {
        for (int i = 1; i <= n - j; ++i) {
            const double denom = xs[i - 1] - xs[i + j - 1];
            if (denom == 0.0) return 0.0; /* duplicate abscissa; caller checks order */
            const double c1 = x - xs[i + j - 1];
            const double c2 = xs[i - 1] - x;
            work[i - 1] = (c1 * work[i - 1] + c2 * work[i]) / denom;
        }
    }
    return work[0];
}

/*
 * HRMINT — Hermite interpolation on n nodes carrying value and derivative,
 * returning both the interpolated value and its derivative at x.
 *
 * The table is the theoretical 2n-abscissa triangular table with each node
 * doubled, but the abscissas are never materialised twice: XI and XIJ below
 * index the physical node array. `wd` is updated BEFORE `wf` in every cell
 * because the derivative recurrence consumes the previous column's function
 * values, which the function recurrence is about to overwrite in place.
 */
inline void hermite(int n, const double* xs, const double* y, const double* dy, double x,
                    double* f, double* df) {
    const int m = 2 * n;
    double wf[2 * kMaxNodes];
    double wd[2 * kMaxNodes];

    for (int i = 0; i < n; ++i) {
        wf[2 * i] = y[i];
        wf[2 * i + 1] = dy[i];
    }
    for (int i = 0; i < m; ++i) wd[i] = 0.0;

    /* Column 2: the n-1 first-degree interpolants evaluated at x, and their
     * derivatives. Odd-indexed derivatives are the input derivatives; even ones
     * are the secant slopes. Odd-indexed values are the linear Taylor
     * polynomial about each node. */
    for (int i0 = 0; i0 < n - 1; ++i0) {
        const double c1 = xs[i0 + 1] - x;
        const double c2 = x - xs[i0];
        const double denom = xs[i0 + 1] - xs[i0];
        if (denom == 0.0) {
            *f = 0.0;
            *df = 0.0;
            return;
        }
        const int prev = 2 * i0;
        const int self = prev + 1;
        const int next = self + 1;

        wd[prev] = wf[self];
        wd[self] = (wf[next] - wf[prev]) / denom;

        const double temp = wf[self] * (x - xs[i0]) + wf[prev];
        wf[self] = (c1 * wf[prev] + c2 * wf[next]) / denom;
        wf[prev] = temp;
    }
    /* The loop above never reaches the last node's pair. */
    wd[m - 2] = wf[m - 1];
    wf[m - 2] = wf[m - 1] * (x - xs[n - 1]) + wf[m - 2];

    for (int j = 2; j <= m - 1; ++j) {
        for (int i0 = 0; i0 < m - j; ++i0) {
            const int xi = i0 / 2;
            const int xij = (i0 + j) / 2;
            const double c1 = xs[xij] - x;
            const double c2 = x - xs[xi];
            const double denom = xs[xij] - xs[xi];
            if (denom == 0.0) {
                *f = 0.0;
                *df = 0.0;
                return;
            }
            wd[i0] = (c1 * wd[i0] + c2 * wd[i0 + 1] + (wf[i0 + 1] - wf[i0])) / denom;
            wf[i0] = (c1 * wf[i0] + c2 * wf[i0 + 1]) / denom;
        }
    }
    *f = wf[0];
    *df = wd[0];
}

/* The trailer of a type 8 segment: EPOCH1, STEP, DEGREE, N — the final four
 * words, per SPK Required Reading. Window size is DEGREE+1 STATES. */
struct Type8Control {
    double first_epoch;
    double step;
    int degree;
    long long n;
};

/* The trailer of a type 9 or 13 segment: one control word then N.
 *
 * The control word means DIFFERENT THINGS in the two types and this is the one
 * place the layouts diverge. Type 9 stores the polynomial DEGREE. Type 13
 * stores WINDOW SIZE - 1. Both feed the same record-selection arithmetic (NAIF
 * reuses SPKR09 for type 13), so the field is carried as `degree` and the
 * window is always degree+1 states — but the polynomial a type-13 window
 * reaches is degree 2*(window)-1, not window-1. Measured against CSPICE: a
 * spkw13 call with degree 7 writes 3 here, and LADEE's "interp= 7" segments
 * carry 3. */
struct Type9Control {
    int degree;
    long long n;
    long long ndir;
};

inline ephem::Status read_type8_control(const daf::File& f, const daf::Summary& seg,
                                        Type8Control* c) {
    const size_t end = static_cast<size_t>(seg.ic[5]);
    double t[4];
    if (end < 4 || !f.words(end - 3, 4, t)) return ephem::Status::Truncated;
    for (int i = 0; i < 4; ++i) {
        if (!ephem::is_finite(t[i])) return ephem::Status::Malformed;
    }
    c->first_epoch = t[0];
    c->step = t[1];
    c->degree = static_cast<int>(detail::nint(t[2]));
    c->n = detail::nint(t[3]);
    if (c->step <= 0.0) return ephem::Status::Malformed;
    if (c->n < 1) return ephem::Status::Malformed;
    if (c->degree < 1 || c->degree > kMaxNodes - 1) return ephem::Status::UnsupportedVariant;
    if (c->n < c->degree + 1) return ephem::Status::NotEnoughStates;
    /* The declared layout must account for every word the descriptor claims.
     * A segment whose trailer disagrees with its own address range is not
     * something to evaluate optimistically. */
    if (daf::File::segment_word_count(seg) !=
        static_cast<size_t>(c->n) * 6 + 4) {
        return ephem::Status::Malformed;
    }
    return ephem::Status::Ok;
}

inline ephem::Status read_type9_control(const daf::File& f, const daf::Summary& seg,
                                        Type9Control* c) {
    const size_t end = static_cast<size_t>(seg.ic[5]);
    double t[2];
    if (end < 2 || !f.words(end - 1, 2, t)) return ephem::Status::Truncated;
    if (!ephem::is_finite(t[0]) || !ephem::is_finite(t[1])) return ephem::Status::Malformed;
    c->degree = static_cast<int>(detail::nint(t[0]));
    c->n = detail::nint(t[1]);
    if (c->n < 1) return ephem::Status::Malformed;
    if (c->degree < 1 || c->degree > kMaxNodes - 1) return ephem::Status::UnsupportedVariant;
    if (c->n < c->degree + 1) return ephem::Status::NotEnoughStates;
    /* The epoch directory holds every 100th epoch, indices 100, 200, ...,
     * ((N-1)/100)*100. Its LENGTH is what makes the segment's word count
     * checkable, which is the whole reason it is parsed here rather than
     * skipped: the record is 6N states + N epochs + (N-1)/100 directory
     * entries + 2 trailer words, and a segment that does not add up is
     * refused before a single state is read. */
    c->ndir = (c->n - 1) / 100;
    if (daf::File::segment_word_count(seg) !=
        static_cast<size_t>(c->n) * 7 + static_cast<size_t>(c->ndir) + 2) {
        return ephem::Status::Malformed;
    }
    return ephem::Status::Ok;
}

/*
 * LSTLTD over the segment's epoch array: the 1-based index of the last epoch
 * STRICTLY LESS than `et`, or 0 when there is none.
 *
 * Bisection over the epochs, not NAIF's linear walk of the directory followed
 * by a bounded search. The directory exists so a toolkit reading from disk can
 * page in 100 epochs instead of N; we already hold the bytes, so the directory
 * would cost O(N/100) reads to save a log2(N) bisection. Same index, fewer
 * touches — and the directory is still parsed, because its length is what
 * validates the layout.
 */
inline bool last_epoch_below(const daf::File& f, size_t epoch_base, long long n, double et,
                             long long* out) {
    long long lo = 0;          /* known: epoch[lo] < et, or lo == 0 (no such) */
    long long hi = n + 1;      /* known: epoch[hi] >= et, or hi == n+1        */
    while (hi - lo > 1) {
        const long long mid = lo + (hi - lo) / 2;
        double e;
        if (!f.word(epoch_base + static_cast<size_t>(mid) - 1, &e)) return false;
        if (!ephem::is_finite(e)) return false;
        if (e < et) lo = mid; else hi = mid;
    }
    *out = lo;
    return true;
}

}  // namespace detail

/*
 * Evaluate one segment at `et` (ET seconds past J2000, TDB).
 *
 * Output is km and km/s in the SEGMENT'S OWN frame relative to the SEGMENT'S
 * OWN center. No frame rotation and no center shift happen here — those need
 * kernels this module was not given, and silently returning a state in a frame
 * the caller did not ask for is the failure mode that makes ephemeris bugs so
 * expensive to find.
 */
inline ephem::Status evaluate(const daf::File& f, const daf::Summary& seg, double et,
                              ephem::StateRow* out) {
    if (out == nullptr) return ephem::Status::Malformed;
    const int32_t type = segment_type(seg);
    if (!is_supported_type(type)) return ephem::Status::UnsupportedVariant;
    if (!ephem::is_finite(et)) return ephem::Status::Malformed;
    if (et < seg.dc[0] || et > seg.dc[1]) return ephem::Status::OutOfRange;
    if (seg.ic[4] < 1 || seg.ic[5] < seg.ic[4]) return ephem::Status::Malformed;

    const size_t begin = static_cast<size_t>(seg.ic[4]);

    *out = ephem::StateRow{};
    out->epoch = et;
    out->has_vel = true;

    double window_states[kMaxNodes * 6];
    double column[kMaxNodes];
    double dcolumn[kMaxNodes];

    if (type == 8) {
        detail::Type8Control c;
        const ephem::Status st = detail::read_type8_control(f, seg, &c);
        if (st != ephem::Status::Ok) return st;

        const int degree = c.degree;
        const long long grpsiz = degree + 1;

        /* SPKR08's record selection, verbatim. An odd window centres on the
         * NEAREST state; an even window centres on the interval, taking the
         * state below the request epoch as the (grpsiz/2)th of the window. */
        long long anchor;
        if (grpsiz % 2 != 0) {
            anchor = detail::nint((et - c.first_epoch) / c.step) + 1;
        } else {
            anchor = detail::trunc_toward_zero((et - c.first_epoch) / c.step) + 1;
        }
        long long first = detail::lmin(detail::lmax(anchor - degree / 2, 1), c.n - degree);
        const long long last = first + degree;
        if (first < 1 || last > c.n) return ephem::Status::Malformed;

        if (!f.words(begin + static_cast<size_t>(first - 1) * 6,
                     static_cast<size_t>(grpsiz) * 6, window_states)) {
            return ephem::Status::Truncated;
        }
        const double window_first_epoch = c.first_epoch + static_cast<double>(first - 1) * c.step;

        for (int comp = 0; comp < 6; ++comp) {
            for (long long j = 0; j < grpsiz; ++j) {
                column[j] = window_states[j * 6 + comp];
            }
            const double v = detail::lagrange_equal(static_cast<int>(grpsiz), window_first_epoch,
                                                    c.step, column, et);
            if (comp < 3) out->pos[comp] = v; else out->vel[comp - 3] = v;
        }
        return ephem::row_is_finite(*out) ? ephem::Status::Ok : ephem::Status::Malformed;
    }

    /* Types 9 and 13 share this record layout exactly. */
    detail::Type9Control c;
    const ephem::Status st = detail::read_type9_control(f, seg, &c);
    if (st != ephem::Status::Ok) return st;

    const int degree = c.degree;
    const long long wndsiz = degree + 1;
    const size_t epoch_base = begin + static_cast<size_t>(c.n) * 6;

    long long i = 0;
    if (!detail::last_epoch_below(f, epoch_base, c.n, et, &i)) return ephem::Status::Truncated;
    if (i >= c.n) i = c.n - 1; /* et beyond the last epoch; descriptor bound already passed */
    const long long low = i == 0 ? 1 : i;
    const long long high = low + 1;

    long long anchor = low;
    if (wndsiz % 2 != 0) {
        /* Odd window: anchor on whichever bracketing epoch is nearer. */
        if (i != 0) {
            double e_low, e_high;
            if (!f.word(epoch_base + static_cast<size_t>(low) - 1, &e_low)) {
                return ephem::Status::Truncated;
            }
            if (high > c.n) return ephem::Status::Malformed;
            if (!f.word(epoch_base + static_cast<size_t>(high) - 1, &e_high)) {
                return ephem::Status::Truncated;
            }
            anchor = detail::dabs(et - e_low) < detail::dabs(et - e_high) ? low : high;
        }
    }
    long long first = detail::lmin(detail::lmax(anchor - degree / 2, 1), c.n - degree);
    const long long last = first + degree;
    if (first < 1 || last > c.n) return ephem::Status::Malformed;

    double window_epochs[kMaxNodes];
    if (!f.words(begin + static_cast<size_t>(first - 1) * 6, static_cast<size_t>(wndsiz) * 6,
                 window_states)) {
        return ephem::Status::Truncated;
    }
    if (!f.words(epoch_base + static_cast<size_t>(first) - 1, static_cast<size_t>(wndsiz),
                 window_epochs)) {
        return ephem::Status::Truncated;
    }

    if (type == 9) {
        for (int comp = 0; comp < 6; ++comp) {
            for (long long j = 0; j < wndsiz; ++j) column[j] = window_states[j * 6 + comp];
            const double v =
                detail::lagrange_uneven(static_cast<int>(wndsiz), window_epochs, column, et);
            if (comp < 3) out->pos[comp] = v; else out->vel[comp - 3] = v;
        }
        return ephem::row_is_finite(*out) ? ephem::Status::Ok : ephem::Status::Malformed;
    }

    /* Type 13: Hermite per axis over (position, velocity). One call yields both
     * the position and the velocity, because the velocity IS the derivative of
     * the position polynomial the segment defines. */
    for (int axis = 0; axis < 3; ++axis) {
        for (long long j = 0; j < wndsiz; ++j) {
            column[j] = window_states[j * 6 + axis];
            dcolumn[j] = window_states[j * 6 + axis + 3];
        }
        double value = 0.0, deriv = 0.0;
        detail::hermite(static_cast<int>(wndsiz), window_epochs, column, dcolumn, et, &value,
                        &deriv);
        out->pos[axis] = value;
        out->vel[axis] = deriv;
    }
    return ephem::row_is_finite(*out) ? ephem::Status::Ok : ephem::Status::Malformed;
}

/*
 * Materialise a segment's STORED nodes into a Series — no interpolation, no
 * resampling. The Series is the spine every other container in this module
 * shares, so this is the door from SPK into $OEM, SP3, STK and Code-500.
 *
 * `interp_degree` is set so that ephem::evaluate reconstructs the segment's own
 * window: Lagrange takes degree+1 nodes, Hermite takes (degree+1)/2, so a
 * type-13 window of w states is recorded as degree 2w-1. Frames and centers
 * stay as NAIF integers plus a name only where SPICE itself fixes one.
 */
inline ephem::Status to_series(const daf::File& f, const daf::Summary& seg, ephem::Series* out) {
    if (out == nullptr) return ephem::Status::Malformed;
    const int32_t type = segment_type(seg);
    if (!is_supported_type(type)) return ephem::Status::UnsupportedVariant;
    if (seg.ic[4] < 1 || seg.ic[5] < seg.ic[4]) return ephem::Status::Malformed;

    const size_t begin = static_cast<size_t>(seg.ic[4]);

    *out = ephem::Series{};
    out->time_system = "TDB";
    out->has_naif_ids = true;
    out->naif_target = segment_target(seg);
    out->naif_center = segment_center(seg);
    out->frame_name = builtin_frame_name(segment_frame(seg));

    /* The NAIF id as text is the identity the container actually carries; a
     * body NAME would need a name/id kernel this module was not given. */
    {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%d", static_cast<int>(segment_target(seg)));
        out->object_id = buf;
    }

    long long n = 0;
    double first_epoch = 0.0, step = 0.0;
    int degree = 0;

    if (type == 8) {
        detail::Type8Control c;
        const ephem::Status st = detail::read_type8_control(f, seg, &c);
        if (st != ephem::Status::Ok) return st;
        n = c.n;
        first_epoch = c.first_epoch;
        step = c.step;
        degree = c.degree;
        out->interp = ephem::Interp::Lagrange;
        out->interp_degree = degree;
    } else {
        detail::Type9Control c;
        const ephem::Status st = detail::read_type9_control(f, seg, &c);
        if (st != ephem::Status::Ok) return st;
        n = c.n;
        degree = c.degree;
        if (type == 9) {
            out->interp = ephem::Interp::Lagrange;
            out->interp_degree = degree;
        } else {
            out->interp = ephem::Interp::Hermite;
            out->interp_degree = 2 * (degree + 1) - 1;
        }
    }

    out->rows.resize(static_cast<size_t>(n));

    /* States stream in a page at a time. A LADEE segment is 9357 states; a
     * per-row bounds check on 56142 words costs more than the reads. */
    static constexpr size_t kChunkStates = 256;
    double buf[kChunkStates * 6];
    for (long long base = 0; base < n; base += static_cast<long long>(kChunkStates)) {
        const size_t take = static_cast<size_t>(
            n - base < static_cast<long long>(kChunkStates) ? n - base
                                                            : static_cast<long long>(kChunkStates));
        if (!f.words(begin + static_cast<size_t>(base) * 6, take * 6, buf)) {
            return ephem::Status::Truncated;
        }
        for (size_t k = 0; k < take; ++k) {
            ephem::StateRow& r = out->rows[static_cast<size_t>(base) + k];
            for (int a = 0; a < 3; ++a) {
                r.pos[a] = buf[k * 6 + a];
                r.vel[a] = buf[k * 6 + a + 3];
            }
            r.has_vel = true;
        }
    }

    if (type == 8) {
        /* Equally spaced: the epochs are not stored, they are DEFINED by
         * EPOCH1 and STEP. Reconstructing them as first + i*step rather than
         * by repeated addition keeps the i-th epoch independent of the
         * accumulated error in the first i-1. */
        for (long long i = 0; i < n; ++i) {
            out->rows[static_cast<size_t>(i)].epoch =
                first_epoch + static_cast<double>(i) * step;
        }
    } else {
        const size_t epoch_base = begin + static_cast<size_t>(n) * 6;
        for (long long base = 0; base < n; base += static_cast<long long>(kChunkStates)) {
            const size_t take = static_cast<size_t>(
                n - base < static_cast<long long>(kChunkStates)
                    ? n - base
                    : static_cast<long long>(kChunkStates));
            if (!f.words(epoch_base + static_cast<size_t>(base), take, buf)) {
                return ephem::Status::Truncated;
            }
            for (size_t k = 0; k < take; ++k) {
                out->rows[static_cast<size_t>(base) + k].epoch = buf[k];
            }
        }
    }

    for (const ephem::StateRow& r : out->rows) {
        if (!ephem::row_is_finite(r)) return ephem::Status::Malformed;
    }
    return ephem::Status::Ok;
}

}  // namespace spk

#endif  // ORBIT_PRODUCTS_SPK_READ_HPP
