// TEST-ONLY cross-band shape diagnostics. Never used to calibrate the module.
// The runtime's Jupiter 550 nm and Saturn Pioneer red bands are NOT Johnson V.
// Normalizing both curves at opposition isolates the phase-shape mismatch;
// this cannot pass an absolute or matched-band acceptance gate.
import {planetMagnitude} from './mallama-hilton-oracle.mjs';
import {invoke} from './measurements.mjs';

export async function planetDiagnostics(harness) {
  const reports={};
  for(const [body,model,maxPhase] of [['Jupiter','jupiter:heng2021:550nm',130],['Saturn','saturn:dyudina2016:640nm',150]]) {
    const angles=Array.from({length:maxPhase+1},(_,i)=>i);
    // Synthetic geometry and zero-point cancel in this shape comparison.
    // Only runtime albedos enter; distances do not represent these planets.
    const result=await invoke(harness,'disk_photometry',{model,phase_rad:angles.map(a=>a*Math.PI/180),
      radius_m:1000,observer_distance_m:1e8,sun_distance_au:1,solar_magnitude:0});
    let maxResidual=0,worst=null;
    for(let i=0;i<angles.length;i++) {
      const dimming=-2.5*Math.log10(result.disk_albedo[i]/result.disk_albedo[0]);
      const oracle=planetMagnitude(body,angles[i])-planetMagnitude(body,0);
      const residual=dimming-oracle;
      if(Math.abs(residual)>maxResidual){maxResidual=Math.abs(residual);worst={phase_deg:angles[i],residual_mag:residual};}
    }
    reports[body]={model,model_band:result.band,samples:angles.length,phase_domain_deg:[0,maxPhase],
      max_phase_shape_residual_mag:maxResidual,worst,model_geometric_albedo:result.disk_albedo[0],
      absolute_calibration:false,matched_band:false,
      scope:'Cross-band, zero-phase-normalized diagnostic only. No parameters are fitted to Mallama-Hilton.'};
  }
  return reports;
}
