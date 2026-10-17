/**
 * @file atmosphere_types.h
 * @brief Type definitions for the atmosphere plugin
 *
 * OrbPro2-ModSim Atmosphere Plugin
 * Supports US Standard Atmosphere 1976 and NRLMSISE-00 models
 */

#ifndef ATMOSPHERE_TYPES_H
#define ATMOSPHERE_TYPES_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * @brief Atmosphere model selection
 */
typedef enum AtmosphereModel {
    ATMOSPHERE_MODEL_US76 = 0,      /**< US Standard Atmosphere 1976 (0-86km) */
    ATMOSPHERE_MODEL_NRLMSISE00 = 1 /**< NRLMSISE-00 (0-1000km, solar/geomagnetic) */
} AtmosphereModel;

/**
 * @brief Atmospheric state at a given point
 */
typedef struct AtmosphereState {
    double density;       /**< Atmospheric density [kg/m³] */
    double temperature;   /**< Temperature [K] */
    double pressure;      /**< Pressure [Pa] */
    double speedOfSound;  /**< Speed of sound [m/s] */

    /* Extended NRLMSISE-00 outputs */
    double molecularMass; /**< Mean molecular mass [g/mol] */
    double numDensityN2;  /**< N2 number density [1/m³] */
    double numDensityO2;  /**< O2 number density [1/m³] */
    double numDensityO;   /**< Atomic O number density [1/m³] */
    double numDensityHe;  /**< He number density [1/m³] */
    double numDensityAr;  /**< Ar number density [1/m³] */
    double numDensityH;   /**< H number density [1/m³] */
    double numDensityN;   /**< Atomic N number density [1/m³] */
    double exosphericTemp;/**< Exospheric temperature [K] */
} AtmosphereState;

/**
 * @brief Geographic position
 */
typedef struct GeoPosition {
    double latitude;  /**< Geodetic latitude [radians] */
    double longitude; /**< Geodetic longitude [radians] */
    double altitude;  /**< Altitude above reference ellipsoid [m] */
} GeoPosition;

/**
 * @brief Solar and geomagnetic activity indices for NRLMSISE-00
 */
typedef struct SolarActivity {
    double F107;      /**< Daily F10.7 solar flux (previous day) [SFU] */
    double F107A;     /**< 81-day centered average F10.7 [SFU] */
    double Ap[7];     /**< Magnetic index array:
                       *   Ap[0] = daily Ap
                       *   Ap[1] = 3-hr Ap index for current time
                       *   Ap[2] = 3-hr Ap index for 3 hrs before
                       *   Ap[3] = 3-hr Ap index for 6 hrs before
                       *   Ap[4] = 3-hr Ap index for 9 hrs before
                       *   Ap[5] = Average of eight 3-hr Ap indices (12-33 hrs prior)
                       *   Ap[6] = Average of eight 3-hr Ap indices (36-57 hrs prior)
                       */
} SolarActivity;

/**
 * @brief Wind vector in local NED frame
 */
typedef struct WindVector {
    double north; /**< Wind component toward north [m/s] */
    double east;  /**< Wind component toward east [m/s] */
    double down;  /**< Wind component downward [m/s] (usually negative = upward) */
} WindVector;

/**
 * @brief Time specification for atmosphere queries
 */
typedef struct AtmosphereEpoch {
    int32_t year;        /**< Year (e.g., 2024) */
    int32_t dayOfYear;   /**< Day of year (1-366) */
    double secondOfDay;  /**< Seconds since midnight UTC */
} AtmosphereEpoch;

/**
 * @brief Plugin configuration
 */
typedef struct AtmosphereConfig {
    AtmosphereModel defaultModel;  /**< Default atmosphere model */
    SolarActivity solarActivity;   /**< Solar activity data */
    int32_t useStoredSolarData;    /**< If non-zero, use internal solar data tables */
} AtmosphereConfig;

/**
 * @brief Result/error codes
 */
typedef enum AtmosphereResult {
    ATMOSPHERE_OK = 0,
    ATMOSPHERE_ERROR_INVALID_ALTITUDE = -1,
    ATMOSPHERE_ERROR_INVALID_MODEL = -2,
    ATMOSPHERE_ERROR_NOT_INITIALIZED = -3,
    ATMOSPHERE_ERROR_INVALID_PARAMETER = -4
} AtmosphereResult;

/* Physical constants */
#define ATMOSPHERE_R_SPECIFIC    287.053    /**< Specific gas constant for air [J/(kg·K)] */
#define ATMOSPHERE_G0            9.80665    /**< Standard gravity [m/s²] */
#define ATMOSPHERE_M0            28.9644    /**< Mean molecular weight at sea level [kg/kmol] */
#define ATMOSPHERE_GAMMA         1.4        /**< Ratio of specific heats for air */
#define ATMOSPHERE_R_UNIVERSAL   8314.32    /**< Universal gas constant [J/(kmol·K)] */

/* Reference values at sea level */
#define ATMOSPHERE_P0            101325.0   /**< Sea level pressure [Pa] */
#define ATMOSPHERE_T0            288.15     /**< Sea level temperature [K] */
#define ATMOSPHERE_RHO0          1.225      /**< Sea level density [kg/m³] */

/* Model limits */
#define US76_MAX_ALTITUDE        86000.0    /**< Maximum altitude for US76 [m] */
#define NRLMSISE_MAX_ALTITUDE    1000000.0  /**< Maximum altitude for NRLMSISE-00 [m] */

#ifdef __cplusplus
}
#endif

#endif /* ATMOSPHERE_TYPES_H */
