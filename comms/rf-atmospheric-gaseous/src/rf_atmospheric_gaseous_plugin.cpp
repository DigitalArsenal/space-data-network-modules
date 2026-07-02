// SPDX-License-Identifier: Apache-2.0
//
// rf-atmospheric-gaseous — gaseous absorption: oxygen + water vapor.
//
// **AUDIT NOTE.** This module ports the existing simplified single-line
// approximations from RfCommsCore.js verbatim. The forms are NOT
// ITU-R P.676-13 Annex 2 — they are ad-hoc Lorentzian fits centered on
// the dominant 60 GHz O₂ line and 22 GHz H₂O line. The port is
// deliberately faithful so behavior is preserved during the WASM
// migration; Phase 2 of the RF audit will (a) characterize their
// deviation from the proper P.676-13 reference values across the
// (frequency, temperature, humidity) operating envelope, and (b) annotate
// `valid_range` metadata at the call sites where the deviation is
// acceptable, OR replace them with full P.676 Annex 2 in a follow-up.
//
// Citations:
//   - Simplified O₂ / H₂O line fits — RfCommsCore.js:4882-4906 (origin
//     unknown, no published reference cited in the JS).
//   - Magnus saturation vapor pressure — WMO No. 8 (CIMO Guide), 8th ed.,
//     Annex 4.A.1 (Alduchov & Eskridge 1996 form).
//
// Returns dB for a given path length, frequency, temperature, and
// humidity. Compatible signature with RfCommsCore.js's
// `_atmosphericAbsorption(freqGHz, pathKm, tempC, humidity, profile)`.

#include "orbpro_plugin.h"

#include <cmath>
#include <cstdint>
#include <cstddef>

