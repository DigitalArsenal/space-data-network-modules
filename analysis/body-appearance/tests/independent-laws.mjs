// INDEPENDENT TEST ORACLES ONLY. Never included by build.mjs or package files.
// Rock source: Golombek et al. (2021), doi:10.1029/2021EA001959, section 1,
// reproducing Golombek-Rapp (1997), doi:10.1029/96JE03319. Diameters meters,
// areas m^2, dimensionless fractions; body-fixed static populations, no epoch.
// Count integrals below use E1, not the runtime's Simpson quadrature/rejection.
export function e1(x) {
  let sum=0,term=1;
  for(let k=1;k<150;k++) {term*=-x/k;sum+=term/k;if(Math.abs(term/k)<1e-17)break;}
  return -0.5772156649015329-Math.log(x)-sum;
}
export function rockIntegral(q,a,b) {
  return Math.exp(-q*a)/a-Math.exp(-q*b)/b-q*(e1(q*a)-e1(q*b));
}
export function rockNumberCdf(d,q,a,b) {return rockIntegral(q,a,d)/rockIntegral(q,a,b);}
// Source: Neukum et al. (2001) doi:10.1023/A:1011989004263, Eq. (2),
// Table I "New" column. This transcription is independent of shipped JSON.
// Only ratios to N(1 km) enter, so a0 and the retention age cancel.
export function lunarCraterShape(diameterM) {
  const coefficients=[-3.557528,.781027,1.021521,-.156012,-.444058,.019977,.086850,-.005874,-.006809,.000825,.0000554];
  const x=Math.log10(diameterM/1000);
  return 10**coefficients.reduce((sum,a,i)=>sum+a*x**(i+1),0);
}
export function craterNumberCdf(d,a,b) {return (lunarCraterShape(a)-lunarCraterShape(d))/(lunarCraterShape(a)-lunarCraterShape(b));}
export function craterAreaFraction(n1PerKm2,a,b) {
  // Integration by parts on cumulative N(D), independent of the runtime's
  // polynomial derivative/Simpson integration. Midpoints in log D, 8192 bins;
  // doubling this resolution is checked below against a 1e-7 relative budget.
  const integrate=n=>{
    const h=Math.log(b/a)/n;let sum=0;
    for(let i=0;i<n;i++){const d=a*Math.exp((i+.5)*h);sum+=2*d*d*lunarCraterShape(d)*h;}
    return n1PerKm2/1e6*Math.PI/4*(a*a*lunarCraterShape(a)-b*b*lunarCraterShape(b)+sum);
  };
  const coarse=integrate(8192),fine=integrate(16384);
  if(Math.abs(coarse/fine-1)>1e-7)throw new Error('Independent crater area quadrature did not converge');
  return fine;
}
export function ks(samples,cdf) {
  const sorted=[...samples].sort((a,b)=>a-b),n=sorted.length;let d=0;
  for(let i=0;i<n;i++){const f=cdf(sorted[i]);d=Math.max(d,(i+1)/n-f,f-i/n);}
  const z=(Math.sqrt(n)+.12+.11/Math.sqrt(n))*d;let p=0;
  for(let k=1;k<100;k++)p+=2*(k%2?1:-1)*Math.exp(-2*k*k*z*z);
  return {n,d,p:Math.max(0,Math.min(1,p))};
}

// Test-only ROLO 311g. Kieffer & Stone (2005), doi:10.1086/430185,
// Eqs. (10)/(11), Tables 4/5. 553.8 nm narrow band (NOT Johnson V).
// Polynomial phase and solar longitude radians; exponential/cosine angles
// and observer libration degrees. Standard distances cancel in ratios.
// Domain in section 3.3.1: 1.55 < phase < 97 degrees. No fitting of another
// runtime model to this oracle is allowed. Independently transcribed from
// the paper; also used to verify the published ROLO implementation's absolute
// irradiance through Eqs.(7),(8). Same-model verification is labeled as such.
export function roloReflectance(phaseDeg,solarLongitudeDeg=phaseDeg,observerLatDeg=0,observerLonDeg=0) {
  const g=phaseDeg*Math.PI/180,s=solarLongitudeDeg*Math.PI/180;
  const logA=-2.12504-1.65970*g+.38409*g*g-.20655*g*g*g
    +.04052*s+.01009*s**3-.00388*s**5
    +.00034115*observerLatDeg-.0013425*observerLonDeg+.00095906*s*observerLatDeg+.00066229*s*observerLonDeg
    +.37206*Math.exp(-phaseDeg/4.06054)-.10745*Math.exp(-phaseDeg/12.8802)
    +.00347*Math.cos((phaseDeg+30.5858)/16.7498);
  return Math.exp(logA);
}
