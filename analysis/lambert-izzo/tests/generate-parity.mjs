import fs from 'node:fs';
import {encodeGridRequest} from '../grid-codec.js';
import {hohmann,antipodalMulti,earthMars,metadata,circular} from './grid-fixtures.mjs';
const dir=new URL('./fixtures/',import.meta.url);
const requestCase=(id,options)=>{
  const request=encodeGridRequest(options),input=request.inputs[0],payloadFile=`${id}.pce`;
  fs.writeFileSync(new URL(payloadFile,dir),input.payload);
  return {id,expect:'ok',request:{methodId:request.methodId,inputs:[{portId:'request',typeRef:input.typeRef,payloadFile}]}};
};
const epochs=Array.from({length:400},(_,i)=>i*60), arrivals=epochs.map(t=>t+10000);
const maxGrid={...metadata,departure:circular(7e6,epochs),arrival:circular(8e6,arrivals,.4),
  departureStart:0,departureEnd:23940,arrivalStart:10000,arrivalEnd:33940,step:60};
const bad=requestCase('invalid-step',{...hohmann(),step:0});
// Command ABI transports a typed failure with process exit 0; parity compares
// that complete error response. The direct suite asserts its failure code.
const cases=[requestCase('hohmann',hohmann()),requestCase('izzo-left',antipodalMulti(1)),
  requestCase('izzo-right',antipodalMulti(2)),requestCase('earth-mars',earthMars()),
  requestCase('max-grid',maxGrid),bad];
fs.writeFileSync(new URL('grid-parity.json',dir),JSON.stringify({name:'lambert-grid',threadCounts:[1],cases},null,2)+'\n');
console.log('Generated 6 PCE parity fixtures.');
