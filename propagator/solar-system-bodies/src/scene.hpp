/*
 * propagator/solar-system-bodies — the scene surface: everything OrbPro's
 * scene.bodies computes for a frame, so the engine's JavaScript only moves
 * values between this module's memory and GPU primitives (owner 2026-10-13:
 * "The starfield functions, all of the planetary and galactic additional
 * features should all be in WASM, and modular").
 *
 * WHAT IS HERE. Per frame: every body's state relative to the central body
 * and its fixed-frame place, the rotations a frame needs, the coverage, the
 * central body's frame, the Earth scope's rigid transform and camera, the
 * lighting, the sky observer, the apparent places and magnitudes (refreshed
 * four times a second or when the observer moved far for the nearest body),
 * the light-time and aberration shifts and the drawn places; the level of
 * detail of every body that is not central (lit ellipsoid or point, its
 * pixels, its point size and opacity from V, its pick target and whether a
 * moon gives way to a small parent's disc), its model matrix and light, the
 * stand-in positions of far points and labels, label decluttering on screen,
 * the barycentre and Milky Way labels, the Milky Way's frame and fade, the
 * sky box fade, Saturn's ring frame, the orbiters' propagation cutoff with its
 * hysteresis, the switch of central body (the camera re-expressed and the
 * flight to the day side), the camera kept outside every body, the camera
 * carried with the central body's spin, and the small-body layer's observer
 * and heliocentric frame.
 *
 * INTERNAL LAYOUT, NOT A STANDARD. These are typed arrays in the module's
 * memory that the engine reads and writes in place (engine-module buffers;
 * owner 2026-10-13: no new SDS schemas for internal-only communication). The
 * layout is `ssb_scene_layout`'s pointer table below; the index constants are
 * mirrored in OrbPro's Scene/CelestialBodyLayout.js. Matrices named `*_cm`
 * are Cesium column-major (Matrix3/Matrix4 storage); every other rotation is
 * row-major ICRF -> body-fixed, as ssb_orientations.
 */

#ifndef SSB_SCENE_HPP
#define SSB_SCENE_HPP

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <type_traits>
#include <vector>

namespace ssb_scene {

/* ---- params (double[], written by the engine) ---------------------------- */
enum Param : int {
    P_TAI_DAY = 0,
    P_TAI_SEC = 1,
    P_CENTRAL = 2,          /* index of the central body */
    P_CENTRAL_EXTERNAL = 3, /* the central body is placed by its own module */
    P_CENTRAL_HELIO = 4,    /* 6: its heliocentric state when external */
    P_CENTRAL_HELIO_OK = 10,
    P_CAM_POS = 11,  /* 3: camera positionWC */
    P_CAM_DIR = 14,  /* 3 */
    P_CAM_UP = 17,   /* 3 */
    P_CAM_RIGHT = 20, /* 3 */
    P_WALL_MS = 23,
    P_EARTH_ROT = 24, /* 9: ICRF -> ITRF at the frame time (the engine's EOP path), row-major */
    P_FOVY = 33,
    P_BUFFER_HEIGHT = 34,
    P_MIN_ELLIPSOID_PIXELS = 35,
    P_DRAW_POINTS = 36,
    P_SHOW_LABELS = 37,
    P_PICK_PASS = 38,
    P_CLIENT_WIDTH = 39,
    P_CLIENT_HEIGHT = 40,
    P_VIEW = 41,       /* 16: camera.viewMatrix, column-major */
    P_PROJECTION = 57, /* 16: camera.frustum.projectionMatrix, column-major */
    P_SSB_LABEL_SHOWN = 73,
    P_GALAXY_LABEL_SHOWN = 74,
    P_SWITCH_BODY = 76,  /* index of the body becoming central */
    P_CARRY_NOW = 77,    /* 9: ICRF -> central fixed now, row-major */
    P_CARRY_LAST = 86,   /* 9: ICRF -> central fixed last frame, row-major */
    P_COUNT = 128,
};

/* ---- outputs (double[]) --------------------------------------------------- */
enum Out : int {
    O_FRAME_VALID = 0,
    O_LOST_CENTRAL = 1,
    O_COVERAGE_WORST = 2,
    O_COVERAGE_MISSING = 3,
    O_ET = 4,
    O_CENTRAL_ROT = 5,       /* 9, row-major ICRF -> central fixed */
    O_SSB_FIXED = 14,        /* 3 */
    O_EARTH_TO_CENTRAL = 17, /* 16, column-major */
    O_CENTRAL_TO_EARTH = 33, /* 16, column-major */
    O_SCOPE_VALID = 49,
    O_SUN_WC = 50,  /* 3 */
    O_MOON_WC = 53, /* 3 */
    O_LIGHTING_VALID = 56,
    O_HILL = 57, /* -1 when undefined */
    O_OBSERVER_VALID = 58,
    O_OBSERVER = 59, /* 6: SSB position, velocity */
    O_TDB = 65,
    O_APPARENT_RECOMPUTED = 66,
    O_SB_OBSERVER = 67, /* 10: heliocentric position, barycentric velocity, Sun's velocity, et */
    O_SB_OBSERVER_COUNT = 77,
    O_HELIO_TO_WORLD = 78, /* 16, column-major */
    O_HELIO_TO_WORLD_VALID = 94,
    O_SCOPE_CAMERA = 95, /* 12: position, direction, up, right in the Earth frame */
    O_SCOPE_SUN = 107,   /* 3 */
    O_SCOPE_MOON = 110,  /* 3 */
    O_SKY_FITS = 113,
    O_SKY_BOX_ALPHA = 114,
    O_GALAXY_ALPHA = 115,
    O_WORLD_TO_GALAXY = 116, /* 9, column-major (Matrix3) */
    O_GALAXY_CENTRE = 125,   /* 3 */
    O_GALAXY_CAMERA_KPC = 128, /* 3 */
    O_SSB_LABEL_SHOW = 131,
    O_SSB_LABEL_REL = 132, /* 3 */
    O_GALAXY_LABEL_SHOW = 135,
    O_GALAXY_LABEL_REL = 136, /* 3 */
    O_DECLUTTER = 139,
    O_PIXEL_ANGLE = 140,
    O_OUT_OF_RANGE = 141,
    O_SWITCH_OK = 160,
    O_SWITCH_TRANSFORM = 161, /* 16 body -> central, column-major */
    O_SWITCH_CAMERA = 177,    /* 12: position, direction, up, right in the new frame */
    O_SWITCH_SUN_VALID = 189,
    O_SWITCH_DESTINATION = 190, /* 3 */
    O_SWITCH_DIRECTION = 193,   /* 3 */
    O_SWITCH_UP = 196,          /* 3 */
    O_TRANSFORM_OK = 199,
    O_TRANSFORM = 200, /* 16: ssb_scene_body_transform, column-major */
    O_CARRY_CAMERA = 216, /* 12 */
    O_COUNT = 256,
};

/* ---- per-body input flags ------------------------------------------------- */
enum BodyFlag : int32_t {
    F_EXTERNAL = 1,        /* placed by its own module (heliocentric state from the engine) */
    F_SHOW = 2,            /* body.show */
    F_EXTERNAL_OFFSET = 4, /* its own module gives its light-time shift */
    F_NO_LABEL = 8,        /* body.showLabel is false: hidden every frame, no declutter slot.
                           * Set by the engine (CelestialBodyRegistry writeBodies); zero
                           * by default, preserving engines that do not set it. */
};

/* ---- per-body draw flags (output) ----------------------------------------- */
enum DrawFlag : int32_t {
    D_HIDE = 1,            /* point, pick and label hidden */
    D_POINT_SHOW = 2,
    D_PICK_SHOW = 4,
    D_LABEL_SET = 8,       /* set the label's show to D_LABEL_SHOW */
    D_LABEL_SHOW = 16,
    D_ELLIPSOID = 32,      /* draw the lit ellipsoid with D_MODEL */
    D_ELLIPSOID_PICKABLE = 64,
    D_LIGHT = 128,         /* the light direction is valid */
    D_RING_SET = 256,      /* set the ring's show to D_RING_SHOW */
    D_RING_SHOW = 512,
    D_POINT_MOVED = 1024,  /* write the point and pick positions */
    D_LABEL_MOVED = 2048,  /* write the label position */
    D_STYLE = 4096,        /* the point's size and opacity are set */
};

constexpr int32_t kEarth = 399, kSun = 10, kMoon = 301, kSaturn = 699;
constexpr int32_t kOutOfRange = -5;
constexpr double kApparentIntervalMs = 250.0;
constexpr double kSystemLabelDistance = 1.0e14;
constexpr double kGalaxyLabelDistance = 3.0e19;
constexpr double kProxyDistance = 1.0e9;
constexpr double kPickPixels = 10.0;
constexpr double kMinimumLabelSeparation = 36.0;
constexpr int kDeclutterFrames = 3;
constexpr double kSkyFadeStart = 1.0e15, kSkyFadeEnd = 1.0e16;
constexpr double kKiloparsec = (1000.0 * 149597870700.0 * 648000.0) / 3.14159265358979323846;
constexpr double kPiOverThree = 3.14159265358979323846 / 3.0;
/* The orbiter propagation cutoff, in mean radii of the body orbited (owner
 * 2026-10-17: "when the camera moves away 100x the radius of any central
 * body the satellites for that central body should be hidden"), and the
 * resume distance inside it (the hysteresis band). The one definition: see
 * scopes(). */
constexpr double kOrbiterCutoffRadii = 100.0;
constexpr double kOrbiterResumeRadii = 90.0;

struct Scene {
    uint32_t capacity = 0, n = 0;
    double params[P_COUNT] = {};
    double out[O_COUNT] = {};
    std::vector<int32_t> ids, flags, kinds, parents, extOk, status, rotStatus, appStatus, offStatus, suspended,
        suspendedChanged, drawFlags, ellipsoid;
    std::vector<double> radii, extHelio, hg, cutoff, state, rot, fixed, drawn, app, off, pointRel, labelRel, style,
        model, light, ring, labelWorld, lastPoint, lastLabel, ringSun;
    std::vector<uint8_t> hasLastPoint, hasLastLabel, hasRingSun;
    /* declutter scratch, sized with the bodies (the frame path allocates nothing) */
    std::vector<uint32_t> order;
    std::vector<double> placed;
    /* persistent between frames */
    bool apparentValid = false;
    double apparentTime = 0.0;
    int32_t apparentCentral = 0;
    double apparentObserver[3] = {0, 0, 0};
    int labelFrame = 0;
    double ssbState[6] = {};
    uint32_t layout[64] = {};
};

inline Scene& scene() {
    static Scene s;
    return s;
}

/* ---- small vector and matrix helpers (Cesium's operation order) ----------- */
inline double mag(const double* v) { return std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); }
inline double dist(const double* a, const double* b) {
    const double d[3] = {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
    return mag(d);
}
inline void normalize(double* v) {
    const double m = mag(v);
    v[0] /= m;
    v[1] /= m;
    v[2] /= m;
}
inline void cross(const double* a, const double* b, double* out) {
    const double x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0];
    out[0] = x;
    out[1] = y;
    out[2] = z;
}
inline double clampd(double v, double lo, double hi) { return v < lo ? lo : (v > hi ? hi : v); }
/* row-major R * v */
inline void mulRv(const double* r, const double* v, double* out) {
    const double x = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
    const double y = r[3] * v[0] + r[4] * v[1] + r[5] * v[2];
    const double z = r[6] * v[0] + r[7] * v[1] + r[8] * v[2];
    out[0] = x;
    out[1] = y;
    out[2] = z;
}
/* row-major R^T * v */
inline void mulRTv(const double* r, const double* v, double* out) {
    const double x = r[0] * v[0] + r[3] * v[1] + r[6] * v[2];
    const double y = r[1] * v[0] + r[4] * v[1] + r[7] * v[2];
    const double z = r[2] * v[0] + r[5] * v[1] + r[8] * v[2];
    out[0] = x;
    out[1] = y;
    out[2] = z;
}
/* row-major A * B^T */
inline void mulABt(const double* a, const double* b, double* out) {
    double t[9];
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j) t[i * 3 + j] = a[i * 3] * b[j * 3] + a[i * 3 + 1] * b[j * 3 + 1] + a[i * 3 + 2] * b[j * 3 + 2];
    std::copy(t, t + 9, out);
}
/* row-major rotation and translation -> Cesium column-major Matrix4 */
inline void rigidCm(const double* r, const double* t, double* m) {
    m[0] = r[0]; m[1] = r[3]; m[2] = r[6]; m[3] = 0.0;
    m[4] = r[1]; m[5] = r[4]; m[6] = r[7]; m[7] = 0.0;
    m[8] = r[2]; m[9] = r[5]; m[10] = r[8]; m[11] = 0.0;
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1.0;
}
/* inverse of a rigid column-major transform (Matrix4.inverseTransformation) */
inline void inverseRigidCm(const double* m, double* out) {
    const double r0 = m[0], r1 = m[1], r2 = m[2], r3 = m[4], r4 = m[5], r5 = m[6], r6 = m[8], r7 = m[9], r8 = m[10];
    const double tx = m[12], ty = m[13], tz = m[14];
    out[0] = r0; out[1] = r3; out[2] = r6; out[3] = 0.0;
    out[4] = r1; out[5] = r4; out[6] = r7; out[7] = 0.0;
    out[8] = r2; out[9] = r5; out[10] = r8; out[11] = 0.0;
    out[12] = -r0 * tx - r1 * ty - r2 * tz;
    out[13] = -r3 * tx - r4 * ty - r5 * tz;
    out[14] = -r6 * tx - r7 * ty - r8 * tz;
    out[15] = 1.0;
}
inline void cmPoint(const double* m, const double* p, double* out) {
    const double x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const double y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const double z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
    out[0] = x;
    out[1] = y;
    out[2] = z;
}
inline void cmVector(const double* m, const double* p, double* out) {
    const double x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2];
    const double y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2];
    const double z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2];
    out[0] = x;
    out[1] = y;
    out[2] = z;
}
inline void identity9(double* r) {
    for (int k = 0; k < 9; ++k) r[k] = (k % 4 == 0) ? 1.0 : 0.0;
}
inline double angleBetween(const double* a, const double* b) {
    double na[3] = {a[0], a[1], a[2]}, nb[3] = {b[0], b[1], b[2]};
    normalize(na);
    normalize(nb);
    const double c = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
    double x[3];
    cross(na, nb, x);
    return std::atan2(mag(x), c);
}

