/*
 * propagator/solar-system-bodies — ephemerides, orientation and photometry of
 * the Sun, planets, moons, dwarf planets and asteroids, from NAIF kernels.
 *
 * THE ONLY SOURCE OF BODY PHYSICS FOR MULTI-BODY NAVIGATION. OrbPro's engine
 * asks this module, through a resident direct surface, where every body is,
 * how it is turned, how bright it looks and where the observer is, and draws
 * what it is told. Nothing in JavaScript computes any of it.
 *
 * KERNELS ARE CALLER BYTES. SPK (types 2 and 3, read by files/orbit-products'
 * spk_read.hpp), the lunar binary PCK (type 2) and text kernels (pck00011,
 * gm_de440, the lunar frame kernel) arrive as unmodified NAIF files, delivered
 * by CID. Nothing is embedded. An epoch outside every loaded segment is the
 * named failure `out-of-range`; there is no analytic substitute, ever.
 *
 * FRAMES AND UNITS. States are geometric (no light time, no aberration; the
 * ssb_apparent_offsets shifts add both for drawing), ICRF
 * (SPICE "J2000"), metres and metres/second. Rotations are ICRF -> body-fixed:
 * IAU_<body> from the text PCK (WGCCRE 2015, Archinal et al. 2018) and, for
 * the Moon, MOON_ME (DE440 PA angles from the binary PCK, rotated to the mean
 * Earth/polar axis frame by the frame kernel's TKFRAME_31009 angles). Earth's
 * terrestrial frame (ITRF, EOP) is the engine's and not this module's.
 *
 * TIME. Callers pass a Cesium JulianDate on the TAI scale (day number, seconds
 * of day from noon). TDB follows the SPICE leapseconds-kernel relation:
 * TDB - TAI = 32.184 s + K sin(E), E = M + EB sin M, M = M0 + M1 t
 * (K = 1.657e-3 s, EB = 1.671e-2, M0 = 6.239996, M1 = 1.99096871e-7 rad/s;
 * NAIF naif0012.tls "DELTET" block). An `et` input (TDB seconds past J2000)
 * bypasses the conversion for comparisons against CSPICE.
 */

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

/* Amalgamated ahead of this file by build.mjs:
 *   files/orbit-products/src/{ephemeris_series,daf,spk_read}.hpp
 *   foundation/frames/src/iau_body_models.hpp
 *   src/text_kernel.hpp, src/bodies.hpp, nlohmann/json.hpp, the SDK invoke glue */

#define SSB_EXPORT(name) __attribute__((export_name(name))) extern "C"

