// TEST ONLY. Mallama & Hilton 2018, doi:10.1016/j.ascom.2018.08.002,
// Section 3.4 and published Ap_Mag_V3.f90, Mars/Mars_Stirling routines.
// Values are Johnson V mag at 10-degree intervals starting at longitude 0.
// Longitudes are west-positive body-fixed (rotation), heliocentric ecliptic
// (orbit); the latter is converted to Ls using the published -85-degree offset.
// No ephemeris or epoch is computed. Never import this into runtime/build code.
const rotation=[.036,.045,.038,.023,.015,.011,0,-.012,-.018,-.036,-.044,-.059,-.060,-.055,-.043,-.041,-.041,-.036,-.036,-.018,-.038,-.011,.002,.004,.018,.019,.035,.050,.035,.027,.037,.048,.025,.022,.024,.034];
const orbit=[-.029,-.017,-.014,-.006,-.018,-.020,-.014,-.030,-.008,-.040,-.024,-.037,-.036,-.032,.010,.010,-.001,.044,.025,-.004,-.016,-.008,.029,-.054,-.033,.055,.017,.052,.006,.087,.006,.064,.030,.019,-.030,-.017];
const wrap=a=>((a%360)+360)%360;
function interpolate(values,angle) {
  const x=wrap(angle)/10,index=Math.floor(x),fraction=x-index;
  // Five-point Lagrange form of the central fourth-degree interpolant.
  // Independent of the published program's finite-difference implementation.
  let result=0;
  for(let j=-2;j<=2;j++) {
    let basis=1;
    for(let k=-2;k<=2;k++)if(j!==k)basis*=(fraction-k)/(j-k);
    result+=basis*values[(index+j+36)%36];
  }
  return result;
}
export function marsCorrections(observerWestDeg,solarWestDeg,heliocentricLongitudeDeg) {
  if(![observerWestDeg,solarWestDeg,heliocentricLongitudeDeg].every(Number.isFinite))throw new RangeError('Nonfinite Mars geometry');
  const observer=wrap(observerWestDeg),solar=wrap(solarWestDeg);
  const effective=(observer+solar)/2+(Math.abs(observer-solar)>180?180:0);
  return {marsLongitudeCorrection:interpolate(rotation,effective),marsSeasonCorrection:interpolate(orbit,heliocentricLongitudeDeg-85)};
}
