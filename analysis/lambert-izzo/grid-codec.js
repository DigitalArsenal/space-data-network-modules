// Wire orchestration only: every transfer and delta-V is computed in C++ WASM.
import * as fb from 'flatbuffers';
import { PCE, PCEEvaluationContext, PCEEvaluationRequest, PCEEvaluationResult,
  PCEParameterSample, PCEParameterValue, pceParameter, pceResultStatus,
  pceUnit, pceOwnerClass } from 'spacedatastandards.org/lib/js/PCE/main.js';

export const gridTypeRef = Object.freeze({schemaName:'PCE.fbs', fileIdentifier:'$PCE', rootTypeName:'PCE'});
// Inputs are SI. Each ephemeris has epochs (seconds from epochOrigin), positions
// (N-by-3 metres), velocities (N-by-3 m/s), all in referenceFrame/timeScale.
export function encodeGridRequest({ departure, arrival, departureStart, departureEnd,
  arrivalStart, arrivalEnd, step, mu, maxRevolutions = 0, prograde = true,
  retrograde = false, referenceFrame, timeScale, epochOrigin, requestId = 'lambert-grid' }) {
  const b = new fb.Builder(4096), entries = [];
  const add = (name, value, unit, columns = 0) => {
    const isArray = Array.isArray(value) || ArrayBuffer.isView(value);
    const nameOffset = b.createString(name);
    const data = isArray ? PCEParameterValue.createValuesVector(b, value) : 0;
    entries.push(PCEParameterValue.createPCEParameterValue(b, pceParameter.PROVIDER_DEFINED,
      nameOffset, pceResultStatus.OK, isArray ? 0 : value, data,
      columns ? value.length / columns : 0, columns, 0, unit, 0));
  };
  for (const [prefix, states] of [['departure', departure], ['arrival', arrival]]) {
    add(`${prefix}_epochs`, states.epochs, pceUnit.SECOND);
    add(`${prefix}_positions`, states.positions.flat?.() ?? states.positions, pceUnit.METRE, 3);
    add(`${prefix}_velocities`, states.velocities.flat?.() ?? states.velocities, pceUnit.METRE_PER_SECOND, 3);
  }
  for (const [name, value] of Object.entries({departure_start:departureStart, departure_end:departureEnd,
    arrival_start:arrivalStart, arrival_end:arrivalEnd, grid_step:step})) add(name, value, pceUnit.SECOND);
  add('max_revolutions', maxRevolutions, pceUnit.DIMENSIONLESS);
  add('direction_flags', (prograde ? 1 : 0) | (retrograde ? 2 : 0), pceUnit.DIMENSIONLESS);
  const values = PCEParameterSample.createParameterValuesVector(b, entries);
  const sample = PCEParameterSample.createPCEParameterSample(b, 0, 0, values);
  const samples = PCEEvaluationResult.createSamplesVector(b, [sample]);
  const result = PCEEvaluationResult.createPCEEvaluationResult(b, pceResultStatus.OK, 0, samples, 0, 0);
  const frame = b.createString(referenceFrame), time = b.createString(timeScale), origin = b.createString(epochOrigin);
  PCEEvaluationContext.startPCEEvaluationContext(b);
  PCEEvaluationContext.addOwnerClass(b, pceOwnerClass.SOLVER);
  PCEEvaluationContext.addGravitationalParameter(b, mu);
  PCEEvaluationContext.addDefaultCoordinateSystemName(b, frame);
  PCEEvaluationContext.addDefaultTimeSystem(b, time);
  PCEEvaluationContext.addReferenceEpoch(b, origin);
  const context = PCEEvaluationContext.endPCEEvaluationContext(b);
  const trace = b.createString(requestId);
  const request = PCEEvaluationRequest.createPCEEvaluationRequest(b, context, 0, 0, trace);
  PCE.startPCE(b);
  PCE.addEvaluationRequest(b, request);
  PCE.addEvaluationResult(b, result);
  const root = PCE.endPCE(b);
  PCE.finishPCEBuffer(b, root);
  return {methodId:'grid_search', inputs:[{portId:'request', typeRef:gridTypeRef, payload:b.asUint8Array()}]};
}
export function decodeGridRecord(payload) {
  const bb = new fb.ByteBuffer(payload);
  if (!PCE.bufferHasIdentifier(bb)) throw new Error('Expected $PCE');
  const result = PCE.getRootAsPCE(bb).EVALUATION_RESULT();
  if (!result || result.STATUS() !== pceResultStatus.OK) throw new Error('Grid evaluation failed');
  const sample = result.SAMPLES(0), values = {}, units = {};
  for (let i = 0; i < sample.parameterValuesLength(); i++) {
    const v = sample.PARAMETER_VALUES(i), name = v.PROVIDER_DEFINED_NAME();
    // A present zero-length vector denotes an empty best result.
    const scalar = name === "departure_index" || name === "arrival_index";
    values[name] = v.STRING_VALUE() ?? (scalar ? v.VALUE() :
      Array.from({length:v.valuesLength()}, (_, i) => v.VALUES(i)));
    units[name] = v.UNIT();
  }
  return {values, units, epochOrigin:sample.EPOCH(), timeScale:sample.EPOCH_TIME_SYSTEM(), requestId:result.TRACE_ID()};
}