inline int32_t indexOf(const Scene& s, int32_t id) {
    for (uint32_t i = 0; i < s.n; ++i)
        if (s.ids[i] == id) return static_cast<int32_t>(i);
    return -1;
}
inline double maxRadius(const Scene& s, uint32_t i) {
    return std::max(s.radii[3 * i], std::max(s.radii[3 * i + 1], s.radii[3 * i + 2]));
}

/* The sky box's opacity for an observer this far from the barycentre: 1 up to
 * 1e15 m, 0 from 1e16 m, linear in log distance between. */
inline double skyAlphaAtDistance(double d) {
    if (!(d > kSkyFadeStart)) return 1.0;
    const double t = (std::log10(d) - std::log10(kSkyFadeStart)) / (std::log10(kSkyFadeEnd) - std::log10(kSkyFadeStart));
    return std::min(1.0, std::max(0.0, 1.0 - t));
}

/* ---- layout ---------------------------------------------------------------- */
enum Slot : int {
    S_CAPACITY = 0, S_N, S_PARAMS, S_OUT, S_IDS, S_FLAGS, S_KINDS, S_PARENTS, S_RADII, S_EXT_HELIO, S_EXT_OK, S_HG,
    S_CUTOFF, S_STATE, S_STATUS, S_ROT, S_ROT_STATUS, S_FIXED, S_DRAWN, S_APP, S_APP_STATUS, S_OFF, S_OFF_STATUS,
    S_SUSPENDED, S_SUSPENDED_CHANGED, S_DRAW_FLAGS, S_POINT_REL, S_LABEL_REL, S_STYLE, S_MODEL, S_LIGHT, S_RING,
    S_ELLIPSOID, S_COUNT
};

template <class T>
inline uint32_t ptr(std::vector<T>& v) {
    return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(v.data()));
}

