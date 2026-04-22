/**
 * @file atmosphere_plugin.cpp
 * @brief Plugin ABI wrapper for atmosphere models
 *
 * Provides the standardized plugin interface for OrbPro2-ModSim.
 * Wraps US Standard Atmosphere 1976 and NRLMSISE-00 models.
 */

#include "atmosphere.h"
#include <algorithm>
#include <cstring>
#include <cstdint>
#include <cstdio>
#include <cmath>

/* ============================================================================
 * Plugin State
 * ============================================================================ */

static bool g_initialized = false;
static AtmosphereModel g_defaultModel = ATMOSPHERE_MODEL_US76;
static SolarActivity g_solarActivity = {
    150.0,  /* F107: moderate solar activity */
    150.0,  /* F107A: 81-day average */
    {4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0}  /* Ap: quiet geomagnetic conditions */
};

/* ============================================================================
 * Internal Implementations
 * ============================================================================ */

/* Forward declarations from us76.cpp */
extern double us76_get_temperature(double altitude);
extern double us76_get_pressure(double altitude);
extern double us76_get_density(double altitude);
extern double us76_get_speed_of_sound(double altitude);

/* ============================================================================
 * Plugin Core Functions
 * ============================================================================ */

AtmosphereResult atmosphere_init(const AtmosphereConfig* config)
{
    if (config != nullptr) {
        g_defaultModel = config->defaultModel;
        std::memcpy(&g_solarActivity, &config->solarActivity, sizeof(SolarActivity));
    }

    g_initialized = true;
    return ATMOSPHERE_OK;
}

void atmosphere_shutdown(void)
{
    g_initialized = false;
}

void atmosphere_set_default_model(AtmosphereModel model)
{
    g_defaultModel = model;
}

AtmosphereModel atmosphere_get_default_model(void)
{
    return g_defaultModel;
}

void atmosphere_set_solar_activity(const SolarActivity* solar)
{
    if (solar != nullptr) {
        std::memcpy(&g_solarActivity, solar, sizeof(SolarActivity));
    }
}

/* ============================================================================
 * Query Functions
 * ============================================================================ */

AtmosphereResult atmosphere_get(double altitude, AtmosphereModel model, AtmosphereState* state)
{
    if (!g_initialized) {
        /* Auto-initialize with defaults */
        atmosphere_init(nullptr);
    }

    if (state == nullptr) {
        return ATMOSPHERE_ERROR_INVALID_PARAMETER;
    }

    switch (model) {
        case ATMOSPHERE_MODEL_US76:
            return us76_calculate(altitude, state);

        case ATMOSPHERE_MODEL_NRLMSISE00:
            return nrlmsise00_calculate_simple(altitude, &g_solarActivity, state);

        default:
            return ATMOSPHERE_ERROR_INVALID_MODEL;
    }
}

AtmosphereResult atmosphere_get_ex(const GeoPosition* position,
                                    const AtmosphereEpoch* epoch,
                                    const SolarActivity* solar,
                                    AtmosphereModel model,
                                    AtmosphereState* state)
{
    if (!g_initialized) {
        atmosphere_init(nullptr);
    }

    if (position == nullptr || state == nullptr) {
        return ATMOSPHERE_ERROR_INVALID_PARAMETER;
    }

    const SolarActivity* effectiveSolar = solar ? solar : &g_solarActivity;

    switch (model) {
        case ATMOSPHERE_MODEL_US76:
            /* US76 ignores position/time, altitude only */
            return us76_calculate(position->altitude, state);

        case ATMOSPHERE_MODEL_NRLMSISE00:
            return nrlmsise00_calculate(position, epoch, effectiveSolar, state);

        default:
            return ATMOSPHERE_ERROR_INVALID_MODEL;
    }
}

double atmosphere_get_density(double altitude)
{
    if (!g_initialized) {
        atmosphere_init(nullptr);
    }

    if (g_defaultModel == ATMOSPHERE_MODEL_US76) {
        return us76_get_density(altitude);
    } else {
        AtmosphereState state;
        if (nrlmsise00_calculate_simple(altitude, &g_solarActivity, &state) == ATMOSPHERE_OK) {
            return state.density;
        }
        return -1.0;
    }
}

double atmosphere_get_temperature(double altitude)
{
    if (!g_initialized) {
        atmosphere_init(nullptr);
    }

    if (g_defaultModel == ATMOSPHERE_MODEL_US76) {
        return us76_get_temperature(altitude);
    } else {
        AtmosphereState state;
        if (nrlmsise00_calculate_simple(altitude, &g_solarActivity, &state) == ATMOSPHERE_OK) {
            return state.temperature;
        }
        return -1.0;
    }
}

double atmosphere_get_pressure(double altitude)
{
    if (!g_initialized) {
        atmosphere_init(nullptr);
    }

    if (g_defaultModel == ATMOSPHERE_MODEL_US76) {
        return us76_get_pressure(altitude);
    } else {
        AtmosphereState state;
        if (nrlmsise00_calculate_simple(altitude, &g_solarActivity, &state) == ATMOSPHERE_OK) {
            return state.pressure;
        }
        return -1.0;
    }
}

