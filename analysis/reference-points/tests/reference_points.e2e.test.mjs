import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, {after} from 'node:test';
import {createBrowserModuleHarness} from 'space-data-module-sdk/host/browser-module';
import {validateArtifactWithStandards} from 'space-data-module-sdk/compliance';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import path from 'node:path';

const wasmURL=new URL('../dist/isomorphic/module.wasm',import.meta.url);
const harness=await createBrowserModuleHarness({wasmSource:fs.readFileSync(wasmURL),surface:'direct'});
const x=harness.instance.exports;
const mem=()=> (harness.memory??x.memory).buffer;
const allocations=[];
function alloc(values) {
  const n=typeof values==='number'?values:values.length,p=x.plugin_alloc(n*8);
  assert.ok(p);allocations.push([p,n*8]);
  if (typeof values!=='number') new Float64Array(mem(),p,n).set(values);
  return p;
}
const read=(p,n)=>Array.from(new Float64Array(mem(),p,n));
const output=alloc(12000);
const zero=alloc([0,0,0]),pole=alloc([0,0,1]);
const identity=alloc([1,0,0,0,1,0,0,0,1]);
const turn=alloc([0,-1,0,1,0,0,0,0,1]);
const AU=149597870700;
const GM={sun:1.32712440041279419e20,emb:4.0350323550225981e14,earth:3.986004354360959e14,moon:4.902800118457549e12,jupiter:1.26686531900e17};
const close=(a,b,tol,message='')=>assert.ok(Number.isFinite(a)&&Math.abs(a-b)<=tol,`${message}: ${a} vs ${b}; tolerance ${tol}`);
const norm=a=>Math.hypot(...a);
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const force=(v,mu)=>v-(1-mu)*(v+mu)/Math.abs(v+mu)**3-mu*(v-1+mu)/Math.abs(v-1+mu)**3;
const vertices=n=>Array.from({length:n},(_,i)=>read(output+24*i,3));
function strips(n,lengths) {
  const points=vertices(n);let offset=0;
  for (const [i,length] of lengths.entries()) {
    for (const p of points.slice(offset,offset+length)) assert.ok(p.every(Number.isFinite));
    offset+=length;
    if (i<lengths.length-1) {assert.ok(points[offset].every(Number.isNaN));++offset;}
  }
  assert.equal(offset,n);return points;
}
after(async()=>{for (const [p,n] of allocations) x.plugin_free(p,n);await harness.dispose?.();});

test('SDK artifact, manifest, and direct ABI',async()=>{
  const manifest=JSON.parse(fs.readFileSync(new URL('../plugin-manifest.json',import.meta.url)));
  const requireSdk=createRequire(import.meta.resolve('space-data-module-sdk'));
  const standardsRoot=path.dirname(requireSdk.resolve('spacedatastandards.org/package.json'));
  const report=await validateArtifactWithStandards({manifest,wasmPath:fileURLToPath(wasmURL),standardsRoot});
  assert.ok(report.ok,JSON.stringify(report.issues));
  assert.deepEqual(manifest.invokeSurfaces,['direct']);
  assert.deepEqual(manifest.methods.map(m=>m.methodId),['describe']);
  assert.deepEqual(JSON.parse(fs.readFileSync(new URL('../dist/plugin-manifest.json',import.meta.url))),manifest);
  const response=await harness.invoke({methodId:'describe',inputs:[]});
  assert.equal(response.statusCode,0,response.errorMessage);
  assert.equal(response.outputs.length,1);
  const {ByteBuffer}=requireSdk('flatbuffers');
  const {PCE}=await import(pathToFileURL(requireSdk.resolve('spacedatastandards.org/lib/js/PCE/main.js')));
  const payload=new ByteBuffer(response.outputs[0].payload);
  assert.ok(PCE.bufferHasIdentifier(payload));
  const result=PCE.getRootAsPCE(payload).EVALUATION_RESULT();
  assert.equal(result.samplesLength(),1);
  const sample=result.SAMPLES(0);assert.equal(sample.parameterValuesLength(),1);
  assert.equal(sample.PARAMETER_VALUES(0).PROVIDER_DEFINED_NAME(),'version');
  assert.equal(sample.PARAMETER_VALUES(0).STRING_VALUE(),'0.1.0');
  assert.equal(x.rp_abi_version(),1);
  for (const name of ['plugin_alloc','plugin_free','plugin_invoke_stream','plugin_get_manifest_flatbuffer','plugin_get_manifest_flatbuffer_size',
    'rp_collinear','rp_lagrange','rp_influence','rp_shadow','rp_wire_circle','rp_wire_sphere','rp_wire_cone','rp_wire_dipole','rp_terminator','rp_sub_point','rp_region','rp_geomagnetic_axis']) assert.equal(typeof x[name],'function',name);
});