inline void writeLayout(Scene& s) {
    uint32_t* l = s.layout;
    l[S_CAPACITY] = s.capacity;
    l[S_N] = s.n;
    l[S_PARAMS] = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(s.params));
    l[S_OUT] = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(s.out));
    l[S_IDS] = ptr(s.ids); l[S_FLAGS] = ptr(s.flags); l[S_KINDS] = ptr(s.kinds); l[S_PARENTS] = ptr(s.parents);
    l[S_RADII] = ptr(s.radii); l[S_EXT_HELIO] = ptr(s.extHelio); l[S_EXT_OK] = ptr(s.extOk); l[S_HG] = ptr(s.hg);
    l[S_CUTOFF] = ptr(s.cutoff); l[S_STATE] = ptr(s.state); l[S_STATUS] = ptr(s.status); l[S_ROT] = ptr(s.rot);
    l[S_ROT_STATUS] = ptr(s.rotStatus); l[S_FIXED] = ptr(s.fixed); l[S_DRAWN] = ptr(s.drawn); l[S_APP] = ptr(s.app);
    l[S_APP_STATUS] = ptr(s.appStatus); l[S_OFF] = ptr(s.off); l[S_OFF_STATUS] = ptr(s.offStatus);
    l[S_SUSPENDED] = ptr(s.suspended); l[S_SUSPENDED_CHANGED] = ptr(s.suspendedChanged);
    l[S_DRAW_FLAGS] = ptr(s.drawFlags); l[S_POINT_REL] = ptr(s.pointRel); l[S_LABEL_REL] = ptr(s.labelRel);
    l[S_STYLE] = ptr(s.style); l[S_MODEL] = ptr(s.model); l[S_LIGHT] = ptr(s.light); l[S_RING] = ptr(s.ring);
    l[S_ELLIPSOID] = ptr(s.ellipsoid);
}

/* Sizes the arrays for n bodies. With keep, the first min(old, n) bodies keep
 * their values (a body was appended); the rest start unknown. The arrays are
 * reserved with room for 64 more bodies, so appending one (a promoted
 * asteroid) allocates nothing while a kernel loads on the loader thread. */
inline void resize(uint32_t n, bool keep) {
    Scene& s = scene();
    const uint32_t old = keep ? std::min(s.n, n) : 0;
    if (n > s.capacity || s.ids.empty()) {
        const uint32_t cap = n + 64;
        auto grow = [&](auto& v, size_t stride, auto fill) {
            using T = typename std::remove_reference<decltype(v)>::type::value_type;
            std::vector<T> next(stride * cap, static_cast<T>(fill));
            const size_t k = std::min(stride * old, v.size());
            for (size_t i = 0; i < k; ++i) next[i] = v[i];
            v.swap(next);
        };
        grow(s.ids, 1, 0); grow(s.flags, 1, 0); grow(s.kinds, 1, 0); grow(s.parents, 1, -1); grow(s.radii, 3, 0.0);
        grow(s.extHelio, 6, 0.0); grow(s.extOk, 1, 0); grow(s.hg, 2, NAN); grow(s.cutoff, 2, 0.0); grow(s.state, 6, 0.0);
        grow(s.status, 1, -9); grow(s.rot, 10, 0.0); grow(s.rotStatus, 1, -9); grow(s.fixed, 3, 0.0); grow(s.drawn, 3, 0.0);
        grow(s.app, 7, 0.0); grow(s.appStatus, 1, -9); grow(s.off, 3, 0.0); grow(s.offStatus, 1, -9);
        grow(s.suspended, 1, 0); grow(s.suspendedChanged, 1, 0); grow(s.drawFlags, 1, 0); grow(s.pointRel, 3, 0.0);
        grow(s.labelRel, 3, 0.0); grow(s.style, 2, 0.0); grow(s.model, 16, 0.0); grow(s.light, 3, 0.0); grow(s.ring, 6, 0.0);
        grow(s.ellipsoid, 1, 0); grow(s.labelWorld, 3, 0.0); grow(s.lastPoint, 3, 0.0); grow(s.lastLabel, 3, 0.0);
        grow(s.hasLastPoint, 1, 0); grow(s.hasLastLabel, 1, 0); grow(s.ringSun, 3, 0.0); grow(s.hasRingSun, 1, 0);
        s.order.assign(cap, 0);
        s.placed.assign(2 * (cap + 2), 0.0);
        s.capacity = cap;
    } else {
        /* the bodies past `old` start unknown, in place */
        auto clear = [&](auto& v, size_t stride, auto fill) {
            using T = typename std::remove_reference<decltype(v)>::type::value_type;
            std::fill(v.begin() + stride * old, v.begin() + stride * s.capacity, static_cast<T>(fill));
        };
        clear(s.ids, 1, 0); clear(s.flags, 1, 0); clear(s.kinds, 1, 0); clear(s.parents, 1, -1); clear(s.radii, 3, 0.0);
        clear(s.extHelio, 6, 0.0); clear(s.extOk, 1, 0); clear(s.hg, 2, NAN); clear(s.cutoff, 2, 0.0); clear(s.state, 6, 0.0);
        clear(s.status, 1, -9); clear(s.rot, 10, 0.0); clear(s.rotStatus, 1, -9); clear(s.fixed, 3, 0.0); clear(s.drawn, 3, 0.0);
        clear(s.app, 7, 0.0); clear(s.appStatus, 1, -9); clear(s.off, 3, 0.0); clear(s.offStatus, 1, -9);
        clear(s.suspended, 1, 0); clear(s.suspendedChanged, 1, 0); clear(s.drawFlags, 1, 0); clear(s.pointRel, 3, 0.0);
        clear(s.labelRel, 3, 0.0); clear(s.style, 2, 0.0); clear(s.model, 16, 0.0); clear(s.light, 3, 0.0); clear(s.ring, 6, 0.0);
        clear(s.ellipsoid, 1, 0); clear(s.labelWorld, 3, 0.0); clear(s.lastPoint, 3, 0.0); clear(s.lastLabel, 3, 0.0);
        clear(s.hasLastPoint, 1, 0); clear(s.hasLastLabel, 1, 0); clear(s.ringSun, 3, 0.0); clear(s.hasRingSun, 1, 0);
    }
    s.n = n;
    if (!keep) s.out[O_FRAME_VALID] = 0.0;
    writeLayout(s);
}

/* Removes body i from every array (a promoted body released): the bodies
 * after it move up in place. */
inline void removeAt(uint32_t i) {
    Scene& s = scene();
    if (i >= s.n) return;
    auto drop = [&](auto& v, size_t stride) {
        std::copy(v.begin() + stride * (i + 1), v.begin() + stride * s.n, v.begin() + stride * i);
    };
    drop(s.ids, 1); drop(s.flags, 1); drop(s.kinds, 1); drop(s.parents, 1); drop(s.radii, 3); drop(s.extHelio, 6);
    drop(s.extOk, 1); drop(s.hg, 2); drop(s.cutoff, 2); drop(s.state, 6); drop(s.status, 1); drop(s.rot, 10);
    drop(s.rotStatus, 1); drop(s.fixed, 3); drop(s.drawn, 3); drop(s.app, 7); drop(s.appStatus, 1); drop(s.off, 3);
    drop(s.offStatus, 1); drop(s.suspended, 1); drop(s.suspendedChanged, 1); drop(s.drawFlags, 1);
    drop(s.pointRel, 3); drop(s.labelRel, 3); drop(s.style, 2); drop(s.model, 16); drop(s.light, 3); drop(s.ring, 6);
    drop(s.ellipsoid, 1); drop(s.labelWorld, 3); drop(s.lastPoint, 3); drop(s.lastLabel, 3); drop(s.hasLastPoint, 1);
    drop(s.hasLastLabel, 1); drop(s.ringSun, 3); drop(s.hasRingSun, 1);
    for (uint32_t k = 0; k + 1 < s.n; ++k)
        if (s.parents[k] == static_cast<int32_t>(i)) s.parents[k] = -1;
        else if (s.parents[k] > static_cast<int32_t>(i)) s.parents[k] -= 1;
    s.n -= 1;
    writeLayout(s);
}

/* ---- rotations -------------------------------------------------------------- */
inline double et() { return scene().out[O_ET]; }

/* The rotation of body i at the frame's time, evaluated now when the frame
 * skipped it (a body not drawn as an ellipsoid). */
inline void ensureRotation(uint32_t i) {
    Scene& s = scene();
    if (s.rotStatus[i] == 0 || s.ids[i] == kEarth) return;
    double spin = 0.0;
    s.rotStatus[i] = ssb::rotation(s.ids[i], et(), &s.rot[10 * i], &spin);
    if (s.rotStatus[i] == 0) s.rot[10 * i + 9] = spin;
}

/* R_central * R_body^T: body-fixed axes into central-fixed axes (row-major). */
inline void bodyToCentralRotation(uint32_t i, double* out) {
    Scene& s = scene();
    double body[9];
    if (s.ids[i] == kEarth) std::copy(s.params + P_EARTH_ROT, s.params + P_EARTH_ROT + 9, body);
    else if (s.rotStatus[i] == 0) std::copy(&s.rot[10 * i], &s.rot[10 * i] + 9, body);
    else identity9(body);
    mulABt(s.out + O_CENTRAL_ROT, body, out);
}

/* The rigid transform from body i's fixed frame to the central body's (Cesium
 * column-major), or false when its place is unknown. */
