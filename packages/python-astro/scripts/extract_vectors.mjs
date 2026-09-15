// Extract existing module test expectations. Never import module outputs.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sources = {};
function read(p) { const s=fs.readFileSync(path.join(root,p),'utf8'); sources[p]=crypto.createHash('sha256').update(s).digest('hex'); return s; }
function expression(s, pattern) { const m=s.match(pattern); if(!m) throw Error(`Fixture source changed: ${pattern}`); return vm.runInNewContext('('+m[1]+')', {Math,Date}); }
function constant(s,n) {return expression(s,new RegExp(`const ${n} = ([\\s\\S]*?);`));}
const sgp=read('propagator/sgp4/tests/tudat_wasm_derived.test.mjs');
const hpop=JSON.parse(read('propagator/hpop/tests/fixtures/tudat.reference.json'));
const est=read('analysis/estimation/tests/native_conformance.cpp');
const time=read('foundation/time/tests/time_conversion.test.mjs');
const ft=read('foundation/frames/tests/frame_transform.test.mjs');
const lam=read('analysis/lambert-izzo/tests/sdk-compat.test.mjs');
const ac=read('analysis/access/test/accessAnalyzer.test.mjs');
const ev=read('propagator/events/tests/events.test.mjs');
const sgpData={};
for(const name of ['VALLADO_OMM','VALLADO_TARGET_JD','VALLADO_TEME_POSITION_MAGNITUDE_METERS']) sgpData[name]=constant(sgp,name);
const gibbs={};
// C++ initializer lists are numeric arrays; parse rather than execute C++.
gibbs.positions=[0,1,2].map(i=>est.match(new RegExp(`vallado_gibbs_positions\\[${i}\\]\\.value = \\{([^}]+)\\}`))[1].split(',').slice(0,3).map(Number));
gibbs.expected=est.match(/const Vector6 gibbs_expected\{([^}]+)\}/)[1].split(',').map(Number);
gibbs.mu=Number(est.match(/(?:double|auto) vallado_mu = ([\d.e+-]+)/)[1]);
const taiblock=time.slice(time.indexOf('test("converts Orekit TAIScaleTest.testAAS06134'), time.indexOf('test("converts Orekit UTCScaleTest.testOffsets'));
const frames={dcm:constant(ft,'BASILISK_DCM_J2000_TO_PFIX'),input:expression(ft,/operation: frmOperationCode.PCI_TO_PCPF,\s*position: (\[[^\]]+\])/),expected:expression(ft,/assertVector\(result, (\[[^\]]+\]), 0.0, "PCPF position"/)};
const lamblock=lam.slice(lam.indexOf('function createClosedFormCircularQuarterOrbitInvokeRequest'));
const acblock=ac.slice(ac.indexOf('test("Access analyzer matches Orekit TopocentricFrame inverse'));
const data={sources,sgp4:sgpData,hpop,estimation:gibbs,
 time:{input:expression(taiblock,/sourceIso8601: ("[^"]+")/),expected:expression(taiblock,/target.ISO8601\(\), ("[^"]+")/),delta:expression(taiblock,/result.DELTA_SECONDS\(\), ([\d.]+)/)},frames,
 lambert:{mu:constant(lamblock,'mu'),radius:constant(lamblock,'radiusKm')},
 access:{vectors:expression(acblock,/const vectors = (\[[\s\S]*?\]);/)},
 events:Object.fromEntries(['START','PERIOD_SECONDS','PHASE','A','B','C'].map(n=>[n,constant(ev,n)])),
 conjunction:JSON.parse(read('analysis/conjunction-assessment/tests/fixtures/socrates/reference.top3.json'))};
data.conjunctionGp={};
for(const file of ['gp_61721,67298.json','gp_47935,49179.json','gp_48282,58288.json']) data.conjunctionGp[file]=JSON.parse(read('analysis/conjunction-assessment/tests/fixtures/socrates/'+file));
const out=path.join(root,'packages/python-astro/tests/fixtures/module-vectors.json');
fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(data,null,2)+'\n');
console.log('PASS: extracted authoritative input/expectations from '+Object.keys(sources).length+' existing module sources');
