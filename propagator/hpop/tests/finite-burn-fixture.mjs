// Runtime input orchestration only. Independent closed-form physics checks live
// in finite_burn_invoke.test.mjs; no module-produced golden outputs are used.
export const epochJD = 2451545;
export const controls = {method:'RKF78', initialStep:17, minStep:1e-6, maxStep:17,
  absTolerance:2e-13, relTolerance:2e-13, maxSteps:100000};
export const vacuum = {centralBody:false, j2:false, thirdBody:false, srp:false, drag:false};
export const base = {epochJD, targetJD:epochJD+120/86400,
  position:[7000,100,-50], velocity:[1,7,.4], massKg:1000,
  forces:vacuum, integrator:controls, includeSTM:true};
export const burn = {startSeconds:10, stopSeconds:110, thrustNewtons:12,
  ispSeconds:300, frame:'INERTIAL', direction:[1,0,0]};
export const scheduled = {...base, finiteBurns:[burn]};
// Orekit 13.0.1 ConstantThrustManeuverTest.testRoughBehaviour input, converted
// from a=24396.159km,e=.72831215,i=7deg,omega=180deg,Omega=261deg,nu=0
// by the classical perifocal basis. These are inputs, never module outputs.
export const orekit = {...base,targetJD:epochJD+20934.08/86400,massKg:2500,
  position:[1036.869533073127,6546.536584960848,9.892293545390519e-14],
  velocity:[-9.994355552422482,1.5829504105748595,-1.2424491690083865],
  forces:{gravityMode:'POINT_MASS',j2:false,mu:398600.47},
  integrator:{...controls,initialStep:30,maxStep:30},finiteBurns:[{
    startSeconds:17134.08,stopSeconds:20788.07,thrustNewtons:420,ispSeconds:318,
    frame:'INERTIAL',direction:[.9792434793418552,-.1550969304170116,-.1304881233740379]}]};
export const throttled = {...base, finiteBurns:[{...burn,
  throttle:[{seconds:30,throttle:.5},{seconds:70,throttle:0},{seconds:90,throttle:1}]}]};
export const steered = {...base, finiteBurns:[{startSeconds:10, stopSeconds:110,
  accelerationKmS2:1e-5, ispSeconds:300, frame:'INERTIAL', direction:[1,0,0], steeringRate:[0,.003,0]}]};
export const massCutoff = {...base, targetJD:epochJD+250/86400,
  finiteBurns:[{...burn, startSeconds:0, stopSeconds:200, thrustNewtons:100,
    stopEvent:{kind:'MASS',goal:997,direction:-1}}]};
export const nodeStart = {...base, targetJD:epochJD+250/86400,
  position:[7000,0,-10], velocity:[.1,7.5,.1], finiteBurns:[{...burn,
    startSeconds:0, stopSeconds:200, startEvent:{kind:'NODE',goal:0,direction:1}}]};
export const highFlowCutoff = {...base,massKg:1,targetJD:epochJD+12/86400,
  integrator:{...controls,initialStep:2,maxStep:2},finiteBurns:[{...burn,
    startSeconds:0,stopSeconds:10,thrustNewtons:980.665,ispSeconds:100,
    stopEvent:{kind:'MASS',goal:.5,direction:-1}}]};
export const crossingEvents = [
  ['RADIUS',7010,1],['SPEED',Math.hypot(...base.velocity)+.0005,1],['RADIAL_VELOCITY',1.2,1],
].map(([kind,goal,direction])=>({kind,params:{...massCutoff,
  finiteBurns:[{...massCutoff.finiteBurns[0],stopEvent:{kind,goal,direction}}]}}));
export const frames = ['INERTIAL','RTN','LVLH','VNC','VELOCITY','ANTI_VELOCITY'];
export const frameParams = frame => ({...base, targetJD:epochJD+.1/86400,
  finiteBurns:[{startSeconds:0,stopSeconds:.01,accelerationKmS2:1e-4,ispSeconds:300,frame,
    ...(['VELOCITY','ANTI_VELOCITY'].includes(frame)?{}:{direction:[.4,.8,-.2]})}]});
export const request = params => ({methodId:'invoke',inputs:[{portId:'request',
  typeRef:{schemaName:'orbpro.hpop.InvokeRequest',rootTypeName:'InvokeRequest'},
  payloadHex:Buffer.from(JSON.stringify({operation:'propagate',params})).toString('hex')}]});
