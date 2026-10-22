// TEST-ONLY ORACLE. Mallama & Hilton (2018), doi:10.1016/j.ascom.2018.08.002,
// section 3, Eqs. (2)-(17), and their Ap_Mag_V3.f90. NEVER import into runtime
// source, build input, or the published entry point. Runtime calibration must
// come from its own photometric parameters, not these magnitude equations.
// Units: Johnson V mag, angles degrees, r and delta AU. Geocentric viewing;
// outer-planet extensions use the paper's spacecraft phase domains. Neptune
// year is CE. No epoch applies to the other static mean curves.
export const phaseDomains=Object.freeze({Mercury:[2,170],Venus:[0,179],Mars:[0,50],Jupiter:[0,130],Saturn:[0,150],Uranus:[0,154],Neptune:[0,133]});
export function planetMagnitude(body,phaseDeg,{r=1,delta=1,year=2014,uranusLatitudeDeg=0,saturnRings=false,ringLatitudeDeg=0,marsLongitudeCorrection=0,marsSeasonCorrection=0}={}) {
  const a=phaseDeg,range=phaseDomains[body];
  if(!range || !Number.isFinite(a) || a<range[0] || a>range[1] || !(r>0 && delta>0))throw new RangeError('Outside documented oracle domain');
  let m;
  if(body==='Mercury')m=-.613+.063280*a-.0016336*a**2+.000033644*a**3-.00000034265*a**4+1.6893e-9*a**5-3.0334e-12*a**6;
  if(body==='Venus')m=a<=163.7?-4.384-.001044*a+.0003687*a**2-.000002814*a**3+8.938e-9*a**4:236.05828-2.81914*a+.00839034*a*a;
  if(body==='Mars')m=-1.601+.02267*a-.0001302*a*a+marsLongitudeCorrection+marsSeasonCorrection;
  if(body==='Jupiter')m=a<=12?-9.395-.00037*a+.000616*a*a:-9.428-2.5*Math.log10(1-1.507*(a/180)-.363*(a/180)**2-.062*(a/180)**3+2.809*(a/180)**4-1.876*(a/180)**5);
  if(body==='Saturn') {
    if(saturnRings) {
      if(a>6.5 || Math.abs(ringLatitudeDeg)>27)throw new RangeError('Saturn ring oracle domain');
      const b=Math.sin(Math.abs(ringLatitudeDeg)*Math.PI/180);m=-8.914-1.825*b+.026*a-.378*b*Math.exp(-2.25*a);
    } else m=a<=6.5?-8.95-.00037*a+.000616*a*a:-8.94+.0002446*a+.0002672*a*a-.000001505*a**3+4.767e-9*a**4;
    // Eq. (12) prints 1.505e-6; published Fortran uses 1.506e-6. This oracle
    // follows the paper and records that difference instead of silently fitting.
  }
  if(body==='Uranus')m=-7.110-.00084*Math.abs(uranusLatitudeDeg)+.006587*a+.0001045*a*a;
  if(body==='Neptune') {
    m=year<1980?-6.89:year<=2000?-6.89-.0054*(year-1980):-7;
    if(a>1.9) {if(year<=2000)throw new RangeError('Neptune extended curve requires year > 2000');m+=.007944*a+.00009617*a*a;}
  }
  return m+5*Math.log10(r*delta);
}
