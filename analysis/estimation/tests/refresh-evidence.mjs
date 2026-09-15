// Regenerate evidence only after executing independent references and verifying
// a tri-runtime receipt for the current artifact. No new golden output is made.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const read=p=>JSON.parse(fs.readFileSync(path.join(root,p)));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const artifactHash=hash(fs.readFileSync(path.join(root,'dist/isomorphic/module.wasm')));
const parity=read('conformance/lane05-parity.json');
assert.equal(parity.ok,true);assert.equal(parity.artifactSha256,artifactHash);
assert.equal(parity.lanes.length,3);assert.ok(parity.runs.length>=192);
assert.ok(parity.runs.some(r=>r.caseId==='nonlinear-kind-2-complete'));
execFileSync(process.execPath,['--test','tests/invoke.test.mjs','tests/depth-invoke.test.mjs','tests/sdk_compat.test.mjs'],{cwd:root,stdio:'inherit'});
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'estimation-receipt-'));
let native,seq,depth;
try {
 for(const [name,args] of [['native_conformance',[]],['sequential_validation',['tests/fixtures/hipparchus-cv-smoother.txt']],['depth_validation',['tests/fixtures/orekit-pv-reference.txt']]]) {
  const binary=path.join(tmp,name);
  execFileSync(process.env.CXX||'c++',['-std=c++17','-O2','-Wall','-Wextra','-Werror','-Isrc','src/estimation.cpp',`tests/${name}.cpp`,'-o',binary],{cwd:root,stdio:'inherit'});
  const output=execFileSync(binary,args,{cwd:root,encoding:'utf8'});
  if(name==='native_conformance')native=JSON.parse(output);else if(name==='sequential_validation')seq=output;else depth=output;
 }
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
console.log(seq);console.log(depth);
const batch=JSON.parse(seq.split('\n').find(l=>l.startsWith('BATCH_AUTHORITY ')).slice(16));
const evidence=read('conformance/estimation-evidence.json');
evidence.artifact.sha256=artifactHash;
evidence.authority.nativeExecutable='tests/native_conformance.cpp + tests/sequential_validation.cpp + tests/depth_validation.cpp';
evidence.authority.runtimeExecutable='tests/parity.mjs + tests/invoke.test.mjs + tests/depth-invoke.test.mjs';
evidence.authority.batchReference='Exact Gaussian conditioning fractions in tests/fixtures/README.md; edited set from legacy native_conformance';
evidence.authority.scope='Legacy SDK tiers plus nonlinear Orekit EKF/UKF port replay, GNSS/linear/adaptive cases and 500-run nonlinear radar/crosslink consistency. See tests/fixtures/DEPTH.md.';
const runs=parity.runs.filter(r=>r.caseId==='correlated-vector');
const digest=(lane,n)=>{const r=runs.find(r=>r.lane===lane&&r.threadCount===n);assert.equal(r.exitClass,'ok');return r.stdoutSha256;};
evidence.runtime={digestEncoding:'SDK command stdout including invoke result bytes',browser:{outputSha256:digest('browser',1)},wasmedge:{version:parity.pin,outputSha256:digest('wasmedge',1)},container:{version:parity.pin,outputSha256:digest('docker-wasmedge',1)},threads:Object.fromEntries([1,2,4,8].map(n=>[n,digest('wasmedge',n)]))};
evidence.batch={positionAbsoluteErrorM:batch.position_error_m,positionRelativeError:batch.position_error_m/Math.hypot(83/56,-3/14,48/25),positionSigmaRssM:batch.sigma_rss_m,covarianceRssRelativeError:batch.sigma_rss_relative_error,residualRms:batch.rms,residualRmsRelativeError:batch.rms_relative_error,rejectedExpected:[7],rejectedActual:[native.edited_index],iterationCount:batch.iterations,iterationCovarianceCount:batch.iterations,iterationCovariancesSpd:true};
Object.assign(evidence.filter,{positionErrorM:native.filter_position_error_m,smootherPositionErrorM:native.smoother_position_error_m,neesMean:native.average_nees,sncCovarianceGrowthRatio:native.snc_growth_ratio,dmcCovarianceGrowthRatio:native.dmc_growth_ratio,ekfUkfCovarianceDifference:native.ukf_covariance_difference});
Object.assign(evidence.measurements,{rangeMaxRelativeError:native.orekit_range_relative,rangeRateMaxRelativeError:native.orekit_range_rate_relative,azElMaxRelativeError:native.orekit_az_el_relative,raDecMaxRelativeError:native.orekit_ra_dec_relative,lightTimeCorrectionM:native.light_time_m,lightTimeMagnitudeErrorM:native.light_time_magnitude_error_m,sagnacCorrectionM:native.sagnac_m,sagnacMagnitudeErrorM:native.sagnac_magnitude_error_m,dopplerHz:native.doppler_hz,relayDifferencedDopplerHz:native.relay_dowd_hz});
Object.assign(evidence.media,{hopfieldSaastamoinenMaxRelativeError:native.orekit_saastamoinen_relative,mariniMaxRelativeError:native.orekit_marini_relative,p531Table3RangeM:native.p531_table3_range_m});
Object.assign(evidence.iod,{gaussMaxErrorSi:native.vallado_gauss_max_error_si,laplaceMaxErrorSi:native.vallado_laplace_max_error_si,gibbsMaxErrorMps:native.vallado_gibbs_max_error_mps,herrickGibbsMaxErrorMps:native.vallado_herrick_max_error_mps});
Object.assign(evidence.simulator,{stateInsideThreeSigmaFraction:native.simulator_coverage,recoveredNoiseSigma:native.recovered_noise_sigma,recoveredNoiseSigmaRelativeError:Math.abs(native.recovered_noise_sigma-2)/2});
evidence.invariants.residualOrthogonalityMax=native.residual_orthogonality;
evidence.lane05={nativeSourceSha256:hash(fs.readFileSync(path.join(root,'tests/sequential_validation.cpp'))),receipt:seq,depthReceipt:depth,parityReceipt:'conformance/lane05-parity.json'};
fs.writeFileSync(path.join(root,'conformance/estimation-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
console.log('PASS refreshed authoritative conformance evidence for '+artifactHash);