double atmosphere_get_speed_of_sound(double altitude)
{
    if (!g_initialized) {
        atmosphere_init(nullptr);
    }

    if (g_defaultModel == ATMOSPHERE_MODEL_US76) {
        return us76_get_speed_of_sound(altitude);
    } else {
        AtmosphereState state;
        if (nrlmsise00_calculate_simple(altitude, &g_solarActivity, &state) == ATMOSPHERE_OK) {
            return state.speedOfSound;
        }
        return -1.0;
    }
}

double atmosphere_get_mach_number(double velocity, double altitude)
{
    double a = atmosphere_get_speed_of_sound(altitude);
    if (a <= 0.0) {
        return -1.0;
    }
    return velocity / a;
}

AtmosphereResult atmosphere_get_wind(const GeoPosition* position,
                                      const AtmosphereEpoch* epoch,
                                      WindVector* wind)
{
    if (position == nullptr || wind == nullptr) {
        return ATMOSPHERE_ERROR_INVALID_PARAMETER;
    }

    /* Simple horizontal wind model (NED frame, m/s).
     * This provides a deterministic non-zero wind field for drag sensitivity
     * tests until a full HWM-style model is integrated.
     */
    constexpr double PI = 3.14159265358979323846;
    constexpr double TWO_PI = 6.28318530717958647692;

    const double lat = position->latitude;
    const double lon = position->longitude;
    const double altKm = position->altitude * 1e-3;

    // Winds are negligible outside the thermosphere regime for this model.
    if (altKm < 80.0 || altKm > 800.0) {
        wind->north = 0.0;
        wind->east = 0.0;
        wind->down = 0.0;
        return ATMOSPHERE_OK;
    }

    double secondOfDay = 43200.0;
    if (epoch != nullptr) {
        secondOfDay = epoch->secondOfDay;
    }
    double lstHours = secondOfDay / 3600.0 + lon * (12.0 / PI);
    lstHours = std::fmod(lstHours, 24.0);
    if (lstHours < 0.0) {
        lstHours += 24.0;
    }

    const double tidePhase = TWO_PI * (lstHours / 24.0);
    const double altEnvelope = std::exp(-std::pow((altKm - 250.0) / 180.0, 2.0));
    const double apScale = 1.0 + 0.003 * std::max(0.0, g_solarActivity.Ap[0]);

    // Eastward winds are generally larger than meridional winds.
    const double eastAmp = 110.0 * altEnvelope * std::cos(lat) * apScale;
    const double northAmp = 45.0 * altEnvelope * std::sin(2.0 * lat) * apScale;

    wind->east = eastAmp * std::sin(tidePhase - PI / 3.0);
    wind->north = northAmp * std::cos(tidePhase + lon);
    wind->down = 0.0;

    return ATMOSPHERE_OK;
}

/* ============================================================================
 * Plugin ABI Interface
 * ============================================================================ */

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Plugin information structure
 */
typedef struct PluginInfo {
    const char* name;
    const char* version;
    const char* description;
    const char* author;
    uint32_t apiVersion;
} PluginInfo;

/**
 * @brief Query result for atmosphere
 */
typedef struct AtmosphereQueryResult {
    double density;
    double temperature;
    double pressure;
    double speedOfSound;
    int32_t errorCode;
} AtmosphereQueryResult;

/**
 * @brief Extended query result
 */
typedef struct AtmosphereQueryResultEx {
    AtmosphereState state;
    int32_t errorCode;
} AtmosphereQueryResultEx;

/* Plugin ABI version */
#define PLUGIN_API_VERSION 1

/* Static plugin info */
static const PluginInfo g_pluginInfo = {
    "atmosphere",
    "1.0.0",
    "Atmospheric models: US Standard Atmosphere 1976 and NRLMSISE-00",
    "OrbPro2-ModSim",
    PLUGIN_API_VERSION
};

/**
 * @brief Get plugin information
 * @return Pointer to plugin info structure
 */
const PluginInfo* get_plugin_info(void)
{
    return &g_pluginInfo;
}

/**
 * @brief Initialize the plugin
 * @param configJson JSON configuration string (optional)
 * @return 0 on success, negative on error
 */
