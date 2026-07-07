// higherpop/stationkeeping.hpp — orbit-maintenance maneuver planning.
//
// The station-keeping analyses STK and FreeFlyer provide for operational
// orbits, built on the two-body/J2 geometry and the tangential-burn relation
// dv = (n a / 2) * (da/a)  (Gauss VOP, along-track impulse changes a).
//
//  * GEO East-West longitude keeping: a satellite off its nominal
//    geosynchronous radius drifts in longitude at rate proportional to the
//    semi-major-axis error. eastWestCycle() sizes the drift period and the
//    tangential dv per correction cycle for a given longitude deadband.
//
//  * LEO altitude / ground-track maintenance: atmospheric drag lowers the
//    semi-major axis; leoAltitudeMaintenance() sizes the reboost dv and the
//    interval between reboosts for a given SMA-decay rate and deadband.
//
//  * genericSmaControl(): the tangential dv to change a by a target amount,
//    the primitive underneath both (also usable by the hp::target solver).
//
// Units km, s, km/s, rad. Header-only, depends only on constants + vec3.

#ifndef HIGHERPOP_STATIONKEEPING_HPP
#define HIGHERPOP_STATIONKEEPING_HPP

#include <cmath>
#include "higherpop/constants.hpp"

namespace hp {
namespace stationkeeping {

// Mean motion and the tangential-burn <-> da relation ------------------------
inline double meanMotion(double a, double mu=MU_EARTH){ return std::sqrt(mu/(a*a*a)); }

// Tangential dv (km/s) that produces a semi-major-axis change da (km), to first
// order (Gauss): da = 2/(n a) * (a) * dv_t  =>  dv_t = (n a / 2) * (da / a).
inline double genericSmaControl(double a, double da, double mu=MU_EARTH){
  double n = meanMotion(a,mu);
  return 0.5 * n * a * (da / a);   // = 0.5 * n * da
}

// ---- GEO East-West longitude keeping --------------------------------------
// A GEO satellite with semi-major-axis error da drifts in longitude because its
// orbital period differs from the sidereal day. Longitude drift rate:
//     dLon/dt = -1.5 * (n_geo / a_geo) * da     [rad/s]   (to first order)
// East-West keeping lets a drift across a deadband +/- dLonDeadband, then a
// tangential burn reverses the SMA error to drift back — a saw-tooth cycle.
struct EWResult {
  double a_geo;             // nominal geostationary radius [km]
  double drift_rate;        // [rad/s] for the given da
  double drift_rate_deg_day;
  double cycle_days;        // time to cross the full deadband and return
  double dv_per_cycle;      // tangential dv per correction [km/s]
  double dv_per_year;       // annual budget [km/s]
};

inline EWResult eastWestKeeping(double da_km, double lon_deadband_deg,
                                double mu=MU_EARTH, double omega_earth=OMEGA_EARTH) {
  EWResult r;
  // geostationary radius: n == Earth rotation rate
  r.a_geo = std::cbrt(mu/(omega_earth*omega_earth));
  double n = meanMotion(r.a_geo, mu);
  // longitude drift rate for SMA error da (rad/s)
  r.drift_rate = -1.5 * (n / r.a_geo) * da_km;
  r.drift_rate_deg_day = r.drift_rate * (180.0/M_PI) * 86400.0;
  double band = 2.0 * lon_deadband_deg * M_PI/180.0; // full peak-to-peak
  double rate = std::fabs(r.drift_rate);
  r.cycle_days = (rate>0) ? band/rate/86400.0 : 0.0;
  // each cycle reverses the SMA error (delta a = 2*da), needing dv=0.5*n*(2 da)
  r.dv_per_cycle = std::fabs(genericSmaControl(r.a_geo, 2.0*da_km, mu));
  r.dv_per_year  = (r.cycle_days>0) ? r.dv_per_cycle * (365.25/r.cycle_days) : 0.0;
  return r;
}

// ---- LEO altitude / ground-track maintenance ------------------------------
// Drag lowers a at rate da/dt (< 0, km/s). To hold altitude within a deadband
// of depth dAlt (km) below nominal, reboost when a has dropped by dAlt.
struct LEOResult {
  double reboost_interval_days;
  double dv_per_reboost;   // [km/s]
  double dv_per_year;      // [km/s]
};

inline LEOResult leoAltitudeMaintenance(double a, double da_dt_km_per_s,
                                        double dAlt_km, double mu=MU_EARTH) {
  LEOResult r;
  double decay = std::fabs(da_dt_km_per_s);
  r.reboost_interval_days = (decay>0) ? (dAlt_km/decay)/86400.0 : 0.0;
  // reboost raises a by dAlt: dv = 0.5*n*dAlt
  r.dv_per_reboost = std::fabs(genericSmaControl(a, dAlt_km, mu));
  r.dv_per_year = (r.reboost_interval_days>0)
                    ? r.dv_per_reboost*(365.25/r.reboost_interval_days) : 0.0;
  return r;
}

} // namespace stationkeeping
} // namespace hp

#endif // HIGHERPOP_STATIONKEEPING_HPP