// Source: Szebehely, Theory of Orbits (1967), CR3BP equilibria; task-supplied
// NASA Earth-Moon table rounded to 8 decimals. Units: separation=1; rotating
// barycentric frame; timeless circular model. 1e-8 allows rounding/truncation in the supplied 8-decimal table.
test('Earth-Moon published collinear coordinates',()=>{
  assert.equal(x.rp_collinear(0.0121505856,output),0);
  read(output,3).forEach((v,i)=>close(v,[0.83691513,1.15568217,-1.00506264][i],1e-8));
});
// Source: Newtonian CR3BP force balance, independently evaluated here; NAIF
// gm_de440.tpc and pck00011 constants as supplied in the task. Normalized units,
// barycentric rotating frame, no epoch (constant GM). Residual <1e-13 is the
// requested solver accuracy, comfortably above floating-point cancellation.
test('collinear roots satisfy force balance for Sun-Earth, Earth-Moon, Sun-Jupiter and equal masses',()=>{
  for (const [gp,gs] of [[GM.sun,GM.earth],[GM.sun,GM.emb],[GM.earth,GM.moon],[GM.sun,GM.jupiter],[1,1]]) {
    const mu=gs/(gp+gs);assert.equal(x.rp_collinear(mu,output),0);
    const [l1,l2,l3]=read(output,3);
    assert.ok(l1>-mu&&l1<1-mu&&l2>1-mu&&l3<-mu);
    for (const v of [l1,l2,l3]) close(force(v,mu),0,1e-13);
  }
});
// Source: closed-form equilateral triangle and instantaneous rotating basis.
// Meters, m/s, synthetic ICRF epoch t=0. 2e-13 m / 2e-15 cosine account for
// double arithmetic at separation 10 m. Reversing velocity reverses leading L4.
test('Lagrange distances, 60 degree lead, common origin and output rotation',()=>{
  const primary=alloc([3,4,5,2,0,0]);
  for (const sign of [1,-1]) {
    const secondary=alloc([13,4,5,2,sign*7,0]);
    assert.equal(x.rp_lagrange(primary,secondary,9,1,0,output),0);const a=read(output,27);
    close(a[15],0.1,1e-16);close(a[16],10,0);
    for (const i of [3,4]) {close(a[17+2*i],10,2e-13);close(a[18+2*i],10,2e-13);}
    const l4=sub(a.slice(9,12),[3,4,5]),l5=sub(a.slice(12,15),[3,4,5]);
    close(dot(l4,[10,0,0])/(norm(l4)*10),0.5,2e-15);
    assert.ok(l4[1]*sign>0&&l5[1]*sign<0);
    for (let i=0;i<5;i++) {
      close(norm(sub(a.slice(3*i,3*i+3),[3,4,5])),a[17+2*i],2e-13);
      close(norm(sub(a.slice(3*i,3*i+3),[13,4,5])),a[18+2*i],2e-13);
    }
    assert.equal(x.rp_lagrange(primary,secondary,9,1,turn,output),0);const b=read(output,27);
    for (let i=0;i<5;i++) {close(b[3*i],-a[3*i+1],2e-13);close(b[3*i+1],a[3*i],2e-13);close(b[3*i+2],a[3*i+2],2e-13);}
    assert.deepEqual(b.slice(15),a.slice(15));
  }
});
// Source: Hill and Laplace analytical radii with DE440 GM and IAU 2012 B2 au.
// Meters; Sun-centered synthetic ICRF circular state t=0. Rounded references
// allow 1e6 m (SOI) / 3e5 m (Hill; the supplied approximate value differs by 259 km); equations allow 1e-6 m roundoff.
test('Earth Hill and Laplace sphere of influence at one au',()=>{
  const p=alloc([0,0,0,0,0,0]),b=alloc([AU,0,0,0,29780,0]);
  assert.equal(x.rp_influence(p,b,GM.sun,GM.earth,output),0);const [d,h,s]=read(output,3);
  assert.equal(d,AU);close(s,9.25e8,1e6);close(h,1.4963e9,3e5);
  close(h,AU*Math.cbrt(GM.earth/GM.sun/3),1e-6);close(s,AU*(GM.earth/GM.sun)**0.4,1e-6);
});
// Source: tangent cones of two spheres; IAU nominal solar radius 695700 km,
// task Earth mean radius 6371 km. Meters; Sun-centered ICRF t=0. Rounded length
// 2e6 m tolerance (the supplied radii actually give 1.38263e9 m); analytic
// cone sines/tangents 2e-15 relative roundoff.
test('Earth umbra and penumbra geometry',()=>{
  const rs=695700e3,rb=6371e3;
  assert.equal(x.rp_shadow(zero,alloc([AU,0,0]),rs,rb,output),0);const a=read(output,8);
  a.slice(0,3).forEach((v,i)=>close(v,[1,0,0][i],2e-16));assert.equal(a[3],AU);close(a[4],1.384e9,2e6);
  close(a[4],rb*AU/(rs-rb),1e-6);close(a[5],rb*AU/(rs+rb),1e-6);
  for (const [i,s] of [[6,(rs-rb)/AU],[7,(rs+rb)/AU]]) close(a[i],s/Math.sqrt(1-s*s),2e-17);
});
// Source: ellipsoid equation and normal gradient, closed-form analytic geometry.
// Meters, synthetic body-fixed axes rotated 90 degrees from ICRF at t=0.
// 2e-14 dimensionless surface/normalized normal residual; 1e-8 m closure allows
// Earth-sized coordinate roundoff. Includes oblate and triaxial ellipsoids.
test('terminator lies on ellipsoid with normal perpendicular to Sun, through both rotations',()=>{
  const center=[11,22,33],c=alloc(center),sun=[2,3,5],s=alloc(sun);
  for (const radii of [[6378137,6378137,6356752.314245],[9,5,3]]) {
    assert.equal(x.rp_terminator(s,turn,alloc(radii),c,turn,72,output,73),73);
    const points=vertices(73);points[0].forEach((v,i)=>close(v,points[72][i],1e-8));
    for (const out of points) {
      const icrf=sub([out[1],-out[0],out[2]],center);
      const p=[-icrf[1],icrf[0],icrf[2]],bs=[-sun[1],sun[0],sun[2]];
      close(p.reduce((sum,v,i)=>sum+(v/radii[i])**2,0),1,2e-14);
      const n=p.map((v,i)=>v/radii[i]**2);close(dot(n,bs)/(norm(n)*norm(bs)),0,2e-14);
    }
  }
});
// Source: radial sphere intercept, and NGA WGS84 a=6378137 m, 1/f=298.257223563;
// tan(geodetic latitude)=tan(geocentric latitude)/(1-e^2). ICRF/body axes
// identical at synthetic t=0. 2e-9 m / 2e-12 degree tolerate double arithmetic.
test('sub-points on sphere and WGS84 at 45 degree geocentric latitude',()=>{
  const target=alloc([1,2,3]);
  assert.equal(x.rp_sub_point(target,identity,alloc([7,7,7]),zero,0,output),0);let a=read(output,6);
  a.slice(0,3).forEach((v,i)=>close(v,7*[1,2,3][i]/Math.sqrt(14),2e-14));close(a[5],Math.sqrt(14),1e-15);
  const major=6378137,f=1/298.257223563,b=major*(1-f);
  assert.equal(x.rp_sub_point(alloc([1e8,0,1e8]),identity,alloc([major,major,b]),zero,0,output),0);a=read(output,6);
  close(a[4],Math.atan(1/(1-f)**2)*180/Math.PI,2e-12);close(a[3],0,0);
  close((a[0]/major)**2+(a[2]/b)**2,1,1e-15);
  assert.equal(x.rp_sub_point(alloc([-2,-0,0]),0,alloc([7,7,7]),zero,turn,output),0);
  a=read(output,6);close(a[3],180,0);close(a[0],0,0);close(a[1],-7,1e-14);
});
// Source: circle/sphere parametrizations and linear cone r(s), closed-form.
// Meters; input ICRF at synthetic t=0, R is a 90 degree z rotation. Counts and
// NaN locations exact; 1e-13 m allows trig and rotation rounding.
test('circle, sphere and cone counts, deterministic basis, closure and separators',()=>{
  const center=alloc([1,2,3]);
  assert.equal(x.rp_wire_circle(center,pole,turn,2,8,output,9),9);let points=vertices(9);
  assert.deepEqual(points[0],[0,1,3]);assert.deepEqual(points[0],points[8]);
  for (const p of points) close(norm(sub(p,[-2,1,3])),2,1e-13);
  assert.equal(x.rp_wire_sphere(zero,pole,0,2,2,3,9,output,49),49);
  points=strips(49,[9,9,9,9,9]);for (const p of points.filter(p=>p.every(Number.isFinite))) close(norm(p),2,1e-13);
  close(points[0][2],-1,1e-13);close(points[10][2],1,1e-13);
  for (const offset of [20,30,40]) {close(points[offset][2],-2,1e-13);close(points[offset+8][2],2,1e-13);}
  assert.equal(x.rp_wire_cone(zero,pole,0,2,-0.5,0,4,3,4,9,output,41),41);
  points=strips(41,[9,9,9,2,2,2,2]);for (const p of points.filter(p=>p.every(Number.isFinite))) close(Math.hypot(p[0],p[1]),Math.max(0,2-0.5*p[2]),1e-13);
  assert.equal(x.rp_wire_cone(zero,pole,0,1,-1,0,2,0,3,4,output,8),8);strips(8,[2,2,2]);
  assert.equal(x.rp_wire_cone(zero,pole,0,-1,1,1,3,2,0,4,output,9),9);
  points=strips(9,[4,4]);close(norm(points[0]),1,1e-13);close(Math.hypot(...points[5].slice(0,2)),2,1e-13);
  // Least-aligned reference axis for pole +x is +y, hence u=-z.
  assert.equal(x.rp_wire_circle(zero,alloc([1,0,0]),0,2,4,output,5),5);assert.deepEqual(read(output,3),[0,0,-2]);
});
// Source: centered magnetic dipole field line r=L R cos^2(latitude).
// Meters with R=2 m; magnetic frame aligned to synthetic ICRF t=0. 2e-13 m
// permits trigonometric roundoff at the equator and surface intersections.
test('dipole L shell equator, surface cuts and complete curve',()=>{
  assert.equal(x.rp_wire_dipole(zero,pole,0,2,4,3,17,output,53),53);
  const points=strips(53,[17,17,17]);
  for (const offset of [0,18,36]) {
    close(norm(points[offset]),2,2e-13);close(norm(points[offset+16]),2,2e-13);close(norm(points[offset+8]),8,2e-13);
    for (const p of points.slice(offset,offset+17)) {const r=norm(p);close(r,8*(1-(p[2]/r)**2),2e-13);}
  }
});
// Sources: JPL SSD Standish 1800-2050 Jupiter a=5.20288700 au and Kepler's
// period law (Kirkwood 4:1,2:1); NASA Kuiper Belt / Van Allen Probes; Voyager
// Stone 2005/2008/2019 and Gurnett 2013 crossings (README citations).
// Meters for kinds 0-3, dimensionless dipole L for 4-5; heliocentric/equatorial
// model boundaries, epochs specified by those sources, not time propagation.
// 0.01 m and 2e-15 L allow constants/exponent rounding only, not model accuracy.
test('documented approximate region boundaries',()=>{
  const expected=[[5.202887*AU/Math.cbrt(16),5.202887*AU/Math.cbrt(4)],[30*AU,50*AU],
    [88.85*AU,88.85*AU],[120.3*AU,120.3*AU],[1+1000/6378.137,1+6000/6378.137],[1+13000/6378.137,1+60000/6378.137]];
  expected.forEach((a,i)=>{assert.equal(x.rp_region(i,output),0);read(output,2).forEach((v,k)=>close(v,a[k],i<4?0.01:2e-15));});
});
// Source: IGRF-13 2020.0 degree-1 coefficients (Alken et al. 2021).
// Unit vector in Earth-fixed geographic frame; angles degrees. Rounded published
// longitude 72.68 W permits 0.01 degree; unit length 3e-16 double roundoff.
// The task's approximate 80.65 N conflicts with its coefficients, which yield
// 80.5894687 N. Test the specified coefficients independently to 2e-12 degree.
test('IGRF-13 centered geomagnetic north axis',()=>{
  assert.equal(x.rp_geomagnetic_axis(output),0);const p=read(output,3);
  close(norm(p),1,3e-16);close(Math.asin(p[2])*180/Math.PI,Math.atan2(29404.8,Math.hypot(1450.9,4652.5))*180/Math.PI,2e-12);close(Math.atan2(p[1],p[0])*180/Math.PI,-72.68,0.01);
});

