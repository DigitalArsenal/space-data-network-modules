// Classical FK5 coordinate frames, with ERFA as the numerical authority.
#pragma once
#include "coords_types.h"

namespace coords {

// ERFA two-part Julian dates. TT controls precession/nutation; UT1 controls
// Earth rotation. Neither date is summed before evaluation.
struct Epoch {
    double tt1, tt2, ut11, ut12;
};

// All public double-date arguments are UTC Julian dates. They are split at
// midnight and converted UTC -> TAI -> TT by ERFA. With no EOP input, UT1=UTC:
// the missing DUT1 can reach 0.9 s (13.5 arcsec; about 2.8 km at GEO). The
// explicit Epoch overload permits an independently supplied two-part UT1.
//
// GCRF and J2000 are aliases here: the classical FK5 axes omit frame bias.
// MOD/TOD use IAU 1976/1980; TEME uses R3(eqeq94)*pnm80; PEF/ECEF/ITRF use
// R3(gst94)*pnm80, with zero polar motion for these general transforms.
// Every valid Frame pair is supported. Invalid frame values or invalid dates
// return a flagged all-NaN matrix/state; no exceptions or identity fallback.
Matrix3x3 getTransformMatrix(Frame from, Frame to, const Epoch& epoch);
Matrix3x3 getTransformMatrix(Frame from, Frame to, double jdUtc);

// Velocity rule: v_to = M*v_from + Mdot*r_from. Mdot retains Earth rotation
// only, about the true pole (the TOD/PEF/ECEF z axis), using the analytic
// GMST82 polynomial derivative as dGAST/dt. Precession, nutation and equinox
// rates are neglected, including for inertial-to-inertial transformations.
// The approximate neglected-rate scale is 2e-11 rad/s times radius: about
// 1.4e-4 m/s at LEO and 8e-4 m/s at GEO. The E2E records the full ERFA
// central-difference diagnostic; this estimate is not a strict upper bound.
StateVec transform(const StateVec& state, Frame from, Frame to, const Epoch& epoch);
StateVec transform(const StateVec& state, Frame from, Frame to, double jdUtc);
Vec3 transformPosition(const Vec3& position, Frame from, Frame to, double jdUtc);

// Retained public compatibility helpers. Polar motion is classical eraPom00
// with zero TIO locator. xp/yp are arcseconds; no frame bias is applied.
Matrix3x3 gcrfToItrf(double jdUtc, double xp = 0.0, double yp = 0.0);
Matrix3x3 temeToGcrf(double jdUtc);

} // namespace coords
