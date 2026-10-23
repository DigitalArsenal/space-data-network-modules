import assert from 'node:assert/strict';
import test from 'node:test';
import {planetMagnitude} from './mallama-hilton-oracle.mjs';

import {publishedCases} from './published-planet-cases.mjs';
import {measureOracle} from './oracle-measurements.mjs';
import {marsCorrections} from './mars-oracle-geometry.mjs';

test('test-only magnitude oracle reproduces published program examples',()=>{

  for(const [body,date,phase,options,expected] of publishedCases)
    assert.ok(Math.abs(planetMagnitude(body,phase,options)-expected)<.001,`${body} ${date}`);
});

// Same paper/code as the fixtures: Johnson V mag, static supplied phase in
// degrees and CE decimal year. These checks cover branch semantics, not a new
// observational accuracy claim. 1e-12 mag allows double-precision rounding.
test('Saturn paper/code discrepancy is bounded and ring domain is explicit',()=>{
  const report=measureOracle();assert.equal(report.status,'pass');
  assert.ok(Math.abs(report.saturnPaperCodeDifference.max_difference_mag-.003375)<1e-12);
  assert.throws(()=>planetMagnitude('Saturn',6.500001,{saturnRings:true}),RangeError);
  assert.throws(()=>planetMagnitude('Saturn',1,{saturnRings:true,ringLatitudeDeg:27.001}),RangeError);
  assert.ok(Number.isFinite(planetMagnitude('Saturn',150)));
});
test('Neptune epoch and spacecraft branches preserve published discontinuities',()=>{
  for(const [year,expected] of [[1979,-6.89],[1980,-6.89],[1990,-6.944],[2000,-6.998],[2000.000001,-7]])
    assert.ok(Math.abs(planetMagnitude('Neptune',1.9,{year})-expected)<1e-12);
  assert.throws(()=>planetMagnitude('Neptune',1.900001,{year:2000}),RangeError);
  assert.ok(Math.abs(planetMagnitude('Neptune',133)-(-7+.007944*133+.00009617*133**2))<1e-12);
  for(const options of [{year:NaN},{year:Infinity},{r:Infinity},{delta:0}])
    assert.throws(()=>planetMagnitude('Neptune',1,options),RangeError);
});
test('Mars published correction grid respects circular longitude geometry',()=>{
  const atZero=marsCorrections(0,0,85);
  // Published tabulated values at rotational longitude 0 and Ls=0, mag.
  assert.equal(atZero.marsLongitudeCorrection,.036);assert.equal(atZero.marsSeasonCorrection,-.029);
  assert.deepEqual(marsCorrections(350,10,85),atZero);
  assert.deepEqual(marsCorrections(710,370,445),atZero);
});
