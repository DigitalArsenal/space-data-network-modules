// APP host adapter: binary SDS serialization and routing only. All orbital,
// frame and time-scale calculations execute in the supplied WASM modules.
import { Builder, ByteBuffer } from 'flatbuffers';
import * as p from 'spacedatastandards.org/lib/js/PRW/main.js';
import * as f from 'spacedatastandards.org/lib/js/FRM/main.js';
import * as t from 'spacedatastandards.org/lib/js/TIM/main.js';
import * as o from 'spacedatastandards.org/lib/js/OEM/main.js';
import { OPM } from 'spacedatastandards.org/lib/js/OPM/OPM.js';
import { NCD, NCDT, ncdContainerFormat } from 'spacedatastandards.org/lib/js/NCD/main.js';
import { sha256, numericId } from './crosswalk.js';
const table = (s, name, fields) => Object.assign(new s[`${name}T`](), fields);
const type = code => ({ schemaName:`${code}.fbs`, fileIdentifier:`$${code}`, rootTypeName:code });
const encode = (s, name, value, prefix = true) => { const b = new Builder(2048); const root = value.pack(b); prefix ? b.finishSizePrefixed(root,`$${name}`) : b.finish(root,`$${name}`); return new Uint8Array(b.asUint8Array()); };
function bounded(bytes, code) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12 || bytes.length > 16*1024*1024 || new DataView(bytes.buffer,bytes.byteOffset,bytes.length).getUint32(0,true) !== bytes.length-4 || String.fromCharCode(...bytes.subarray(8,12)) !== `$${code}`) throw new Error(`Expected one bounded size-prefixed $${code} record.`);
  return bytes;
}
export function gridPolicy(grid) {
  if (!grid || typeof grid.start !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(grid.start) || !Number.isFinite(Date.parse(grid.start)) || !Number.isFinite(grid.stepSeconds) || grid.stepSeconds < .001 || !Number.isSafeInteger(grid.samples) || grid.samples < 5 || grid.samples > 10000 || grid.stepSeconds*(grid.samples-1) > 7*86400) throw new Error('Choose a UTC grid of 5–10,000 samples over at most seven days.');
  const start = new Date(grid.start).toISOString();
  if (start.slice(0,19) !== grid.start.slice(0,19) || !Number.isSafeInteger(grid.stepSeconds*1000)) throw new Error('The grid must use a valid UTC date and millisecond-aligned steps.');
  return { start, stepSeconds:grid.stepSeconds, samples:grid.samples, frame:'GCRF', timeSystem:'UTC' };
}
export const DEFAULT_MODEL = Object.freeze({ j2:true,j3:true,j4:true,thirdBody:true,mu:398600.4418,initialStep:10,maxStep:60,absoluteTolerance:1e-8,relativeTolerance:1e-11 });
export async function invokeChecked(module, methodId, inputs, output) {
  const result = await module.invoke({methodId,inputs});
  if (result.statusCode !== 0) throw new Error(result.errorMessage || 'A normalization module refused the input.');
  const frames = result.outputs.filter(x=>x.portId===output);
  if (!frames.length) throw new Error(`Module omitted ${output}.`);
  return frames;
}
export async function normalizeVimpel(bytes, nativeId, module) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length>16*1024*1024) throw new Error('Vimpel input exceeds 16 MiB.');
  const descriptor=Object.assign(new NCDT(),{FORMAT:ncdContainerFormat.PROVIDER_DEFINED,PROVIDER_DEFINED_FORMAT_NAME:'vimpel-orbits-text',SOURCE_SHA256:await sha256(bytes),SOURCE_BYTE_LENGTH:BigInt(bytes.length)});
  const header=encode({NCD},'NCD',descriptor),payload=new Uint8Array(header.length+bytes.length);payload.set(header);payload.set(bytes,header.length);
  const states=await invokeChecked(module,'normalize_vimpel',[{portId:'container',typeRef:type('NCD'),payload}],'states');
  const selected=states.filter(({payload})=>numericId(OPM.getSizePrefixedRootAsOPM(new ByteBuffer(payload)).OBJECT_NAME().replace(/^vimpel:/,''))===numericId(nativeId));
  if(selected.length!==1) throw new Error('The Vimpel product must identify exactly one selected native object.');
  return selected[0].payload;
}
export function readOpm(bytes) {
  bounded(bytes,'OPM'); const state=OPM.getSizePrefixedRootAsOPM(new ByteBuffer(bytes));
  const values=['X','Y','Z','X_DOT','Y_DOT','Z_DOT'].map(k=>state[k]());
  const frame=state.REF_FRAME(),epoch=state.EPOCH();
  if(state.CENTER_NAME()!=='EARTH' || state.TIME_SYSTEM()!=='UTC' || !['J2000','EME2000','GCRF'].includes(frame) || !Number.isFinite(Date.parse(epoch)) || values.some(v=>!Number.isFinite(v))) throw new Error('OPM must declare a finite Earth-centered J2000, EME2000 or GCRF state and UTC epoch.');
  return {values,frame,epoch};
}
const system = (name,epoch) => table(f,'RFMCoordinateSystem',{ NAME:name, AXIS_TYPE:name==='GCRF'?f.rfmAxisType.ICRF:f.rfmAxisType.MEAN_EQUATOR_EQUINOX_J2000,
  AXIS_REFERENCE_BODY_ID:399, ORIGIN:table(f,'RFMOrigin',{KIND:f.rfmOriginKind.CELESTIAL_BODY,CELESTIAL_BODY_ID:399}),EPOCH:epoch,EPOCH_TIME_SYSTEM:'UTC' });