namespace {

bool g_initialized = false;

inline bool isFiniteD(double v) { return std::isfinite(v); }

// WMO Magnus form for saturation vapor pressure over water.
// temperature_c: temperature in °C.
// Returns saturation vapor pressure in hPa.
inline double magnus_saturation_vapor_pressure_hpa(double temperature_c) {
  return 6.1121 * std::exp(
      (17.502 * temperature_c) / (240.97 + temperature_c));
}

// Single-Lorentzian oxygen-line absorption, dB/km.
// Valid roughly < 57 GHz; above that the 60 GHz oxygen complex dominates
// and this single-line fit is meaningless.
inline double oxygen_specific_attenuation_db_per_km(
    double frequency_ghz, double temperature_kelvin) {
  if (frequency_ghz >= 57.0) return 0.0;
  const double f2 = frequency_ghz * frequency_ghz;
  const double thetaCubed =
      std::pow(300.0 / temperature_kelvin, 3.0);
  return ((7.2 * f2) / (f2 + 0.34)) * thetaCubed * 1.0e-3;
}

// Single-Lorentzian water-vapor-line absorption (centered at 22.235 GHz),
// dB/km. Valid roughly > 1 GHz and below the dominant 183 GHz H₂O line.
inline double water_vapor_specific_attenuation_db_per_km(
    double frequency_ghz,
    double temperature_kelvin,
    double vapor_pressure_hpa) {
  if (frequency_ghz <= 1.0) return 0.0;
  const double thetaPow25 = std::pow(300.0 / temperature_kelvin, 2.5);
  const double f_minus_22 = frequency_ghz - 22.235;
  const double denom = f_minus_22 * f_minus_22 + 9.0;
  return 0.05 * vapor_pressure_hpa * thetaPow25 * (3.0 / denom);
}

// ---------------------------------------------------------------------------
// ITU-R P.676-13 Annex 1 §1 — line-by-line specific gaseous attenuation.
//
// Spectroscopic line tables (Tables 1 and 2 of Rec. ITU-R P.676-13; these
// tables are identical in P.676-12 and P.676-13, the -13 revision only
// changed Annex 2). Coefficients sourced verbatim from the ITU-Rpy
// reference implementation (itur 0.4.0, data/676/v12_lines_oxygen.txt and
// v12_lines_water_vapour.txt).
//
// Inputs follow strict P.676 semantics:
//   f     : frequency, GHz (valid 1–1000 GHz)
//   p     : DRY-air partial pressure, hPa (total barometric = p + e)
//   rho   : water-vapour density, g/m^3  (e = rho * T / 216.7 hPa)
//   T     : temperature, K
// Output: specific attenuation, dB/km.

// Table 1 — oxygen: f0 [GHz], a1..a6 (44 lines).
constexpr int kOxygenLineCount = 44;
constexpr double kOxygenLines[kOxygenLineCount][7] = {
    {50.474214, 0.975, 9.651, 6.69, 0.0, 2.566, 6.85},
    {50.987745, 2.529, 8.653, 7.17, 0.0, 2.246, 6.8},
    {51.503360, 6.193, 7.709, 7.64, 0.0, 1.947, 6.729},
    {52.021429, 14.32, 6.819, 8.11, 0.0, 1.667, 6.64},
    {52.542418, 31.24, 5.983, 8.58, 0.0, 1.388, 6.526},
    {53.066934, 64.29, 5.201, 9.06, 0.0, 1.349, 6.206},
    {53.595775, 124.6, 4.474, 9.55, 0.0, 2.227, 5.085},
    {54.130025, 227.3, 3.8, 9.96, 0.0, 3.17, 3.75},
    {54.671180, 389.7, 3.182, 10.37, 0.0, 3.558, 2.654},
    {55.221384, 627.1, 2.618, 10.89, 0.0, 2.56, 2.952},
    {55.783815, 945.3, 2.109, 11.34, 0.0, -1.172, 6.135},
    {56.264774, 543.4, 0.014, 17.03, 0.0, 3.525, -0.978},
    {56.363399, 1331.8, 1.654, 11.89, 0.0, -2.378, 6.547},
    {56.968211, 1746.6, 1.255, 12.23, 0.0, -3.545, 6.451},
    {57.612486, 2120.1, 0.910, 12.62, 0.0, -5.416, 6.056},
    {58.323877, 2363.7, 0.621, 12.95, 0.0, -1.932, 0.436},
    {58.446588, 1442.1, 0.083, 14.91, 0.0, 6.768, -1.273},
    {59.164204, 2379.9, 0.387, 13.53, 0.0, -6.561, 2.309},
    {59.590983, 2090.7, 0.207, 14.08, 0.0, 6.957, -0.776},
    {60.306056, 2103.4, 0.207, 14.15, 0.0, -6.395, 0.699},
    {60.434778, 2438.0, 0.386, 13.39, 0.0, 6.342, -2.825},
    {61.150562, 2479.5, 0.621, 12.92, 0.0, 1.014, -0.584},
    {61.800158, 2275.9, 0.910, 12.63, 0.0, 5.014, -6.619},
    {62.411220, 1915.4, 1.255, 12.17, 0.0, 3.029, -6.759},
    {62.486253, 1503.0, 0.083, 15.13, 0.0, -4.499, 0.844},
    {62.997984, 1490.2, 1.654, 11.74, 0.0, 1.856, -6.675},
    {63.568526, 1078.0, 2.108, 11.34, 0.0, 0.658, -6.139},
    {64.127775, 728.7, 2.617, 10.88, 0.0, -3.036, -2.895},
    {64.678910, 461.3, 3.181, 10.38, 0.0, -3.968, -2.590},
    {65.224078, 274.0, 3.8, 9.96, 0.0, -3.528, -3.680},
    {65.764779, 153.0, 4.473, 9.55, 0.0, -2.548, -5.002},
    {66.302096, 80.4, 5.2, 9.06, 0.0, -1.660, -6.091},
    {66.836834, 39.8, 5.982, 8.58, 0.0, -1.680, -6.393},
    {67.369601, 18.56, 6.818, 8.11, 0.0, -1.956, -6.475},
    {67.900868, 8.172, 7.708, 7.64, 0.0, -2.216, -6.545},
    {68.431006, 3.397, 8.652, 7.17, 0.0, -2.492, -6.600},
    {68.960312, 1.334, 9.65, 6.69, 0.0, -2.773, -6.650},
    {118.750334, 940.3, 0.010, 16.64, 0.0, -0.439, 0.079},
    {368.498246, 67.4, 0.048, 16.40, 0.0, 0.0, 0.0},
    {424.763020, 637.7, 0.044, 16.40, 0.0, 0.0, 0.0},
    {487.249273, 237.4, 0.049, 16.00, 0.0, 0.0, 0.0},
    {715.392902, 98.1, 0.145, 16.00, 0.0, 0.0, 0.0},
    {773.839490, 572.3, 0.141, 16.20, 0.0, 0.0, 0.0},
    {834.145546, 183.1, 0.145, 14.70, 0.0, 0.0, 0.0},
};

// Table 2 — water vapour: f0 [GHz], b1..b6 (35 lines).
constexpr int kWaterLineCount = 35;
constexpr double kWaterLines[kWaterLineCount][7] = {
    {22.235080, 0.1079, 2.144, 26.38, 0.76, 5.087, 1.00},
    {67.803960, 0.0011, 8.732, 28.58, 0.69, 4.930, 0.82},
    {119.995940, 0.0007, 8.353, 29.48, 0.70, 4.780, 0.79},
    {183.310087, 2.273, 0.668, 29.06, 0.77, 5.022, 0.85},
    {321.225630, 0.047, 6.179, 24.04, 0.67, 4.398, 0.54},
    {325.152888, 1.514, 1.541, 28.23, 0.64, 4.893, 0.74},
    {336.227764, 0.0010, 9.825, 26.93, 0.69, 4.740, 0.61},
    {380.197353, 11.67, 1.048, 28.11, 0.54, 5.063, 0.89},
    {390.134508, 0.0045, 7.347, 21.52, 0.63, 4.810, 0.55},
    {437.346667, 0.0632, 5.048, 18.45, 0.60, 4.230, 0.48},
    {439.150807, 0.9098, 3.595, 20.07, 0.63, 4.483, 0.52},
    {443.018343, 0.192, 5.048, 15.55, 0.60, 5.083, 0.50},
    {448.001085, 10.41, 1.405, 25.64, 0.66, 5.028, 0.67},
    {470.888999, 0.3254, 3.597, 21.34, 0.66, 4.506, 0.65},
    {474.689092, 1.260, 2.379, 23.20, 0.65, 4.804, 0.64},
    {488.490108, 0.2529, 2.852, 25.86, 0.69, 5.201, 0.72},
    {503.568532, 0.0372, 6.731, 16.12, 0.61, 3.980, 0.43},
    {504.482692, 0.0124, 6.731, 16.12, 0.61, 4.010, 0.45},
    {547.676440, 0.9785, 0.158, 26.00, 0.70, 4.500, 1.00},
    {552.020960, 0.184, 0.158, 26.00, 0.70, 4.500, 1.00},
    {556.935985, 497.0, 0.159, 30.86, 0.69, 4.552, 1.00},
    {620.700807, 5.015, 2.391, 24.38, 0.71, 4.856, 0.68},
    {645.766085, 0.0067, 8.633, 18.00, 0.60, 4.000, 0.50},
    {658.005280, 0.2732, 7.816, 32.10, 0.69, 4.140, 1.00},
    {752.033113, 243.4, 0.396, 30.86, 0.68, 4.352, 0.84},
    {841.051732, 0.0134, 8.177, 15.90, 0.33, 5.760, 0.45},
    {859.965698, 0.1325, 8.055, 30.60, 0.68, 4.090, 0.84},
    {899.303175, 0.0547, 7.914, 29.85, 0.68, 4.530, 0.90},
    {902.611085, 0.0386, 8.429, 28.65, 0.70, 5.100, 0.95},
    {906.205957, 0.1836, 5.110, 24.08, 0.70, 4.700, 0.53},
    {916.171582, 8.400, 1.441, 26.73, 0.70, 5.150, 0.78},
    {923.112692, 0.0079, 10.293, 29.00, 0.70, 5.000, 0.80},
    {970.315022, 9.009, 1.919, 25.50, 0.64, 4.940, 0.67},
    {987.926764, 134.6, 0.257, 29.85, 0.68, 4.550, 0.90},
    {1780.000000, 17506.0, 0.952, 196.30, 2.00, 24.150, 5.00},
};

// Water-vapour partial pressure from density (P.676-13 eq. for e), hPa.
inline double p676_vapor_pressure_hpa(double rho_g_m3, double temperature_k) {
  return rho_g_m3 * temperature_k / 216.7;
}

inline bool p676_inputs_invalid(double f_ghz, double dry_pressure_hpa,
                                double rho_g_m3, double temperature_k) {
  if (!isFiniteD(f_ghz) || !isFiniteD(dry_pressure_hpa) ||
      !isFiniteD(rho_g_m3) || !isFiniteD(temperature_k)) {
    return true;
  }
  if (f_ghz <= 0.0 || dry_pressure_hpa < 0.0 || rho_g_m3 < 0.0 ||
      temperature_k <= 0.0) {
    return true;
  }
  return false;
}

// P.676-13 Annex 1 §1, eq. (1)–(9): specific attenuation due to dry air
// (oxygen line complex + Debye/pressure-induced-nitrogen dry continuum).
double p676_gamma0_db_per_km(double f, double p, double rho, double T) {
  const double theta = 300.0 / T;
  const double e = p676_vapor_pressure_hpa(rho, T);

  double sumSF = 0.0;
  for (int i = 0; i < kOxygenLineCount; ++i) {
    const double f0 = kOxygenLines[i][0];
    const double a1 = kOxygenLines[i][1];
    const double a2 = kOxygenLines[i][2];
    const double a3 = kOxygenLines[i][3];
    const double a4 = kOxygenLines[i][4];
    const double a5 = kOxygenLines[i][5];
    const double a6 = kOxygenLines[i][6];

    // Line strength, eq. (3).
    const double Si = a1 * 1.0e-7 * p * theta * theta * theta *
                      std::exp(a2 * (1.0 - theta));
    // Line width with Zhevakin–Naumov correction, eq. (6a)/(6b).
    double Df = a3 * 1.0e-4 *
                (p * std::pow(theta, 0.8 - a4) + 1.1 * e * theta);
    Df = std::sqrt(Df * Df + 2.25e-6);
    // Interference (line-coupling) correction, eq. (7).
    const double delta =
        (a5 + a6 * theta) * 1.0e-4 * (p + e) * std::pow(theta, 0.8);
    // Line-shape factor, eq. (5).
    const double dfm = f0 - f;
    const double dfp = f0 + f;
    const double Fi = (f / f0) * ((Df - delta * dfm) / (dfm * dfm + Df * Df) +
                                  (Df - delta * dfp) / (dfp * dfp + Df * Df));
    sumSF += Si * Fi;
  }

  // Dry continuum (Debye spectrum + pressure-induced N2), eq. (8)/(9).
  const double d = 5.6e-4 * (p + e) * std::pow(theta, 0.8);
  const double Nd =
      f * p * theta * theta *
      (6.14e-5 / (d * (1.0 + (f / d) * (f / d))) +
       1.4e-12 * p * std::pow(theta, 1.5) /
           (1.0 + 1.9e-5 * std::pow(f, 1.5)));

  return 0.1820 * f * (sumSF + Nd);
}

// P.676-13 Annex 1 §1: specific attenuation due to water vapour.
double p676_gammaw_db_per_km(double f, double p, double rho, double T) {
  const double theta = 300.0 / T;
  const double e = p676_vapor_pressure_hpa(rho, T);

  double sumSF = 0.0;
  for (int i = 0; i < kWaterLineCount; ++i) {
    const double f0 = kWaterLines[i][0];
    const double b1 = kWaterLines[i][1];
    const double b2 = kWaterLines[i][2];
    const double b3 = kWaterLines[i][3];
    const double b4 = kWaterLines[i][4];
    const double b5 = kWaterLines[i][5];
    const double b6 = kWaterLines[i][6];

    // Line strength, eq. (3).
    const double Si =
        b1 * 1.0e-1 * e * std::pow(theta, 3.5) * std::exp(b2 * (1.0 - theta));
    // Line width, eq. (6a), with Doppler-broadening correction eq. (6b).
    double Df = b3 * 1.0e-4 *
                (p * std::pow(theta, b4) + b5 * e * std::pow(theta, b6));
    Df = 0.535 * Df +
         std::sqrt(0.217 * Df * Df + 2.1316e-12 * f0 * f0 / theta);
    // Line-shape factor, eq. (5), with delta = 0 for water vapour.
    const double dfm = f0 - f;
    const double dfp = f0 + f;
    const double Fi = (f / f0) *
                      (Df / (dfm * dfm + Df * Df) + Df / (dfp * dfp + Df * Df));
    sumSF += Si * Fi;
  }

  return 0.1820 * f * sumSF;
}

}  // namespace

