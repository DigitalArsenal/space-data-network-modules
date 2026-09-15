// Exact Gaussian conditioning case, SI Cartesian coordinates at JD 2451545 TAI.
// These fractions are independently derived in fixtures/README.md.
import fs from 'node:fs';
import { invocation } from './wire.mjs';
const epoch={jd_day:2451545,seconds:0};
const identity=Array.from({length:36},(_,i)=>i%7===0?1:0);
const covariance=[...identity];covariance[0]=4;covariance[7]=9;covariance[14]=16;covariance[1]=covariance[6]=3;
const config={initial_epoch:epoch,initial_state:[0,0,0,0,0,0],initial_covariance:covariance,process_noise_spectral_density:[0,0,0,0,0,0],state_convergence_tolerance:1e-6,rms_convergence_tolerance:1e-9,sigma_edit_threshold:10,dynamic_model_correlation_time_seconds:300,maximum_iterations:12,reference_frame:'ICRF',estimator:'EXTENDED_KALMAN_FILTER',process_noise:'NONE',flags:0};
const observation={station_position_m:[0,0,0],station_velocity_mps:[0,0,0],station_east:[0,1,0],station_north:[0,0,1],station_up:[1,0,0],remote_position_m:[0,0,0],remote_velocity_mps:[0,0,0],frequency_hz:8.4e9,transmitter_delay_seconds:0,receiver_delay_seconds:0,transponder_delay_seconds:0,elevation_rad:1.5707963267948966,station_latitude_rad:0,station_height_m:0,pressure_hpa:1013.25,temperature_k:293.15,relative_humidity:.5,wavelength_m:5.32e-7,total_electron_content:0,total_electron_content_rate_per_second:0,turnaround_numerator:1,turnaround_denominator:1,transmitter_index:0,receiver_index:0,epoch,value:[2,-1,3,0],sigma:[1,2,3,1],kind:'POSITION_VECTOR',value_count:3,flags:0};
const sample={epoch,state:[0,0,0,0,0,0],stm:identity};
export const correlated=invocation(config,[observation],[sample]);
export const expectedState=[83/56,-3/14,48/25,0,0,0];
export const expectedCovariance=[...identity];expectedCovariance[0]=43/56;expectedCovariance[7]=18/7;expectedCovariance[14]=144/25;expectedCovariance[1]=expectedCovariance[6]=3/14;
export const rejected=invocation(config,[{...observation,value:[2,-1,1000,0]}],[sample]);
export const invalid=invocation(config,[{...observation,sigma:[0,2,3,1]}],[sample]);
export const invalidCount=invocation(config,[{...observation,value_count:5}],[sample]);
export const wrongEpoch=invocation(config,[observation],[{...sample,epoch:{...epoch,seconds:1}}]);
// Published values and independently generated test-provider samples are read
// verbatim; JavaScript only packs the existing SDK ABI and compares results.
export const smootherRows=fs.readFileSync(new URL('./fixtures/hipparchus-cv-smoother.txt',import.meta.url),'utf8').split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.trim().split(/\s+/).map(Number)).slice(1);
const smootherP=identity.map((v,i)=>v?(i<18?.01:.25):0);
const smootherConfig={...config,initial_state:[0,0,0,-.5,0,0],initial_covariance:smootherP,process_noise_spectral_density:[.1,0,0,0,0,0],sigma_edit_threshold:1e9,process_noise:'STATE_NOISE_COMPENSATION',estimator:'EXTENDED_KALMAN_FILTER_WITH_RTS'};
const cvInputs=JSON.parse(fs.readFileSync(new URL('./fixtures/hipparchus-cv-inputs.json',import.meta.url)));
const smootherSamples=cvInputs.samples;
const smootherObservations=cvInputs.observations.map(o=>({...observation,...o}));
export const smoother=invocation(smootherConfig,smootherObservations,smootherSamples);
export const circular=JSON.parse(fs.readFileSync(new URL('./fixtures/circular-fusion.json',import.meta.url)));
const circularSamples=circular.samples.map(({t,...s})=>({...s,epoch:{...epoch,seconds:t}}));
const circularObservations=circular.observations.map(({t,...o})=>({...observation,...o,flags:3,epoch:{...epoch,seconds:t}}));
export const fusion=invocation({...config,initial_state:circular.initial,initial_covariance:circular.covariance,estimator:'EXTENDED_KALMAN_FILTER_WITH_RTS'},circularObservations,circularSamples);
export const cases=[
 {id:'correlated-vector',request:correlated},
 {id:'asynchronous-circular-fusion',request:fusion},
 {id:'whole-vector-edit',request:rejected},
 {id:'invalid-zero-sigma',request:invalid},
 {id:'invalid-value-count',request:invalidCount},
 {id:'mismatched-epoch',request:wrongEpoch},
 {id:'published-cv-smoother',request:smoother},
];