inline bool bodyToCentralTransform(uint32_t i, double* m) {
    Scene& s = scene();
    if (s.out[O_FRAME_VALID] == 0.0) return false;
    const uint32_t c = static_cast<uint32_t>(s.params[P_CENTRAL]);
    if (i == c) {
        const double r[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1}, t[3] = {0, 0, 0};
        rigidCm(r, t, m);
        return true;
    }
    if (s.ids[i] == kEarth) {
        std::copy(s.out + O_EARTH_TO_CENTRAL, s.out + O_EARTH_TO_CENTRAL + 16, m);
        return true;
    }
    if (s.status[i] != 0) return false;
    ensureRotation(i);
    double r[9];
    bodyToCentralRotation(i, r);
    rigidCm(r, &s.fixed[3 * i], m);
    return true;
}

/* ---- the frame ---------------------------------------------------------------- */
inline void updateCoverage(int32_t worst, int32_t missing) {
    Scene& s = scene();
    s.out[O_COVERAGE_WORST] = worst;
    s.out[O_COVERAGE_MISSING] = missing;
}

inline bool observerMovedFar(const double* observer, const double* cam) {
    Scene& s = scene();
    const double moved = dist(observer, s.apparentObserver);
    if (!(moved > 0.0)) return false;
    const uint32_t c = static_cast<uint32_t>(s.params[P_CENTRAL]);
    double nearest = INFINITY;
    for (uint32_t i = 0; i < s.n; ++i) {
        if (s.status[i] != 0 || i == c) continue;
        nearest = std::min(nearest, dist(&s.fixed[3 * i], cam));
    }
    return moved > 0.05 * nearest;
}

/* Every body's state relative to the central body, its fixed-frame place, the
 * central body's frame, the Earth scope, the lighting, the sky observer and,
 * when due, the apparent places and shifts (CelestialBodyCollection's frame).
 * The light-time shifts of bodies placed by their own module are left to it
 * (O_APPARENT_RECOMPUTED, O_SB_OBSERVER); ssb_scene_place then draws them. */
inline void frame() {
    Scene& s = scene();
    double* o = s.out;
    const double* p = s.params;
    const uint32_t n = s.n;
    o[O_FRAME_VALID] = 0.0;
    o[O_LOST_CENTRAL] = 0.0;
    o[O_SCOPE_VALID] = 0.0;
    o[O_LIGHTING_VALID] = 0.0;
    o[O_OBSERVER_VALID] = 0.0;
    o[O_APPARENT_RECOMPUTED] = 0.0;
    o[O_SB_OBSERVER_COUNT] = 0.0;
    o[O_HELIO_TO_WORLD_VALID] = 0.0;
    o[O_OUT_OF_RANGE] = 0.0;
    o[O_SKY_BOX_ALPHA] = skyAlphaAtDistance(mag(p + P_CAM_POS));
    const double e = ssb::tai_to_et(p[P_TAI_DAY], p[P_TAI_SEC]);
    o[O_ET] = e;
    const uint32_t ci = static_cast<uint32_t>(p[P_CENTRAL]);
    const int32_t centralId = s.ids[ci];
    const bool centralExternal = p[P_CENTRAL_EXTERNAL] != 0.0;
    const double* ch = p + P_CENTRAL_HELIO;
    if (centralExternal && p[P_CENTRAL_HELIO_OK] == 0.0) {
        o[O_LOST_CENTRAL] = 1.0;
        updateCoverage(kOutOfRange, static_cast<int32_t>(n));
        return;
    }
    const int32_t center = centralExternal ? kSun : centralId;
    for (uint32_t i = 0; i < n; ++i) {
        s.status[i] = ssb::state_m(s.ids[i], center, e, &s.state[6 * i]);
        if (s.status[i] != 0) {
            for (int k = 0; k < 6; ++k) s.state[6 * i + k] = 0.0;
            if (s.status[i] == kOutOfRange) o[O_OUT_OF_RANGE] = 1.0;
        }
    }
    /* bodies placed by their own module */
    if (centralExternal) {
        for (uint32_t i = 0; i < n; ++i)
            if (s.status[i] == 0)
                for (int k = 0; k < 6; ++k) s.state[6 * i + k] -= ch[k];
    }
    const int32_t si = indexOf(s, kSun);
    for (uint32_t i = 0; i < n; ++i) {
        if (!(s.flags[i] & F_EXTERNAL)) continue;
        if (i == ci) {
            for (int k = 0; k < 6; ++k) s.state[6 * i + k] = 0.0;
            s.status[i] = 0;
            continue;
        }
        if (!s.extOk[i]) {
            s.status[i] = -9;
            continue;
        }
        if (centralExternal) {
            for (int k = 0; k < 6; ++k) s.state[6 * i + k] = s.extHelio[6 * i + k] - ch[k];
            s.status[i] = 0;
        } else if (si >= 0 && s.status[si] == 0) {
            for (int k = 0; k < 6; ++k) s.state[6 * i + k] = s.extHelio[6 * i + k] + s.state[6 * si + k];
            s.status[i] = 0;
        } else {
            s.status[i] = -9;
        }
    }
    /* rotations only for the bodies that use one this frame */
    for (uint32_t i = 0; i < n; ++i) {
        s.rotStatus[i] = -9;
        if (s.ids[i] != kEarth && (i == ci || s.ellipsoid[i])) {
            double spin = 0.0;
            s.rotStatus[i] = ssb::rotation(s.ids[i], e, &s.rot[10 * i], &spin);
            if (s.rotStatus[i] == 0) s.rot[10 * i + 9] = spin;
            else
                for (int k = 0; k < 10; ++k) s.rot[10 * i + k] = 0.0;
        }
    }
    /* coverage */
    int32_t missing = 0, worst = 0;
    for (uint32_t i = 0; i < n; ++i) {
        if (s.status[i] != 0) {
            ++missing;
            if (s.status[i] == kOutOfRange) worst = kOutOfRange;
        }
    }
    const bool sunKnown = si < 0 || s.status[si] == 0;
    updateCoverage(worst, missing);
    double* r = o + O_CENTRAL_ROT;
    if (centralId == kEarth) {
        std::copy(p + P_EARTH_ROT, p + P_EARTH_ROT + 9, r);
    } else if (centralExternal && s.rotStatus[ci] != 0) {
        identity9(r);
    } else {
        if (s.rotStatus[ci] != 0 || s.status[ci] != 0 || !sunKnown) {
            o[O_LOST_CENTRAL] = 1.0;
            return;
        }
        std::copy(&s.rot[10 * ci], &s.rot[10 * ci] + 9, r);
    }
    if (!sunKnown) return;
    /* the barycentre and every fixed-frame place */
    double ssbState[6];
    if (ssb::state_m(0, center, e, ssbState) != 0)
        for (double& v : ssbState) v = 0.0;
    if (centralExternal)
        for (int k = 0; k < 3; ++k) ssbState[k] -= ch[k];
    mulRv(r, ssbState, o + O_SSB_FIXED);
    for (uint32_t i = 0; i < n; ++i) mulRv(r, &s.state[6 * i], &s.fixed[3 * i]);
    o[O_FRAME_VALID] = 1.0;
    /* the Earth scope and the lighting */
    if (centralId != kEarth) {
        const int32_t ei = indexOf(s, kEarth);
        if (ei >= 0 && s.status[ei] == 0) {
            double er[9];
            bodyToCentralRotation(static_cast<uint32_t>(ei), er);
            rigidCm(er, &s.fixed[3 * ei], o + O_EARTH_TO_CENTRAL);
            inverseRigidCm(o + O_EARTH_TO_CENTRAL, o + O_CENTRAL_TO_EARTH);
            o[O_SCOPE_VALID] = 1.0;
        }
        const int32_t mi = indexOf(s, centralId == kMoon ? kEarth : kMoon);
        if (si >= 0) {
            std::copy(&s.fixed[3 * si], &s.fixed[3 * si] + 3, o + O_SUN_WC);
            if (mi >= 0 && s.status[mi] == 0) std::copy(&s.fixed[3 * mi], &s.fixed[3 * mi] + 3, o + O_MOON_WC);
            else std::copy(o + O_SUN_WC, o + O_SUN_WC + 3, o + O_MOON_WC);
            o[O_LIGHTING_VALID] = 1.0;
        }
    }
    /* the sky observer */
    double hill = -1.0;
    if (!centralExternal) {
        double h = 0.0;
        if (ssb::hill_radius(centralId, e, &h) == 0 && h > 0.0) hill = h;
    }
    o[O_HILL] = hill;
    const double* cam = p + P_CAM_POS;
    double camIcrf[3];
    mulRTv(r, cam, camIcrf);
    const bool corotating = !centralExternal && (hill < 0.0 || mag(camIcrf) < hill);
    double cs[6] = {camIcrf[0], camIcrf[1], camIcrf[2], 0.0, 0.0, 0.0};
    if (centralExternal)
        for (int k = 0; k < 3; ++k) {
            cs[k] += ch[k];
            cs[k + 3] = ch[k + 3];
        }
    double* obs = o + O_OBSERVER;
    if (ssb::observer_state(centralExternal ? kSun : centralId, e, cs, cs + 3, corotating, obs) == 0) {
        o[O_OBSERVER_VALID] = 1.0;
        o[O_TDB] = e;
        const double now = p[P_WALL_MS];
        if (!s.apparentValid || now - s.apparentTime > kApparentIntervalMs || s.apparentCentral != centralId ||
            observerMovedFar(obs, cam)) {
            s.apparentValid = true;
            s.apparentTime = now;
            s.apparentCentral = centralId;
            std::copy(obs, obs + 3, s.apparentObserver);
            o[O_APPARENT_RECOMPUTED] = 1.0;
            for (uint32_t i = 0; i < n; ++i) {
                s.appStatus[i] = ssb::apparent(s.ids[i], e, obs, &s.app[7 * i]);
                if (s.appStatus[i] != 0)
                    for (int k = 0; k < 7; ++k) s.app[7 * i + k] = 0.0;
            }
            for (uint32_t i = 0; i < n; ++i) {
                if (!(s.flags[i] & F_EXTERNAL)) continue;
                s.appStatus[i] = -9;
                if (!s.extOk[i]) continue;
                const double mean = (s.radii[3 * i] + s.radii[3 * i + 1] + s.radii[3 * i + 2]) / 3.0;
                double a[7];
                if (ssb::apparent_point(e, obs, kSun, &s.extHelio[6 * i], s.hg[2 * i], s.hg[2 * i + 1], mean, a) == 0) {
                    std::copy(a, a + 7, &s.app[7 * i]);
                    s.appStatus[i] = 0;
                }
            }
            for (uint32_t i = 0; i < n; ++i) {
                s.offStatus[i] = ssb::apparent_offset(s.ids[i], e, obs, &s.off[3 * i]);
                if (s.offStatus[i] != 0)
                    for (int k = 0; k < 3; ++k) s.off[3 * i + k] = 0.0;
            }
            /* the observer bodies placed by their own module are shifted with */
            bool any = false;
            for (uint32_t i = 0; i < n; ++i)
                if (s.flags[i] & F_EXTERNAL_OFFSET) {
                    s.offStatus[i] = -9;
                    any = true;
                }
            if (any) {
                double sunBary[6];
                if (ssb::state_m(kSun, 0, e, sunBary) == 0) {
                    double* so = o + O_SB_OBSERVER;
                    for (int k = 0; k < 3; ++k) {
                        so[k] = obs[k] - sunBary[k];
                        so[3 + k] = obs[3 + k];
                        so[6 + k] = sunBary[3 + k];
                    }
                    so[9] = e;
                    o[O_SB_OBSERVER_COUNT] = 10.0;
                }
            }
        }
    }
    /* the small-body layer: heliocentric ICRF into the central frame */
    if (si >= 0 && s.status[si] == 0) {
        rigidCm(r, &s.fixed[3 * si], o + O_HELIO_TO_WORLD);
        o[O_HELIO_TO_WORLD_VALID] = 1.0;
    }
    /* the sky box fade, from the observer (or the camera) */
    o[O_SKY_BOX_ALPHA] = skyAlphaAtDistance(o[O_OBSERVER_VALID] != 0.0 ? mag(obs) : mag(cam));
    /* the sky provider fits only from the Earth inside its Hill sphere */
    o[O_SKY_FITS] = (centralId == kEarth && (hill < 0.0 || mag(cam) <= hill)) ? 1.0 : 0.0;
}

