#!/usr/bin/env node
// One offline end-to-end regression: native coords -> independent pyerfa ->
// C++ reductions, plus the shipped WASM's actual plugin ECEF export.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {composeErfaTranslationUnit} from '../../../../../foundation/frames/erfa-amalgamation.mjs';
import {createFFMPropagator} from '../../../index.js';

const here=path.dirname(fileURLToPath(import.meta.url)),ffm=path.resolve(here,'../../..'),repo=path.resolve(ffm,'../..');
const before=process.argv.includes('--capture-before');
const hasEpoch=fs.readFileSync(path.join(ffm,'lib/coords.h'),'utf8').includes('struct Epoch');
const python=process.env.ERFA_PYTHON||'/Users/tj/software/tools/xval/erfa-spice/bin/python';
const work=fs.mkdtempSync(path.join(here,'.classical-'));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const run=(exe,args,options={})=>execFileSync(exe,args,{encoding:'utf8',maxBuffer:128<<20,env:{...process.env,TMPDIR:work,TMP:work,TEMP:work},...options});
try{
 const erfa=await composeErfaTranslationUnit(),unit=path.join(work,'erfa.cpp'),bin=path.join(work,'classical-frames');
 fs.writeFileSync(unit,erfa.source);
 const compileFlags=['-std=c++17','-O2',...(hasEpoch?['-DFFM_COORDS_EPOCH']:[]),'-I',path.join(ffm,'lib'),'-I',path.join(ffm,'src/cpp/include'),'-I',path.join(repo,'higherpop/third_party/erfa'),path.join(here,'classical-frames.cpp'),path.join(ffm,'lib/coords.cpp'),path.join(ffm,'lib/time_convert.cpp'),unit];
 run('c++',[...compileFlags,'-o',bin]);
 const epochs=path.join(work,'epochs.txt'),reference=path.join(work,'reference.bin'),pins=path.join(work,'tools.json');
 fs.writeFileSync(epochs,run(bin,['epochs']));
 run(python,['-I','-B',path.join(here,'classical-frames-reference.py'),epochs,reference,pins]);
 const result=JSON.parse(run(bin,['compare',reference]));
 const nativeMet=result.met;
 const wasmNative=path.join(work,'classical-frames-wasm-arithmetic');
 run('c++',[...compileFlags,'-ffp-contract=off','-o',wasmNative]);
 const uncontracted=JSON.parse(run(wasmNative,['matrix-compare',reference]));
 result.compilerRounding={native:'Apple clang -O2, default floating-point contraction (matches supplied pyerfa)',wasmNative:'Apple clang -O2 -ffp-contract=off (matches WASM noncontracted arithmetic)',uncontractedMaxPositionM:uncontracted.maxPositionM,uncontractedMaxVelocityMS:uncontracted.maxVelocityMS,uncontractedMeetsReferenceLimits:uncontracted.met,note:'Strict 1 um/1 nm/s reference limits apply to the normal native build; noncontracted WASM arithmetic has the separately reported ERFA polynomial rounding spread.'};
 const seeds=JSON.parse(run(bin,['wasm-seeds',epochs]));
 const plugin=await createFFMPropagator(),ex=plugin.exports;
 const state=ex.malloc(56),out=ex.malloc(56),forces=ex.malloc(120);
 try{for(const seed of seeds){
  if(ex.plugin_init()!==0)throw new Error('plugin_init failed');
  new Float64Array(ex.memory.buffer,forces,15).set([398600.4418,0,0,0,0,0,0,0,0,0,1000,20,20,2.2,1.3]);
  if(ex.plugin_set_force_model(forces)!==0)throw new Error('plugin_set_force_model failed');
  new Float64Array(ex.memory.buffer,state,7).set([seed.jdUtc,...seed.positionKm,...seed.velocityKmS]);
  ex.plugin_set_state(state);
  if(ex.plugin_propagate_path(seed.jdUtc,0,1,out)!==1)throw new Error('plugin_propagate_path failed');
  seed.ecefM=Array.from(new Float64Array(ex.memory.buffer,out,3));
 }}finally{ex.free(state);ex.free(out);ex.free(forces);await plugin.destroy?.();}
 const wasm=path.join(work,'wasm.json');fs.writeFileSync(wasm,JSON.stringify(seeds));
 result.hostLibmWasm=JSON.parse(run(wasmNative,['wasm',wasm]));
 // Exact source parity requires the same elementary-math runtime. Apple's
 // libc sin/cos differ from WASM musl by one output ULP at one selected epoch.
 // Keep that spread recorded; use the toolchain's unchanged musl routines for
 // the exact parity lane. The independent pyerfa lane above uses Apple libc.
 const config=JSON.parse(fs.readFileSync(path.join(ffm,'.sdk-build/compiler.json'),'utf8'));
 const musl=path.resolve(path.dirname(config.clangxx),'../emscripten/system/lib/libc/musl');
 fs.writeFileSync(path.join(work,'endian.h'),'#define __BYTE_ORDER __BYTE_ORDER__\n#define __LITTLE_ENDIAN __ORDER_LITTLE_ENDIAN__\n#define __BIG_ENDIAN __ORDER_BIG_ENDIAN__\n');
 const mathObjects=[],mathSources={};
 for(const name of ['sin','cos','__sin','__cos','__rem_pio2','__rem_pio2_large']){
  const source=path.join(musl,'src/math',`${name}.c`),object=path.join(work,`${name}.o`);
  run('cc',['-std=c99','-O2','-ffp-contract=off','-fno-builtin','-Dhidden=','-I',work,'-I',path.join(musl,'src/internal'),'-I',path.join(musl,'arch/generic'),'-c',source,'-o',object]);
  mathObjects.push(object);mathSources[`src/math/${name}.c`]=hash(source);
 }
 for(const name of ['src/internal/libm.h','arch/generic/fp_arch.h'])mathSources[name]=hash(path.join(musl,name));
 run('c++',[...compileFlags,'-ffp-contract=off','-fno-builtin-sin','-fno-builtin-cos',...mathObjects,'-o',wasmNative]);
 result.wasmEcef=JSON.parse(run(wasmNative,['wasm',wasm]));
 result.wasmEcef.nativeMath='Provisioned WASM toolchain musl sin/cos and argument reduction, native C++, floating-point contraction disabled';
 result.tools=JSON.parse(fs.readFileSync(pins,'utf8'));
 result.tools.wasmNativeMathSources=mathSources;
 result.tools.nativeCompiler=run('c++',['--version']).trim();
 result.tools.erfaAmalgamationSha256=hash(unit);
 result.tools.erfaFileCount=erfa.fileCount;
 result.epochsSha256=hash(epochs);
 result.sources=Object.fromEntries(['lib/coords.cpp','lib/coords.h','lib/coords_types.h','lib/time_convert.cpp','lib/time_types.h','tests/evidence/erfa-spice/classical-frames.cpp','tests/evidence/erfa-spice/classical-frames-reference.py','tests/evidence/erfa-spice/check-classical-frames.mjs'].map(p=>[p,hash(path.join(ffm,p))]));
 result.moduleVersion=JSON.parse(fs.readFileSync(path.join(ffm,'package.json'),'utf8')).version;
 result.moduleSha256=hash(path.join(ffm,'dist/isomorphic/module.wasm'));
 result.met=result.met&&result.wasmEcef.met;
 if(before){
  const target=path.join(here,'before-after.json');if(fs.existsSync(target))throw new Error('Refusing to overwrite captured before evidence');
  const summary=JSON.parse(fs.readFileSync(path.join(here,'summary-erfa-spice.json'),'utf8'));
  const originalDiagnosis=JSON.parse(fs.readFileSync(path.join(here,'diagnosis.json'),'utf8'));
  const measuredKeys=['clockBound','clockPlusInterpolationBound','clockPrecision','maxOmittedCoefficientMas','maxima','nutationBound','omittedTerms','precessionBound','referenceSpread','retainedTerms','worstClock','wasmEcef','temeReplay','forcePath'];
  const diagnosis=Object.fromEntries(measuredKeys.filter(k=>k in originalDiagnosis).map(k=>[k,originalDiagnosis[k]]));
  fs.writeFileSync(target,JSON.stringify({about:'Before captured on unchanged 1.3.1 sources; 10k frames are UTC-input public transforms. Historical 50-epoch results retain their measured values and original reference definitions.',before:{classicalFrames:result,erfaSpice:summary,diagnosis}},null,1)+'\n');
 }else{
  fs.writeFileSync(path.join(here,'classical-frames-10k.json'),JSON.stringify(result,null,1)+'\n');
  const p=path.join(here,'before-after.json');if(fs.existsSync(p)){const both=JSON.parse(fs.readFileSync(p,'utf8'));both.after={...both.after,classicalFrames:result};fs.writeFileSync(p,JSON.stringify(both,null,1)+'\n');}
 }
 console.log(`classical frames E2E: ${result.met?'PASS':'FAIL'}; ${result.epochs} epochs, ${result.pairs} frame pairs, ${result.directions} directions`);
 for(const row of result.rows.filter(r=>r.from==='GCRF'||(r.from==='MOD'&&r.to==='TOD')))
  console.log(`${row.from}->${row.to}: ${row.rotationMas} mas; GEO ${row.positionM} m; ${row.velocityMS} m/s; full-rate diagnostic ${row.neglectedRatesMS} m/s`);
 console.log(`ERFA compiler rounding: noncontracted reference max ${result.compilerRounding.uncontractedMaxPositionM} m; native compiler strict limit ${nativeMet?'met':'not met'}`);
 console.log(`Native libc/WASM math spread: ${result.hostLibmWasm.maxPositionM} m; exact parity lane uses matched musl sin/cos`);
 console.log(`WASM ECEF/native: ${result.wasmEcef.samples} epochs, ${result.wasmEcef.maxPositionM} m`);
 console.log(`wrong-GCRF-pole transport diagnostic at 2026-08-02: ${JSON.stringify(result.velocityAxisDefect)}`);
 if(hasEpoch)console.log(`Invalid enum/date flags: matrix ${result.invalidInputs.matrixFlagged}, state ${result.invalidInputs.stateFlagged}; Epoch overload checked at every sample`);
 console.log(`limits: position <= 0.000001 m, velocity <= 1e-9 m/s; ${before?'before evidence captured':'classical-frames-10k.json written'}`);
 if(!result.met)process.exitCode=1;
}finally{fs.rmSync(work,{recursive:true,force:true});}