namespace ssb {

/* ------------------------------------------------------------------------ */
/* Status codes (stable: they cross the module boundary)                     */
/* ------------------------------------------------------------------------ */
enum Code : int32_t {
    Ok = 0,
    ErrOutOfRange = -5,       /* no loaded segment covers the epoch          */
    ErrUnknownBody = -8,      /* not a body this module knows                */
    ErrNoEphemeris = -9,      /* no loaded segment for this body at all      */
    ErrNoRotation = -10,      /* no rotation model for this body             */
    ErrBadKernel = -11,       /* the bytes are not a kernel this module reads */
    ErrBadArgument = -12,
    ErrChainTooLong = -13,
    ErrNoGM = -14,            /* no positive GM for the conic's center       */
};

inline const char* code_name(int32_t c) {
    switch (c) {
        case Ok: return "ok";
        case ErrOutOfRange: return "out-of-range";
        case ErrUnknownBody: return "unknown-body";
        case ErrNoEphemeris: return "no-ephemeris";
        case ErrNoRotation: return "no-rotation-model";
        case ErrBadKernel: return "bad-kernel";
        case ErrBadArgument: return "bad-argument";
        case ErrChainTooLong: return "chain-too-long";
        case ErrNoGM: return "no-gm";
        default: return "error";
    }
}

constexpr double kAu = 149597870700.0;  /* IAU 2012 Resolution B2, metres */
constexpr double kPi = 3.14159265358979323846;
constexpr double kHalfPi = 1.57079632679489661923;
constexpr double kDeg = kPi / 180.0;
constexpr double kOuterRestDistance = 1.0e14; /* m: SSB at rest beyond this */

/* ------------------------------------------------------------------------ */
/* Resident state                                                            */
/* ------------------------------------------------------------------------ */
struct Kernel {
    std::vector<uint8_t> bytes;       /* copied in (ssb_load_kernel) */
    uint8_t* adopted = nullptr;       /* adopted from the host (ssb_kernel_job_begin) */
    uint32_t adopted_size = 0;
    daf::File file;
    bool binary_pck = false;
    Kernel() = default;
    Kernel(const Kernel&) = delete;
    Kernel& operator=(const Kernel&) = delete;
    ~Kernel() {
        if (adopted != nullptr) plugin_free(static_cast<uint32_t>(reinterpret_cast<uintptr_t>(adopted)), adopted_size);
    }
};

struct State {
    std::vector<std::unique_ptr<Kernel>> kernels;
    KernelPool pool;
    std::string error;
};

State& state() {
    static State s;
    return s;
}

/* ------------------------------------------------------------------------ */
/* Time                                                                      */
/* ------------------------------------------------------------------------ */
inline double tai_to_et(double day, double seconds) {
    const double tai = (day - 2451545.0) * 86400.0 + seconds;
    const double tt = tai + 32.184;
    const double m = 6.239996 + 1.99096871e-7 * tt;
    const double e = m + 1.671e-2 * std::sin(m);
    return tt + 1.657e-3 * std::sin(e);
}

/* ------------------------------------------------------------------------ */
/* Kernel loading                                                            */
/* ------------------------------------------------------------------------ */
inline int32_t load_kernel(const uint8_t* bytes, size_t len) {
    State& s = state();
    if (bytes == nullptr || len < 8) {
        s.error = "empty kernel";
        return ErrBadKernel;
    }
    if (std::memcmp(bytes, "DAF/SPK", 7) == 0 || std::memcmp(bytes, "DAF/PCK", 7) == 0 ||
        std::memcmp(bytes, "NAIF/DAF", 8) == 0) {
        auto k = std::make_unique<Kernel>();
        k->bytes.assign(bytes, bytes + len);
        const ephem::Status st = daf::read(k->bytes.data(), k->bytes.size(), &k->file, false);
        if (st != ephem::Status::Ok) {
            s.error = std::string("DAF read failed: ") + ephem::status_name(st);
            return ErrBadKernel;
        }
        k->binary_pck = k->file.ni == 5;
        if (!k->binary_pck && k->file.ni != 6) {
            s.error = "DAF is neither an SPK (ND=2, NI=6) nor a binary PCK (ND=2, NI=5)";
            return ErrBadKernel;
        }
        s.kernels.push_back(std::move(k));
        return static_cast<int32_t>(s.kernels.size());
    }
    std::string error;
    if (!parse_text_kernel(bytes, len, &s.pool, &error)) {
        s.error = error;
        return ErrBadKernel;
    }
    return 0;
}

inline void reset() {
    State& s = state();
    s.kernels.clear();
    s.pool = KernelPool{};
    s.error.clear();
}

/* ------------------------------------------------------------------------ */
/* SPK chains                                                                */
/* ------------------------------------------------------------------------ */

/* SPICE priority: the last-loaded file wins, and within a file the last
 * segment wins. Returns ErrNoEphemeris when the body has no segment at all,
 * ErrOutOfRange when it has segments but none covers `et`. */
inline int32_t find_segment(int32_t target, double et, const Kernel** kernel, const daf::Summary** seg) {
    State& s = state();
    bool seen = false;
    for (size_t k = s.kernels.size(); k-- > 0;) {
        const Kernel& kk = *s.kernels[k];
        if (kk.binary_pck) continue;
        const auto& sums = kk.file.summaries;
        for (size_t i = sums.size(); i-- > 0;) {
            const daf::Summary& sm = sums[i];
            if (spk::segment_target(sm) != target) continue;
            seen = true;
            if (et < sm.dc[0] || et > sm.dc[1]) continue;
            if (!spk::is_supported_type(spk::segment_type(sm)) || spk::segment_frame(sm) != 1) continue;
            *kernel = &kk;
            *seg = &sm;
            return Ok;
        }
    }
    return seen ? ErrOutOfRange : ErrNoEphemeris;
}

struct Link {
    int32_t body;
    int32_t center;
    double st[6];  /* km, km/s relative to center */
};

/* A chain of links in place (no allocation on the per-frame path). */
struct Chain {
    Link links[16];
    int size = 0;
    const Link* begin() const { return links; }
    const Link* end() const { return links + size; }
    void clear() { size = 0; }
    void push_back(const Link& l) { links[size++] = l; }
};

/* The chain body -> center -> ... -> SSB (0). */
inline int32_t chain_to_ssb(int32_t body, double et, Chain* out) {
    out->clear();
    int32_t current = body;
    for (int hop = 0; hop < 16; ++hop) {
        if (current == 0) return Ok;
        const Kernel* k = nullptr;
        const daf::Summary* sm = nullptr;
        const int32_t found = find_segment(current, et, &k, &sm);
        if (found != Ok) return found;
        ephem::StateRow row;
        const ephem::Status st = spk::evaluate(k->file, *sm, et, &row);
        if (st != ephem::Status::Ok) return st == ephem::Status::OutOfRange ? ErrOutOfRange : ErrBadKernel;
        Link link;
        link.body = current;
        link.center = spk::segment_center(*sm);
        for (int c = 0; c < 3; ++c) {
            link.st[c] = row.pos[c];
            link.st[c + 3] = row.has_vel ? row.vel[c] : 0.0;
        }
        out->push_back(link);
        current = link.center;
    }
    return ErrChainTooLong;
}

/* Geometric state of `target` relative to `center`, km and km/s, ICRF. The two
 * chains are summed only up to their first common node, as the toolkit's
 * SPKGEO does, so the Moon relative to the Earth never passes through the SSB. */
inline int32_t relative_state(int32_t target, int32_t center, double et, double out[6]) {
    Chain a, b;
    int32_t code = chain_to_ssb(target, et, &a);
    if (code != Ok) return code;
    code = chain_to_ssb(center, et, &b);
    if (code != Ok) return code;
    int32_t nodes_b[17], nodes_a[17];
    int nb = 0, na = 0;
    nodes_b[nb++] = center;
    for (const Link& l : b) nodes_b[nb++] = l.center;
    nodes_a[na++] = target;
    for (const Link& l : a) nodes_a[na++] = l.center;
    int32_t common = 0;
    for (int i = 0; i < na; ++i) {
        bool hit = false;
        for (int j = 0; j < nb; ++j) hit = hit || (nodes_b[j] == nodes_a[i]);
        if (hit) {
            common = nodes_a[i];
            break;
        }
    }
    double sa[6] = {0, 0, 0, 0, 0, 0}, sb[6] = {0, 0, 0, 0, 0, 0};
    for (const Link& l : a) {
        if (l.body == common) break;
        for (int c = 0; c < 6; ++c) sa[c] += l.st[c];
    }
    for (const Link& l : b) {
        if (l.body == common) break;
        for (int c = 0; c < 6; ++c) sb[c] += l.st[c];
    }
    for (int c = 0; c < 6; ++c) out[c] = sa[c] - sb[c];
    return Ok;
}

/* metres / metres per second */
inline int32_t state_m(int32_t target, int32_t center, double et, double out[6]) {
    if (target == center) {
        for (int c = 0; c < 6; ++c) out[c] = 0.0;
        return Ok;
    }
    double km[6];
    const int32_t code = relative_state(target, center, et, km);
    if (code != Ok) return code;
    for (int c = 0; c < 6; ++c) out[c] = km[c] * 1000.0;
    return Ok;
}

/* ------------------------------------------------------------------------ */
/* Kernel-pool lookups                                                       */
/* ------------------------------------------------------------------------ */
/* A kernel-pool variable name in a stack buffer (no allocation). */
struct VarName {
    char buf[96];
    operator std::string_view() const { return std::string_view(buf); }
};
inline VarName var(const char* prefix, int32_t id, const char* suffix) {
    VarName v;
    std::snprintf(v.buf, sizeof v.buf, "%s%d%s", prefix, static_cast<int>(id), suffix);
    return v;
}

inline bool radii_m(int32_t id, double out[3]) {
    const auto* r = state().pool.get(var("BODY", id, "_RADII"));
    if (!r || r->size() < 3) return false;
    for (int c = 0; c < 3; ++c) out[c] = (*r)[c] * 1000.0;
    return true;
}

inline bool gm_m3s2(int32_t id, double* out) {
    const auto* g = state().pool.get(var("BODY", id, "_GM"));
    if (!g || g->empty()) return false;
    *out = (*g)[0] * 1.0e9;
    return true;
}

/* ------------------------------------------------------------------------ */
/* Osculating two-body conics                                                 */
/* ------------------------------------------------------------------------ */
inline bool conic_gm(int32_t id, double* out) {
    if (gm_m3s2(id, out)) return true;
    /* A planet's system GM is the text kernel's fallback, never a moon's. */
    return id >= 199 && id <= 999 && id % 100 == 99 && gm_m3s2(id / 100, out);
}

/* Universal functions U1=x(1-zS), U2=x^2 C, U3=x^3 S, z=beta*x^2.
 * The Stumpff series avoids cancellation near the parabolic limit z=0; the
 * half-angle forms avoid subtracting nearly equal cosines elsewhere. */
inline void conic_universal(double beta, double x, double& u1, double& u2, double& u3) {
    const double w = std::sqrt(std::fabs(beta)) * x;
    if (w < 0.1) {
        const double z = beta * x * x;
        double c = 0.5, s = 1.0 / 6.0, tc = c, ts = s;
        for (int k = 1; k <= 8; ++k) {
            tc *= -z / ((2 * k + 1) * (2 * k + 2));
            ts *= -z / ((2 * k + 2) * (2 * k + 3));
            c += tc;
            s += ts;
        }
        u1 = x * (1.0 - z * s);
        u2 = x * x * c;
        u3 = x * x * (x * s);
    } else if (beta > 0.0) {
        const double sh = std::sin(w / 2.0);
        u1 = std::sin(w) / std::sqrt(beta);
        u2 = 2.0 * sh * sh / beta;
        u3 = (x - u1) / beta;
    } else {
        const double sh = std::sinh(w / 2.0);
        u1 = std::sinh(w) / std::sqrt(-beta);
        u2 = 2.0 * sh * sh / -beta;
        u3 = (u1 - x) / -beta;
    }
}

/* Universal-variable Kepler equation in units r0, sqrt(mu/r0), and
 * sqrt(r0^3/mu). Its derivative is radius/r0 > 0, so a bracket protects
 * Newton at all eccentricities. Reduce complete elliptic revolutions before
 * solving, rather than accumulating phase error in a large anomaly. */
inline int32_t conic_state(const double initial[6], double mu, double dt, double out[7]) {
    const double r0 = std::hypot(std::hypot(initial[0], initial[1]), initial[2]);
    if (!(r0 > 0.0) || !std::isfinite(r0) || !std::isfinite(dt)) return ErrBadArgument;
    const double speed = std::sqrt(mu / r0), scale = r0 / speed;
    double r[3], v[3], v2 = 0.0, eta = 0.0;
    for (int c = 0; c < 3; ++c) {
        r[c] = initial[c] / r0;
        v[c] = initial[c + 3] / speed;
        v2 += initial[c + 3] * initial[c + 3];
        eta += r[c] * v[c];
    }
    /* Evaluate energy before the square-root velocity normalization so an
     * exactly parabolic input does not acquire artificial binding energy. */
    const double beta = 2.0 - v2 / (mu / r0);
    out[6] = beta > 0.0 ? 2.0 * kPi * scale / (beta * std::sqrt(beta)) : std::nan("");
    if (beta > 0.0 && std::isfinite(out[6])) dt = std::remainder(dt, out[6]);
    if (dt == 0.0) {
        std::memcpy(out, initial, 6 * sizeof(double));
        return Ok;
    }
    const double direction = dt > 0.0 ? 1.0 : -1.0;
    const double tau = std::fabs(dt) / scale, radial = direction * eta;
    if (!std::isfinite(tau) || !std::isfinite(beta)) return ErrBadArgument;
    auto evaluate = [&](double x, double& derivative) {
        double u1, u2, u3;
        conic_universal(beta, x, u1, u2, u3);
        /* Hyperbolic overflow during bracket growth lies beyond the root. */
        if (!std::isfinite(u3) || !std::isfinite(u2)) {
            derivative = HUGE_VAL;
            return HUGE_VAL;
        }
        derivative = 1.0 + radial * u1 + (1.0 - beta) * u2;
        return x + radial * u2 + (1.0 - beta) * u3 - tau;
    };
    double lo = 0.0, hi = tau < 1.0 ? tau : 1.0, derivative;
    for (int i = 0; evaluate(hi, derivative) < 0.0; ++i) {
        if (i >= 1024 || !std::isfinite(hi *= 2.0)) return ErrBadArgument;
    }
    double x = hi / 2.0;
    bool solved = false;
    for (int i = 0; i < 512; ++i) {
        const double residual = evaluate(x, derivative);
        if (std::fabs(residual) <= 8.0e-15 * tau) { solved = true; break; }
        if (residual > 0.0) hi = x;
        else lo = x;
        const double width = hi - lo;
        if (width <= 8.0e-15 * hi) { x = lo + width / 2.0; solved = true; break; }
        const double next = x - residual / derivative;
        x = next > lo + 0.1 * width && next < hi - 0.1 * width ? next : lo + width / 2.0;
    }
    if (!solved) return ErrBadArgument;
    double u1, u2, u3;
    conic_universal(beta, x, u1, u2, u3);
    u1 *= direction;
    /* g/scale = U1 + eta*U2 avoids subtracting large, almost equal
     * times (tau-U3) on long parabolic/hyperbolic arcs. */
    double position[3];
    for (int c = 0; c < 3; ++c) position[c] = (1.0 - u2) * r[c] + (u1 + eta * u2) * v[c];
    const double radius = std::hypot(std::hypot(position[0], position[1]), position[2]);
    if (!(radius > 0.0) || !std::isfinite(radius)) return ErrBadArgument;
    for (int c = 0; c < 3; ++c) {
        out[c] = r0 * position[c];
        out[c + 3] = speed * (-u1 / radius * r[c] + (1.0 - u2 / radius) * v[c]);
        if (!std::isfinite(out[c]) || !std::isfinite(out[c + 3])) return ErrBadArgument;
    }
    return Ok;
}

/* ------------------------------------------------------------------------ */
/* Rotation                                                                  */
/* ------------------------------------------------------------------------ */
inline void mat_mul(const double a[9], const double b[9], double out[9]) {
    double t[9];
    for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c)
            t[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    std::memcpy(out, t, sizeof t);
}

/* SPICE ROTATE: the frame (passive) rotation by `angle` about `axis` (1..3). */
inline void rotate(double angle, int axis, double out[9]) {
    const double c = std::cos(angle), s = std::sin(angle);
    for (int i = 0; i < 9; ++i) out[i] = 0.0;
    const int a = axis - 1, b = axis % 3, d = (axis + 1) % 3;
    out[a * 3 + a] = 1.0;
    out[b * 3 + b] = c;
    out[d * 3 + d] = c;
    out[b * 3 + d] = s;
    out[d * 3 + b] = -s;
}

/* SPICE EUL2M(a3, a2, a1, ax3, ax2, ax1) = [a3]ax3 [a2]ax2 [a1]ax1. */
inline void eul2m(double a3, double a2, double a1, int ax3, int ax2, int ax1, double out[9]) {
    double r3[9], r2[9], r1[9], t[9];
    rotate(a3, ax3, r3);
    rotate(a2, ax2, r2);
    rotate(a1, ax1, r1);
    mat_mul(r2, r1, t);
    mat_mul(r3, t, out);
}

/* Binary PCK type 2 (Chebyshev Euler angles): NAIF PCK Required Reading,
 * "Segments--The Fundamental PCK Building Blocks", type 2. Angles in radians. */
inline int32_t bpc_angles(int32_t frame_class, double et, double ang[3]) {
    State& s = state();
    bool seen = false;
    for (size_t k = s.kernels.size(); k-- > 0;) {
        const Kernel& kk = *s.kernels[k];
        if (!kk.binary_pck) continue;
        for (size_t i = kk.file.summaries.size(); i-- > 0;) {
            const daf::Summary& sm = kk.file.summaries[i];
            if (sm.ic[0] != frame_class) continue;
            seen = true;
            if (sm.ic[1] != 1 || sm.ic[2] != 2) continue;
            if (et < sm.dc[0] || et > sm.dc[1]) continue;
            const size_t begin = static_cast<size_t>(sm.ic[3]);
            const size_t end = static_cast<size_t>(sm.ic[4]);
            double ctl[4];
            if (!kk.file.words(end - 3, 4, ctl)) return ErrBadKernel;
            const double init = ctl[0], intlen = ctl[1];
            const long long rsize = static_cast<long long>(ctl[2]);
            const long long n = static_cast<long long>(ctl[3]);
            if (intlen <= 0.0 || rsize < 5 || n < 1) return ErrBadKernel;
            long long idx = static_cast<long long>(std::floor((et - init) / intlen));
            if (idx < 0) idx = 0;
            if (idx >= n) idx = n - 1;
            const int per = static_cast<int>((rsize - 2) / 3);
            if (per < 1 || per > 64) return ErrBadKernel;
            double rec[2 + 3 * 64];
            if (!kk.file.words(begin + static_cast<size_t>(idx * rsize), static_cast<size_t>(rsize), rec)) {
                return ErrBadKernel;
            }
            const double x = (et - rec[0]) / rec[1];
            for (int a = 0; a < 3; ++a) {
                const double* c = rec + 2 + a * per;
                double b0 = 0.0, b1 = 0.0, b2 = 0.0;
                for (int j = per - 1; j >= 1; --j) {
                    b2 = b1;
                    b1 = b0;
                    b0 = 2.0 * x * b1 - b2 + c[j];
                }
                ang[a] = x * b0 - b1 + c[0];
            }
            return Ok;
        }
    }
    return seen ? ErrOutOfRange : ErrNoRotation;
}

/* TKFRAME_<id> with SPEC 'ANGLES' (NAIF Frames Required Reading, "Defining a
 * TK Frame Using Euler Angles"): the rotation from the TK frame to its
 * RELATIVE frame is [A1]X1 [A2]X2 [A3]X3 = EUL2M(A1, A2, A3, X1, X2, X3). */
inline bool tk_angles(int32_t id, double out[9]) {
    const KernelPool& p = state().pool;
    const auto* a = p.get(var("TKFRAME_", id, "_ANGLES"));
    const auto* x = p.get(var("TKFRAME_", id, "_AXES"));
    if (!a || !x || a->size() != 3 || x->size() != 3) return false;
    double scale = kDeg;
    auto units = p.strings.find(std::string_view(var("TKFRAME_", id, "_UNITS")));
    if (units != p.strings.end() && !units->second.empty()) {
        const std::string& u = units->second[0];
        if (u == "ARCSECONDS") scale = kDeg / 3600.0;
        else if (u == "RADIANS") scale = 1.0;
        else if (u == "DEGREES") scale = kDeg;
        else return false;
    }
    eul2m((*a)[0] * scale, (*a)[1] * scale, (*a)[2] * scale, static_cast<int>((*x)[0]),
          static_cast<int>((*x)[1]), static_cast<int>((*x)[2]), out);
    return true;
}

inline void transpose(const double m[9], double out[9]) {
    double t[9] = {m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]};
    std::memcpy(out, t, sizeof t);
}

