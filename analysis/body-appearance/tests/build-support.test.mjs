import test from 'node:test';
import assert from 'node:assert/strict';
import {cppString} from '../build-support.mjs';

test('C++ parameter literals preserve UTF-8 and delimit adjacent escapes',()=>{
  // Independent C++ lexical examples: exactly three octal digits per byte.
  assert.equal(cppString('doi:10.1/example'),'"doi:10.1/example"');
  assert.equal(cppString('a"\\\n\0'+'7'),'"a\\042\\134\\012\\0007"');
  assert.equal(cppString('μm'),'"\\316\\274m"');
});