/* The small-body layer's snapshot observer for this frame (see
 * SmallBodyLayer): heliocentric camera position (ICRF), the observer's
 * barycentric velocity, the Sun's barycentric velocity and the epoch; three
 * values (position only) when there is no observer. */
inline int32_t smallBodyObserver(double* out10) {
    Scene& s = scene();
    const double* o = s.out;
    if (o[O_FRAME_VALID] == 0.0) return 0;
    const int32_t si = indexOf(s, kSun);
    if (si < 0 || s.status[si] != 0) return 0;
    double rel[3];
    for (int k = 0; k < 3; ++k) rel[k] = s.params[P_CAM_POS + k] - s.fixed[3 * si + k];
    mulRTv(o + O_CENTRAL_ROT, rel, out10);
    double sunBary[6];
    if (o[O_OBSERVER_VALID] == 0.0 || ssb::state_m(kSun, 0, o[O_ET], sunBary) != 0) return 3;
    for (int k = 0; k < 3; ++k) {
        out10[3 + k] = o[O_OBSERVER + 3 + k];
        out10[6 + k] = sunBary[3 + k];
    }
    out10[9] = o[O_ET];
    return 10;
}

/* Where each body is drawn: its fixed place plus its light-time and
 * aberration shift turned into the central frame (the central body is the
 * frame and is not shifted). */
inline void place() {
    Scene& s = scene();
    const uint32_t ci = static_cast<uint32_t>(s.params[P_CENTRAL]);
    for (uint32_t i = 0; i < s.n; ++i) {
        for (int k = 0; k < 3; ++k) s.drawn[3 * i + k] = s.fixed[3 * i + k];
        if (s.offStatus[i] != 0 || i == ci) continue;
        double off[3];
        mulRv(s.out + O_CENTRAL_ROT, &s.off[3 * i], off);
        for (int k = 0; k < 3; ++k) s.drawn[3 * i + k] += off[k];
    }
}

/* ---- level of detail and drawing ---------------------------------------- */

/* A stand-in on the line of sight from the camera to target: in front of the
 * body by clearance and no farther than about PROXY_DISTANCE. */
inline void proxyPosition(const double* cam, const double* target, double clearance, double* out,
                          bool compressDistance = true) {
    double d[3] = {target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]};
    const double distance = mag(d);
    if (!(distance > 0.0)) {
        std::copy(target, target + 3, out);
        return;
    }
    const double nearer = std::max(distance - clearance, 0.5 * distance);
    const double along =
        !compressDistance || nearer <= kProxyDistance ? nearer : kProxyDistance * (1.0 + 0.05 * std::log2(nearer / kProxyDistance));
    const double f = along / distance;
    for (int k = 0; k < 3; ++k) out[k] = cam[k] + d[k] * f;
}

inline bool onSmallParent(uint32_t i, const double* position, const double* cam, double pixelAngle) {
    Scene& s = scene();
    const int32_t pi = s.parents[i];
    const uint32_t ci = static_cast<uint32_t>(s.params[P_CENTRAL]);
    if (s.kinds[i] != 2 || pi < 0 || !(s.flags[pi] & F_SHOW)) return false;
    /* A central parent is the origin; it counts too while it is a few
     * pixels across (the Earth seen from far out: its Moon gives way to it). */
    const bool parentCentral = static_cast<uint32_t>(pi) == ci;
    if (!parentCentral && s.status[pi] != 0) return false;
    double toParent[3];
    for (int k = 0; k < 3; ++k) toParent[k] = (parentCentral ? 0.0 : s.drawn[3 * pi + k]) - cam[k];
    const double pd = mag(toParent);
    const double pr = maxRadius(s, static_cast<uint32_t>(pi));
    const double parentPixels = pr / std::max(pd, pr) / pixelAngle;
    if (!(parentPixels < kPickPixels)) return false;
    double toBody[3];
    for (int k = 0; k < 3; ++k) toBody[k] = position[k] - cam[k];
    const double separation = angleBetween(toParent, toBody) / pixelAngle;
    return separation < parentPixels + 0.5 * kPickPixels;
}

/* Whether a position written last frame is still within a tenth of a pixel
 * (the anchor is the camera, so |position| is the viewing distance). */
inline bool moved(const double* last, bool hasLast, const double* next, double pixelAngle) {
    return !hasLast || dist(last, next) >= 0.1 * pixelAngle * mag(next);
}

