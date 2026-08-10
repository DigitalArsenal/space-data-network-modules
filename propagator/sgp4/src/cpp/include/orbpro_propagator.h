/**
 * OrbPro Plugin SDK - Propagator Plugin Header
 *
 * Defines the binary data structures and function signatures for
 * propagator plugins that compute orbital state vectors from TLE,
 * Keplerian elements, or other orbital data.
 *
 * Binary format: 64-byte StateVector, 8-byte aligned
 *
 * @file orbpro_propagator.h
 *
 * =========================================================================
 * NORMATIVE — UNITS. READ THIS BEFORE WRITING A SINGLE BYTE.
 * =========================================================================
 *
 *   OrbProStateVector.position IS IN METERS.
 *   OrbProStateVector.velocity IS IN METERS PER SECOND.
 *
 * There is no km variant, no per-plugin unit flag, and no negotiation. A
 * plugin that writes kilometres into this struct is off by 1000x and its
 * satellites render INSIDE the Earth. There is no runtime check that can
 * catch it for you: 6778 and 6778000 are both finite doubles.
 *
 * This block is normative because the file previously contradicted itself —
 * the struct field comments said km while the layout block three lines below
 * said METERS. The binding truth is what the shipped runtimes actually do,
 * and both of them emit meters:
 *
 *   - packages/orbpro-integration/propagator.sgp4/index.js
 *       "Output: ECEF positions in meters" — reads position[] straight out
 *       of this struct with NO scaling.
 *   - packages/orbpro-integration/propagator.hpop/index.js
 *       "Output: ECEF positions in meters (always — no JS-side unit
 *       normalization)".
 *
 * and the engine writes plugin output directly into Cesium Cartesian3, whose
 * unit is metres. km was never true anywhere on this seam.
 *
 * The ONE place km survives is OrbProOrbitalElements.semi_major_axis, an
 * INPUT struct that is not this state vector. It is labelled km there and
 * stays km; do not "unify" it silently.
 *
 * Ruling: graph/findings/official-harness-shapes.md §4.1 / §8.1
 * Task:   graph/tasks/harness-w0-immediate-fixes.md (W0.1)
 * =========================================================================
 *
 * @example
 * #include "orbpro_plugin.h"
 * #include "orbpro_propagator.h"
 *
 * static OrbProStateVector state;
 *
 * ORBPRO_EXPORT int32_t plugin_init(const uint8_t* data, size_t len) {
 *     // Parse TLE or orbital elements from data buffer
 *     return ORBPRO_OK;
 * }
 *
 * ORBPRO_EXPORT int32_t plugin_propagate(
 *     double julian_date, uint32_t entity_index, OrbProStateVector* out
 * ) {
 *     // Compute position/velocity at julian_date.
 *     // METERS and METERS/SECOND — see the NORMATIVE UNITS block above.
 *     out->epoch = julian_date;
 *     out->position[0] = x_m;
 *     out->position[1] = y_m;
 *     out->position[2] = z_m;
 *     out->velocity[0] = vx_m_s;
 *     out->velocity[1] = vy_m_s;
 *     out->velocity[2] = vz_m_s;
 *     out->reference_frame = ORBPRO_FRAME_TEME;
 *     out->flags = ORBPRO_STATE_VALID;
 *     return 0;
 * }
 */

#ifndef ORBPRO_PROPAGATOR_H
#define ORBPRO_PROPAGATOR_H

#include "orbpro_plugin.h"

/* memset() for orbpro_state_init(); offsetof() for the layout static_asserts. */
#include <string.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ========================================================================= */
/* Reference Frames                                                          */
/* ========================================================================= */

