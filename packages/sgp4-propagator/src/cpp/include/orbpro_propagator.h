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
 *     // Compute position/velocity at julian_date
 *     out->epoch = julian_date;
 *     out->position[0] = x_km;
 *     out->position[1] = y_km;
 *     out->position[2] = z_km;
 *     out->velocity[0] = vx_kms;
 *     out->velocity[1] = vy_kms;
 *     out->velocity[2] = vz_kms;
 *     out->reference_frame = ORBPRO_FRAME_TEME;
 *     out->flags = ORBPRO_STATE_VALID;
 *     return 0;
 * }
 */

#ifndef ORBPRO_PROPAGATOR_H
#define ORBPRO_PROPAGATOR_H

#include "orbpro_plugin.h"

#ifdef __cplusplus
extern "C" {
#endif

/* ========================================================================= */
/* Reference Frames                                                          */
/* ========================================================================= */

/**
 * Reference frame for state vectors.
 * Must match PropagatorPlugin.js ReferenceFrame enum values.
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
 *   8       24    float64×3 position (x, y, z) in km
 *   32      24    float64×3 velocity (vx, vy, vz) in km/s
 *   56      4     uint32    reference_frame (see OrbProReferenceFrame)
 *   60      4     uint32    flags (see OrbProStateFlags)
 *
 * IMPORTANT: All propagator plugins MUST output positions in the ECEF
 * (Earth-Centered Earth-Fixed) reference frame, in METERS (not km).
 * Internal reference frame transforms (e.g. TEME→ECEF for SGP4) must be
 * performed inside the WASM plugin. Cesium expects ECEF/Fixed frame by default.
 * User-space transforms (ECEF↔ICRF etc.) are handled in JavaScript.
 *
 * Position and velocity units:
 *   - Position: meters (m) in ECEF frame
 *   - Velocity: meters per second (m/s) in ECEF frame
 */
typedef struct {
    double   epoch;            /**< Julian date of this state */
    double   position[3];      /**< Position [x, y, z] in km */
    double   velocity[3];      /**< Velocity [vx, vy, vz] in km/s */
    uint32_t reference_frame;  /**< Reference frame (OrbProReferenceFrame) */
    uint32_t flags;            /**< State flags (OrbProStateFlags bitfield) */
} OrbProStateVector;

/**
 * Compile-time check: OrbProStateVector must be exactly 64 bytes.
 */
_Static_assert(sizeof(OrbProStateVector) == 64,
    "OrbProStateVector must be 64 bytes");

/* ========================================================================= */
/* Orbital Elements (64 bytes)                                               */
/* ========================================================================= */

/**
 * Keplerian orbital elements for initialization.
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
 */
static inline void orbpro_state_init(OrbProStateVector* sv) {
    sv->epoch = 0.0;
    sv->position[0] = 0.0;
    sv->position[1] = 0.0;
    sv->position[2] = 0.0;
    sv->velocity[0] = 0.0;
    sv->velocity[1] = 0.0;
    sv->velocity[2] = 0.0;
    sv->reference_frame = ORBPRO_FRAME_TEME;
    sv->flags = 0;
}

/**
 * Set position on a state vector (km).
 */
static inline void orbpro_state_set_position(
    OrbProStateVector* sv, double x, double y, double z
) {
    sv->position[0] = x;
    sv->position[1] = y;
    sv->position[2] = z;
}

/**
 * Set velocity on a state vector (km/s).
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
