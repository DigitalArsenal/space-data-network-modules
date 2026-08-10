/* ===========================================================================
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source of truth : schemas/orbpro/Propagator.fbs
 * Generator       : scripts/generate-propagator-abi.mjs
 * Drift gate      : scripts/check-propagator-abi.mjs  (runs in `npm test`)
 * Contract        : docs/propagator-abi.md
 *
 * Edit the .fbs and regenerate. A hand edit here is erased by the next run and
 * failed by the gate in between — which is the point: this file existing in
 * five hand-maintained copies is the drift that
 * graph/findings/official-harness-shapes.md §3 forbids.
 * ===========================================================================
 */

#ifndef ORBPRO_PROPAGATOR_ABI_H
#define ORBPRO_PROPAGATOR_ABI_H

#include <stdint.h>
#include <stddef.h> /* offsetof */

/* The ABI locks below must compile in both C and C++ — first-party
 * modules are C++ (sgp4_plugin.cpp, poly_coverage_module.cpp) while the
 * reference module and the header's own examples are C. */
#if defined(__cplusplus)
#define ORBPRO_ABI_STATIC_ASSERT(cond, msg) static_assert(cond, msg)
#else
#define ORBPRO_ABI_STATIC_ASSERT(cond, msg) _Static_assert(cond, msg)
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* ========================================================================= */
/* ReferenceFrame */
/* ========================================================================= */

/** ReferenceFrame */
typedef enum {
    ORBPRO_FRAME_TEME = 0,
    ORBPRO_FRAME_J2000 = 1,
    ORBPRO_FRAME_ICRF = 2,
    ORBPRO_FRAME_ECEF = 3,
    ORBPRO_FRAME_MCI = 4,
    ORBPRO_FRAME_MCMF = 5,
} OrbProReferenceFrame;

/* ========================================================================= */
/* StateFlags */
/* ========================================================================= */

/**
 * StateVector.flags is a BITFIELD carrying any OR-combination of these, so it
 * is declared `uint` on the struct rather than typed to this enum. The C
 * enumerators are generated from here anyway — they are the contract.
 */
typedef enum {
    ORBPRO_STATE_NONE = 0,
    ORBPRO_STATE_VALID = 1,
    ORBPRO_STATE_IN_ECLIPSE = 2,
    ORBPRO_STATE_DECAYED = 4,
    ORBPRO_STATE_MANEUVERING = 8,
    ORBPRO_STATE_EXTRAPOLATED = 16,
    ORBPRO_STATE_HAS_COVARIANCE = 32,
} OrbProStateFlags;

/* ========================================================================= */
/* OrbProStateVector — 64 bytes, 8-byte aligned */
/* ========================================================================= */

/**
 * Orbital state vector — 64 bytes, 8-byte aligned. Mirrors
 * `OrbProStateVector` in orbpro-integration/sdk/include/orbpro_propagator.h
 * byte for byte:
 *
 *   0   8   epoch (Julian date, float64)
 *   8   24  position (METERS)
 *   32  24  velocity (METERS/SECOND)
 *   56  1   reference_frame (ubyte)
 *   57  3   padding, MUST be zero
 *   60  4   flags (uint32)
 *
 * NORMATIVE UNITS: position METERS, velocity METERS/SECOND. There is no km
 * variant and no host-side conversion — the engine hands these straight to
 * Cesium Cartesian3, whose unit is metres, and both shipped propagators emit
 * meters. The C header used to declare `reference_frame` as a uint32 at
 * offset 56, wire-identical to this ubyte+padding only by little-endian
 * accident; it now declares ubyte + 3 reserved so the two agree by
 * construction.
 *
 * Ruling: graph/findings/official-harness-shapes.md §4.1 / §4.2
 *
 * Binary layout (derived from the IDL, not hand-written):
 *
 *   Offset  Size  Field
 *   ------  ----  -----------------------------------------
 *        0     8  epoch
 *        8    24  position
 *       32    24  velocity
 *       56     1  reference_frame
 *       57     3  (alignment padding — MUST be written as zero)
 *       60     4  flags
 */
typedef struct {
    double epoch; /**< Julian date of this state. */
    double position[3]; /**< Position [x, y, z] in METERS. */
    double velocity[3]; /**< Velocity [vx, vy, vz] in METERS PER SECOND. */
    uint8_t reference_frame; /**< Reference frame of position/velocity. One byte; the three bytes that follow are alignment padding and MUST be written as zero. */
    uint8_t _reserved[3]; /**< Alignment padding at offset 57. MUST be 0. */
    uint32_t flags; /**< StateFlags bitfield. */
} OrbProStateVector;