int32_t init(const char* configJson)
{
    AtmosphereConfig config;
    config.defaultModel = ATMOSPHERE_MODEL_US76;
    config.useStoredSolarData = 0;

    /* Default solar activity */
    config.solarActivity.F107 = 150.0;
    config.solarActivity.F107A = 150.0;
    for (int i = 0; i < 7; ++i) {
        config.solarActivity.Ap[i] = 4.0;
    }

    /* Parse simple configuration if provided */
    if (configJson != nullptr) {
        /* Simple parsing for model selection */
        if (std::strstr(configJson, "\"model\":\"NRLMSISE00\"") ||
            std::strstr(configJson, "\"model\": \"NRLMSISE00\"")) {
            config.defaultModel = ATMOSPHERE_MODEL_NRLMSISE00;
        }

        /* Parse F107 if present (simple extraction) */
        const char* f107Ptr = std::strstr(configJson, "\"F107\":");
        if (f107Ptr) {
            double f107 = 0.0;
            if (std::sscanf(f107Ptr, "\"F107\":%lf", &f107) == 1 ||
                std::sscanf(f107Ptr, "\"F107\": %lf", &f107) == 1) {
                config.solarActivity.F107 = f107;
                config.solarActivity.F107A = f107;  /* Use same for both */
            }
        }

        /* Parse Ap if present */
        const char* apPtr = std::strstr(configJson, "\"Ap\":");
        if (apPtr) {
            double ap = 0.0;
            if (std::sscanf(apPtr, "\"Ap\":%lf", &ap) == 1 ||
                std::sscanf(apPtr, "\"Ap\": %lf", &ap) == 1) {
                for (int i = 0; i < 7; ++i) {
                    config.solarActivity.Ap[i] = ap;
                }
            }
        }
    }

    return (int32_t)atmosphere_init(&config);
}

/**
 * @brief Shutdown the plugin
 */
void shutdown_plugin(void)
{
    atmosphere_shutdown();
}

/**
 * @brief Query atmosphere at altitude (simple interface)
 * @param altitude Geometric altitude [m]
 * @param result Output result structure
 * @return 0 on success, negative on error
 */
int32_t query_atmosphere(double altitude, AtmosphereQueryResult* result)
{
    if (result == nullptr) {
        return ATMOSPHERE_ERROR_INVALID_PARAMETER;
    }

    AtmosphereState state;
    AtmosphereResult res = atmosphere_get(altitude, g_defaultModel, &state);

    result->density = state.density;
    result->temperature = state.temperature;
    result->pressure = state.pressure;
    result->speedOfSound = state.speedOfSound;
    result->errorCode = (int32_t)res;

    return (int32_t)res;
}

/**
 * @brief Query atmosphere with full parameters
 * @param lat Geodetic latitude [radians]
 * @param lon Geodetic longitude [radians]
 * @param alt Altitude above reference ellipsoid [m]
 * @param year Year
 * @param dayOfYear Day of year (1-366)
 * @param secondOfDay Seconds since midnight UTC
 * @param result Output result structure
 * @return 0 on success, negative on error
 */
int32_t query_atmosphere_ex(double lat, double lon, double alt,
                            int32_t year, int32_t dayOfYear, double secondOfDay,
                            AtmosphereQueryResultEx* result)
{
    if (result == nullptr) {
        return ATMOSPHERE_ERROR_INVALID_PARAMETER;
    }

    GeoPosition pos = {lat, lon, alt};
    AtmosphereEpoch epoch = {year, dayOfYear, secondOfDay};

    AtmosphereResult res = atmosphere_get_ex(&pos, &epoch, nullptr, g_defaultModel, &result->state);
    result->errorCode = (int32_t)res;

    return (int32_t)res;
}

/**
 * @brief Get wind at position and time
 * @param lat Geodetic latitude [radians]
 * @param lon Geodetic longitude [radians]
 * @param alt Altitude [m]
 * @param year Year
 * @param dayOfYear Day of year
 * @param secondOfDay Seconds since midnight
 * @param windNorth Output: north wind component [m/s]
 * @param windEast Output: east wind component [m/s]
 * @param windDown Output: downward wind component [m/s]
 * @return 0 on success, negative on error
 */
int32_t get_wind(double lat, double lon, double alt,
                 int32_t year, int32_t dayOfYear, double secondOfDay,
                 double* windNorth, double* windEast, double* windDown)
{
    GeoPosition pos = {lat, lon, alt};
    AtmosphereEpoch epoch = {year, dayOfYear, secondOfDay};
    WindVector wind;

    AtmosphereResult res = atmosphere_get_wind(&pos, &epoch, &wind);

    if (windNorth) *windNorth = wind.north;
    if (windEast) *windEast = wind.east;
    if (windDown) *windDown = wind.down;

    return (int32_t)res;
}

/**
 * @brief Set the default atmosphere model
 * @param model 0 = US76, 1 = NRLMSISE00
 */
void set_model(int32_t model)
{
    atmosphere_set_default_model((AtmosphereModel)model);
}

/**
 * @brief Update solar activity indices
 * @param f107 Daily F10.7 flux
 * @param f107a 81-day average F10.7
 * @param ap Daily Ap index
 */
void set_solar_activity(double f107, double f107a, double ap)
{
    SolarActivity solar;
    solar.F107 = f107;
    solar.F107A = f107a;
    for (int i = 0; i < 7; ++i) {
        solar.Ap[i] = ap;
    }
    atmosphere_set_solar_activity(&solar);
}

#ifdef __cplusplus
}
#endif
