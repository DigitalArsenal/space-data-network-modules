import assert from 'node:assert/strict';
import {encodeRequest,decodeResult} from '../codec.js';
import {rockIntegral,rockNumberCdf,lunarCraterShape,craterNumberCdf,ks,roloReflectance} from './independent-laws.mjs';

export async function invoke(harness,method,values) {
  const response=await harness.invoke(encodeRequest(method,values));
  assert.equal(response.statusCode,0,`${method}: ${response.errorCode}: ${response.errorMessage}`);
  assert.equal(response.outputs.length,1);assert.equal(response.outputs[0].portId,'result');
  return decodeResult(response.outputs[0].payload);
}
export function rockRequest() {
  const k=.1,q=1.79+.152/k,lo=.1,hi=2;
  const density=4*k*q/Math.PI*rockIntegral(q,lo,hi);
  return {body_id:499,level:0,x:0,y:0,seed:20261022,radius_m:Math.sqrt(100005/density/(4*Math.PI)),rock_abundance:k,rock_min_m:lo,rock_max_m:hi};
}
export function craterRequest() {
  const a=10,b=100,n1=.00001,area=100005/(n1/1e6*(lunarCraterShape(a)-lunarCraterShape(b)));
  return {body_id:301,level:0,x:0,y:0,seed:20261022,radius_m:Math.sqrt(area/(4*Math.PI)),crater_n1_km2:n1,crater_min_m:a,crater_max_m:b};
}
export async function measure(harness) {
  const report={};
  // Static synthetic spheres, body-fixed meters; radii solve the independent
  // count integral for 100005 objects. These are NOT measured planetary radii.
  // KS p>0.05 is the task gate, footprint CFA within 5% allows finite sampling.
  const req=rockRequest(),rock=await invoke(harness,'place',req),q=1.79+.152/req.rock_abundance;
  const stat=ks(rock.rock_diameter_m,d=>rockNumberCdf(d,q,req.rock_min_m,req.rock_max_m));
  const expected=req.rock_abundance*(Math.exp(-q*req.rock_min_m)-Math.exp(-q*req.rock_max_m));
  const area=4*Math.PI*req.radius_m**2;
  const measured=rock.rock_diameter_m.reduce((s,d)=>s+Math.PI*d*d/4,0)/area;
  report.rock={...stat,target_cfa:expected,measured_cfa:measured,relative_area_error:Math.abs(measured/expected-1)};
  assert.ok(stat.n>=100000);assert.ok(stat.p>.05,JSON.stringify(report.rock));assert.ok(report.rock.relative_area_error<=.05);
  // Pure arithmetic expectation tolerances budget double precision and the
  // runtime quadrature, not uncertainty in the physical empirical law.
  assert.ok(Math.abs(rock.rock_expected_count-100005)<.01);
  assert.ok(Math.abs(rock.rock_actual_cfa-measured)<1e-12);
  assert.ok(Math.abs(rock.tile_area_m2/area-1)<1e-12);
  for(let i=0;i<rock.rock_count;i++) {
    const radius=Math.hypot(...rock.rock_position_m.slice(3*i,3*i+3));
    assert.ok(Math.abs(radius/req.radius_m-1)<1e-12);
    assert.ok(rock.rock_azimuth_rad[i]>=0 && rock.rock_azimuth_rad[i]<2*Math.PI);
    assert.ok(Number.isInteger(rock.rock_shape_seed[i]));
  }
  const cq=craterRequest(),crater=await invoke(harness,'place',cq);
  const cs=ks(crater.crater_diameter_m,d=>craterNumberCdf(d,cq.crater_min_m,cq.crater_max_m));
  report.crater={...cs,expected_count:crater.crater_expected_count,measured_cfa:crater.crater_actual_cfa};
  assert.ok(cs.n>=100000);assert.ok(cs.p>.05,JSON.stringify(report.crater));
  assert.ok(Math.abs(crater.crater_expected_count-100005)<.01);
  // Snodgrass-Ulrich Table 1 magnetic profile, latitude 0 and pi/2, 86400 TAI
  // seconds from synthetic epoch 0, sidereal frame. Closed form at the poles
  // is A+B+C=2.055 microradian/s; 1e-14 rad tolerance is roundoff only.
  report.rotation=[];
  for(const [latitude,expectedRate] of [[0,2.879e-6],[Math.PI/2,2.055e-6]]) {
    const r=await invoke(harness,'rotate',{profile:'magnetic',latitude_rad:latitude,longitude_rad:0,epoch_tai_s:0,scene_tai_s:86400});
    const error=Math.abs(r.longitude_rad-expectedRate*86400);assert.ok(error<1e-14);
    report.rotation.push({latitude_rad:latitude,rate_rad_s:r.sidereal_rate_rad_s,advance_rad:r.longitude_rad,error_rad:error});
  }
  // Independent values printed in Muinonen Table 3 at 30 degrees: Phi1 and
  // Phi2. 1e-12 flux tolerance measures interpolation/arithmetic, no epoch.
  for(const [g1,g2,expectedFlux] of [[1,0,.33486016],[0,1,.62884169]]) {
    const r=await invoke(harness,'phase_curve',{model:'hg1g2',G1:g1,G2:g2,phase_rad:[Math.PI/6]});
    assert.ok(Math.abs(r.relative_flux[0]-expectedFlux)<1e-12);
  }
  // DIAGNOSTIC, not an acceptance substitute: relative phase shape only at
  // 553.8 nm vs the published lunar H,G1,G2 shape, normalized at 5 degrees.
  // Both signs of solar longitude; zero observer libration; 2..96 degrees.
  const degrees=Array.from({length:95},(_,i)=>i+2),angles=degrees.map(a=>a*Math.PI/180);
  const moon=await invoke(harness,'phase_curve',{model:'moon:muinonen2010',phase_rad:angles});
  const anchor=moon.dimming_mag[3];let maximum=0,worst=null;
  for(const sign of [-1,1])for(let i=0;i<degrees.length;i++) {
    const oracle=-2.5*Math.log10(roloReflectance(degrees[i],sign*degrees[i])/roloReflectance(5,sign*5));
    const error=moon.dimming_mag[i]-anchor-oracle;
    if(Math.abs(error)>maximum){maximum=Math.abs(error);worst={phase_deg:degrees[i],solar_longitude_sign:sign,residual_mag:error};}
  }
  report.moon_phase_shape={max_residual_mag:maximum,worst,samples:190,absolute_calibration:false,band:'ROLO 553.8 nm'};
  return report;
}