const vector = a => table(f,'FRMVector3',{X:a[0],Y:a[1],Z:a[2]});
const stateVector = (values,frame,epoch) => table(f,'FRMStateVector',{REPRESENTATION:f.frmStateRepresentation.CARTESIAN,POSITION:vector(values.slice(0,3).map(x=>x*1000)),VELOCITY:vector(values.slice(3).map(x=>x*1000)),COORDINATE_SYSTEM_NAME:frame,EPOCH:epoch,EPOCH_TIME_SYSTEM:'UTC'});
async function toGcrf(seed, frames) {
  const request=table(f,'FRMFrameTransformRequest',{OPERATION:f.frmOperationCode.STATE_TRANSFORM,SOURCE_COORDINATE_SYSTEM:system(seed.frame,seed.epoch),TARGET_COORDINATE_SYSTEM:system('GCRF',seed.epoch),SOURCE_STATE:stateVector(seed.values,seed.frame,seed.epoch),TARGET_REPRESENTATION:f.frmStateRepresentation.CARTESIAN,EPOCH:seed.epoch,EPOCH_TIME_SYSTEM:'UTC'});
  const out=await invokeChecked(frames,'transform_frame_position',[{portId:'request',typeRef:type('FRM'),payload:encode(f,'FRM',table(f,'FRM',{FRAME_TRANSFORM_REQUEST:request}),false)}],'result');
  const result=f.FRM.getRootAsFRM(new ByteBuffer(out[0].payload)).FRAME_TRANSFORM_RESULT();
  if(!result || result.STATUS()!==0) throw new Error(result?.ERROR_MESSAGE()||'Frame transformation failed.');
  const target=result.TARGET_STATE().unpack(); target.ELEMENTS=[]; return target;
}
const instant = (jd,scale) => table(t,'TIMInstant',{TIME_SYSTEM:t.timingStandard[scale],EPOCH_FORMAT:t.timEpochRepresentation.JULIAN_DATE,JULIAN_DATE:jd});
async function convertTime(time, jd, from, to) {
  const request=table(t,'TIM',{CONVERSION_REQUEST:table(t,'TIMConversionRequest',{SOURCE:instant(jd,from),TARGET_TIME_SYSTEM:t.timingStandard[to],TARGET_EPOCH_FORMAT:t.timEpochRepresentation.JULIAN_DATE})});
  const out=await invokeChecked(time,'convert_time',[{portId:'request',typeRef:type('TIM'),payload:encode(t,'TIM',request,false)}],'result');
  const result=t.TIM.getRootAsTIM(new ByteBuffer(out[0].payload)).CONVERSION_RESULT();
  if(!result || result.STATUS()!==0 || !Number.isFinite(result.TARGET().JULIAN_DATE())) throw new Error(result?.ERROR_MESSAGE()||'Time conversion failed.');
  return result.TARGET().JULIAN_DATE();
}
function oemBytes(values,grid) {
  const frame=table(o,'RFM',{REFERENCE_FRAME_type:o.RFMUnion.CelestialFrameWrapper,REFERENCE_FRAME:table(o,'CelestialFrameWrapper',{frame:o.CelestialFrame.GCRF})});
  return encode(o,'OEM',table(o,'OEM',{CCSDS_OEM_VERS:2,ORIGINATOR:'Catalog common-grid flow',EPHEMERIS_DATA_BLOCK:[table(o,'ephemerisDataBlock',{CENTER_NAME:'EARTH',REFERENCE_FRAME:frame,TIME_SYSTEM:o.timingStandard.UTC,START_TIME:grid.start,STEP_SIZE:grid.stepSeconds,STATE_VECTOR_SIZE:6,EPHEMERIS_DATA:values})]}));
}
/** Any selected implementation of the PRW execution contract can be supplied. */
export async function propagateCommonGrid(seedBytes, requestedGrid, {propagator,frames,time}, model=DEFAULT_MODEL) {
  const grid=gridPolicy(requestedGrid),seed=readOpm(seedBytes);
  if(Date.parse(grid.start)<Date.parse(seed.epoch) || Date.parse(grid.start)-Date.parse(seed.epoch)>7*86400000) throw new Error('The grid must start within seven days after the state epoch.');
  for(const key of ['mu','initialStep','maxStep','absoluteTolerance','relativeTolerance']) if(!Number.isFinite(model[key]) || model[key]<=0) throw new Error('Invalid propagation model settings.');
  for(const key of ['j2','j3','j4','thirdBody']) if(typeof model[key]!=='boolean') throw new Error('Specify every gravity and third-body switch.');
  const initial=await toGcrf(seed,frames),epochs=[];
  for(let i=0;i<grid.samples;i++) epochs.push(instant(await convertTime(time,(Date.parse(grid.start)+i*grid.stepSeconds*1000)/86400000+2440587.5,'UTC','TDB'),'TDB'));
  const request=table(p,'PRWExecutionRequest',{
    INITIAL:table(p,'PRWResidentState',{STATE:initial,COORDINATE_SYSTEM:system('GCRF',seed.epoch)}),TARGET_EPOCH:epochs.at(-1),SAMPLE_EPOCHS:epochs,
    INTEGRATOR:table(p,'PRWIntegratorSettings',{ALGORITHM:p.prwSolverAlgorithm.RK78,INITIAL_STEP_SECONDS:model.initialStep,MINIMUM_STEP_SECONDS:1e-5,MAXIMUM_STEP_SECONDS:model.maxStep,ABSOLUTE_TOLERANCES:Array(6).fill(model.absoluteTolerance),RELATIVE_TOLERANCE:model.relativeTolerance,MAXIMUM_STEPS:100000}),
    FORCES:table(p,'PRWForceConfiguration',{GRAVITY_CHOICE:p.prwGravitySelection.INFER_FLAGS,ENABLE_POINT_MASS:true,GRAVITATIONAL_PARAMETER:model.mu*1e9,ENABLE_J2:model.j2,ENABLE_J3:model.j3,ENABLE_J4:model.j4,ENABLE_THIRD_BODY:model.thirdBody,THIRD_BODY_IDS:[10,301],ENABLE_SRP:false,ENABLE_DRAG:false,EPHEMERIS_SOURCE:'Analytical'}),
  });
  const out=await invokeChecked(propagator,'invoke',[{portId:'request',typeRef:type('PRW'),payload:encode(p,'PRW',table(p,'PRW',{EXECUTION_REQUEST:request}))}],'response');
  const result=p.PRW.getSizePrefixedRootAsPRW(new ByteBuffer(bounded(out[0].payload,'PRW'))).EXECUTION_RESULT();
  if(!result || result.samplesLength()!==grid.samples) throw new Error('The propagator omitted common-grid samples.');
  const values=[];
  for(let i=0;i<grid.samples;i++) {
    const resident=result.SAMPLES(i).STATE(),s=resident?.STATE(),cs=resident?.COORDINATE_SYSTEM();
    if(!s || cs?.NAME()!=='GCRF' || cs.AXIS_TYPE()!==f.rfmAxisType.ICRF || cs.ORIGIN()?.CELESTIAL_BODY_ID()!==399 || s.EPOCH_TIME_SYSTEM()!=='TDB') throw new Error('The propagator returned an unexpected frame or time scale.');
    const returnedJD=Date.parse(s.EPOCH().replace(/Z?$/,'Z'))/86400000+2440587.5;
    if(!Number.isFinite(returnedJD) || Math.abs((returnedJD-epochs[i].JULIAN_DATE)*86400)>.002) throw new Error('The propagator returned a different sample epoch.');
    const pv=[s.POSITION()?.X(),s.POSITION()?.Y(),s.POSITION()?.Z(),s.VELOCITY()?.X(),s.VELOCITY()?.Y(),s.VELOCITY()?.Z()];
    if(pv.some(x=>!Number.isFinite(x))) throw new Error('The propagator returned a missing or non-finite state.');
    values.push(...pv.map(x=>x/1000));
  }
  return {payload:oemBytes(values,grid),grid,model:{...model,drag:false,srp:false,ephemerisSource:result.EPHEMERIS_SOURCE()}};
}
export async function runMatching({module,candidates,pairs,policy,prepare}) {
  if(candidates.length<2 || candidates.length>64 || !pairs.length || pairs.length>4096) throw new Error('Choose 2–64 candidates and 1–4,096 pairs.');
  const prepared=[],metadata=[];let bytes=0;
  for(const candidate of candidates) {
    const {payload,provenance={}}=await prepare(candidate);bounded(payload,'OEM');bytes+=payload.length;
    if(bytes>128*1024*1024) throw new Error('Prepared trajectories exceed 128 MiB.');
    prepared.push({portId:'ephemerides',typeRef:type('OEM'),payload});
    const {bytes:unused,...description}=candidate;
    metadata.push({...description,trajectorySha256:await sha256(payload),provenance});
  }
  const recipe={version:1,...policy,candidates:metadata,pairs},payload=new TextEncoder().encode(JSON.stringify(recipe));
  const outputs=await invokeChecked(module,'match_catalog',[{portId:'recipe',typeRef:{wireFormat:'aligned-binary',requiredAlignment:1,byteLength:payload.length},payload},...prepared],'report');
  return {recipe,report:JSON.parse(new TextDecoder().decode(outputs[0].payload))};
}
