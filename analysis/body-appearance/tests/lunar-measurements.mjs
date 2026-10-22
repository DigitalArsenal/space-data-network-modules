import assert from 'node:assert/strict';
import {invoke} from './measurements.mjs';
import {roloReflectance} from './independent-laws.mjs';

export function lunarRequest() {
  return {model:'moon:rolo311g:553.8nm',phase_rad:[2,5,30,60,96].map(a=>a*Math.PI/180),
    solar_longitude_rad:[2,5,30,60,96].map(a=>a*Math.PI/180),
    observer_latitude_rad:0,observer_longitude_rad:0,sun_distance_au:1,observer_distance_m:384400000};
}

export async function measureLunar(harness) {
  // Primary reference: Kieffer & Stone 2005 doi:10.1086/430185, Eqs.(7),(8),
  // (10),(11), Tables 1/4. 553.8 nm, W m^-2 nm^-1; radians on the wire,
  // selenographic east longitudes, fixed surface (no epoch). This verifies a
  // published ROLO implementation, not an independent surface-scattering fit.
  // Absolute residual is -2.5 log10(I_module/I_reference): no fitted zero point,
  // phase normalization, albedo scaling, or magnitude offset is permitted.
  let samples=0,maxResidual=0,maxRelativeFluxError=0,worst=null;
  const referenceExamples=[];
  const radians=a=>a*Math.PI/180;
  const degrees=[1.5501,...Array.from({length:190},(_,i)=>2+i*.5),96.9999];
  for(const observerLat of [-6,0,6])for(const observerLon of [-8,0,8])for(const sign of [-1,1]) {
    const phases=degrees.filter(a=>a>=Math.abs(observerLat));
    // A zero-latitude Sun and the selected observer latitude imply this
    // longitude separation: cos(g)=cos(observerLat)*cos(delta-longitude).
    const solarLongitudes=phases.map(a=>observerLon+sign*Math.acos(Math.min(1,Math.cos(radians(a))/Math.cos(radians(observerLat))))*180/Math.PI);
    for(const [sun,observer] of [[.983,360000000],[1,384400000],[1.017,405000000]]) {
      const result=await invoke(harness,'lunar_irradiance',{model:'moon:rolo311g:553.8nm',
        phase_rad:phases.map(radians),solar_longitude_rad:solarLongitudes.map(radians),
        observer_latitude_rad:radians(observerLat),observer_longitude_rad:radians(observerLon),
        sun_distance_au:sun,observer_distance_m:observer});
      for(let i=0;i<phases.length;i++) {
        const albedo=roloReflectance(phases[i],solarLongitudes[i],observerLat,observerLon);
        const irradiance=albedo*6.4177e-5*1.8575/Math.PI/(sun*sun)*(384400000/observer)**2;
        const ratio=result.spectral_irradiance_w_m2_nm[i]/irradiance;
        const residual=-2.5*Math.log10(ratio);
        samples++;maxRelativeFluxError=Math.max(maxRelativeFluxError,Math.abs(ratio-1));
        if(Math.abs(residual)>maxResidual) {maxResidual=Math.abs(residual);worst={phase_deg:phases[i],solar_longitude_deg:solarLongitudes[i],observer_latitude_deg:observerLat,observer_longitude_deg:observerLon,sun_distance_au:sun,observer_distance_m:observer,residual_mag:residual};}
        // The monochromatic AB convention is independently evaluated via
        // the equivalent 48.60 zero point, not a Johnson V transformation.
        const fnu=irradiance*553.8**2*1e-6/299792458;
        assert.ok(Math.abs(result.monochromatic_ab_magnitude[i]-(-2.5*Math.log10(fnu)-48.60))<1e-12);
        if(observerLat===0 && observerLon===0 && sign===1 && sun===1 && [2,5,30,60,96].includes(phases[i]))
          referenceExamples.push({phase_deg:phases[i],disk_reflectance:result.disk_reflectance[i],spectral_irradiance_w_m2_nm:result.spectral_irradiance_w_m2_nm[i],monochromatic_ab_magnitude:result.monochromatic_ab_magnitude[i]});
      }
    }
  }
  return {status:maxResidual<=.1?'pass':'fail',threshold_mag:.1,max_residual_mag:maxResidual,max_relative_flux_error:maxRelativeFluxError,
    samples,phase_domain_deg:[1.5501,96.9999],absolute_calibration:true,band:'ROLO 553.8 nm; monochromatic-equivalent AB, not Johnson V',
    verification:'Same published ROLO model, independently transcribed oracle; no independent Hapke validation is claimed.',
    worst,reference_examples:referenceExamples};
}