/* Galaxy placement (also needed for the label decision in draw). */
inline void galaxy(bool wanted, const double* icrfToGalactic, const double* centreFromSun) {
    Scene& s = scene();
    double* o = s.out;
    o[O_GALAXY_ALPHA] = 0.0;
    if (!wanted || o[O_FRAME_VALID] == 0.0) return;
    const double* cam = s.params + P_CAM_POS;
    const double fromSsb = dist(cam, o + O_SSB_FIXED);
    double alpha = 1.0 - skyAlphaAtDistance(fromSsb);
    if (!(alpha > 0.0)) return;
    const int32_t si = indexOf(s, kSun);
    if (si < 0 || s.status[si] != 0) return;
    /* world -> ICRF -> Galactic: G * R^T (row-major), stored column-major */
    const double* r = o + O_CENTRAL_ROT;
    double w2g[9];
    mulABt(icrfToGalactic, r, w2g);
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j) o[O_WORLD_TO_GALAXY + j * 3 + i] = w2g[i * 3 + j];
    double centre[3];
    mulRv(r, centreFromSun, centre);
    for (int k = 0; k < 3; ++k) o[O_GALAXY_CENTRE + k] = s.fixed[3 * si + k] + centre[k];
    double offset[3];
    for (int k = 0; k < 3; ++k) offset[k] = cam[k] - o[O_GALAXY_CENTRE + k];
    double kpc[3];
    mulRv(w2g, offset, kpc);
    for (int k = 0; k < 3; ++k) o[O_GALAXY_CAMERA_KPC + k] = kpc[k] / kKiloparsec;
    o[O_GALAXY_ALPHA] = alpha;
}

inline int32_t rankTimesTwo(uint32_t i) {
    static const int32_t kKindRank[5] = {0, 1, 3, 2, 4};
    Scene& s = scene();
    if (s.ids[i] == kEarth) return 1; /* 0.5: the Earth's name wins over a neighbouring planet's */
    const int32_t k = s.kinds[i];
    return 2 * ((k >= 0 && k < 5) ? kKindRank[k] : 5);
}

/* Window coordinates of a world position (SceneTransforms in 3D, perspective):
 * false when it is behind the camera. */
inline bool toWindow(const double* pos, double* w) {
    Scene& s = scene();
    const double* v = s.params + P_VIEW;
    const double* pr = s.params + P_PROJECTION;
    const double ec[4] = {
        v[0] * pos[0] + v[4] * pos[1] + v[8] * pos[2] + v[12],
        v[1] * pos[0] + v[5] * pos[1] + v[9] * pos[2] + v[13],
        v[2] * pos[0] + v[6] * pos[1] + v[10] * pos[2] + v[14],
        v[3] * pos[0] + v[7] * pos[1] + v[11] * pos[2] + v[15],
    };
    const double cc[4] = {
        pr[0] * ec[0] + pr[4] * ec[1] + pr[8] * ec[2] + pr[12] * ec[3],
        pr[1] * ec[0] + pr[5] * ec[1] + pr[9] * ec[2] + pr[13] * ec[3],
        pr[2] * ec[0] + pr[6] * ec[1] + pr[10] * ec[2] + pr[14] * ec[3],
        pr[3] * ec[0] + pr[7] * ec[1] + pr[11] * ec[2] + pr[15] * ec[3],
    };
    if (cc[2] < 0.0) return false;
    const double width = s.params[P_CLIENT_WIDTH], height = s.params[P_CLIENT_HEIGHT];
    const double nx = cc[0] / cc[3], ny = cc[1] / cc[3];
    w[0] = width * 0.5 * nx + width * 0.5;
    w[1] = height - (height * 0.5 * ny + height * 0.5);
    return true;
}

/* The barycentre and Milky Way labels: whether each is wanted and where. */
inline void systemLabels() {
    Scene& s = scene();
    double* o = s.out;
    const double* cam = s.params + P_CAM_POS;
    const bool show = s.params[P_SHOW_LABELS] != 0.0;
    const double d = dist(cam, o + O_SSB_FIXED);
    o[O_SSB_LABEL_SHOW] = (show && d > kSystemLabelDistance && d < kGalaxyLabelDistance * 100.0) ? 1.0 : 0.0;
    double world[3];
    proxyPosition(cam, o + O_SSB_FIXED, 0.0, world);
    for (int k = 0; k < 3; ++k) o[O_SSB_LABEL_REL + k] = world[k] - cam[k];
    o[O_GALAXY_LABEL_SHOW] = (show && d > kGalaxyLabelDistance && o[O_GALAXY_ALPHA] > 0.0) ? 1.0 : 0.0;
    proxyPosition(cam, o + O_GALAXY_CENTRE, 0.0, world);
    for (int k = 0; k < 3; ++k) o[O_GALAXY_LABEL_REL + k] = world[k] - cam[k];
}

/* Every body that is not central: ellipsoid or point, its pick target, label,
 * model matrix and light (CelestialBodyCollection#update). */
inline void draw() {
    Scene& s = scene();
    double* o = s.out;
    const double* p = s.params;
    const uint32_t n = s.n;
    const uint32_t ci = static_cast<uint32_t>(p[P_CENTRAL]);
    const double* cam = p + P_CAM_POS;
    const double height = std::max(1.0, p[P_BUFFER_HEIGHT]);
    const double fovy = std::isfinite(p[P_FOVY]) ? p[P_FOVY] : kPiOverThree;
    const double pixelAngle = fovy / height;
    o[O_PIXEL_ANGLE] = pixelAngle;
    const bool drawPoints = p[P_DRAW_POINTS] != 0.0;
    const bool showLabels = p[P_SHOW_LABELS] != 0.0;
    s.labelFrame = (s.labelFrame + 1) % kDeclutterFrames;
    const bool declutter = s.labelFrame == 0 || p[P_PICK_PASS] != 0.0;
    o[O_DECLUTTER] = declutter ? 1.0 : 0.0;
    const int32_t si = indexOf(s, kSun);
    const bool sunKnown = si >= 0 && s.status[si] == 0;
    for (uint32_t i = 0; i < n; ++i) {
        int32_t f = (s.flags[i] & F_NO_LABEL) ? D_LABEL_SET : 0;
        const bool isCentral = i == ci;
        const bool known = (isCentral || s.status[i] == 0) && (s.flags[i] & F_SHOW);
        if (!known) {
            s.drawFlags[i] = f | D_HIDE;
            continue;
        }
        double position[3] = {0.0, 0.0, 0.0};
        if (!isCentral) std::copy(&s.drawn[3 * i], &s.drawn[3 * i] + 3, position);
        const double distance = dist(position, cam);
        const double radius = maxRadius(s, i);
        const double pixels = (2.0 * radius) / std::max(distance, radius) / pixelAngle;
        const bool asEllipsoid = pixels >= p[P_MIN_ELLIPSOID_PIXELS];
        bool hasLight = false;
        double* light = &s.light[3 * i];
        if (sunKnown && s.ids[i] != kSun) {
            double geometric[3] = {0.0, 0.0, 0.0};
            if (!isCentral) std::copy(&s.fixed[3 * i], &s.fixed[3 * i] + 3, geometric);
            for (int k = 0; k < 3; ++k) light[k] = s.fixed[3 * si + k] - geometric[k];
            normalize(light);
            hasLight = true;
            f |= D_LIGHT;
        }
        if (s.ids[i] == kSaturn) {
            f |= D_RING_SET;
            if (asEllipsoid || isCentral) {
                f |= D_RING_SHOW;
                double m[16];
                if (isCentral) {
                    const double r[9] = {1, 0, 0, 0, 1, 0, 0, 0, 1};
                    rigidCm(r, position, m);
                    m[12] = m[13] = m[14] = 0.0;
                } else {
                    ensureRotation(i);
                    double r[9];
                    bodyToCentralRotation(i, r);
                    rigidCm(r, position, m);
                }
                std::copy(m, m + 16, &s.model[16 * i]);
                if (hasLight) {
                    std::copy(light, light + 3, &s.ringSun[3 * i]);
                    s.hasRingSun[i] = 1;
                } else if (!s.hasRingSun[i]) {
                    s.ringSun[3 * i] = 1.0;
                    s.ringSun[3 * i + 1] = s.ringSun[3 * i + 2] = 0.0;
                    s.hasRingSun[i] = 1;
                }
                double inv[16];
                inverseRigidCm(m, inv);
                cmPoint(inv, cam, &s.ring[6 * i]);
                double sun[3] = {s.ringSun[3 * i], s.ringSun[3 * i + 1], s.ringSun[3 * i + 2]};
                normalize(sun);
                cmVector(inv, sun, &s.ring[6 * i + 3]);
            }
        }
        if (isCentral && asEllipsoid) {
            s.drawFlags[i] = f | D_HIDE;
            continue;
        }
        if (asEllipsoid && !isCentral && !s.ellipsoid[i]) {
            s.ellipsoid[i] = 1;
            ensureRotation(i);
        } else if (!asEllipsoid) {
            s.ellipsoid[i] = 0;
        }
        const bool spritePick = !asEllipsoid || pixels < kPickPixels;
        if (asEllipsoid && !isCentral) {
            f |= D_ELLIPSOID;
            if (!spritePick) f |= D_ELLIPSOID_PICKABLE;
            double r[9];
            bodyToCentralRotation(i, r);
            rigidCm(r, position, &s.model[16 * i]);
        }
        /* point size and opacity from V: display only */
        const double v = s.appStatus[i] == 0 ? s.app[7 * i + 4] : 6.0;
        const int32_t kind = s.kinds[i];
        s.style[2 * i] = clampd(4.5 - 0.35 * v, 1.5, 6.0);
        const double minimumAlpha = (kind == 1 || kind == 0) ? 0.65 : 0.0;
        s.style[2 * i + 1] = clampd(1.15 - 0.12 * v, minimumAlpha, 1.0);
        f |= D_STYLE;
        double world[3];
        // Body sprites participate in surface depth and picking. Compressing
        // their distance can put a background body in front of its occluder.
        proxyPosition(cam, position, 0.0, world, false);
        double rel[3] = {world[0] - cam[0], world[1] - cam[1], world[2] - cam[2]};
        if (moved(&s.lastPoint[3 * i], s.hasLastPoint[i], rel, pixelAngle)) {
            f |= D_POINT_MOVED;
            std::copy(rel, rel + 3, &s.lastPoint[3 * i]);
            std::copy(rel, rel + 3, &s.pointRel[3 * i]);
            s.hasLastPoint[i] = 1;
        }
        if (drawPoints && !asEllipsoid && s.ids[i] != kSun) f |= D_POINT_SHOW;
        if (spritePick && !onSmallParent(i, position, cam, pixelAngle)) f |= D_PICK_SHOW;
        proxyPosition(cam, position, 1.05 * radius, &s.labelWorld[3 * i], false);
        for (int k = 0; k < 3; ++k) rel[k] = s.labelWorld[3 * i + k] - cam[k];
        if (moved(&s.lastLabel[3 * i], s.hasLastLabel[i], rel, pixelAngle)) {
            f |= D_LABEL_MOVED;
            std::copy(rel, rel + 3, &s.lastLabel[3 * i]);
            std::copy(rel, rel + 3, &s.labelRel[3 * i]);
            s.hasLastLabel[i] = 1;
        }
        if (!declutter && !showLabels) f |= D_LABEL_SET;
        s.drawFlags[i] = f;
    }
    systemLabels();
}

