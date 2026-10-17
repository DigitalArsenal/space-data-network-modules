// FlatBuffer serialization only. Budgets, units conversion and ranking execute in WASM.
import * as fb from 'flatbuffers';
import * as pce from 'spacedatastandards.org/lib/js/PCE/main.js';
export const typeRef=Object.freeze({schemaName:'PCE.fbs',fileIdentifier:'$PCE',rootTypeName:'PCE'});
export const units=pce.pceUnit;
export function encodeContext(entries,{trace='mission-screening',context=null}={}) {
  const sample=new pce.PCEParameterSampleT();
  sample.PARAMETER_VALUES=Object.entries(entries).map(([name,entry])=>{
    const {value,unit=units.DIMENSIONLESS,columns=0}=entry;
    const v=new pce.PCEParameterValueT();
    v.PARAMETER=pce.pceParameter.PROVIDER_DEFINED;v.PROVIDER_DEFINED_NAME=name;
    v.STATUS=pce.pceResultStatus.OK;v.UNIT=unit;
    if(typeof value==='string')v.STRING_VALUE=value;
    else if(Array.isArray(value)||ArrayBuffer.isView(value)){v.VALUES=Array.from(value);v.COLUMN_COUNT=columns;v.ROW_COUNT=columns?value.length/columns:0;}
    else v.VALUE=value;
    // SDS object bindings always emit an empty VALUES vector. A scalar needs
    // an absent vector so the public numeric shape remains unambiguous.
    v.pack=b=>pce.PCEParameterValue.createPCEParameterValue(b,v.PARAMETER,b.createString(name),v.STATUS,v.VALUE,
      Array.isArray(value)||ArrayBuffer.isView(value)?pce.PCEParameterValue.createValuesVector(b,v.VALUES):0,
      v.ROW_COUNT,v.COLUMN_COUNT,v.STRING_VALUE===null?0:b.createString(v.STRING_VALUE),v.UNIT,0);
    return v;
  });
  const root=new pce.PCET();root.EVALUATION_RESULT=new pce.PCEEvaluationResultT();
  root.EVALUATION_RESULT.STATUS=pce.pceResultStatus.OK;root.EVALUATION_RESULT.TRACE_ID=trace;root.EVALUATION_RESULT.SAMPLES=[sample];
  if(context){root.EVALUATION_REQUEST=new pce.PCEEvaluationRequestT();root.EVALUATION_REQUEST.CONTEXT=Object.assign(new pce.PCEEvaluationContextT(),context);root.EVALUATION_REQUEST.TRACE_ID=trace;}
  const custom=sample.PARAMETER_VALUES.filter(v=>v.UNIT===units.PROVIDER_DEFINED);
  if(custom.length){
    root.CATALOG=new pce.PCEParameterCatalogT();root.CATALOG.CATALOG_ID='mission-screening-si';
    root.CATALOG.ENTRIES=custom.map(v=>Object.assign(new pce.PCEParameterDescriptorT(),{
      PARAMETER:pce.pceParameter.PROVIDER_DEFINED,PROVIDER_DEFINED_NAME:v.PROVIDER_DEFINED_NAME,
      UNIT:units.PROVIDER_DEFINED,PROVIDER_DEFINED_UNIT_SYMBOL:'m^3/s^2',DATA_TYPE:pce.pceDataType.REAL_SCALAR,
      DESCRIPTION:'Body gravitational parameter in SI units.'}));
  }
  const b=new fb.Builder(4096);pce.PCE.finishPCEBuffer(b,root.pack(b));return b.asUint8Array();
}
export function decodeContext(payload) {
  const bb=new fb.ByteBuffer(payload);if(!pce.PCE.bufferHasIdentifier(bb))throw Error('Expected PCE');
  const r=pce.PCE.getRootAsPCE(bb).EVALUATION_RESULT();if(r.STATUS()!==pce.pceResultStatus.OK)throw Error('PCE evaluation failed');
  const sample=r.SAMPLES(0),values={};
  for(let i=0;i<sample.parameterValuesLength();++i){const v=sample.PARAMETER_VALUES(i);values[v.PROVIDER_DEFINED_NAME()]=v.STRING_VALUE()??(v.valuesArray()?Array.from(v.valuesArray()):v.VALUE());}
  return {values,epochOrigin:sample.EPOCH(),timeScale:sample.EPOCH_TIME_SYSTEM()};
}