ORBPRO_ABI_STATIC_ASSERT(sizeof(OrbProStateVector) == 64,
    "OrbProStateVector must be 64 bytes");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProStateVector, epoch) == 0,
    "OrbProStateVector.epoch must be at offset 0");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProStateVector, position) == 8,
    "OrbProStateVector.position must be at offset 8");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProStateVector, velocity) == 32,
    "OrbProStateVector.velocity must be at offset 32");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProStateVector, reference_frame) == 56,
    "OrbProStateVector.reference_frame must be at offset 56");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProStateVector, flags) == 60,
    "OrbProStateVector.flags must be at offset 60");

/**
 * Zero an entire OrbProStateVector, INCLUDING its alignment padding.
 * Start every write here — see the note above about scratch buffers.
 */
static inline void orbpro_state_init(OrbProStateVector* value) {
    for (size_t i = 0; i < sizeof(*value); ++i) {
        ((unsigned char*)value)[i] = 0;
    }
}

/**
 * Set OrbProStateVector.reference_frame AND clear the 3 padding byte(s)
 * that follow it. USE THIS instead of assigning the field directly.
 */
static inline void orbpro_state_set_reference_frame(OrbProStateVector* value, OrbProReferenceFrame v) {
    value->reference_frame = (uint8_t)v;
    ((unsigned char*)value)[57] = 0;
    ((unsigned char*)value)[58] = 0;
    ((unsigned char*)value)[59] = 0;
}

/* ========================================================================= */
/* OrbProOrbitalElements — 64 bytes, 8-byte aligned */
/* ========================================================================= */

/**
 * Keplerian orbital elements — the OPTIONAL initialization input accepted by
 * `plugin_init_elements`. 64 bytes, 8-byte aligned.
 *
 * UNITS NOTE: `semi_major_axis` is KILOMETRES. That is deliberate and it is
 * NOT an inconsistency with StateVector's metres: this is an INPUT element
 * set, not an output state vector, and the two are different structs on
 * different sides of the call. Do not "unify" them — see the normative units
 * block in the generated C header.
 *
 * Binary layout (derived from the IDL, not hand-written):
 *
 *   Offset  Size  Field
 *   ------  ----  -----------------------------------------
 *        0     8  semi_major_axis
 *        8     8  eccentricity
 *       16     8  inclination
 *       24     8  raan
 *       32     8  arg_periapsis
 *       40     8  true_anomaly
 *       48     8  epoch
 *       56     8  reserved
 */
typedef struct {
    double semi_major_axis; /**< Semi-major axis in KILOMETRES. */
    double eccentricity; /**< Orbital eccentricity (0 = circular, <1 = ellipse). */
    double inclination; /**< Inclination in RADIANS. */
    double raan; /**< Right ascension of the ascending node in RADIANS. */
    double arg_periapsis; /**< Argument of periapsis in RADIANS. */
    double true_anomaly; /**< True anomaly in RADIANS. */
    double epoch; /**< Epoch as a Julian date. */
    double reserved; /**< Reserved, MUST be written as 0. */
} OrbProOrbitalElements;

ORBPRO_ABI_STATIC_ASSERT(sizeof(OrbProOrbitalElements) == 64,
    "OrbProOrbitalElements must be 64 bytes");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOrbitalElements, semi_major_axis) == 0,
    "OrbProOrbitalElements.semi_major_axis must be at offset 0");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOrbitalElements, eccentricity) == 8,
    "OrbProOrbitalElements.eccentricity must be at offset 8");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOrbitalElements, inclination) == 16,
    "OrbProOrbitalElements.inclination must be at offset 16");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOrbitalElements, raan) == 24,
    "OrbProOrbitalElements.raan must be at offset 24");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOrbitalElements, arg_periapsis) == 32,
    "OrbProOrbitalElements.arg_periapsis must be at offset 32");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOrbitalElements, true_anomaly) == 40,
    "OrbProOrbitalElements.true_anomaly must be at offset 40");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOrbitalElements, epoch) == 48,
    "OrbProOrbitalElements.epoch must be at offset 48");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOrbitalElements, reserved) == 56,
    "OrbProOrbitalElements.reserved must be at offset 56");

/**
 * Zero an entire OrbProOrbitalElements, INCLUDING its alignment padding.
 * Start every write here — see the note above about scratch buffers.
 */
static inline void orbpro_elements_init(OrbProOrbitalElements* value) {
    for (size_t i = 0; i < sizeof(*value); ++i) {
        ((unsigned char*)value)[i] = 0;
    }
}

/* ========================================================================= */
/* OrbProOMMRecord — 88 bytes, 8-byte aligned */
/* ========================================================================= */

