// Test transport codec for the published SDS 1.232.0 PRW contract.
// Only representation/unit serialization happens here. Propagation, frame and
// time-scale transformations, events and derivatives run in C++ WASM.
import * as flatbuffers from 'flatbuffers';
import * as sds from '../generated/sds/main.js';
import { createHash } from 'node:crypto';

export { sds };
export const TYPE = Object.freeze({schemaName:'PRW.fbs',fileIdentifier:'$PRW',rootTypeName:'PRW',wireFormat:'flatbuffer'});
export const makeTable = (name, fields = {}) => Object.assign(new sds[`${name}T`](), fields);
export function encodePrw(arm, value) {
  const b = new flatbuffers.Builder(2048);
  const root = typeof arm === 'string' ? makeTable('PRW', {[arm]:value}) : arm;
  sds.PRW.finishSizePrefixedPRWBuffer(b,root.pack(b));
  return new Uint8Array(b.asUint8Array());
}
export function decodePrw(bytes) {
  const b = new flatbuffers.ByteBuffer(new Uint8Array(bytes));
  if (String.fromCharCode(...bytes.slice(8,12)) !== '$PRW') throw new Error('Expected size-prefixed $PRW');
  return sds.PRW.getSizePrefixedRootAsPRW(b).unpack();
}
export const instant = (jd, scale='TDB') => makeTable('TIMInstant', {
  TIME_SYSTEM:sds.timingStandard[scale] ?? 127,
  EPOCH_FORMAT:sds.timEpochRepresentation.JULIAN_DATE, JULIAN_DATE:jd,
});
// JD <-> Gregorian text is a representation codec, without time-scale change.
// Retain 9 fractional seconds; Date.toISOString alone loses sub-ms precision.
export function isoFromJD(jd) {
  const day=Math.floor(jd-2440587.5), seconds=(jd-2440587.5-day)*86400;
  const whole=Math.floor(seconds), nanos=Math.round((seconds-whole)*1e9);
  const date=new Date(day*86400000+whole*1000);
  return date.toISOString().slice(0,19)+'.'+String(nanos).padStart(9,'0');
}
function jdFromISO(iso) {
  const m=/^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?Z?$/.exec(iso);
  if(!m) throw new Error(`Invalid result epoch ${iso}`);
  return Date.parse(m[1]+'Z')/86400000+2440587.5+Number('0.'+(m[2]??'0'))/86400;
}
export function coordinateSystem(frame='GCRF', center=399) {
  return makeTable('RFMCoordinateSystem', {NAME:frame,
    AXIS_TYPE:frame==='TEME'?sds.rfmAxisType.TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE:
      ['ECEF','ITRF'].includes(frame)?sds.rfmAxisType.BODY_FIXED:sds.rfmAxisType.ICRF,
    AXIS_REFERENCE_BODY_ID:center,
    ORIGIN:makeTable('RFMOrigin',{KIND:sds.rfmOriginKind.CELESTIAL_BODY,CELESTIAL_BODY_ID:center}),
  });
}
const number = x => typeof x === 'number' ? x : NaN;
const vec = (v, scale=1) => makeTable('FRMVector3', {
  X:number(v?.[0])*scale,Y:number(v?.[1])*scale,Z:number(v?.[2])*scale,
});
export function residentState(params) {
  const frame=params.frame??'GCRF', time=params.epochTimeScale??'TDB';
  return makeTable('PRWResidentState', {
    STATE:makeTable('FRMStateVector', {REPRESENTATION:sds.frmStateRepresentation.CARTESIAN,
      POSITION:vec(params.position,1000),VELOCITY:vec(params.velocity,1000),
      COORDINATE_SYSTEM_NAME:frame,EPOCH:isoFromJD(params.epochJD),EPOCH_TIME_SYSTEM:time}),
    COORDINATE_SYSTEM:coordinateSystem(frame),
    HAS_MASS_KG:params.massKg!==undefined,MASS_KG:params.massKg??0,
  });
}
const choice = (enumName, value, fallback) => sds[enumName][value??fallback] ?? 255;
const basis = x => choice('prwSteeringBasis',({INERTIAL:'INTEGRATION_FRAME',RTN:'RTN_AXES',LVLH:'RTN_AXES',
  VNC:'VNC_AXES',VELOCITY:'ALONG_VELOCITY',ANTI_VELOCITY:'OPPOSITE_VELOCITY'})[x??'INERTIAL']??'INVALID');
