// Task acceptance gate. Missing calibrations are failures, never skipped passes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {measure} from './measurements.mjs';
import {runtimeParity} from './runtime-parity.mjs';
import {measurePlanets} from './planet-measurements.mjs';
import {measureLunar} from './lunar-measurements.mjs';
import {planetDiagnostics} from './planet-diagnostics.mjs';
import {measureOracle} from './oracle-measurements.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const bytes=await fs.readFile(path.join(root,'dist/isomorphic/module.wasm'));
const report={task:'body-appearance-module-20261022',measuredAt:new Date().toISOString(),
  testedCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
  artifactSha256:createHash('sha256').update(bytes).digest('hex'),acceptance:{},failures:[]};
report.oracleVerification=measureOracle();
if(report.oracleVerification.status!=='pass')report.failures.push('Test oracle disagrees with published examples');
const table=JSON.parse(await fs.readFile(path.join(root,'data/parameters.json'),'utf8'));
const missing=table.filter(p=>!Number.isFinite(p.value)||!/^10\./.test(p.doi)||!p.locator||!p.unit||!p.scope);
report.acceptance.citations={status:missing.length?'fail':'pass',values:table.length,uncited:missing.length,
  scope:'All shipped table entries; this does not assert that all requested body tables exist.'};
if(missing.length)report.failures.push('Uncited table entries');
const harness=await createBrowserModuleHarness({wasmSource:bytes,surface:'direct'});
try {
  report.measurements=await measure(harness);
  report.acceptance.placement={status:'pass',rock:report.measurements.rock,crater:report.measurements.crater,
    cfaConvention:'Sum of circular footprints within the diameter interval, not overlap-unioned coverage.'};
} catch(error) {report.failures.push(`Numerical checks: ${error.message}`);report.acceptance.placement={status:'fail',error:error.message};}
try {
  report.acceptance.moon=await measureLunar(harness);
  if(report.acceptance.moon.status!=='pass')report.failures.push('Moon absolute disk photometry exceeds 0.1 mag');
} catch(error) {report.acceptance.moon={status:'fail',error:error.message};report.failures.push(`Moon: ${error.message}`);}
try {report.planetDiagnostics=await planetDiagnostics(harness);}
catch(error) {report.planetDiagnostics={error:error.message};report.failures.push(`Planet diagnostics: ${error.message}`);}
try {
  report.acceptance.planets=await measurePlanets(harness);
  for(const [body,result] of Object.entries(report.acceptance.planets))
    if(result.status!=='pass')report.failures.push(`${body}: ${result.max_residual_mag===null?result.reason:`absolute Johnson V residual ${result.max_residual_mag} mag exceeds 0.1 mag`}`);
} catch(error) {report.failures.push(`Planet measurements: ${error.message}`);report.acceptance.planets={status:'fail',error:error.message};}
await harness.destroy();
try {report.acceptance.runtimeParity=await runtimeParity();}
catch(error) {report.acceptance.runtimeParity={status:'fail',error:error.message};report.failures.push(`Runtime parity: ${error.message}`);}
report.unfinishedScope=['Whole-body photometric/albedo/color tables and roughness RMS baselines',
  'D and X/M taxonomic priors and explicit taxonomy/albedo selection',
  'Diviner rock-abundance input mapping and independently justified lunar rock-size law',
  'Named-spacecraft matched-geometry render/image-similarity and shadow-fraction evidence'];
report.status=report.failures.length?'fail':'pass';
const reportPath=process.env.BODY_APPEARANCE_REPORT || path.join(root,'.build/e2e-report.json');
await fs.mkdir(path.dirname(reportPath),{recursive:true});await fs.writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));console.log(`Evidence: ${reportPath}`);
process.exitCode=report.status==='pass'?0:1;