/**
 * Reference frame for state vectors.
 *
 * !! FOUR INCOMPATIBLE `ReferenceFrame` VOCABULARIES CROSS THIS SEAM !!
 * ---------------------------------------------------------------------------
 * This enum is the `orbpro.propagator` vocabulary. It is NOT the only one, and
 * the numeric values are NOT interchangeable with the others. Never let a raw
 * integer frame value cross a boundary unqualified — translate by NAME.
 *
 *   (A) orbpro.propagator  — THIS enum. Also:
 *         space-data-module-sdk/schemas/orbpro/Propagator.fbs
 *         orbpro-integration/sdk/src/generated/orbpro/propagator/reference-frame.ts
 *       TEME=0  J2000=1  ICRF=2  ECEF=3  MCI=4  MCMF=5
 *
 *   (B) orbpro.plugins     — the PropagatorState.fbs wire ("PRST"), emitted by
 *       the compiled sgp4/hpop/conjunction/sensor-shader modules. Also:
 *         orbpro-integration/sdk/include/generated/PropagatorState_generated.h
 *         orbpro-integration/sdk/src/generated/orbpro/plugins/reference-frame.ts
 *       ECI=0   ECEF=1   TEME=2   ICRF=3
 *       ^ ECI==0 collides with TEME==0 here, and ECEF is 1 there vs 3 here.
 *
 *   (C) Cesium.ReferenceFrame — the engine/consumer vocabulary.
 *       FIXED=0  INERTIAL=1
 *       ^ FIXED==0 collides with BOTH of the above.
 *
 *   (D) conjunction-assessment/schemas/ConjunctionCommon.fbs — ECI=1.
 *
 * (B)'s numeric values are frozen by compiled WASM artifacts already in the
 * field, so collapsing (A) and (B) into one vocabulary is a wire break, not a
 * Wave-0 edit. See graph/tasks/sdk-reference-frame-enum-unification.md.
 * Until that lands, every seam translates by NAMED TOKEN — the pattern in
 * propagator.hpop/index.js createSourceFromState is the reference.
 *
 * Ruling: graph/findings/official-harness-shapes.md §4.2 / §8.2
 * Task:   graph/tasks/harness-w0-immediate-fixes.md (W0.2)
 */
typedef enum {
    /** True Equator Mean Equinox */
    ORBPRO_FRAME_TEME  = 0,
    /** J2000 equatorial */
    ORBPRO_FRAME_J2000 = 1,
    /** International Celestial Reference Frame */
    ORBPRO_FRAME_ICRF  = 2,
    /** Earth-Centered Earth-Fixed (ITRF/WGS84) — REQUIRED output frame for all plugins */
    ORBPRO_FRAME_ECEF  = 3,
    /** Moon-Centered Inertial (parity with orbpro.propagator; no ECEF-equivalent) */
    ORBPRO_FRAME_MCI   = 4,
    /** Moon-Centered Moon-Fixed */
    ORBPRO_FRAME_MCMF  = 5,
} OrbProReferenceFrame;

/* ========================================================================= */
/* State Flags                                                               */
/* ========================================================================= */

/**
 * State vector flags (bitfield).
 * Must match PropagatorPlugin.js StateFlags enum values.
 */
typedef enum {
    /** State vector data is valid */
    ORBPRO_STATE_VALID      = (1 << 0),
    /** Object is in Earth's shadow */
    ORBPRO_STATE_IN_ECLIPSE = (1 << 1),
    /** Object orbit has decayed */
    ORBPRO_STATE_DECAYED    = (1 << 2),
} OrbProStateFlags;

/* ========================================================================= */
/* State Vector (64 bytes, 8-byte aligned)                                   */
/* ========================================================================= */

/**
 * Orbital state vector - the primary output of propagator plugins.
 *
 * Binary layout (64 bytes total, 8-byte aligned):
 *
 *   Offset  Size  Type      Field
 *   ------  ----  --------  -------------------------
 *   0       8     float64   epoch (Julian date)
 *   8       24    float64×3 position (x, y, z) in METERS
 *   32      24    float64×3 velocity (vx, vy, vz) in METERS/SECOND
 *   56      1     uint8     reference_frame (see OrbProReferenceFrame)
 *   57      3     uint8×3   reserved (MUST be written as 0)
 *   60      4     uint32    flags (see OrbProStateFlags)
 *
 * The `reference_frame` byte + 3 reserved bytes is a DECLARED layout, not an
 * accident. The FlatBuffers IDL that mirrors this struct
 * (space-data-module-sdk/schemas/orbpro/Propagator.fbs, `struct StateVector`)
 * declares `reference_frame:ReferenceFrame` as a `ubyte` at offset 56 with
 * three bytes of alignment padding before the `uint` at 60. This header used
 * to declare a `uint32_t` at 56, which is wire-identical ONLY by little-endian
 * accident. It is now declared as it actually is, so the two agree by
 * construction on any endianness.
 *
 * Writers: use `orbpro_state_set_frame()` (it zeroes the reserved bytes) or
 * `orbpro_state_init()`. Never memcpy a 4-byte frame value at offset 56.
 *
 * IMPORTANT: All propagator plugins MUST output positions in the ECEF
 * (Earth-Centered Earth-Fixed) reference frame, in METERS (not km).
 * Internal reference frame transforms (e.g. TEME→ECEF for SGP4) must be
 * performed inside the WASM plugin. Cesium expects ECEF/Fixed frame by default.
 * User-space transforms (ECEF↔ICRF etc.) are handled in JavaScript.
 *
 * Position and velocity units (NORMATIVE — see the units block at the top of
 * this file):
 *   - Position: METERS (m) in ECEF frame
 *   - Velocity: METERS PER SECOND (m/s) in ECEF frame
 */