// {axes:'INERTIAL'|'RTN', q:[3] m^2/s^3, intervalSeconds}, or none.
export function processNoise(noise) {
  return noise === undefined ? null : makeTable('PRWProcessNoise',{
    MODEL:sds.prwProcessNoiseModel[noise.model??'WHITE_ACCELERATION'],
    AXES:noise.axes==='RTN'?sds.prwProcessNoiseAxes.RADIAL_TRANSVERSE_NORMAL:sds.prwProcessNoiseAxes.INERTIAL,
    SPECTRAL_DENSITY_M2_S3:noise.q,DISCRETIZATION_SECONDS:noise.intervalSeconds});
}
export function matrix(values,n) {
  return values === undefined ? null : makeTable('PRWStateMatrix',{DIMENSION:n,
    VALUES:values.map((v,i)=>v*(Math.floor(i/n)<6?1000:1)*(i%n<6?1000:1))});
}
function boundary(b, edge, epoch) {
  let seconds=b[`${edge}Seconds`];
  if(seconds===undefined && (b[`${edge}JD`]!==undefined || b[`${edge}EpochJD`]!==undefined))
    seconds=((b[`${edge}JD`]??b[`${edge}EpochJD`])-epoch)*86400;
  const event=b[`${edge}Event`];
  let condition=null;
  if(event) {
    const parameter=({RADIUS:'POSITION_MAGNITUDE',SPEED:'VELOCITY_MAGNITUDE',NODE:'POSITION_Z',MASS:'TOTAL_MASS',RADIAL_VELOCITY:'RADIAL_VELOCITY'})[event.kind];
    condition=makeTable('PCEParameterCondition',{
      PARAMETER:makeTable('PCEParameterRef',{PARAMETER:sds.pceParameter[parameter]??65535}),
      GOAL_VALUE:event.goal*(event.kind==='MASS'?1:1000),
      GOAL_TOLERANCE:event.kind==='MASS'?1e-8:1e-5,
      DIRECTION:({'-1':sds.pceConditionDirection.DECREASING,'0':sds.pceConditionDirection.ANY_CROSSING,'1':sds.pceConditionDirection.INCREASING})[event.direction??0]??0,
    });
  }
  return makeTable('PRWBurnBoundary',{ELAPSED_SECONDS:seconds??0,HAS_ELAPSED_SECONDS:seconds!==undefined,CONDITION:condition});
}
function finiteBurn(b,epoch) {
  return makeTable('PRWFiniteBurn',{
    START:boundary(b,'start',epoch),STOP:boundary(b,'stop',epoch),
    THRUST_LAW:b.thrustNewtons!==undefined?sds.prwThrustPrescription.FORCE:sds.prwThrustPrescription.ACCELERATION,
    FORCE_NEWTONS:b.thrustNewtons??0,HAS_FORCE_NEWTONS:b.thrustNewtons!==undefined,
    ACCELERATION_M_S2:(b.accelerationKmS2??0)*1000,HAS_ACCELERATION_M_S2:b.accelerationKmS2!==undefined,
    SPECIFIC_IMPULSE_SECONDS:number(b.ispSeconds),VECTOR_BASIS:basis(b.frame),
    DIRECTION:b.direction===undefined?(['VELOCITY','ANTI_VELOCITY'].includes(b.frame)?null:vec([1,0,0])):vec(b.direction),DIRECTION_RATE:b.steeringRate===undefined?null:vec(b.steeringRate),
    THROTTLE:(b.throttle??[]).map(p=>makeTable('PRWThrottlePoint',{ELAPSED_SECONDS:p.seconds,FRACTION:p.throttle})),
  });
}
export function execution(params,withKernel=false) {
  const f=params.forces??{}, it=params.integrator??{}, sc=params.spacecraft??{};
  const mass=params.massKg??f.massKg??f.mass??sc.massKg??sc.mass??1000;
  const seven=params.finiteBurns!==undefined;
  const tol=it.tolerance??it.absTolerance??1e-12;
  const bodies=[['Sun','sun',10,true],['Moon','moon',301,true],['Mercury','mercury',1,false],
    ['Venus','venus',2,false],['Mars','mars',4,false],['Jupiter','jupiter',5,false],
    ['Saturn','saturn',6,false],['Uranus','uranus',7,false],['Neptune','neptune',8,false]];
  const settings=makeTable('PRWIntegratorSettings',{
    ALGORITHM:choice('prwSolverAlgorithm',it.method?.toUpperCase()==='EQUINOCTIALVOP'?'EQUINOCTIAL_VOP':it.method?.toUpperCase(),'RK78'),
    INITIAL_STEP_SECONDS:it.initialStep??60,MINIMUM_STEP_SECONDS:it.minStep??1,MAXIMUM_STEP_SECONDS:it.maxStep??3600,
    ABSOLUTE_TOLERANCES:[...Array(6).fill(tol*1000),...(seven?[tol]:[])],
    RELATIVE_TOLERANCE:it.tolerance??it.relTolerance??1e-12,MAXIMUM_STEPS:it.maxSteps??100000,
  });
  const forces=makeTable('PRWForceConfiguration',{
    GRAVITY_CHOICE:choice('prwGravitySelection',({J2:'J2_ONLY',J2_J4:'J2_TO_J4'})[f.gravityMode]??f.gravityMode,'INFER_FLAGS'),
    ENABLE_POINT_MASS:f.centralBody??f.pointMass??true,GRAVITATIONAL_PARAMETER:(f.mu??398600.4418)*1e9,
    ENABLE_J2:f.j2??true,ENABLE_J3:f.j3??false,ENABLE_J4:f.j4??false,ENABLE_HIGHER_ZONALS:f.higherZonals??false,
    MAXIMUM_DEGREE:f.maxDegree??0,HAS_MAXIMUM_DEGREE:f.maxDegree!==undefined,
    MAXIMUM_ORDER:f.maxOrder??0,HAS_MAXIMUM_ORDER:f.maxOrder!==undefined,
    ENABLE_THIRD_BODY:f.thirdBody??false,THIRD_BODY_IDS:bodies.filter(([a,b,id,d])=>f[`thirdBody${a}`]??f[b]??d).map(x=>x[2]),
    ENABLE_SRP:f.srp??false,ENABLE_DRAG:f.drag??false,INITIAL_MASS_KG:mass,
    AREA_M2:f.areaM2??f.area??sc.areaM2??sc.area??10,
    REFLECTIVITY_COEFFICIENT:f.cr??f.Cr??1.5,DRAG_COEFFICIENT:f.cd??f.Cd??2.2,
    ATMOSPHERE_MODEL:choice('prwAtmosphereFamily',f.dragModel,'NRLMSISE00'),
    EPHEMERIS_SOURCE:params.ephemerisSource??(withKernel?'JPL_SPK':'Analytical'),
  });
  // Weather is explicitly UTC. This fixture epoch is input metadata, not an
  // inferred UTC=TDB conversion; constant weather indices are sampled there.
  if(params.weather) {
    const w=params.weather;
    forces.WEATHER=makeTable('PRWSpaceWeather',{EPOCH:instant(w.epochUTCJD??params.epochJD,'UTC'),
      F107:w.F107??w.f107??150,F107_AVERAGE:w.F107a??w.f107a??150,AP_INDEX:w.Ap??w.ap??15,KP_INDEX:w.Kp??w.kp??3});
  }
  return makeTable('PRWExecutionRequest',{
    INITIAL:residentState({...params,massKg:seven?mass:params.massKg}),TARGET_EPOCH:instant(params.targetJD),INTEGRATOR:settings,FORCES:forces,
    INCLUDE_STM:params.includeSTM??false,STM_TECHNIQUE:choice('prwDerivativeTechnique',params.STM_METHOD,'ANALYTIC'),
    DENSITY_TREATMENT:choice('prwDensityTreatment',params.DENSITY_GRADIENT,'NEGLECTED'),
    INITIAL_COVARIANCE:matrix(params.covariance,6),INITIAL_MASS_COVARIANCE:matrix(params.covariance7,7),
    SAMPLE_EPOCHS:(params.sampleEpochsJD??[]).map(jd=>instant(number(jd))),
    IMPULSES:(params.maneuvers??[]).map(m=>makeTable('PRWImpulse',{EPOCH:instant(m.epochJD),DELTA_V:vec(m.deltaV,1000),VECTOR_BASIS:basis(m.frame)})),
    INCLUDE_MASS_DYNAMICS:seven,FINITE_BURNS:(params.finiteBurns??[]).map(b=>finiteBurn(b,params.epochJD)),
    PROCESS_NOISE:processNoise(params.processNoise),
  });
}
export function nativeInput(bytes) {
  return encodePrw('NATIVE_INPUT',makeTable('PRWNativeInput',{
    DESCRIPTOR:makeTable('NCD',{FORMAT:sds.ncdContainerFormat.SPK_DAF,SOURCE_BYTE_LENGTH:BigInt(bytes.length),
      SOURCE_SHA256:createHash('sha256').update(bytes).digest('hex')}),CONTENT:Array.from(bytes),
  }));
}
export function operationPayload(operation,params={},withKernel=false) {
  if(operation==='propagate') return encodePrw('EXECUTION_REQUEST',execution(params,withKernel));
  if(operation==='version') return encodePrw('VERSION_QUERY',true);
  if(operation==='ephemeris') return encodePrw('EPHEMERIS_REQUEST',makeTable('PRWEphemerisRequest',{
    EPOCH:instant(params.epochTDBJD),TARGET_NAIF_ID:params.target,CENTER_NAIF_ID:params.center??399,
  }));
  if(operation==='atmosphere') {
    // Calendar fixture metadata in UTC; year 2001 deliberately preserves DOY
    // 172/80 without relying on the legacy year=0 diagnostic convention.
    const epoch=new Date(Date.UTC(params.year>0?params.year:2001,0,params.dayOfYear??172));
    const jd=epoch.getTime()/86400000+2440587.5+(params.secondOfDay??29000)/86400;
    return encodePrw('ATMOSPHERE_REQUEST',makeTable('PRWAtmosphereRequest',{
      EPOCH:instant(jd,'UTC'),ATMOSPHERE_MODEL:choice('prwAtmosphereFamily',params.model,'NRLMSISE00'),
      ALTITUDE_M:params.altitudeKm*1000,LATITUDE_RAD:(params.latitudeDeg??0)*Math.PI/180,LONGITUDE_RAD:(params.longitudeDeg??0)*Math.PI/180,
      LOCAL_SOLAR_TIME_HOURS:params.localSolarTimeHours??0,HAS_LOCAL_SOLAR_TIME_HOURS:params.localSolarTimeHours!==undefined,
      F107:params.f107??150,F107_AVERAGE:params.f107a??150,AP_INDEX:params.ap??4,INCLUDE_ANOMALOUS_OXYGEN:params.includeAnomalousOxygen??false,
    }));
  }
  throw new Error(`Unknown test operation ${operation}`);
}
export function requestFor(operation,params={},kernel) {
  return {methodId:'invoke',inputs:[{portId:'request',typeRef:TYPE,payload:operationPayload(operation,params,!!kernel)},
    ...(kernel?[{portId:'kernel',typeRef:TYPE,payload:nativeInput(kernel)}]:[])]};
}
export function hexRequestFor(operation,params={},kernel) {
  const r=requestFor(operation,params,kernel);
  r.inputs=r.inputs.map(({payload,...input})=>({...input,payloadHex:Buffer.from(payload).toString('hex')}));
  return r;
}
const pv = v=>[v.X,v.Y,v.Z].map(x=>x/1000);
function unpackState(r) { return {epochJD:jdFromISO(r.STATE.EPOCH),position:pv(r.STATE.POSITION),velocity:pv(r.STATE.VELOCITY),
  frame:r.COORDINATE_SYSTEM.NAME,epochTimeScale:r.STATE.EPOCH_TIME_SYSTEM,positionUnits:'km',velocityUnits:'km/s',
  ...(r.HAS_MASS_KG?{massKg:r.MASS_KG,massUnits:'kg'}:{})}; }
