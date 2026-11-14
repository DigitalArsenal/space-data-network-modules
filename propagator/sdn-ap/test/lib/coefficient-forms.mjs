// Synthetic fitted elements and their coefficient-boundary regression bounds.
// Source: numerical synthetic flights, sampled at 300 s over 0–120 h; TEME meters.
// Bounds round the measured maxima upward. These compare evaluation of the same
// theory at state elements with its cached forms, not an independent orbit truth.
import fs from 'node:fs';
import {ocmOf} from './ocm.mjs';
import {buildDiagnostic} from './ap-diagnostic.mjs';
export const cases = [
 ['near-circular 190 km',3,.016,.0034,1.6],
 ['near-circular 300 km',3,.018,.0003,.017],
 ['near-circular 300 km e 0.001',3,.016,.0003,.016],
 ['near-circular 400 km',3,.011,.0002,.011],
 ['near-circular 500 km',3,.0033,.0002,.0028],
 ['near-circular 650 km',2,.011,.0006,.014],
 ['near-circular 800 km',2,.0025,.0003,.0043],
 ['medium orbit',0,.00003,.00015,0],
 ['geosynchronous',2,.00013,.0001,.00013],
 ['strong drag e 0.1',1,.008,.016,2.0],
 ['strong drag e 0.1 polar',1,.0036,.0063,.65],
 ['strong drag e 0.05',1,.0043,.009,.0044],
 ['eccentric e 0.5',1,.0035,.0056,.05],
 ['eccentric e 0.3 low',1,.0022,.0044,.0028],
 ['eccentric e 0.3',1,.0059,.0126,.11],
 ['deep resonance',4,.0052,.0085,2.1],
 ['eccentric e 0.7',1,.0027,.0018,.001],
];
export function records() {
 const stream=fs.readFileSync(new URL('../fixtures/coefficient-forms.fsdata',import.meta.url)), out=[];
 for(let at=0;at<stream.length;){const n=stream.readUInt32LE(at);at+=4;if(n<=0||at+n>stream.length)throw Error('Invalid fixture frame');const bytes=stream.subarray(at,at+n),record=ocmOf(bytes);out.push({bytes,epochMs:Date.parse(record.MEAN_ELEMENTS.EPOCH.replace(/Z?$/,'Z'))});at+=n;}
 if(out.length!==cases.length)throw Error('Fixture count differs');return out;
}
const change=(s,a,b)=>{if(!s.includes(a))throw Error(`Missing coefficient test seam: ${a.slice(0,60)}`);return s.replace(a,b);};
export const probeTheory=s=>{
 s=change(s,'  if (an.valid && an.id == id && an.tlo == lo.t && an.h == hi.t - lo.t) return;',
 '  if (an.valid && an.id == id && an.tlo == lo.t && an.h == hi.t - lo.t) { tess::g_test_anchor_copy = an; return; }');
 s=change(s,'  an.h = hi.t - lo.t;\n  an.valid = true;\n}', '  an.h = hi.t - lo.t;\n  an.valid = true;\n  tess::g_test_anchor_copy = an;\n}');return s;
};
export const probeTesseral=s=>{
 s=change(s,'inline thread_local SpAnchor g_sp_anchor{};', 'inline thread_local SpAnchor g_sp_anchor{};\ninline thread_local SpAnchor g_test_anchor_copy{};\ninline thread_local int g_test_form = -1;');
 return s.replaceAll('uint8_t form, Args&&... args) {','uint8_t form, Args&&... args) {\n  g_test_form = form;');
};
export const probeExports=`
SDNAP_EXPORT("sdnap_test_form") int sdnap_test_form() { return sdnap::xpt::tess::g_test_form; }
SDNAP_EXPORT("sdnap_test_levels") int sdnap_test_levels(double* o) {
 const auto& an = sdnap::xpt::tess::g_test_anchor_copy;
 const auto& levels = sdnap::xpt::tess::g_sp_anchor_levels;
 o[0] = an.valid ? 1 : 0; o[1] = an.tlo; o[2] = an.h;
 const int n = levels.id == an.id && levels.tlo == an.tlo && levels.h == an.h ? levels.count : 0;
 for (int j = 0; j < n; ++j) o[3 + j] = levels.lv[j].n;
 return n;
}
SDNAP_EXPORT("sdnap_test_thread_derivative_bytes") int sdnap_test_thread_derivative_bytes() {
 return sdnap::xpt::tess::g_mdaily_thread_derivatives == nullptr ? 0 : sizeof(sdnap::xpt::tess::MdailyDerivatives);
}
`;
export const exactCoefficients=s=>{
 s=change(s,'  const bool full = table_id == 0 ||','  a_full = a_state; e2_full = e2_state; a_part = a_state;\n  const bool full = true || table_id == 0 ||');
 s=change(s,'  const bool fresh = !sc.keys_valid ||','  a_b = a; e_b = e; ci_b = ci; a_ae = a; e_ae = e; e_pe = e;\n  const bool fresh = true || !sc.keys_valid ||');
 s=change(s,'    const double n_r =','    a_r = a; e_r = e; ci_r = ci;\n    const double n_r =');
 for(const name of ['md_keys_hold','sp_keys_hold']){
  const pattern=new RegExp('(inline bool '+name+'[^\\{]*\\{)');
  if(!pattern.test(s))throw Error('Missing key probe');s=s.replace(pattern,'$1\n  return false;');
 }
 return s;
};
export function buildForms() {
 const production=process.env.SDNAP_WASM??buildDiagnostic('coefficient-forms-production','');
 const probe=buildDiagnostic('coefficient-forms-probe',probeExports,probeTheory,{'tesseral.inc':probeTesseral});
 const full=buildDiagnostic('coefficient-forms-full','',s=>s,{'tesseral.inc':s=>'#define SDNAP_CONTINUITY_RULE 0\n'+s});
 const exact=buildDiagnostic('coefficient-forms-exact','',s=>s,{'tesseral.inc':s=>'#define SDNAP_CONTINUITY_RULE 0\n'+s,'coefficient_evaluation.inc':exactCoefficients});
 return {production,probe,full,exact};
}