/**
 * Binary OMM record — the mean-element ingest struct. 88 bytes, 8-byte
 * aligned.
 *
 * !! THIS STRUCT IS ALSO AN ON-DISK FORMAT !!
 * -----------------------------------------------------------------------
 * It crosses the ABI (`plugin_init_omm`, `plugin_entity_add_omm`) AND is
 * persisted verbatim as a SQLite BLOB by the first-party SGP4 module
 * (`sgp4_plugin.cpp`, `sqlite3_bind_blob(..., &omm, sizeof(OrbProOMMRecord), ...)`).
 * Until W1.1 it carried NO size or offset lock anywhere in the stack, so the
 * layout that every stored blob depends on was held only by the field order
 * of one hand-written C struct in one module.
 *
 * The layout declared here is that layout, EXACTLY as it has been written to
 * disk — the four trailing padding bytes at offset 84 included. This is a
 * description of the wire as it already exists, not a redesign of it; the
 * generated locks now pin it. Migrating the format is explicitly out of
 * scope and would invalidate every stored blob.
 *
 * UNITS: angles in DEGREES, mean motion in REV/DAY, bstar in 1/earth-radii.
 * These are the SDS $OMM units, carried through unconverted.
 *
 * Binary layout (derived from the IDL, not hand-written):
 *
 *   Offset  Size  Field
 *   ------  ----  -----------------------------------------
 *        0     8  epoch_jd
 *        8     8  mean_motion
 *       16     8  eccentricity
 *       24     8  inclination
 *       32     8  ra_of_asc_node
 *       40     8  arg_of_pericenter
 *       48     8  mean_anomaly
 *       56     8  bstar
 *       64     8  mean_motion_dot
 *       72     8  mean_motion_ddot
 *       80     4  norad_cat_id
 *       84     4  (alignment padding — MUST be written as zero)
 */
typedef struct {
    double epoch_jd; /**< Epoch as a Julian date (callers convert ISO 8601 -> JD). */
    double mean_motion; /**< Mean motion in REV/DAY. */
    double eccentricity; /**< Eccentricity (unitless). */
    double inclination; /**< Inclination in DEGREES. */
    double ra_of_asc_node; /**< Right ascension of the ascending node in DEGREES. */
    double arg_of_pericenter; /**< Argument of pericenter in DEGREES. */
    double mean_anomaly; /**< Mean anomaly in DEGREES. */
    double bstar; /**< B* drag term in 1/earth-radii. */
    double mean_motion_dot; /**< First derivative of mean motion, REV/DAY^2. */
    double mean_motion_ddot; /**< Second derivative of mean motion, REV/DAY^3. */
    uint32_t norad_cat_id; /**< NORAD catalog number — the identity authority for this record. */
    uint8_t _reserved[4]; /**< Alignment padding at offset 84. MUST be 0. */
} OrbProOMMRecord;

ORBPRO_ABI_STATIC_ASSERT(sizeof(OrbProOMMRecord) == 88,
    "OrbProOMMRecord must be 88 bytes");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOMMRecord, epoch_jd) == 0,
    "OrbProOMMRecord.epoch_jd must be at offset 0");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOMMRecord, mean_motion) == 8,
    "OrbProOMMRecord.mean_motion must be at offset 8");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOMMRecord, eccentricity) == 16,
    "OrbProOMMRecord.eccentricity must be at offset 16");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOMMRecord, inclination) == 24,
    "OrbProOMMRecord.inclination must be at offset 24");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOMMRecord, ra_of_asc_node) == 32,
    "OrbProOMMRecord.ra_of_asc_node must be at offset 32");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOMMRecord, arg_of_pericenter) == 40,
    "OrbProOMMRecord.arg_of_pericenter must be at offset 40");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOMMRecord, mean_anomaly) == 48,
    "OrbProOMMRecord.mean_anomaly must be at offset 48");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOMMRecord, bstar) == 56,
    "OrbProOMMRecord.bstar must be at offset 56");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOMMRecord, mean_motion_dot) == 64,
    "OrbProOMMRecord.mean_motion_dot must be at offset 64");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOMMRecord, mean_motion_ddot) == 72,
    "OrbProOMMRecord.mean_motion_ddot must be at offset 72");
ORBPRO_ABI_STATIC_ASSERT(offsetof(OrbProOMMRecord, norad_cat_id) == 80,
    "OrbProOMMRecord.norad_cat_id must be at offset 80");

/**
 * Zero an entire OrbProOMMRecord, INCLUDING its alignment padding.
 * Start every write here — see the note above about scratch buffers.
 */
static inline void orbpro_omm_init(OrbProOMMRecord* value) {
    for (size_t i = 0; i < sizeof(*value); ++i) {
        ((unsigned char*)value)[i] = 0;
    }
}

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* ORBPRO_PROPAGATOR_ABI_H */