/* ICRF -> body-fixed (row-major) and the spin rate dW/dt (rad/s). */
inline int32_t rotation(int32_t id, double et, double out[9], double* spin) {
    using sdn::frames::iau2015::pck::RotationModel;
    const KernelPool& p = state().pool;
    if (id == 301) {
        /* MOON_ME = TKFRAME_31009 applied to MOON_PA_DE440 (31008). */
        double ang[3];
        const int32_t code = bpc_angles(31008, et, ang);
        if (code != Ok) return code;
        double pa[9], tk[9], tkT[9];
        eul2m(ang[2], ang[1], ang[0], 3, 1, 3, pa);
        if (!tk_angles(31009, tk)) return ErrNoRotation;
        transpose(tk, tkT);
        mat_mul(tkT, pa, out);
        const auto* pm = p.get("BODY301_PM");
        *spin = (pm && pm->size() > 1) ? (*pm)[1] * kDeg / 86400.0 : 0.0;
        return Ok;
    }
    const auto* ra = p.get(var("BODY", id, "_POLE_RA"));
    const auto* dec = p.get(var("BODY", id, "_POLE_DEC"));
    const auto* pm = p.get(var("BODY", id, "_PM"));
    if (!ra || !dec || !pm) return ErrNoRotation;
    RotationModel m;
    for (size_t i = 0; i < 3; ++i) {
        m.poleRa[i] = i < ra->size() ? (*ra)[i] : 0.0;
        m.poleDec[i] = i < dec->size() ? (*dec)[i] : 0.0;
        m.pm[i] = i < pm->size() ? (*pm)[i] : 0.0;
    }
    const auto* nra = p.get(var("BODY", id, "_NUT_PREC_RA"));
    const auto* ndec = p.get(var("BODY", id, "_NUT_PREC_DEC"));
    const auto* npm = p.get(var("BODY", id, "_NUT_PREC_PM"));
    if (nra || ndec || npm) {
        const int32_t sys = phase_system(id);
        const auto* phases = p.get(var("BODY", sys, "_NUT_PREC_ANGLES"));
        if (!phases) return ErrNoRotation;
        m.phases = phases->data();
        m.nPhases = static_cast<unsigned>(phases->size());
        const auto* deg = p.get(var("BODY", sys, "_MAX_PHASE_DEGREE"));
        m.maxPhaseDegree = (deg && !deg->empty()) ? static_cast<unsigned>((*deg)[0]) : 1u;
        if (nra) { m.nutRa = nra->data(); m.nNutRa = static_cast<unsigned>(nra->size()); }
        if (ndec) { m.nutDec = ndec->data(); m.nNutDec = static_cast<unsigned>(ndec->size()); }
        if (npm) { m.nutPm = npm->data(); m.nNutPm = static_cast<unsigned>(npm->size()); }
    }
    const auto* jed = p.get(var("BODY", id, "_CONSTANTS_JED_EPOCH"));
    if (jed && !jed->empty()) m.epochDays = (*jed)[0] - 2451545.0;
    double a, d, w;
    if (!sdn::frames::iau2015::pck::evaluate(m, et, &a, &d, &w, spin)) return ErrNoRotation;
    eul2m(w, kHalfPi - d, kHalfPi + a, 3, 1, 3, out);
    return Ok;
}