/* Labels decluttered on screen by rank (the Sun, planets, dwarf planets,
 * moons, asteroids), after the system labels the engine shows: each label
 * further than 36 px from every label placed before it. */
inline void declutterLabels() {
    Scene& s = scene();
    const double* o = s.out;
    const double* cam = s.params + P_CAM_POS;
    const bool showLabels = s.params[P_SHOW_LABELS] != 0.0;
    double* placed = s.placed.data();
    size_t placedCount = 0;
    /* the system labels the engine shows, at their stand-in places */
    if (s.params[P_SSB_LABEL_SHOWN] != 0.0) {
        double world[3];
        proxyPosition(cam, o + O_SSB_FIXED, 0.0, world);
        double w[2];
        if (toWindow(world, w)) {
            placed[placedCount++] = w[0];
            placed[placedCount++] = w[1];
        }
    }
    if (s.params[P_GALAXY_LABEL_SHOWN] != 0.0) {
        double world[3];
        proxyPosition(cam, o + O_GALAXY_CENTRE, 0.0, world);
        double w[2];
        if (toWindow(world, w)) {
            placed[placedCount++] = w[0];
            placed[placedCount++] = w[1];
        }
    }
    uint32_t* order = s.order.data();
    uint32_t orderCount = 0;
    for (uint32_t i = 0; i < s.n; ++i) {
        const int32_t f = s.drawFlags[i];
        if (f & D_HIDE) continue;
        order[orderCount++] = i;
    }
    /* by rank, then catalog order (an insertion sort: stable, in place) */
    for (uint32_t a = 1; a < orderCount; ++a) {
        const uint32_t v = order[a];
        uint32_t b = a;
        while (b > 0 && rankTimesTwo(order[b - 1]) > rankTimesTwo(v)) {
            order[b] = order[b - 1];
            --b;
        }
        order[b] = v;
    }
    for (uint32_t oi = 0; oi < orderCount; ++oi) {
        const uint32_t i = order[oi];
        bool show = showLabels && !(s.flags[i] & F_NO_LABEL);
        if (show) {
            double w[2];
            show = toWindow(&s.labelWorld[3 * i], w);
            if (show) {
                for (size_t k = 0; k < placedCount; k += 2) {
                    const double dx = placed[k] - w[0], dy = placed[k + 1] - w[1];
                    if (std::sqrt(dx * dx + dy * dy) < kMinimumLabelSeparation) {
                        show = false;
                        break;
                    }
                }
                if (show) {
                    placed[placedCount++] = w[0];
                    placed[placedCount++] = w[1];
                }
            }
        }
        s.drawFlags[i] |= D_LABEL_SET | (show ? D_LABEL_SHOW : 0);
    }
}

/* ---- scopes ----------------------------------------------------------------- */

/* Each body's orbiter propagation cutoff for a camera position (central
 * frame). A body's orbiters are suspended while the camera is farther than
 * kOrbiterCutoffRadii of its mean radius from its center and resume inside
 * kOrbiterResumeRadii. The mean radius is the mean of the body's three radii
 * (for the Earth's ellipsoid, the IUGG mean radius R1). The two distances
 * (m) are written to each body's S_CUTOFF pair, where the engine reads them;
 * a body without radii is never cut off. */
inline void scopes(const double* cam) {
    Scene& s = scene();
    const uint32_t ci = static_cast<uint32_t>(s.params[P_CENTRAL]);
    for (uint32_t i = 0; i < s.n; ++i) {
        s.suspendedChanged[i] = 0;
        const double* r = &s.radii[3 * i];
        const double mean = (r[0] + r[1] + r[2]) / 3.0;
        const double cutoff = mean > 0.0 ? kOrbiterCutoffRadii * mean : 0.0;
        const double resume = mean > 0.0 ? kOrbiterResumeRadii * mean : 0.0;
        s.cutoff[2 * i] = cutoff;
        s.cutoff[2 * i + 1] = resume;
        const bool was = s.suspended[i] != 0;
        bool now = false;
        if (cutoff > 0.0) {
            /* the central body is the origin; another body whose place is not
             * known this frame keeps its state */
            const double zero[3] = {0.0, 0.0, 0.0};
            const double* position = zero;
            if (i != ci) {
                if (s.out[O_FRAME_VALID] == 0.0 || s.status[i] != 0) continue;
                position = &s.fixed[3 * i];
            }
            const double distance = dist(cam, position);
            now = was ? distance >= resume : distance > cutoff;
        }
        if (now != was) {
            s.suspended[i] = now ? 1 : 0;
            s.suspendedChanged[i] = 1;
        }
    }
}

/* The Earth scope's camera: the scene camera moved rigidly into the
 * Earth-fixed frame, and the Sun and Moon there. */
inline void earthScopeCamera() {
    Scene& s = scene();
    double* o = s.out;
    const double* m = o + O_CENTRAL_TO_EARTH;
    const double* p = s.params;
    cmPoint(m, p + P_CAM_POS, o + O_SCOPE_CAMERA);
    cmVector(m, p + P_CAM_DIR, o + O_SCOPE_CAMERA + 3);
    cmVector(m, p + P_CAM_UP, o + O_SCOPE_CAMERA + 6);
    cmVector(m, p + P_CAM_RIGHT, o + O_SCOPE_CAMERA + 9);
    cmPoint(m, o + O_SUN_WC, o + O_SCOPE_SUN);
    cmPoint(m, o + O_MOON_WC, o + O_SCOPE_MOON);
}

/* ---- the central body's switch ------------------------------------------ */

/* Re-expresses the camera in body b's frame and finds the flight to its day
 * side (Scene#setCentralBody): from the Sun's side, 0.45 toward the evening
 * terminator, at 3.2 maximum radii. */
