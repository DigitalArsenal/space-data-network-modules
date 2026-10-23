// Reference validation only. These residuals are NOT module acceptance results.
import {planetMagnitude,phaseDomains} from './mallama-hilton-oracle.mjs';
import {publishedCases} from './published-planet-cases.mjs';

export function measureOracle() {
  const cases=publishedCases.map(([body,date,phase_deg,options,published_magnitude])=>{
    const oracle_magnitude=planetMagnitude(body,phase_deg,options);
    return {body,date,phase_deg,options,published_magnitude,oracle_magnitude,
      residual_mag:oracle_magnitude-published_magnitude};
  });
  const planets=Object.fromEntries(Object.keys(phaseDomains).map(body=>{
    const samples=cases.filter(c=>c.body===body);
    return [body,{samples:samples.length,max_residual_mag:Math.max(...samples.map(c=>Math.abs(c.residual_mag)))}];
  }));
  // Eq.12 differs from the published code by 1e-9 * alpha^3 mag.
  // It is monotonic on the extended domain, so its maximum is at 150 degrees.
  const saturnPaperCodeDifference={paper_cubic:-1.505e-6,code_cubic:-1.506e-6,
    phase_deg:150,max_difference_mag:Math.abs((-1.505e-6+1.506e-6)*150**3),
    policy:'Paper coefficient retained; difference reported, not fitted away.'};
  return {status:cases.every(c=>Math.abs(c.residual_mag)<.001)?'pass':'fail',
    scope:'Test-only oracle versus published program examples; NOT module residuals.',
    source:'doi:10.1016/j.ascom.2018.08.002, Section 3, Ap_Mag_Input_V3.txt and Ap_Mag_Output_V3.txt',
    units:'Johnson V mag; phase degrees; distances au; supplied UT epochs and geometry',
    threshold_mag:.001,tolerance_rationale:'Published output rounded to three decimal places.',
    planets,cases,saturnPaperCodeDifference};
}