/* ------------------------------------------------------------------------ */
/* Photometry                                                                */
/* ------------------------------------------------------------------------ */
inline double norm3(const double* v) { return std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); }
inline double dot3(const double* a, const double* b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

inline double hg_magnitude(double h, double g, double r_au, double d_au, double alpha) {
    const double t = std::tan(alpha / 2.0);
    const double p1 = std::exp(-3.33 * std::pow(t, 0.63));
    const double p2 = std::exp(-1.87 * std::pow(t, 1.22));
    return h + 5.0 * std::log10(r_au * d_au) - 2.5 * std::log10((1.0 - g) * p1 + g * p2);
}

/* Mallama & Hilton (2018) for the planets; constants in bodies.hpp. `beta` is
 * the ring-plane inclination to the observer (Saturn), `sub_lat` the
 * sub-observer latitude (Uranus), both radians; `et` selects Neptune's epoch. */
inline double magnitude(const BodyInfo& b, double r_au, double d_au, double alpha_rad, double beta,
                        double sub_lat, double et) {
    const double a = alpha_rad / kDeg;
    const double base = 5.0 * std::log10(r_au * d_au);
    switch (b.photometry) {
        case PhotSun:
            return b.v10 + 5.0 * std::log10(d_au);
        case PhotMercury:
            return base - 0.613 + a * (6.3280e-02 + a * (-1.6336e-03 + a * (3.3644e-05 + a * (-3.4265e-07 + a * (1.6893e-09 + a * -3.0334e-12)))));
        case PhotVenus:
            if (a < 163.7) return base - 4.384 + a * (-1.044e-03 + a * (3.687e-04 + a * (-2.814e-06 + a * 8.938e-09)));
            return base + 236.05828 + a * (-2.81914 + a * 8.39034e-03);
        case PhotEarth:
            return base - 3.99 + a * (-1.060e-03 + a * 2.054e-04);
        case PhotMars:
            if (a <= 50.0) return base - 1.601 + a * (0.02267 - 0.0001302 * a);
            return base - 0.367 + a * (-0.02573 + 0.0003445 * a);
        case PhotJupiter:
            if (a <= 12.0) return base - 9.395 + a * (-3.7e-04 + a * 6.16e-04);
            {
                const double x = a / 180.0;
                return base - 9.428 - 2.5 * std::log10(1.0 - 1.507 * x - 0.363 * x * x - 0.062 * x * x * x + 2.809 * x * x * x * x - 1.876 * x * x * x * x * x);
            }
        case PhotSaturn: {
            const double sb = std::sin(std::fabs(beta));
            if (a <= 6.5 && std::fabs(beta) <= 27.0 * kDeg) {
                return base - 8.914 - 1.825 * sb + 0.026 * a - 0.378 * sb * std::exp(-2.25 * a);
            }
            return base - 8.94 + a * (2.446e-04 + a * (2.672e-04 + a * (-1.505e-06 + a * 4.767e-09)));
        }
        case PhotUranus:
            return base - 7.110 - 8.4e-04 * std::fabs(sub_lat / kDeg) + a * (6.587e-03 + a * 1.045e-04);
        case PhotNeptune: {
            /* V(1,0) brightened from -6.89 (1980) to -7.00 (2000) and is held. */
            const double year = 2000.0 + et / (365.25 * 86400.0);
            double v10 = -7.00;
            if (year < 1980.0) v10 = -6.89;
            else if (year < 2000.0) v10 = -6.89 - 0.0055 * (year - 1980.0);
            return base + v10 + a * (7.944e-03 + a * 9.617e-05);
        }
        case PhotMoon:
            return base + b.v10 + 0.0217 * a + 5.5e-9 * a * a * a * a;
        case PhotHG:
            return hg_magnitude(b.v10, b.g, r_au, d_au, alpha_rad);
        case PhotLinear:
        default:
            return base + b.v10 + 0.02 * a;
    }
}

/* Per body: unit direction from the observer (3), distance m, V, angular
 * radius rad, phase angle rad. `observer` is an ICRF SSB position in metres. */
inline int32_t apparent(int32_t id, double et, const double observer[3], double out[7]) {
    const BodyInfo* b = find_body(id);
    if (!b) return ErrUnknownBody;
    double body[6], sun[6];
    int32_t code = state_m(id, 0, et, body);
    if (code != Ok) return code;
    code = state_m(10, 0, et, sun);
    if (code != Ok) return code;
    double to_body[3], to_sun[3], to_obs[3];
    for (int c = 0; c < 3; ++c) {
        to_body[c] = body[c] - observer[c];
        to_sun[c] = sun[c] - body[c];
        to_obs[c] = observer[c] - body[c];
    }
    const double d = norm3(to_body);
    const double r = norm3(to_sun);
    if (!(d > 0.0)) return ErrBadArgument;
    for (int c = 0; c < 3; ++c) out[c] = to_body[c] / d;
    out[3] = d;
    double alpha = 0.0;
    if (id != 10 && r > 0.0) {
        double cosa = dot3(to_sun, to_obs) / (r * d);
        cosa = cosa > 1.0 ? 1.0 : (cosa < -1.0 ? -1.0 : cosa);
        alpha = std::acos(cosa);
    }
    double beta = 0.0, sub_lat = 0.0;
    if (b->photometry == PhotSaturn || b->photometry == PhotUranus) {
        double rot[9], spin;
        if (rotation(id, et, rot, &spin) == Ok) {
            /* Third row of ICRF -> body-fixed is the pole in ICRF. */
            const double pole[3] = {rot[6], rot[7], rot[8]};
            const double s = dot3(pole, to_obs) / d;
            sub_lat = std::asin(s > 1.0 ? 1.0 : (s < -1.0 ? -1.0 : s));
            beta = sub_lat;
        }
    }
    out[4] = magnitude(*b, id == 10 ? 1.0 : r / kAu, d / kAu, alpha, beta, sub_lat, et);
    double radii[3];
    double mean = 0.0;
    if (radii_m(id, radii)) mean = (radii[0] + radii[1] + radii[2]) / 3.0;
    out[5] = mean > 0.0 && mean < d ? std::asin(mean / d) : 0.0;
    out[6] = alpha;
    return Ok;
}

/* Hill-sphere radius of `id` about the body it orbits (m). The Sun's is the
 * outer rest distance: beyond it the observer is the SSB at rest. */
inline int32_t hill_radius(int32_t id, double et, double* out) {
    const BodyInfo* b = find_body(id);
    if (!b) return ErrUnknownBody;
    if (b->parent == 0) {
        *out = kOuterRestDistance;
        return Ok;
    }
    double rel[6];
    const int32_t code = state_m(id, b->parent, et, rel);
    if (code != Ok) return code;
    double gm = 0.0, gp = 0.0;
    if (!gm_m3s2(id, &gm) || !gm_m3s2(b->parent, &gp) || gp <= 0.0) return ErrNoEphemeris;
    *out = norm3(rel) * std::cbrt(gm / (3.0 * gp));
    return Ok;
}

/* The observer for the sky: SSB position and velocity (ICRF, m, m/s). Inside
 * the central body's Hill sphere it moves with that body plus the camera's own
 * inertial velocity (and, for a camera fixed in the body's frame, the body's
 * rotation: omega x r about its pole, no faster than the body's synchronous
 * orbit); from the Hill radius out to 1e14 m the
 * velocity eases to zero (a smoothstep in log distance); beyond, it is the SSB
 * at rest. */
inline int32_t observer_state(int32_t central, double et, const double cam_pos[3], const double cam_vel_in[3],
                              bool corotating, double out[6]) {
    double cam_vel[3] = {cam_vel_in[0], cam_vel_in[1], cam_vel_in[2]};
    if (corotating) {
        double rot[9], spin = 0.0;
        if (rotation(central, et, rot, &spin) == Ok) {
            const double w[3] = {rot[6] * spin, rot[7] * spin, rot[8] * spin};
            double v[3] = {w[1] * cam_pos[2] - w[2] * cam_pos[1], w[2] * cam_pos[0] - w[0] * cam_pos[2],
                           w[0] * cam_pos[1] - w[1] * cam_pos[0]};
            /* A point at rest in the body's frame is a physical observer out to
             * the synchronous radius r_s = (GM / w^2)^(1/3), where it is itself
             * in orbit; beyond, its speed |w| r outruns every orbit and, 1e13 m
             * from the Sun, reaches 0.08 c (aberration then threw the planets
             * tens of au across the screen while zooming out, owner
             * 2026-10-16). From r_s out the speed holds at the synchronous
             * orbit's own, |w| r_s: the surface and GEO are untouched. */
            double gm = 0.0, cap = 0.0;
            if (spin != 0.0 && gm_m3s2(central, &gm) && gm > 0.0) {
                cap = std::fabs(spin) * std::cbrt(gm / (spin * spin));
            } else {
                double r3[3];
                if (radii_m(central, r3)) cap = std::fabs(spin) * std::fmax(r3[0], std::fmax(r3[1], r3[2]));
            }
            const double speed = norm3(v);
            const double scale = speed > cap ? cap / speed : 1.0;
            for (int i = 0; i < 3; ++i) cam_vel[i] += scale * v[i];
        }
    }
    double c[6];
    int32_t code = state_m(central, 0, et, c);
    if (code != Ok) return code;
    double rh = kOuterRestDistance;
    code = hill_radius(central, et, &rh);
    if (code != Ok) return code;
    const double r = norm3(cam_pos);
    double keep = 1.0;
    if (r > rh) {
        if (r >= kOuterRestDistance || rh >= kOuterRestDistance) {
            keep = r >= kOuterRestDistance ? 0.0 : 1.0;
        } else {
            double x = std::log(r / rh) / std::log(kOuterRestDistance / rh);
            x = x < 0.0 ? 0.0 : (x > 1.0 ? 1.0 : x);
            keep = 1.0 - x * x * (3.0 - 2.0 * x);
        }
    }
    for (int i = 0; i < 3; ++i) {
        out[i] = c[i] + cam_pos[i];
        out[i + 3] = keep * (c[i + 3] + cam_vel[i]);
    }
    return Ok;
}

/* Planetodetic (Cesium Cartographic on the body's triaxial ellipsoid) and IAU
 * planetocentric coordinates. mode 0: (lon, lat_detic, h) -> (lon, lat_centric,
 * radius); mode 1: (lon, lat_centric, *) -> (lon, lat_detic, 0) on the surface. */
inline int32_t cartographic_convert(int32_t id, int32_t mode, const double in[3], double out[3]) {
    double r[3];
    if (!radii_m(id, r)) return ErrNoRotation;
    const double a2 = r[0] * r[0], b2 = r[1] * r[1], c2 = r[2] * r[2];
    if (mode == 0) {
        const double cl = std::cos(in[1]);
        const double n[3] = {cl * std::cos(in[0]), cl * std::sin(in[0]), std::sin(in[1])};
        const double k[3] = {a2 * n[0], b2 * n[1], c2 * n[2]};
        const double gamma = std::sqrt(n[0] * k[0] + n[1] * k[1] + n[2] * k[2]);
        double p[3];
        for (int i = 0; i < 3; ++i) p[i] = k[i] / gamma + n[i] * in[2];
        out[0] = std::atan2(p[1], p[0]);
        out[1] = std::atan2(p[2], std::sqrt(p[0] * p[0] + p[1] * p[1]));
        out[2] = norm3(p);
        return Ok;
    }
    if (mode == 1) {
        const double cl = std::cos(in[1]);
        const double u[3] = {cl * std::cos(in[0]), cl * std::sin(in[0]), std::sin(in[1])};
        const double s = 1.0 / std::sqrt(u[0] * u[0] / a2 + u[1] * u[1] / b2 + u[2] * u[2] / c2);
        const double p[3] = {u[0] * s, u[1] * s, u[2] * s};
        double n[3] = {p[0] / a2, p[1] / b2, p[2] / c2};
        const double nn = norm3(n);
        for (double& v : n) v /= nn;
        out[0] = std::atan2(n[1], n[0]);
        out[1] = std::asin(n[2]);
        out[2] = 0.0;
        return Ok;
    }
    return ErrBadArgument;
}

/* ------------------------------------------------------------------------ */
/* Where a body is SEEN: light time and stellar aberration                   */
/* ------------------------------------------------------------------------ */
constexpr double kSpeedOfLight = 299792458.0; /* m/s, SI defining constant */

/* The apparent position of `id` from an observer (ICRF SSB position and
 * velocity, m and m/s) minus its geometric position from the same observer:
 * the shift a renderer adds to draw the body where it is seen, consistent with
 * stars drawn with aberration. Light time is iterated three times (converged
 * far below a millimetre in the solar system); aberration is the classical
 * first-order stellar aberration u' = u + v/c - u (u.v/c), normalized (SPICE
 * STELAB keeps the second-order term, under 1 mas at 30 km/s). The apparent
 * vector keeps the light-time distance. NAIF "Aberration Corrections",
 * spkezr_c LT+S. */
inline int32_t apparent_offset(int32_t id, double et, const double obs[6], double out[3]) {
    double b[6];
    int32_t code = state_m(id, 0, et, b);
    if (code != Ok) return code;
    const double geo[3] = {b[0] - obs[0], b[1] - obs[1], b[2] - obs[2]};
    double p[3] = {geo[0], geo[1], geo[2]};
    double tau = norm3(p) / kSpeedOfLight;
    for (int it = 0; it < 3; ++it) {
        code = state_m(id, 0, et - tau, b);
        if (code != Ok) return code;
        for (int c = 0; c < 3; ++c) p[c] = b[c] - obs[c];
        tau = norm3(p) / kSpeedOfLight;
    }
    const double d = norm3(p);
    if (!(d > 0.0)) return ErrBadArgument;
    const double u[3] = {p[0] / d, p[1] / d, p[2] / d};
    const double v[3] = {obs[3] / kSpeedOfLight, obs[4] / kSpeedOfLight, obs[5] / kSpeedOfLight};
    const double uv = dot3(u, v);
    double a[3];
    for (int c = 0; c < 3; ++c) a[c] = u[c] + v[c] - u[c] * uv;
    const double an = norm3(a);
    for (int c = 0; c < 3; ++c) out[c] = a[c] / an * d - geo[c];
    return Ok;
}

/* Sky appearance (as `apparent`) of a point that is not in the body table: a
 * small body at `pos` (m, ICRF) relative to `center`, with H and G and a mean
 * radius (m). */
inline int32_t apparent_point(double et, const double observer[3], int32_t center, const double pos[3], double h,
                              double g, double radius, double out[7]) {
    double c[6], sun[6];
    int32_t code = state_m(center, 0, et, c);
    if (code != Ok) return code;
    code = state_m(10, 0, et, sun);
    if (code != Ok) return code;
    double ssb[3], to_body[3], to_sun[3], to_obs[3];
    for (int k = 0; k < 3; ++k) {
        ssb[k] = c[k] + pos[k];
        to_body[k] = ssb[k] - observer[k];
        to_sun[k] = sun[k] - ssb[k];
        to_obs[k] = observer[k] - ssb[k];
    }
    const double d = norm3(to_body), r = norm3(to_sun);
    if (!(d > 0.0) || !(r > 0.0)) return ErrBadArgument;
    for (int k = 0; k < 3; ++k) out[k] = to_body[k] / d;
    out[3] = d;
    double cosa = dot3(to_sun, to_obs) / (r * d);
    cosa = cosa > 1.0 ? 1.0 : (cosa < -1.0 ? -1.0 : cosa);
    const double alpha = std::acos(cosa);
    out[4] = std::isfinite(h) ? hg_magnitude(h, std::isfinite(g) ? g : 0.15, r / kAu, d / kAu, alpha) : NAN;
    out[5] = radius > 0.0 && radius < d ? std::asin(radius / d) : 0.0;
    out[6] = alpha;
    return Ok;
}

}  // namespace ssb