inline bool switchCentral(uint32_t b, double maxRadiusOfBody) {
    Scene& s = scene();
    double* o = s.out;
    o[O_SWITCH_OK] = 0.0;
    o[O_SWITCH_SUN_VALID] = 0.0;
    double* bodyToCentral = o + O_SWITCH_TRANSFORM;
    if (!bodyToCentralTransform(b, bodyToCentral)) return false;
    double centralToBody[16];
    inverseRigidCm(bodyToCentral, centralToBody);
    const int32_t si = indexOf(s, kSun);
    double sunDirection[3];
    /* the Sun's place (the origin when it is central), seen from the new body */
    const bool sunCentral = si >= 0 && static_cast<uint32_t>(si) == static_cast<uint32_t>(s.params[P_CENTRAL]);
    if (si >= 0 && s.out[O_FRAME_VALID] != 0.0 && (sunCentral || s.status[si] == 0) && s.ids[b] != kSun) {
        const double zero[3] = {0.0, 0.0, 0.0};
        cmPoint(centralToBody, sunCentral ? zero : &s.fixed[3 * si], sunDirection);
        normalize(sunDirection);
        o[O_SWITCH_SUN_VALID] = 1.0;
    }
    const double* p = s.params;
    double* c = o + O_SWITCH_CAMERA;
    cmPoint(centralToBody, p + P_CAM_POS, c);
    cmVector(centralToBody, p + P_CAM_DIR, c + 3);
    cmVector(centralToBody, p + P_CAM_UP, c + 6);
    cmVector(centralToBody, p + P_CAM_RIGHT, c + 9);
    normalize(c + 3);
    normalize(c + 6);
    normalize(c + 9);
    if (o[O_SWITCH_SUN_VALID] != 0.0) {
        const double up[3] = {0.0, 0.0, 1.0};
        double east[3];
        cross(up, sunDirection, east);
        if (east[0] * east[0] + east[1] * east[1] + east[2] * east[2] > 1.0e-12) normalize(east);
        double view[3] = {sunDirection[0] + east[0] * 0.45, sunDirection[1] + east[1] * 0.45,
                          sunDirection[2] + east[2] * 0.45};
        normalize(view);
        const double range = 3.2 * maxRadiusOfBody;
        double direction[3] = {-view[0], -view[1], -view[2]};
        double t[3], cameraUp[3];
        cross(direction, up, t);
        cross(t, direction, cameraUp);
        if (cameraUp[0] * cameraUp[0] + cameraUp[1] * cameraUp[1] + cameraUp[2] * cameraUp[2] < 1.0e-12) {
            cameraUp[0] = 1.0;
            cameraUp[1] = cameraUp[2] = 0.0;
        }
        normalize(cameraUp);
        for (int k = 0; k < 3; ++k) {
            o[O_SWITCH_DESTINATION + k] = view[k] * range;
            o[O_SWITCH_DIRECTION + k] = direction[k];
            o[O_SWITCH_UP + k] = cameraUp[k];
        }
    }
    o[O_SWITCH_OK] = 1.0;
    return true;
}

/* Keeps a camera position at least 1 km outside every body that is not
 * central (the central body's surface is the globe's). Returns whether it
 * moved it. */
inline bool keepOutside(double* camera) {
    Scene& s = scene();
    if (s.out[O_FRAME_VALID] == 0.0 || s.n < 2) return false;
    const uint32_t ci = static_cast<uint32_t>(s.params[P_CENTRAL]);
    bool changed = false;
    for (uint32_t i = 0; i < s.n; ++i) {
        if (i == ci || s.status[i] != 0) continue;
        const double* center = &s.fixed[3 * i];
        double offset[3] = {camera[0] - center[0], camera[1] - center[1], camera[2] - center[2]};
        const double distance = mag(offset);
        const double keepOut = maxRadius(s, i) + 1000.0;
        if (distance < keepOut && distance > 0.0) {
            const double f = keepOut / distance;
            for (int k = 0; k < 3; ++k) camera[k] = center[k] + offset[k] * f;
            changed = true;
        }
    }
    return changed;
}

/* The camera carried with the central body's spin since the last frame
 * (beyond its Hill sphere the sky stays still): spin = R_now * R_last^T. */
inline void carry() {
    Scene& s = scene();
    const double* now = s.params + P_CARRY_NOW;   /* ICRF -> central fixed now, row-major */
    const double* last = s.params + P_CARRY_LAST; /* ICRF -> central fixed last frame, row-major */
    double spin[9];
    mulABt(now, last, spin);
    const double* p = s.params;
    double* c = s.out + O_CARRY_CAMERA;
    mulRv(spin, p + P_CAM_POS, c);
    mulRv(spin, p + P_CAM_DIR, c + 3);
    mulRv(spin, p + P_CAM_UP, c + 6);
    normalize(c + 3);
    normalize(c + 6);
    cross(c + 3, c + 6, c + 9);
    normalize(c + 9);
}

}  // namespace ssb_scene

/* ======================================================================== */
/* Scene surface (resident, synchronous; the engine's per-frame path)        */
/* ======================================================================== */

/* Sizes the scene for n bodies (keep != 0: the bodies already there keep
 * their values) and returns the layout's pointer table (uint32 per slot). */
SSB_EXPORT("ssb_scene_resize") uint32_t ssb_scene_resize(uint32_t n, int32_t keep) {
    ssb_scene::resize(n, keep != 0);
    return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(ssb_scene::scene().layout));
}
SSB_EXPORT("ssb_scene_remove") uint32_t ssb_scene_remove(uint32_t index) {
    ssb_scene::removeAt(index);
    return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(ssb_scene::scene().layout));
}
SSB_EXPORT("ssb_scene_frame") int32_t ssb_scene_frame(void) {
    ssb_scene::frame();
    return static_cast<int32_t>(ssb_scene::scene().out[ssb_scene::O_FRAME_VALID]);
}
SSB_EXPORT("ssb_scene_place") void ssb_scene_place(void) { ssb_scene::place(); }
SSB_EXPORT("ssb_scene_small_body_observer") int32_t ssb_scene_small_body_observer(double* out10) {
    return ssb_scene::smallBodyObserver(out10);
}
SSB_EXPORT("ssb_scene_draw") void ssb_scene_draw(void) { ssb_scene::draw(); }
SSB_EXPORT("ssb_scene_declutter") void ssb_scene_declutter(void) { ssb_scene::declutterLabels(); }
SSB_EXPORT("ssb_scene_galaxy") void ssb_scene_galaxy(int32_t wanted) {
    double out[14];
    sdn::frames::galactic::icrs_to_galactic(out);
    sdn::frames::galactic::centre_from_sun(out + 9);
    ssb_scene::galaxy(wanted != 0, out, out + 9);
}
SSB_EXPORT("ssb_scene_system_labels") void ssb_scene_system_labels(void) { ssb_scene::systemLabels(); }
SSB_EXPORT("ssb_scene_scopes") void ssb_scene_scopes(const double* camera) { ssb_scene::scopes(camera); }
SSB_EXPORT("ssb_scene_earth_scope") void ssb_scene_earth_scope(void) { ssb_scene::earthScopeCamera(); }
SSB_EXPORT("ssb_scene_ensure_rotation") void ssb_scene_ensure_rotation(uint32_t i) { ssb_scene::ensureRotation(i); }
SSB_EXPORT("ssb_scene_body_transform") int32_t ssb_scene_body_transform(uint32_t i) {
    auto& s = ssb_scene::scene();
    const bool ok = i < s.n && ssb_scene::bodyToCentralTransform(i, s.out + ssb_scene::O_TRANSFORM);
    s.out[ssb_scene::O_TRANSFORM_OK] = ok ? 1.0 : 0.0;
    return ok ? 1 : 0;
}
SSB_EXPORT("ssb_scene_switch") int32_t ssb_scene_switch(uint32_t i, double maxRadius) {
    return i < ssb_scene::scene().n && ssb_scene::switchCentral(i, maxRadius) ? 1 : 0;
}
SSB_EXPORT("ssb_scene_keep_outside") int32_t ssb_scene_keep_outside(double* camera) {
    return ssb_scene::keepOutside(camera) ? 1 : 0;
}
SSB_EXPORT("ssb_scene_carry") void ssb_scene_carry(void) { ssb_scene::carry(); }
/* Whether a camera position (central frame) is beyond the central body's
 * Hill sphere at the last frame (no Hill sphere: never). */
SSB_EXPORT("ssb_scene_beyond_hill") int32_t ssb_scene_beyond_hill(const double* camera) {
    const double hill = ssb_scene::scene().out[ssb_scene::O_HILL];
    const double d = ssb_scene::mag(camera);
    return (hill >= 0.0 && std::isfinite(d) && d > hill) ? 1 : 0;
}
SSB_EXPORT("ssb_sky_alpha") double ssb_sky_alpha(double distance) { return ssb_scene::skyAlphaAtDistance(distance); }

#endif