test('capacity refusal is atomic, including uint32 overflow-sized counts',()=>{
  const sun=alloc([1,2,3]),radii=alloc([3,2,1]);
  const calls=[()=>x.rp_wire_circle(zero,pole,0,1,8,output,8),()=>x.rp_wire_sphere(zero,pole,0,1,2,3,9,output,48),
    ()=>x.rp_wire_cone(zero,pole,0,1,1,0,1,3,4,9,output,40),()=>x.rp_wire_dipole(zero,pole,0,1,2,3,17,output,52),
    ()=>x.rp_terminator(sun,0,radii,zero,0,8,output,8),()=>x.rp_wire_circle(zero,pole,0,1,0xffffffff,output,0xffffffff),
    ()=>x.rp_wire_sphere(zero,pole,0,1,0xffffffff,0xffffffff,0xffffffff,output,0xffffffff)];
  for (const call of calls) {new Float64Array(mem(),output,12000).fill(123);assert.equal(call(),-2);assert.ok(read(output,12000).every(v=>v===123));}
});
test('invalid arguments return -1',()=>{
  const p=alloc([0,0,0,0,0,0]),s=alloc([1,0,0,0,1,0]),rad=alloc([1,1,1]);
  const bad=alloc([NaN,0,1]),badR=alloc([1,0,0,0,Infinity,0,0,0,1]);
  for (const mu of [0,-1,0.50001,NaN,Infinity]) assert.equal(x.rp_collinear(mu,output),-1);
  const calls=[()=>x.rp_collinear(0.1,0),()=>x.rp_lagrange(p,s,1,2,0,output),()=>x.rp_lagrange(p,p,2,1,0,output),
    ()=>x.rp_lagrange(p,alloc([1,0,0,1,0,0]),2,1,0,output),()=>x.rp_lagrange(p,s,0,1,0,output),
    ()=>x.rp_influence(p,s,-1,1,output),()=>x.rp_influence(p,p,1,1,output),()=>x.rp_shadow(zero,pole,2,1,output),
    ()=>x.rp_shadow(zero,alloc([10,0,0]),1,1,output),()=>x.rp_wire_circle(zero,zero,0,1,8,output,9),
    ()=>x.rp_wire_circle(zero,bad,0,1,8,output,9),()=>x.rp_wire_circle(zero,pole,badR,1,8,output,9),
    ()=>x.rp_wire_circle(zero,pole,0,-1,8,output,9),()=>x.rp_wire_circle(zero,pole,0,1,2,output,9),
    ()=>x.rp_wire_sphere(zero,pole,0,1,0,0,9,output,99),()=>x.rp_wire_sphere(zero,pole,0,1,1,1,0,output,99),
    ()=>x.rp_wire_cone(zero,pole,0,1,0,1,0,2,1,9,output,99),()=>x.rp_wire_cone(zero,pole,0,1,0,0,1,1,1,9,output,99),
    ()=>x.rp_wire_dipole(zero,pole,0,1,0.5,1,9,output,99),()=>x.rp_wire_dipole(zero,pole,0,1,2,0,9,output,99),
    ()=>x.rp_terminator(zero,0,rad,zero,0,9,output,99),()=>x.rp_terminator(pole,0,zero,zero,0,9,output,99),
    ()=>x.rp_sub_point(zero,0,rad,zero,0,output),()=>x.rp_sub_point(pole,badR,rad,zero,0,output),
    ()=>x.rp_region(-1,output),()=>x.rp_region(6,output),()=>x.rp_region(0,0),()=>x.rp_geomagnetic_axis(0)];
  for (const call of calls) assert.equal(call(),-1,call.toString());
});