/* ======================================================================== */
/* Direct surface (resident, synchronous; the engine's per-frame path)        */
/* ======================================================================== */

SSB_EXPORT("ssb_reset") void ssb_reset(void) { ssb::reset(); }

/* Copy `len` bytes at `ptr` in as one kernel (SPK, binary PCK or text). The
 * caller frees its buffer afterwards. Returns >= 0 on success. */
SSB_EXPORT("ssb_load_kernel") int32_t ssb_load_kernel(const uint8_t* ptr, uint32_t len) {
    return ssb::load_kernel(ptr, len);
}

/* The last failure's message into `buf` (NUL-terminated); returns its length. */
SSB_EXPORT("ssb_last_error") uint32_t ssb_last_error(char* buf, uint32_t cap) {
    const std::string& e = ssb::state().error;
    if (!buf || cap == 0) return static_cast<uint32_t>(e.size());
    const uint32_t n = static_cast<uint32_t>(e.size() < cap - 1 ? e.size() : cap - 1);
    std::memcpy(buf, e.data(), n);
    buf[n] = '\0';
    return n;
}

SSB_EXPORT("ssb_body_count") int32_t ssb_body_count(void) { return ssb::kBodyCount; }

/* Catalog record i (48 bytes): int32 id, parent, kind, flags; double radii[3]
 * (m), gm (m^3/s^2). flags: 1 radii, 2 gm, 4 rotation model. */