export function unpackMatrix(m,stm=false) {
  return m?.VALUES.map((v,i)=>{
    const row=Math.floor(i/m.DIMENSION)<6?1000:1,col=i%m.DIMENSION<6?1000:1;
    return stm?v/row*col:v/row/col;
  });
}
function unpackSample(s) {
  const out={...unpackState(s.STATE),integrationSteps:Number(s.ACCEPTED_STEPS),integrationRejections:Number(s.REJECTED_STEPS)};
  for(const [key,field,isSTM] of [['stm','STM',true],['stm7','MASS_STM',true],['covariance','COVARIANCE',false],['covariance7','MASS_COVARIANCE',false]])
    if(s[field]) out[key]=unpackMatrix(s[field],isSTM);
  if(s.PROCESS_NOISE) out.processNoise=s.PROCESS_NOISE;
  out.burnSummary=s.BURNS.map(b=>({index:b.BURN_INDEX,started:b.STARTED,stopped:b.STOPPED,startByEvent:b.START_BY_EVENT,stopByEvent:b.STOP_BY_EVENT,
    startSeconds:b.HAS_START_SECONDS?b.START_SECONDS:null,stopSeconds:b.HAS_STOP_SECONDS?b.STOP_SECONDS:null,
    startEpochJD:b.START_EPOCH?.JULIAN_DATE??null,stopEpochJD:b.STOP_EPOCH?.JULIAN_DATE??null,deltaVKmS:b.DELTA_V_M_S/1000,propellantKg:b.PROPELLANT_KG}));
  return out;
}
export function decodeResult(response) {
  const root=decodePrw(response.outputs.find(o=>o.portId==='response').payload);
  if(root.EXECUTION_RESULT) {
    const r=root.EXECUTION_RESULT;
    return {...unpackSample(r.FINAL_SAMPLE),samples:r.SAMPLES.map(unpackSample),propagatedDeltaSeconds:r.ELAPSED_SECONDS,
      ephemerisSource:r.EPHEMERIS_SOURCE,STM_METHOD:sds.prwDerivativeTechnique[r.STM_TECHNIQUE],DENSITY_GRADIENT:sds.prwDensityTreatment[r.DENSITY_TREATMENT]};
  }
  if(root.EPHEMERIS_RESULT) {
    const r=root.EPHEMERIS_RESULT,s=unpackState(r.STATE);
    return {...s,epochTDBJD:s.epochJD,target:r.TARGET_NAIF_ID,center:r.CENTER_NAIF_ID,frame:s.frame,ephemerisSource:r.EPHEMERIS_SOURCE};
  }
  if(root.ATMOSPHERE_RESULT) {
    const r=root.ATMOSPHERE_RESULT,names=['','He','O','N2','O2','Ar','H','N','anomalousO'];
    return {model:sds.prwAtmosphereFamily[r.ATMOSPHERE_MODEL],variant:r.VARIANT,altitudeKm:r.ALTITUDE_M/1000,
      densityKgM3:r.DENSITY_KG_M3,densityGCm3:r.DENSITY_KG_M3/1000,temperatureK:r.HAS_TEMPERATURE_K?r.TEMPERATURE_K:undefined,
      exosphericTemperatureK:r.HAS_EXOSPHERIC_TEMPERATURE_K?r.EXOSPHERIC_TEMPERATURE_K:undefined,
      scaleHeightKm:r.HAS_SCALE_HEIGHT_M?r.SCALE_HEIGHT_M/1000:undefined,
      numberDensitiesCm3:Object.fromEntries(r.NUMBER_DENSITIES.map(n=>[names[n.CONSTITUENT],n.NUMBER_PER_M3/1e6]))};
  }
  if(root.VERSION_RESULT) return {version:root.VERSION_RESULT.VERSION,plugin:root.VERSION_RESULT.MODULE_ID};
  throw new Error('Unexpected PRW result arm');
}
export async function invokeTypedRequest(harness,{operation,params}) {
  const response=await harness.invoke(requestFor(operation,params));
  if(response.statusCode!==0) throw new Error(`${response.errorCode}: ${response.errorMessage}`);
  return decodeResult(response);
}