typedef struct {
    double   epoch;            /**< Julian date of this state */
    double   position[3];      /**< Position [x, y, z] in METERS */
    double   velocity[3];      /**< Velocity [vx, vy, vz] in METERS/SECOND */
    uint8_t  reference_frame;  /**< Reference frame (OrbProReferenceFrame) */
    uint8_t  reserved[3];      /**< Reserved, MUST be 0 (IDL alignment padding) */
    uint32_t flags;            /**< State flags (OrbProStateFlags bitfield) */
} OrbProStateVector;

/**
 * Compile-time check: OrbProStateVector must be exactly 64 bytes.
 */
_Static_assert(sizeof(OrbProStateVector) == 64,
    "OrbProStateVector must be 64 bytes");

/**
 * Compile-time checks: the field offsets are the WIRE, not an implementation
 * detail. Every one of them is read by name from JS at a hard-coded byte
 * offset (see propagator.sgp4/index.js "OrbProStateVector layout (64 bytes)"),
 * so a silent reorder or a padding change is a silent 1000x-class defect.
 */
_Static_assert(offsetof(OrbProStateVector, epoch) == 0,
    "OrbProStateVector.epoch must be at offset 0");
_Static_assert(offsetof(OrbProStateVector, position) == 8,
    "OrbProStateVector.position must be at offset 8");
_Static_assert(offsetof(OrbProStateVector, velocity) == 32,
    "OrbProStateVector.velocity must be at offset 32");
_Static_assert(offsetof(OrbProStateVector, reference_frame) == 56,
    "OrbProStateVector.reference_frame must be at offset 56");
_Static_assert(offsetof(OrbProStateVector, flags) == 60,
    "OrbProStateVector.flags must be at offset 60");

/* ========================================================================= */
/* Orbital Elements (64 bytes)                                               */
/* ========================================================================= */

/**
 * Keplerian orbital elements for initialization.
 *
 * UNITS NOTE: this is an INPUT struct, and its length unit is KILOMETRES —
 * deliberately, and unlike OrbProStateVector, whose position/velocity are
 * METERS (see the NORMATIVE UNITS block at the top of this file). The two are
 * different structs on different sides of the call; do not "unify" them.
 *
 *   Offset  Size  Type      Field
 *   ------  ----  --------  -------------------------
 *   0       8     float64   semi_major_axis (km)
 *   8       8     float64   eccentricity
 *   16      8     float64   inclination (radians)
 *   24      8     float64   raan (radians)
 *   32      8     float64   arg_periapsis (radians)
 *   40      8     float64   true_anomaly (radians)
 *   48      8     float64   epoch (Julian date)
 *   56      8     float64   reserved (must be 0)
 */
typedef struct {
    double semi_major_axis;    /**< Semi-major axis in km */
    double eccentricity;       /**< Orbital eccentricity (0 = circular) */
    double inclination;        /**< Inclination in radians */
    double raan;               /**< Right ascension of ascending node (rad) */
    double arg_periapsis;      /**< Argument of periapsis in radians */
    double true_anomaly;       /**< True anomaly in radians */
    double epoch;              /**< Epoch as Julian date */
    double reserved;           /**< Reserved, must be 0 */
} OrbProOrbitalElements;

_Static_assert(sizeof(OrbProOrbitalElements) == 64,
    "OrbProOrbitalElements must be 64 bytes");

/* ========================================================================= */
/* Required Exported Functions                                               */
/* ========================================================================= */

/**
 * Initialize the propagator.
 *
 * Called by PropagatorPlugin.initFromTLE() or initFromElements().
 * The data buffer contains either UTF-8 TLE text or binary orbital elements.
 *
 * @param data   Pointer to initialization data (TLE string or elements array)
 * @param len    Length of data in bytes
 * @return       Number of entities initialized (>0) or negative error code
 *
 * REQUIRED: At least plugin_init must be exported.
 */
/* ORBPRO_EXPORT int32_t plugin_init(const uint8_t* data, size_t len); */

/**
 * Propagate a single entity to a given Julian date.
 *
 * @param julian_date   Target time as Julian date (float64)
 * @param entity_index  Index of the entity to propagate (0-based)
 * @param out           Pointer to output OrbProStateVector (64 bytes)
 * @return              0 on success, negative error code on failure
 *
 * REQUIRED: At least one of plugin_propagate or plugin_propagate_batch.
 */
/* ORBPRO_EXPORT int32_t plugin_propagate(
       double julian_date, uint32_t entity_index, OrbProStateVector* out); */

/* ========================================================================= */
/* Optional Exported Functions                                               */
/* ========================================================================= */