extern "C" {

ORBPRO_EXPORT
int32_t plugin_init(const uint8_t* data, size_t len) {
  (void)data;
  (void)len;
  g_initialized = true;
  return 0;
}

ORBPRO_EXPORT
void plugin_destroy(void) {
  g_initialized = false;
}

// Specific oxygen attenuation in dB/km.
// frequency_ghz: in GHz. Returns 0.0 above the model's valid range.
// temperature_c: ambient temperature in °C.
ORBPRO_EXPORT
double rf_oxygen_specific_attenuation_db_per_km(
    double frequency_ghz,
    double temperature_c) {
  if (!isFiniteD(frequency_ghz) || !isFiniteD(temperature_c)) return 0.0;
  if (frequency_ghz <= 0.0) return 0.0;
  return oxygen_specific_attenuation_db_per_km(
      frequency_ghz, temperature_c + 273.15);
}

// Specific water-vapor attenuation in dB/km.
// frequency_ghz: in GHz.
// temperature_c: ambient temperature in °C.
// humidity_percent: relative humidity, 0..100. Used with the WMO Magnus
//   form to compute partial vapor pressure.
ORBPRO_EXPORT
double rf_water_vapor_specific_attenuation_db_per_km(
    double frequency_ghz,
    double temperature_c,
    double humidity_percent) {
  if (!isFiniteD(frequency_ghz) || !isFiniteD(temperature_c) ||
      !isFiniteD(humidity_percent)) {
    return 0.0;
  }
  if (frequency_ghz <= 0.0 || humidity_percent < 0.0) return 0.0;
  const double esat = magnus_saturation_vapor_pressure_hpa(temperature_c);
  const double e = humidity_percent * esat / 100.0;
  return water_vapor_specific_attenuation_db_per_km(
      frequency_ghz, temperature_c + 273.15, e);
}

// Total atmospheric absorption over a slant path, dB.
// frequency_ghz: in GHz.
// path_km: path length through the atmosphere, in km.
// temperature_c: ambient temperature in °C.
// humidity_percent: relative humidity, 0..100.
//
// **VALID RANGE NOTE.** The simplified Lorentzian fits are valid roughly
// within (1, 50) GHz at temperate conditions (250–320 K, 0–100 % RH).
// Outside this range the call returns the simplified value but should
// be treated with skepticism until Phase 2 of the audit publishes
// deviation maps.
ORBPRO_EXPORT
double rf_atmospheric_absorption_db(
    double frequency_ghz,
    double path_km,
    double temperature_c,
    double humidity_percent) {
  if (!isFiniteD(frequency_ghz) || !isFiniteD(path_km) ||
      !isFiniteD(temperature_c) || !isFiniteD(humidity_percent)) {
    return 0.0;
  }
  if (path_km <= 0.0 || frequency_ghz <= 0.0 ||
      humidity_percent < 0.0) {
    return 0.0;
  }
  const double tempK = temperature_c + 273.15;
  const double esat = magnus_saturation_vapor_pressure_hpa(temperature_c);
  const double e = humidity_percent * esat / 100.0;
  const double gammaO =
      oxygen_specific_attenuation_db_per_km(frequency_ghz, tempK);
  const double gammaH = water_vapor_specific_attenuation_db_per_km(
      frequency_ghz, tempK, e);
  return (gammaO + gammaH) * path_km;
}

// WMO Magnus saturation vapor pressure exposed as a primitive — used by
// the rain and cloud modules and worth having directly callable.
ORBPRO_EXPORT
double rf_saturation_vapor_pressure_hpa(double temperature_c) {
  if (!isFiniteD(temperature_c)) return 0.0;
  return magnus_saturation_vapor_pressure_hpa(temperature_c);
}

// ITU-R P.676-13 Annex 1 §1 — dry-air (oxygen + dry continuum) specific
// attenuation, dB/km.
// frequency_ghz: in GHz (recommendation valid range 1–1000 GHz).
// dry_pressure_hpa: DRY-air partial pressure in hPa (total = dry + e).
// water_vapour_density_g_m3: water-vapour density rho in g/m^3.
// temperature_k: temperature in K.
// Invalid/non-finite inputs return 0.0 (module convention).
ORBPRO_EXPORT
double rf_gaseous_gamma0_p676_db_per_km(
    double frequency_ghz,
    double dry_pressure_hpa,
    double water_vapour_density_g_m3,
    double temperature_k) {
  if (p676_inputs_invalid(frequency_ghz, dry_pressure_hpa,
                          water_vapour_density_g_m3, temperature_k)) {
    return 0.0;
  }
  return p676_gamma0_db_per_km(frequency_ghz, dry_pressure_hpa,
                               water_vapour_density_g_m3, temperature_k);
}

// ITU-R P.676-13 Annex 1 §1 — water-vapour specific attenuation, dB/km.
// Same argument semantics as rf_gaseous_gamma0_p676_db_per_km.
ORBPRO_EXPORT
double rf_gaseous_gammaw_p676_db_per_km(
    double frequency_ghz,
    double dry_pressure_hpa,
    double water_vapour_density_g_m3,
    double temperature_k) {
  if (p676_inputs_invalid(frequency_ghz, dry_pressure_hpa,
                          water_vapour_density_g_m3, temperature_k)) {
    return 0.0;
  }
  return p676_gammaw_db_per_km(frequency_ghz, dry_pressure_hpa,
                               water_vapour_density_g_m3, temperature_k);
}

// ITU-R P.676-13 Annex 1 §1 — total specific gaseous attenuation
// gamma = gamma_o + gamma_w, dB/km.
// Same argument semantics as rf_gaseous_gamma0_p676_db_per_km.
ORBPRO_EXPORT
double rf_gaseous_specific_attenuation_p676_db_per_km(
    double frequency_ghz,
    double dry_pressure_hpa,
    double water_vapour_density_g_m3,
    double temperature_k) {
  if (p676_inputs_invalid(frequency_ghz, dry_pressure_hpa,
                          water_vapour_density_g_m3, temperature_k)) {
    return 0.0;
  }
  return p676_gamma0_db_per_km(frequency_ghz, dry_pressure_hpa,
                               water_vapour_density_g_m3, temperature_k) +
         p676_gammaw_db_per_km(frequency_ghz, dry_pressure_hpa,
                               water_vapour_density_g_m3, temperature_k);
}

}  // extern "C"