SSB_EXPORT("ssb_body_record") int32_t ssb_body_record(int32_t index, uint8_t* out) {
    if (index < 0 || index >= ssb::kBodyCount || !out) return ssb::ErrBadArgument;
    const ssb::BodyInfo& b = ssb::kBodies[index];
    int32_t flags = 0;
    double radii[3] = {0, 0, 0}, gm = 0.0;
    if (ssb::radii_m(b.id, radii)) flags |= 1;
    if (ssb::gm_m3s2(b.id, &gm)) flags |= 2;
    if (b.id == 301 || ssb::state().pool.get(ssb::var("BODY", b.id, "_POLE_RA"))) flags |= 4;
    const int32_t head[4] = {b.id, b.parent, b.kind, flags};
    std::memcpy(out, head, sizeof head);
    std::memcpy(out + 16, radii, sizeof radii);
    std::memcpy(out + 40, &gm, sizeof gm);
    return ssb::Ok;
}

/* The body's name and kernel shard ("core", "mars", ...) as "name\0shard\0". */
SSB_EXPORT("ssb_body_names") uint32_t ssb_body_names(int32_t index, char* buf, uint32_t cap) {
    if (index < 0 || index >= ssb::kBodyCount) return 0;
    const ssb::BodyInfo& b = ssb::kBodies[index];
    const size_t n1 = std::strlen(b.name), n2 = std::strlen(b.shard);
    const size_t need = n1 + n2 + 2;
    if (!buf || cap < need) return static_cast<uint32_t>(need);
    std::memcpy(buf, b.name, n1 + 1);
    std::memcpy(buf + n1 + 1, b.shard, n2 + 1);
    return static_cast<uint32_t>(need);
}

/* TDB seconds past J2000 for a TAI JulianDate. */
SSB_EXPORT("ssb_et") double ssb_et(double day, double seconds) { return ssb::tai_to_et(day, seconds); }

/* States of `n` bodies relative to `center` at `et` (ICRF, m, m/s): 6 doubles
 * per body into `out`, one int32 status per body into `status`. Returns the
 * number of bodies that failed. */
