// TEST-ONLY acceptance measurements. The Mallama-Hilton oracle is never an
// input to the build, table generation, spectral integration or model fitting.
import {planetMagnitude,phaseDomains} from './mallama-hilton-oracle.mjs';
import {invoke} from './measurements.mjs';

// Prsa et al. (2016), doi:10.3847/0004-6256/152/2/41, Table 1 (IAU 2015 B3).
// Equator-on projected-area-equivalent sphere sqrt(Re*Rp), meters. This
// preserves the projected area, not the detailed ellipsoid scattering law.
// AU is the exact IAU 2012 B2 conversion stated in the same paper, Section 4.
export const jupiterGeometry={radius_m:Math.sqrt(71492000*66854000),sun_distance_au:1,observer_distance_m:149597870700};

export async function measurePlanets(harness) {
  const reports=Object.fromEntries(Object.entries(phaseDomains).map(([body,range])=>[body,
    {status:'fail',phase_domain_deg:range,threshold_mag:.1,samples:0,max_residual_mag:null,
      reason:'No independently sourced and validated absolute Johnson V disk-photometry implementation.'}]));
  const model='jupiter:heng2021:V';
  // 0.125-degree grid plus both sides of the oracle's piecewise boundary.
  // Static Cassini-derived model, equatorial view, no epoch correction.
  const angles=[...new Set([...Array.from({length:1041},(_,i)=>i/8),12-1e-6,12+1e-6])].sort((a,b)=>a-b);
  let maximum=0,worst=null,geometricAlbedo=null;
  const examples=[];
  for(let offset=0;offset<angles.length;offset+=256) {
    const batch=angles.slice(offset,offset+256);
    const result=await invoke(harness,'disk_photometry',{model,...jupiterGeometry,phase_rad:batch.map(a=>a*Math.PI/180)});
    for(let i=0;i<batch.length;i++) {
      const oracle=planetMagnitude('Jupiter',batch[i]);
      const residual=result.apparent_magnitude[i]-oracle;
      const sample={phase_deg:batch[i],module_magnitude:result.apparent_magnitude[i],oracle_magnitude:oracle,residual_mag:residual};
      if(Math.abs(residual)>maximum){maximum=Math.abs(residual);worst=sample;}
      if([0,12,30,60,90,130].includes(batch[i]))examples.push(sample);
      if(batch[i]===0)geometricAlbedo=result.disk_albedo[i];
    }
  }
  reports.Jupiter={status:maximum<.1?'pass':'fail',model,phase_domain_deg:phaseDomains.Jupiter,threshold_mag:.1,
    samples:angles.length,max_residual_mag:maximum,worst,absolute_calibration:true,matched_band:true,
    model_geometric_albedo:geometricAlbedo,band:'Johnson V: Bessell 1990 energy response and CALSPEC Sun',
    geometry:jupiterGeometry,geometry_source:'doi:10.3847/0004-6256/152/2/41 Table 1 and Section 4; projected-area-equivalent sphere, equator-on',
    epoch:'Static Cassini-derived scattering parameters; no secular correction',
    tolerance_rationale:'Task acceptance requires an absolute residual below 0.1 mag throughout the observed phase domain.',
    reference_examples:examples,scope:'Independent spectral-scattering prediction, with no magnitude offset or phase normalization fitted to Mallama-Hilton.'};
  return reports;
}
