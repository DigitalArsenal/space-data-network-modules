#!/usr/bin/env node
// assertNoUserDefined(bytes): an SDN producer never writes USER_DEFINED_PARAMETERS. Decodes one $OMM or $OCM, plain or
// size-prefixed, with the pinned spacedatastandards.org bindings and throws, naming the record type and the count, when
// the list is present and non-empty. Every producing module's E2E calls it on what the module emits.
//
//   node common/tests/no-user-defined.mjs --self-test
import * as flatbuffers from 'flatbuffers';
import { OMM, OMMT, OMMUserDefinedParameterT } from 'spacedatastandards.org/lib/js/OMM/main.js';
import { OCM, OCMT } from 'spacedatastandards.org/lib/js/OCM/main.js';
import { pathToFileURL } from 'node:url';

const RECORDS = {
  $OMM: { plain: OMM.getRootAsOMM, prefixed: OMM.getSizePrefixedRootAsOMM },
  $OCM: { plain: OCM.getRootAsOCM, prefixed: OCM.getSizePrefixedRootAsOCM },
};

const identifierAt = (bytes, at) => (bytes.length >= at + 4 ? String.fromCharCode(...bytes.subarray(at, at + 4)) : '');

export function assertNoUserDefined(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const plain = identifierAt(view, 4);
  const prefixed = identifierAt(view, 8);
  const type = RECORDS[plain] ? plain : RECORDS[prefixed] ? prefixed : null;
  if (!type) throw new Error(`assertNoUserDefined: not an $OMM or $OCM (identifier ${JSON.stringify(plain || prefixed)})`);
  const record = (RECORDS[plain] ? RECORDS[type].plain : RECORDS[type].prefixed)(new flatbuffers.ByteBuffer(view));
  const count = record.userDefinedParametersLength();
  if (count > 0) throw new Error(`${type} carries ${count} USER_DEFINED_PARAMETERS`);
}

function selfTest() {
  const omm = new flatbuffers.Builder(256);
  const ommRecord = new OMMT();
  ommRecord.OBJECT_NAME = 'SELF TEST';
  ommRecord.USER_DEFINED_PARAMETERS = [new OMMUserDefinedParameterT('NAME', 'VALUE')];
  OMM.finishSizePrefixedOMMBuffer(omm, ommRecord.pack(omm));
  let threw = null;
  try { assertNoUserDefined(omm.asUint8Array()); } catch (error) { threw = error.message; }
  if (threw !== '$OMM carries 1 USER_DEFINED_PARAMETERS') throw new Error(`self-test: $OMM with one parameter: got ${JSON.stringify(threw)}`);

  const ocm = new flatbuffers.Builder(256);
  const ocmRecord = new OCMT();
  ocmRecord.USER_DEFINED_PARAMETERS = [];
  OCM.finishOCMBuffer(ocm, ocmRecord.pack(ocm));
  const ocmBytes = ocm.asUint8Array();
  const decoded = OCM.getRootAsOCM(new flatbuffers.ByteBuffer(ocmBytes));
  if (decoded.bb.__offset(decoded.bb_pos, 32) === 0) throw new Error('self-test: $OCM list was not written');
  assertNoUserDefined(ocmBytes);
  console.log(`NO USER DEFINED: self-test passed ($OMM with 1 parameter throws: "${threw}"; $OCM with an empty list passes)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv[2] !== '--self-test') {
    console.error('usage: node common/tests/no-user-defined.mjs --self-test');
    process.exit(2);
  }
  selfTest();
}