SSB_EXPORT("ssb_states") int32_t ssb_states(double et, const int32_t* ids, uint32_t n, int32_t center, double* out,
                                             int32_t* status) {
    int32_t failed = 0;
    for (uint32_t i = 0; i < n; ++i) {
        status[i] = ssb::state_m(ids[i], center, et, out + 6 * i);
        if (status[i] != ssb::Ok) {
            ++failed;
            for (int c = 0; c < 6; ++c) out[6 * i + c] = 0.0;
        }
    }
    return failed;
}

/* Freeze the geometric ephemeris at et0, then follow that two-body conic.
 * out: ICRF m and m/s, followed by its bound period in seconds (NaN if open). */
SSB_EXPORT("ssb_osculating_state") int32_t ssb_osculating_state(double et0, int32_t id, int32_t center,
                                                               double et, double* out7) {
    if (!out7 || !std::isfinite(et0) || !std::isfinite(et)) return ssb::ErrBadArgument;
    double initial[6];
    const int32_t code = ssb::state_m(id, center, et0, initial);
    if (code != ssb::Ok) {
        auto unknown = [et0](int32_t body) {
            const ssb::Kernel* kernel;
            const daf::Summary* segment;
            return !ssb::find_body(body) && (body < 0 || body > 9) &&
                   ssb::find_segment(body, et0, &kernel, &segment) == ssb::ErrNoEphemeris;
        };
        return code == ssb::ErrNoEphemeris && (unknown(id) || unknown(center)) ? ssb::ErrUnknownBody : code;
    }
    double center_gm, body_gm = 0.0;
    if (!ssb::conic_gm(center, &center_gm) || !(center_gm > 0.0) || !std::isfinite(center_gm)) return ssb::ErrNoGM;
    ssb::conic_gm(id, &body_gm);
    if (!(body_gm >= 0.0) || !std::isfinite(body_gm + center_gm)) return ssb::ErrBadArgument;
    return ssb::conic_state(initial, center_gm + body_gm, et - et0, out7);
}

/* ICRF -> body-fixed rotations (9 doubles, row-major) plus the spin rate
 * (rad/s): 10 doubles per body. */
SSB_EXPORT("ssb_orientations") int32_t ssb_orientations(double et, const int32_t* ids, uint32_t n, double* out,
                                                         int32_t* status) {
    int32_t failed = 0;
    for (uint32_t i = 0; i < n; ++i) {
        double* o = out + 10 * i;
        status[i] = ssb::rotation(ids[i], et, o, o + 9);
        if (status[i] != ssb::Ok) {
            ++failed;
            for (int c = 0; c < 10; ++c) o[c] = 0.0;
        }
    }
    return failed;
}

/* Sky appearance from an ICRF SSB observer position (m): 7 doubles per body
 * (direction 3, distance m, V magnitude, angular radius rad, phase rad). */
SSB_EXPORT("ssb_apparent") int32_t ssb_apparent(double et, const double* observer, const int32_t* ids, uint32_t n,
                                                 double* out, int32_t* status) {
    int32_t failed = 0;
    for (uint32_t i = 0; i < n; ++i) {
        status[i] = ssb::apparent(ids[i], et, observer, out + 7 * i);
        if (status[i] != ssb::Ok) {
            ++failed;
            for (int c = 0; c < 7; ++c) out[7 * i + c] = 0.0;
        }
    }
    return failed;
}

/* Observer SSB state (6 doubles) for a camera at `cam` (position 3, inertial
 * velocity 3; ICRF, relative to `central`). `corotating` != 0: the camera is
 * at rest in the central body's fixed frame and turns with it. */
SSB_EXPORT("ssb_observer") int32_t ssb_observer(double et, int32_t central, const double* cam, int32_t corotating,
                                                 double* out) {
    return ssb::observer_state(central, et, cam, cam + 3, corotating != 0, out);
}

SSB_EXPORT("ssb_hill_radius") double ssb_hill_radius(double et, int32_t id) {
    double r = 0.0;
    return ssb::hill_radius(id, et, &r) == ssb::Ok ? r : -1.0;
}

/* One-way light time (s) from body `from` to body `to` at `et`: the geometric
 * distance over c (IAU 2009 / SI defining constant), no iteration for the
 * light path (a display quantity). Negative when either state is unknown. */
SSB_EXPORT("ssb_light_time") double ssb_light_time(double et, int32_t from, int32_t to) {
    double s[6];
    if (ssb::state_m(to, from, et, s) != ssb::Ok) return -1.0;
    return ssb::norm3(s) / ssb::kSpeedOfLight;
}

/* One-way light time (s) from body `from` to a point at `pos` (m, ICRF)
 * relative to body `center` (a promoted asteroid, relative to the Sun). */
SSB_EXPORT("ssb_light_time_point") double ssb_light_time_point(double et, int32_t from, int32_t center,
                                                               const double* pos) {
    double s[6];
    if (!pos || ssb::state_m(center, from, et, s) != ssb::Ok) return -1.0;
    const double d[3] = {s[0] + pos[0], s[1] + pos[1], s[2] + pos[2]};
    return ssb::norm3(d) / ssb::kSpeedOfLight;
}

/* PCK triaxial radii (m) of any NAIF body the loaded text kernels describe,
 * in or out of the body table (Eros, Itokawa, Lutetia...). */
SSB_EXPORT("ssb_radii") int32_t ssb_radii(int32_t id, double* out) {
    if (!out) return ssb::ErrBadArgument;
    return ssb::radii_m(id, out) ? ssb::Ok : ssb::ErrNoRotation;
}

/* Light-time and aberration shifts (3 doubles per body, ICRF, m) for an
 * observer state (6 doubles: SSB position m, velocity m/s): add to the
 * geometric position from the observer to draw a body where it is seen. */
SSB_EXPORT("ssb_apparent_offsets") int32_t ssb_apparent_offsets(double et, const double* observer, const int32_t* ids,
                                                                 uint32_t n, double* out, int32_t* status) {
    int32_t failed = 0;
    for (uint32_t i = 0; i < n; ++i) {
        status[i] = ssb::apparent_offset(ids[i], et, observer, out + 3 * i);
        if (status[i] != ssb::Ok) {
            ++failed;
            for (int c = 0; c < 3; ++c) out[3 * i + c] = 0.0;
        }
    }
    return failed;
}

/* Sky appearance of one point outside the body table (see ssb_apparent):
 * `pos` (m, ICRF) relative to `center`, H, G, mean radius (m). */
SSB_EXPORT("ssb_apparent_point") int32_t ssb_apparent_point(double et, const double* observer, int32_t center,
                                                             const double* pos, double h, double g, double radius,
                                                             double* out) {
    if (!observer || !pos || !out) return ssb::ErrBadArgument;
    return ssb::apparent_point(et, observer, center, pos, h, g, radius, out);
}

/* The Milky Way's frame (foundation/frames galactic.hpp): 9 doubles ICRS ->
 * Galactic (row-major), then the Galactic centre from the Sun (3, ICRS, m),
 * then R0 and z0 (m). */
SSB_EXPORT("ssb_galactic") int32_t ssb_galactic(double* out) {
    if (!out) return ssb::ErrBadArgument;
    sdn::frames::galactic::icrs_to_galactic(out);
    sdn::frames::galactic::centre_from_sun(out + 9);
    out[12] = sdn::frames::galactic::kSunToCentreParsecs * sdn::frames::galactic::kParsecMeters;
    out[13] = sdn::frames::galactic::kSunHeightParsecs * sdn::frames::galactic::kParsecMeters;
    return ssb::Ok;
}

SSB_EXPORT("ssb_cartographic") int32_t ssb_cartographic(int32_t id, int32_t mode, const double* in, double* out) {
    return ssb::cartographic_convert(id, mode, in, out);
}

/* V magnitudes of `n` small bodies from SSB positions (m, 3 per body) and
 * H, G (2 per body), seen from `observer` (ICRF SSB, m). */