const alterBurn = change => ({...base,finiteBurns:[{...burn,...change}]});
export const invalidCases = [
  ['missing-Isp',alterBurn({ispSeconds:undefined})],
  ['zero-Isp',alterBurn({ispSeconds:0})],
  ['negative-Isp',alterBurn({ispSeconds:-1})],
  ['malformed-Isp',alterBurn({ispSeconds:'300'})],
  ['missing-thrust',alterBurn({thrustNewtons:undefined})],
  ['zero-thrust',alterBurn({thrustNewtons:0})],
  ['thrust-and-acceleration',alterBurn({accelerationKmS2:1e-5})],
  ['unknown-frame',alterBurn({frame:'BODY'})],
  ['nonstring-frame',alterBurn({frame:42})],
  ['zero-direction',alterBurn({direction:[0,0,0]})],
  ['malformed-direction',alterBurn({direction:[1,0]})],
  ['velocity-explicit-direction',alterBurn({frame:'VELOCITY'})],
  ['reverse-burn',alterBurn({stopSeconds:5})],
  ['ambiguous-start',alterBurn({startJD:epochJD})],
  ['throttle-outside-range',alterBurn({throttle:[{seconds:0,throttle:1.1}]})],
  ['throttle-not-ordered',alterBurn({throttle:[{seconds:30,throttle:1},{seconds:20,throttle:.5}]})],
  ['unknown-event',alterBurn({stopEvent:{kind:'ALTITUDE',goal:100}})],
  ['nonstring-event-kind',alterBurn({stopEvent:{kind:42,goal:999}})],
  ['nonintegral-event-direction',alterBurn({stopEvent:{kind:'MASS',goal:999,direction:.5}})],
  ['zero-mass',{...scheduled,massKg:0}],
  ['wrong-covariance7-shape',{...scheduled,covariance7:[1]}],
  ['malformed-burns-array',{...scheduled,finiteBurns:{}}],
  ['malformed-samples-array',{...scheduled,sampleEpochsJD:{}}],
  ['nonnumber-sample-epoch',{...scheduled,sampleEpochsJD:[String(epochJD)]}],
  ['sample-before-initial-epoch',{...scheduled,sampleEpochsJD:[epochJD-1/86400]}],
  ['unsupported-finite-difference',{...scheduled,STM_METHOD:'FINITE_DIFFERENCE'}],
  ['backward-propagation',{...scheduled,targetJD:epochJD-1/86400}],
  ['step-budget',{...scheduled,integrator:{...controls,maxSteps:1}}],
  ['mass-exhaustion',{...scheduled,massKg:1,finiteBurns:[{...burn,thrustNewtons:1000000}]}],
  ['coincident-event-stop',{...base,finiteBurns:[{...burn,startSeconds:0,stopSeconds:100,
    thrustNewtons:100,stopEvent:{kind:'MASS',goal:1000-100*100/(300*9.80665),direction:-1}}]}],
];
const covariance7 = Array(49).fill(0); covariance7[48]=4;
export const covarianceCase = {...scheduled,covariance7,
  sampleEpochsJD:[epochJD,scheduled.targetJD]};
export const cases = [
  {id:'Orekit-published-rough-behaviour',request:request(orekit)},
  {id:'constant-thrust-mass-STM',request:request(scheduled)},
  {id:'off-grid-throttle-edges',request:request(throttled)},
  {id:'linear-steering-acceleration',request:request(steered)},
  ...frames.map(frame=>({id:`frame-${frame}`,request:request(frameParams(frame))})),
  {id:'mass-event-cutoff-saltation',request:request(massCutoff)},
  {id:'node-event-start',request:request(nodeStart)},
  {id:'high-flow-cutoff-before-depletion',request:request(highFlowCutoff)},
  ...crossingEvents.map(({kind,params})=>({id:`event-${kind}`,request:request(params)})),
  {id:'epoch-defined-edges',request:request({...scheduled,finiteBurns:[{
    ...burn,startSeconds:undefined,stopSeconds:undefined,startJD:epochJD+10/86400,stopJD:epochJD+110/86400}]})},
  {id:'mass-covariance-cumulative-samples',request:request(covarianceCase)},
  ...invalidCases.map(([id,params])=>({id:`reject-${id}`,request:request(params)})),
  {id:'valid-after-errors',request:request({...scheduled,targetJD:epochJD})},
];
