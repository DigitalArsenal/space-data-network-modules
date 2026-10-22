// SDS binary encoding/decoding only. All appearance physics and statistics are C++/WASM.
import * as fb from 'flatbuffers';
import {PCE, PCEEvaluationResult, PCEParameterSample, PCEParameterValue,
  pceParameter, pceResultStatus, pceUnit, pceDataType} from 'spacedatastandards.org/lib/js/PCE/main.js';
export const typeRef = Object.freeze({schemaName: 'PCE.fbs', fileIdentifier: '$PCE', rootTypeName: 'PCE'});
export function encodeRequest(methodId, values = {}) {
  const b = new fb.Builder(4096);
  const entries = Object.entries(values).map(([name, value]) => {
    const n = b.createString(name), vector = Array.isArray(value) || ArrayBuffer.isView(value);
    const data = vector ? PCEParameterValue.createValuesVector(b, value) : 0;
    const string = typeof value === 'string' ? b.createString(value) : 0;
    return PCEParameterValue.createPCEParameterValue(b, pceParameter.PROVIDER_DEFINED, n,
      pceResultStatus.OK, vector || string ? 0 : value, data, 0, 0, string, pceUnit.PROVIDER_DEFINED, 0);
  });
  const params = PCEParameterSample.createParameterValuesVector(b, entries);
  const sample = PCEParameterSample.createPCEParameterSample(b, 0, 0, params);
  const samples = PCEEvaluationResult.createSamplesVector(b, [sample]);
  const result = PCEEvaluationResult.createPCEEvaluationResult(b, pceResultStatus.OK, 0, samples, 0, 0);
  PCE.startPCE(b); PCE.addEvaluationResult(b, result);
  PCE.finishPCEBuffer(b, PCE.endPCE(b));
  return {methodId, inputs: [{portId: 'request', typeRef, payload: b.asUint8Array()}]};
}
export function decodeResult(payload) {
  const bb = new fb.ByteBuffer(payload);
  if (!PCE.bufferHasIdentifier(bb)) throw new Error('Expected $PCE');
  const root = PCE.getRootAsPCE(bb), result = root.EVALUATION_RESULT();
  if (!result || result.STATUS() !== pceResultStatus.OK) throw new Error('Model evaluation failed');
  const sample = result.SAMPLES(0), values = {}, types = new Map(), catalog = root.CATALOG();
  for (let i = 0; catalog && i < catalog.entriesLength(); i++) {
    const descriptor = catalog.ENTRIES(i);
    types.set(descriptor.PROVIDER_DEFINED_NAME(), descriptor.DATA_TYPE());
  }
  for (let i = 0; i < sample.parameterValuesLength(); i++) {
    const v = sample.PARAMETER_VALUES(i), name = v.PROVIDER_DEFINED_NAME(), type = types.get(name);
    const vector = type === pceDataType.REAL_VECTOR || type === pceDataType.REAL_MATRIX;
    // SDS payloads inside a PIV envelope need not be aligned in the host buffer.
    // Generated scalar accessors handle that; valuesArray() requires alignment.
    values[name] = v.STRING_VALUE() ?? (vector ? Array.from({length: v.valuesLength()}, (_, j) => v.VALUES(j)) : v.VALUE());
  }
  return values;
}