SSB_EXPORT("ssb_small_body_magnitudes") int32_t ssb_small_body_magnitudes(double et, uint32_t n, const double* pos,
                                                                           const double* hg, const double* observer,
                                                                           float* out) {
    double sun[6];
    const int32_t code = ssb::state_m(10, 0, et, sun);
    if (code != ssb::Ok) return code;
    for (uint32_t i = 0; i < n; ++i) {
        const double* p = pos + 3 * i;
        double to_sun[3], to_obs[3];
        for (int c = 0; c < 3; ++c) {
            to_sun[c] = sun[c] - p[c];
            to_obs[c] = observer[c] - p[c];
        }
        const double r = ssb::norm3(to_sun), d = ssb::norm3(to_obs);
        double cosa = (r > 0.0 && d > 0.0) ? ssb::dot3(to_sun, to_obs) / (r * d) : 1.0;
        cosa = cosa > 1.0 ? 1.0 : (cosa < -1.0 ? -1.0 : cosa);
        out[i] = static_cast<float>(ssb::hg_magnitude(hg[2 * i], hg[2 * i + 1], r / ssb::kAu, d / ssb::kAu, std::acos(cosa)));
    }
    return ssb::Ok;
}

/* ======================================================================== */
/* Command surface: `evaluate` — kernels in, one JSON request, JSON out       */
/* ======================================================================== */
namespace ssb_cmd {

using Json = nlohmann::json;

inline int fail(const char* code, const std::string& message) {
    plugin_set_error(code, message.c_str());
    return 1;
}

inline bool epoch_of(const Json& params, double* et) {
    if (params.contains("et") && params["et"].is_number()) {
        *et = params["et"].get<double>();
        return true;
    }
    if (params.contains("jdTai") && params["jdTai"].is_array() && params["jdTai"].size() == 2) {
        *et = ssb::tai_to_et(params["jdTai"][0].get<double>(), params["jdTai"][1].get<double>());
        return true;
    }
    return false;
}

inline Json vec(const double* v, int n) {
    Json a = Json::array();
    for (int i = 0; i < n; ++i) a.push_back(v[i]);
    return a;
}

inline bool ids_of(const Json& params, std::vector<int32_t>* ids) {
    if (!params.contains("ids") || !params["ids"].is_array()) return false;
    for (const auto& v : params["ids"]) {
        if (!v.is_number_integer()) return false;
        ids->push_back(v.get<int32_t>());
    }
    return true;
}

inline bool vec3(const Json& params, const char* key, double out[3]) {
    if (!params.contains(key) || !params[key].is_array() || params[key].size() != 3) return false;
    for (int i = 0; i < 3; ++i) {
        if (!params[key][i].is_number()) return false;
        out[i] = params[key][i].get<double>();
    }
    return true;
}

int run(const Json& request, Json* response) {
    const std::string op = request.value("operation", std::string());
    const Json params = request.contains("params") ? request["params"] : Json::object();
    double et = 0.0;
    if (op == "catalog") {
        Json bodies = Json::array();
        for (const auto& b : ssb::kBodies) {
            Json e = {{"id", b.id}, {"name", b.name}, {"parent", b.parent}, {"kind", b.kind}, {"shard", b.shard}};
            double r[3], gm;
            if (ssb::radii_m(b.id, r)) e["radii_m"] = vec(r, 3);
            if (ssb::gm_m3s2(b.id, &gm)) e["gm_m3_s2"] = gm;
            bodies.push_back(e);
        }
        (*response)["bodies"] = bodies;
        return 0;
    }
    if (!epoch_of(params, &et)) return fail("bad-argument", "params.et (TDB s past J2000) or params.jdTai is required");
    (*response)["et"] = et;
    if (op == "states" || op == "orientations" || op == "apparent") {
        std::vector<int32_t> ids;
        if (!ids_of(params, &ids)) return fail("bad-argument", "params.ids must be an array of NAIF codes");
        double observer[3] = {0, 0, 0};
        if (op == "apparent" && !vec3(params, "observer_m", observer)) {
            return fail("bad-argument", "params.observer_m (ICRF SSB, m) is required");
        }
        const int32_t center = params.value("center", 0);
        Json rows = Json::array();
        for (int32_t id : ids) {
            Json row = {{"id", id}};
            int32_t code;
            if (op == "states") {
                double s[6];
                code = ssb::state_m(id, center, et, s);
                if (code == ssb::Ok) {
                    row["position_m"] = vec(s, 3);
                    row["velocity_m_s"] = vec(s + 3, 3);
                }
            } else if (op == "orientations") {
                double m[9], spin = 0.0;
                code = ssb::rotation(id, et, m, &spin);
                if (code == ssb::Ok) {
                    row["matrix"] = vec(m, 9);
                    row["spin_rad_s"] = spin;
                }
            } else {
                double a[7];
                code = ssb::apparent(id, et, observer, a);
                if (code == ssb::Ok) {
                    row["direction"] = vec(a, 3);
                    row["distance_m"] = a[3];
                    row["v_mag"] = a[4];
                    row["angular_radius_rad"] = a[5];
                    row["phase_rad"] = a[6];
                }
            }
            row["status"] = ssb::code_name(code);
            rows.push_back(row);
        }
        (*response)["rows"] = rows;
        return 0;
    }
    if (op == "observer_state") {
        double cam[6] = {0, 0, 0, 0, 0, 0};
        if (!vec3(params, "camera_position_m", cam)) return fail("bad-argument", "params.camera_position_m is required");
        vec3(params, "camera_velocity_m_s", cam + 3);
        double out[6];
        const int32_t code = ssb::observer_state(params.value("central", 399), et, cam, cam + 3,
                                                 params.value("corotating", false), out);
        if (code != ssb::Ok) return fail(ssb::code_name(code), "observer state unavailable");
        (*response)["position_m"] = vec(out, 3);
        (*response)["velocity_m_s"] = vec(out + 3, 3);
        return 0;
    }
    if (op == "hill_radius") {
        double r = 0.0;
        const int32_t code = ssb::hill_radius(params.value("id", 399), et, &r);
        if (code != ssb::Ok) return fail(ssb::code_name(code), "hill radius unavailable");
        (*response)["hill_radius_m"] = r;
        return 0;
    }
    return fail("unknown-operation", "operation must be catalog, states, orientations, apparent, observer_state or hill_radius");
}

}  // namespace ssb_cmd

extern "C" int evaluate(void) {
    plugin_reset_output_state();
    ssb::reset();
    const uint8_t* request = nullptr;
    uint32_t request_len = 0;
    for (uint32_t i = 0; i < plugin_get_input_count(); ++i) {
        const plugin_input_frame_t* frame = plugin_get_input_frame(i);
        const char* port = frame && frame->port_id ? frame->port_id : "";
        if (std::strcmp(port, "kernel") == 0) {
            if (ssb::load_kernel(frame->payload, frame->payload_length) < 0) {
                return ssb_cmd::fail("bad-kernel", ssb::state().error);
            }
        } else if (std::strcmp(port, "request") == 0) {
            request = frame->payload;
            request_len = frame->payload_length;
        }
    }
    if (!request) return ssb_cmd::fail("missing-request", "a 'request' JSON frame is required");
    const ssb_cmd::Json parsed = ssb_cmd::Json::parse(request, request + request_len, nullptr, false);
    if (parsed.is_discarded() || !parsed.is_object()) return ssb_cmd::fail("bad-request", "the request is not a JSON object");
    ssb_cmd::Json response = ssb_cmd::Json::object();
    if (ssb_cmd::run(parsed, &response) != 0) return 1;
    const std::string text = response.dump();
    if (plugin_push_output_ex("response", nullptr, nullptr, PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY, nullptr, 0, 1,
                              reinterpret_cast<const uint8_t*>(text.data()), static_cast<uint32_t>(text.size())) < 0) {
        return ssb_cmd::fail("output-failed", "could not push the response frame");
    }
    return 0;
}
