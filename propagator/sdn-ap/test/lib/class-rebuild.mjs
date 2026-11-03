// Registered alternative for task 3: re-create every AP coefficient table from
// the current elements whenever the instantaneous class differs from the epoch.
// Test-only build; no production ABI or fit behavior is changed.
import {buildDiagnostic,CLASS_PROBE} from './ap-diagnostic.mjs';
export function buildReclassification(){
 return buildDiagnostic('class-rebuild',CLASS_PROBE.replace('ap_resonance_class(s.ctx,y[kN])','res::band_of(y[kN])'),s=>{
  s=s.replace('inline bool rates(const RateContext& ctx, double t, const double* y, double* out) {',`inline bool reclass_rates(const RateContext&,double,const double*,double*);
inline int32_t reclass_output(const RateContext&,double,const double*,double*,double*,const Bodies*);
inline bool rates(const RateContext& ctx, double t, const double* y, double* out) {
  if(ctx.ap_resonance && res::band_of(y[kN])!=ctx.resonance)return reclass_rates(ctx,t,y,out);`);
  s=s.replace('const Bodies* shared) {\n  if (!(ym[kN] > 0.0))',`const Bodies* shared) {
  if(ctx.ap_resonance && res::band_of(ym[kN])!=ctx.resonance)return reclass_output(ctx,t,ym,r_out,v_out,shared);
  if (!(ym[kN] > 0.0))`);
  const extra=String.raw`
inline bool reclass_make(const RateContext& ctx,const double* y,XpSat& tmp){
 const Kepler k=kepler_of(y);tmp=XpSat{};tmp.ctx=ctx;
 tmp.ctx.res_epoch=nullptr;tmp.ctx.res_count=0;tmp.ctx.res_taylor=nullptr;
 tmp.ctx.half_day=nullptr;tmp.ctx.half_day_count=0;tmp.ctx.shallow=nullptr;tmp.ctx.shallow_count=0;
 tmp.ctx.zt=nullptr;tmp.ctx.mdaily=nullptr;tmp.ctx.sp=nullptr;tmp.ctx.sp_count=0;
 tmp.ctx.resonance=res::band_of(y[kN]);tmp.ctx.e0=k.e;tmp.ctx.i0=k.i;
 Elements e{};e.eo=k.e;e.xincl=k.i;
 const tess::Terms previous=tess::active();tess::active()=tess::Terms{31,20};
 const bool ok=ap_init(e,y[kN],tmp.ctx.resonance,tmp);tess::active()=previous;
 return ok;
}
inline bool reclass_rates(const RateContext& ctx,double t,const double* y,double* out){
 XpSat tmp{};const bool made=reclass_make(ctx,y,tmp);
 const bool ok=made&&rates(tmp.ctx,t,y,out);xp_release(tmp);return ok;
}
inline int32_t reclass_output(const RateContext& ctx,double t,const double* y,double* r,double* v,const Bodies* shared){
 XpSat tmp{};const bool made=reclass_make(ctx,y,tmp);
 const int32_t rc=made?output(tmp.ctx,t,y,r,v,shared):kPropRefused;xp_release(tmp);return rc;
}
`;
  return s.replace('}  // namespace xpt',extra+'\n}  // namespace xpt');
 });
}
if(process.argv[1]===new URL(import.meta.url).pathname)console.log(buildReclassification());
