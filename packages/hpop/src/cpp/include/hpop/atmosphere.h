/**
 * @file atmosphere.h
 * @brief Main interface for the atmosphere plugin
 *
 * OrbPro2-ModSim Atmosphere Plugin
 * Provides atmospheric properties using US76 or NRLMSISE-00 models
 */

#ifndef ATMOSPHERE_H
#define ATMOSPHERE_H

#include "atmosphere_types.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Initialize the atmosphere plugin
 * @param config Plugin configuration
 * @return ATMOSPHERE_OK on success, error code otherwise
 */
AtmosphereResult atmosphere_init(const AtmosphereConfig* config);

/**
 * @brief Shutdown the atmosphere plugin
 */
void atmosphere_shutdown(void);

/**
 * @brief Get atmospheric state at given altitude using specified model
 * @param altitude Geometric altitude [m]
 * @param model Atmosphere model to use
 * @param state Output atmospheric state
 * @return ATMOSPHERE_OK on success, error code otherwise
 */
AtmosphereResult atmosphere_get(double altitude, AtmosphereModel model, AtmosphereState* state);

/**
 * @brief Get atmospheric state with full position, time, and solar activity
 * @param position Geographic position
 * @param epoch Time specification
 * @param solar Solar activity indices (NULL to use defaults)
 * @param model Atmosphere model to use
 * @param state Output atmospheric state
 * @return ATMOSPHERE_OK on success, error code otherwise
 *
 * For US76, position and epoch are ignored (model is altitude-only).
 * For NRLMSISE-00, all parameters affect the result.
 */
AtmosphereResult atmosphere_get_ex(const GeoPosition* position,
                                    const AtmosphereEpoch* epoch,
                                    const SolarActivity* solar,
                                    AtmosphereModel model,
                                    AtmosphereState* state);

/**
 * @brief Get atmospheric density at altitude
 * @param altitude Geometric altitude [m]
 * @return Density [kg/m³], or -1.0 on error
 */
double atmosphere_get_density(double altitude);

/**
 * @brief Get temperature at altitude
 * @param altitude Geometric altitude [m]
 * @return Temperature [K], or -1.0 on error
 */
double atmosphere_get_temperature(double altitude);

/**
 * @brief Get pressure at altitude
 * @param altitude Geometric altitude [m]
 * @return Pressure [Pa], or -1.0 on error
 */
double atmosphere_get_pressure(double altitude);

/**
 * @brief Get speed of sound at altitude
 * @param altitude Geometric altitude [m]
 * @return Speed of sound [m/s], or -1.0 on error
 */
double atmosphere_get_speed_of_sound(double altitude);

/**
 * @brief Calculate Mach number
 * @param velocity True airspeed [m/s]
 * @param altitude Geometric altitude [m]
 * @return Mach number, or -1.0 on error
 */
double atmosphere_get_mach_number(double velocity, double altitude);

/**
 * @brief Get wind vector at position and time
 * @param position Geographic position
 * @param epoch Time specification
 * @param wind Output wind vector
 * @return ATMOSPHERE_OK on success, error code otherwise
 *
 * Note: Current implementation returns zero wind (stub).
 */
AtmosphereResult atmosphere_get_wind(const GeoPosition* position,
                                      const AtmosphereEpoch* epoch,
                                      WindVector* wind);

/**
 * @brief Set default atmosphere model
 * @param model Model to use for simple queries
 */
void atmosphere_set_default_model(AtmosphereModel model);

/**
 * @brief Get currently configured default model
 * @return Current default model
 */
AtmosphereModel atmosphere_get_default_model(void);

/**
 * @brief Update solar activity indices
 * @param solar New solar activity data
 */
void atmosphere_set_solar_activity(const SolarActivity* solar);

/* ============================================================================
 * US Standard Atmosphere 1976 functions
 * ============================================================================ */

/**
 * @brief Calculate US76 atmosphere at geometric altitude
 * @param altitude Geometric altitude [m] (0-86000)
 * @param state Output atmospheric state
 * @return ATMOSPHERE_OK on success, error code otherwise
 */
AtmosphereResult us76_calculate(double altitude, AtmosphereState* state);

/**
 * @brief Convert geometric altitude to geopotential altitude
 * @param geometric Geometric altitude [m]
 * @return Geopotential altitude [m]
 */
double us76_geometric_to_geopotential(double geometric);

/**
 * @brief Convert geopotential altitude to geometric altitude
 * @param geopotential Geopotential altitude [m]
 * @return Geometric altitude [m]
 */
double us76_geopotential_to_geometric(double geopotential);

/* ============================================================================
 * NRLMSISE-00 functions
 * ============================================================================ */

/**
 * @brief Calculate NRLMSISE-00 atmosphere
 * @param position Geographic position
 * @param epoch Time specification
 * @param solar Solar activity indices
 * @param state Output atmospheric state
 * @return ATMOSPHERE_OK on success, error code otherwise
 */
AtmosphereResult nrlmsise00_calculate(const GeoPosition* position,
                                       const AtmosphereEpoch* epoch,
                                       const SolarActivity* solar,
                                       AtmosphereState* state);

/**
 * @brief Calculate NRLMSISE-00 with altitude only (uses default lat/lon/time)
 * @param altitude Geometric altitude [m]
 * @param solar Solar activity indices
 * @param state Output atmospheric state
 * @return ATMOSPHERE_OK on success, error code otherwise
 */
AtmosphereResult nrlmsise00_calculate_simple(double altitude,
                                              const SolarActivity* solar,
                                              AtmosphereState* state);

#ifdef __cplusplus
}
#endif

#endif /* ATMOSPHERE_H */