/**
 * Initialize from TLE data specifically.
 *
 * If exported, PropagatorPlugin.initFromTLE() calls this instead of
 * plugin_init. The buffer contains UTF-8 encoded TLE lines.
 *
 * @param tle_data  UTF-8 encoded TLE text
 * @param len       Length in bytes
 * @return          Number of satellites initialized or negative error code
 */
/* ORBPRO_EXPORT int32_t plugin_init_tle(
       const uint8_t* tle_data, size_t len); */

/**
 * Initialize from orbital elements.
 *
 * If exported, PropagatorPlugin.initFromElements() calls this instead of
 * plugin_init. The buffer contains an array of OrbProOrbitalElements.
 *
 * @param elements  Pointer to array of OrbProOrbitalElements
 * @param count     Number of element sets
 * @return          Number of entities initialized or negative error code
 */
/* ORBPRO_EXPORT int32_t plugin_init_elements(
       const OrbProOrbitalElements* elements, uint32_t count); */

/**
 * Propagate all entities to a given time (batch operation).
 *
 * If exported, PropagatorPlugin.propagateBatch() calls this for efficient
 * batch processing instead of calling plugin_propagate in a loop.
 *
 * @param julian_date  Target time as Julian date
 * @param out          Pointer to output buffer (count × 64 bytes)
 * @param count        Number of entities to propagate
 * @return             0 on success, negative error code on failure
 */
/* ORBPRO_EXPORT int32_t plugin_propagate_batch(
       double julian_date, OrbProStateVector* out, uint32_t count); */

/**
 * Get information about an initialized entity.
 *
 * @param entity_index  Index of the entity
 * @param out           Output buffer (256 bytes, format plugin-defined)
 * @return              0 on success, negative error code if not available
 */
/* ORBPRO_EXPORT int32_t get_entity_info(
       uint32_t entity_index, uint8_t* out); */

/**
 * Clean up all resources. Called when the plugin is being unloaded.
 */
/* ORBPRO_EXPORT void plugin_destroy(void); */

/* ========================================================================= */
/* Helper Functions                                                          */
/* ========================================================================= */

/**
 * Initialize a state vector with default values.
 *
 * Zeroes the WHOLE struct — including the three `reserved` bytes at offsets
 * 57..59, which the IDL requires to be zero. Callers that write into a buffer
 * they did not allocate themselves (the JS side reuses ONE malloc'd 64-byte
 * scratch buffer across every propagate call) MUST start here.
 */
static inline void orbpro_state_init(OrbProStateVector* sv) {
    memset(sv, 0, sizeof(*sv));
    sv->reference_frame = (uint8_t)ORBPRO_FRAME_TEME;
}

/**
 * Set the reference frame AND clear the three IDL-reserved bytes.
 *
 * USE THIS instead of assigning `sv->reference_frame` directly. The field is a
 * single byte (it mirrors the IDL's `ubyte`), so a direct assignment leaves
 * `reserved[0..2]` holding whatever was in the buffer before — and consumers
 * that read offset 56 as a 32-bit word (which several do, on the little-endian
 * assumption the old `uint32_t` declaration invited) would then see garbage in
 * the high bytes. This setter is the only write that is correct under both
 * readings.
 */
static inline void orbpro_state_set_frame(
    OrbProStateVector* sv, OrbProReferenceFrame frame
) {
    sv->reference_frame = (uint8_t)frame;
    sv->reserved[0] = 0;
    sv->reserved[1] = 0;
    sv->reserved[2] = 0;
}

/**
 * Set position on a state vector — METERS.
 * See the NORMATIVE UNITS block at the top of this file.
 */
static inline void orbpro_state_set_position(
    OrbProStateVector* sv, double x, double y, double z
) {
    sv->position[0] = x;
    sv->position[1] = y;
    sv->position[2] = z;
}

/**
 * Set velocity on a state vector — METERS PER SECOND.
 * See the NORMATIVE UNITS block at the top of this file.
 */
static inline void orbpro_state_set_velocity(
    OrbProStateVector* sv, double vx, double vy, double vz
) {
    sv->velocity[0] = vx;
    sv->velocity[1] = vy;
    sv->velocity[2] = vz;
}

/**
 * Mark a state vector as valid.
 */
static inline void orbpro_state_set_valid(OrbProStateVector* sv) {
    sv->flags |= ORBPRO_STATE_VALID;
}

/**
 * Check if a state vector is valid.
 */
static inline bool orbpro_state_is_valid(const OrbProStateVector* sv) {
    return (sv->flags & ORBPRO_STATE_VALID) != 0;
}

#ifdef __cplusplus
}
#endif

#endif /* ORBPRO_PROPAGATOR_H */
