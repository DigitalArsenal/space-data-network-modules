import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

test('population rotation agrees with an independent signed-axis permutation',()=>{
  // Closed-form Cartesian covariance transformation P' = J P J^T.
  // RTN axes R=+Y, T=-X, N=+Z in GCRF; arbitrary epoch (constant rotation).
  // Position entries use km^2, velocity entries km^2/s^2, cross entries km^2/s.
  // Exact signed permutation, tolerance zero: no trigonometry or rounding.
  const source=fs.readFileSync(new URL('../src/covariance_realism.cpp',import.meta.url),'utf8');
  const begin=source.indexOf('void rotate6('),end=source.indexOf('\n// d^2',begin);
  assert.ok(begin>=0&&end>begin);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'population-rotation-'));
  try{
    const code=source.slice(begin,end)+String.raw`
int main(){
  const double axes[3][3]={{0,1,0},{-1,0,0},{0,0,1}};
  double p[36]={},actual[36],expected[36]={};
  for(int i=0;i<6;++i)p[6*i+i]=i+1;
  p[1]=p[6]=0.25;p[3]=p[18]=0.5;
  const double diagonal[]={2,1,3,5,4,6};
  for(int i=0;i<6;++i)expected[6*i+i]=diagonal[i];
  expected[1]=expected[6]=-0.25;expected[10]=expected[25]=0.5;
  rotate6(axes,p,actual,false);
  for(int i=0;i<36;++i)if(actual[i]!=expected[i])return 1;
  return 0;
}`;
    const file=path.join(directory,'rotation.cpp'),binary=path.join(directory,'rotation');
    fs.writeFileSync(file,code);execFileSync(process.env.CXX||'c++',['-std=c++17',file,'-o',binary]);execFileSync(binary);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
