#!/usr/bin/env node
// Attach interpretation and content-addressed provenance to C++ scores.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {here,root} from './frame-diagnostics.mjs';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const H=read(path.join(here,'hpop-frames.json')),R=read(path.join(here,'reference.json')),D=read(path.join(here,'diagnosis.json'));
// id, quantity, independent reference, unit, interpretation (no calculations).
const specs=[
 ['leap','TAI - UTC','ERFA eraDat; SPICE naif0012.tls','s','Leap-second table agreement.'],
 ['tt','TT from UTC','ERFA eraUtctai + eraTaitt','s','PRW whole seconds and fraction construct the two-part TT force instant.'],
 ['tdb','TDB - TT','ERFA eraDtdb at geocentre','s','Existing HPOP two-term model evaluated in seconds. Full ERFA TDB is a different model; no model substitution.'],
 ['tdbSpice','TDB - TT reference spread','SPICE deltet against ERFA eraDtdb','s','Independent reference model spread.'],
 ['forceClock','Force ephemeris TDB instant','ERFA TT + eraDtdb','s','Two-part TT plus HPOP two-term TDB-TT. Remaining difference includes model spread and binary64 SPK ET representation.'],
 ['c2tSameInstant','Force GCRF -> ITRF at same instant','ERFA IERS 2010 CIO full X/Y/s','mas','Hourly TT interpolation of X/Y/s; exact two-part UT1 at each force evaluation.'],
 ['c2tTrue','Force GCRF -> ITRF at exact epoch','ERFA IERS 2010 CIO full X/Y/s','mas','No single-Julian-date force-clock rounding.'],
 ['c2tClock','Force TT clock contribution','ERFA at HPOP TT versus exact TT','mas','Same CIO chain, differing only by represented TT.'],
 ['c2tSpice','Force GCRF -> ITRF','SPICE J2000 -> ITRF93','mas','ITRF93 BPC uses its own EOP and IAU 1976/1980 with corrections; HPOP uses case EOP and IAU 2006/2000A.'],
 ['c2tSpiceErfa','Independent terrestrial-frame reference spread','SPICE ITRF93 versus ERFA CIO','mas','Recorded reference spread, not an HPOP defect.'],
 ['gmstSame','Tides GMST at same instant','ERFA eraGmst06','mas','Two-part UT1 and TT.'],
 ['gmstTrue','Tides GMST at exact epoch','ERFA eraGmst06','mas','Two-part UT1 and TT.'],
 ['c2tBuiltIn','No-EOP fallback versus CIO','ERFA CIO with case EOP','mas','Legacy UT1=UTC, zero polar motion, no frame bias, IAU 1976/1980.'],
 ['coordsPrecession','Classical GCRF/J2000 -> MOD','ERFA eraPmat76','mas','ERFA is the sole implementation.'],
 ['coordsNutation','Classical MOD -> TOD','ERFA eraNutm80','mas','ERFA is the sole implementation; full IAU 1980 series.'],
 ['coordsTeme','Classical GCRF/J2000 -> TEME','ERFA R3(eqeq94) pnm80','mas','FK5 TEME definition.'],
 ['c2tBuiltInClassical','No-EOP fallback classical chain','ERFA R3(gst94(UTC)) nutm80(TT) pmat76(TT)','mas','Reevaluated at every call, exact two-part dates, no hourly N*P cache.'],
 ['teme','SGP4 GCRF -> TEME','ERFA R3(ee06a) pnm06a','mas','Separate foundation/frames IAU 2006/2000A TEME definition.'],
 ['temeFk5','SGP4 versus FK5 TEME definitions','ERFA R3(eqeq94) pnm80','mas','Definition spread.'],
 ['sunSame','Sun relative to Earth at force TDB','SPICE spkgeo, same DE440 and ET','m','Native HPOP force API kernel read; km/km/s converted in C++ to metres.'],
 ['sunTrue','Sun relative to Earth at ERFA TDB','SPICE spkgeo, ERFA TT + eraDtdb','m','Remaining two-term TDB model spread.'],
 ['moonSame','Moon relative to Earth at force TDB','SPICE spkgeo, same DE440 and ET','m','Native HPOP force API kernel read.'],
 ['moonTrue','Moon relative to Earth at ERFA TDB','SPICE spkgeo, ERFA TT + eraDtdb','m','Remaining two-term TDB model spread.'],
 ['coordsEcefCio','Public coords UTC-JD ECEF versus CIO','ERFA CIO with case EOP','mas','Remaining legacy budget: UT1-UTC, polar motion, frame bias and 1976/1980 versus 2006/2000A.'],
 ['coordsEcefSpice','Public coords UTC-JD ECEF versus SPICE','SPICE pxform J2000 -> ITRF93','mas','Legacy coords choices plus independent BPC reference spread.'],
 ['coordsVelocityRates','Neglected full-matrix derivative at GEO','Independent ERFA full-chain central difference, delta=1 s','m/s','10,000 epochs, all frame pairs/directions. Precession/nutation/equinox rates omitted by the documented Earth-rotation-only velocity contract. Includes central-difference rounding.'],
];
const rows=specs.map(([id,quantity,reference,unit,note])=>{if(!D.scores[id])throw new Error(`Missing C++ score ${id}`);return{id,quantity,reference,unit,note,...D.scores[id]};});
const row=id=>rows.find(r=>r.id===id);
row('c2tSpice').referenceSpreadBoundMas=row('c2tSpiceErfa').max;
row('c2tSpice').cause={classification:'reference spread',statement:row('c2tSpice').note,evidence:{spiceErfaMas:row('c2tSpiceErfa').max,hpopErfaMas:row('c2tTrue').max,source:'tools.json BPC comment; reference.py'}};
const files=new Map();const add=p=>{const absolute=path.resolve(here,p);if(fs.existsSync(absolute))files.set(absolute,{path:path.relative(here,absolute),sha256:hash(absolute)});};
for(const p of ['hpop-frames.json','reference.json','tools.json','diagnosis.json','before-after.json','classical-frames-10k.json','frame-diagnostics.cpp','frame-diagnostics.mjs','diagnose-frames.mjs','summarize-erfa-spice.mjs','check-erfa-spice.mjs','hpop_frames_native.cpp','hpop-frames-native.mjs','reference.py','run-erfa-spice.mjs','check-classical-frames.mjs','classical-frames.cpp','classical-frames-reference.py'])add(p);
for(const p of Object.keys(H.sources))add(path.join(root,p));
for(const p of ['propagator/hpop/dist/isomorphic/module.wasm','propagator/hpop/package.json','propagator/hpop/plugin-manifest.json','propagator/hpop/index.js','propagator/hpop/tests/evidence/cases/hpop-reference-cases.json'])add(path.join(root,p));
const erfa=path.join(root,'higherpop/third_party/erfa');for(const p of fs.readdirSync(erfa).sort())if((p.endsWith('.c')&&!['t_erfa_c.c','t_erfa_c_extra.c','erfaversion.c'].includes(p))||p.endsWith('.h'))add(path.join(erfa,p));
const cases=read(path.join(here,'../cases/hpop-reference-cases.json'));
const naif=process.env.XVAL_NAIF??'/Users/tj/software/tools/xval/naif-kernels';
const tools={...R.tools,naifKernels:Object.fromEntries(['naif0012.tls','earth_latest_high_prec.bpc'].map(p=>{add(path.join(naif,p));return[p,hash(path.join(naif,p))];})),de440:cases.models.ephemeris};add(path.join(root,cases.models.ephemeris.path));
const summary={about:'HPOP classical frames, two-part force clock and ephemeris reads against independent offline ERFA/SPICE references.',module:H.module,tools,epochs:H.epochs.length,rows,skipped:[],verdict:{statement:'Classical-frame and force-clock limits are enforced. The unchanged SPICE ITRF93 limit remains a recorded reference-spread miss. Untoleranced rows measure documented model choices.',rows:rows.length,met:rows.filter(r=>r.met===true).length,missed:rows.filter(r=>r.met===false).length,untoleranced:rows.filter(r=>r.met===null).length,misses:rows.filter(r=>r.met===false).map(r=>({id:r.id,max:r.max,unit:r.unit,tolerance:r.tolerance,classification:r.cause?.classification??'unresolved'})),defects:rows.filter(r=>r.met===false&&r.id!=='c2tSpice').map(r=>({source:r.id,effect:r.max}))},provenance:{sourceHashes:H.sources,measurement:{command:'node tests/evidence/erfa-spice/run-erfa-spice.mjs --flatbuffers /Users/tj/software/main-packages/flatbuffers/include',units:'angles mas; position differences/bounds metres; rates m/s',epochs:'50 UTC hourly samples; exact TT/UT1; rates diagnostic spans 1990–2040',radiiM:{LEO:6778137,GPS:26560000,GEO:42164170},toleranceRationale:'Precession 0.001 mas; classical ERFA identity 1e-7 mas (matrix rounding, <0.021 micrometre at GEO); CIO 0.022 mas includes 0.02 mas hourly CIP interpolation; kernel reads 1 mm. Model-spread rows are diagnostic, limits are not widened.'},e2e:{command:'node tests/evidence/erfa-spice/check-erfa-spice.mjs',replay:'Rebuild HPOP against final sources and rescore all 50 epochs against pinned reference.json in C++; assert four classical rows, c2tTrue and SGP4 TEME limits.'}},fileHashes:[...files.values()]};
fs.writeFileSync(path.join(here,'summary-erfa-spice.json'),JSON.stringify(summary,null,1)+'\n');
for(const r of rows)console.log(`${r.id}: ${r.max} ${r.unit}; ${r.met===null?'diagnostic':r.met?'met':'MISSED'}`);
console.log(`Summary: ${summary.verdict.met} met, ${summary.verdict.missed} missed, ${summary.verdict.defects.length} remaining defects.`);
