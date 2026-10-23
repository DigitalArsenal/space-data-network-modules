#include "od/operator_fit.h"
#include "od/meme_parser.h"
#include <sstream>
#include <iomanip>
#include "OCM_generated.h"
#include "ocm_fb_builder.hpp"
namespace od {
namespace {
std::string number(double x){std::ostringstream o;o<<std::setprecision(17)<<x;return o.str();}
template<class T> std::string values(const T& v){std::ostringstream o;o<<std::setprecision(17);for(size_t k=0;k<v.size();++k){if(k)o<<',';o<<v[k];}return o.str();}
}
std::vector<uint8_t> operator_ocm(const OperatorSegment& s,const OperatorFitOptions& opt,bool dca){
    ocm_fb::Record r;
    r.originator="SDN-OD";r.objectName=s.source.meta.object_name;r.internationalDesignator=s.source.meta.object_id;
    r.catalogName=std::to_string(s.source.meta.norad_cat_id);r.timeSystem="UTC";
    r.epoch=jd_to_iso_supgp(s.source.samples.front().epoch_jd);r.creationDate=r.epoch;
    r.state.assign(s.state.begin(),s.state.end());r.frame=r.covarianceFrame="GCRF";r.centerName="EARTH";
    if(s.has_operator_covariance)r.covariance.assign(s.operator_covariance.begin(),s.operator_covariance.end());
    else if(s.has_formal_covariance)r.covariance.assign(s.formal_covariance.begin(),s.formal_covariance.end());
    r.od.present=true;r.od.method="DIFFERENTIAL_CORRECTION";r.od.algorithm="FFM-1_FAST_LM_STATE_B_EFF";r.od.epoch=r.epoch;
    r.od.observationsUsed=s.source.samples.size();r.od.weightedRms=s.rms_km;
    r.od.covReduction=s.has_operator_covariance?"OPERATOR_RULE_1":s.has_formal_covariance?"FORMAL_UNWEIGHTED_NORMAL_EQUATIONS":"UNAVAILABLE";
    r.od.convergenceCriteria=s.converged?"converged":"iteration_limit_or_stall";
    r.od.residuals="position RMS="+number(s.rms_km)+" km; maximum="+number(s.maximum_km)+" km";
    r.od.dynamicParameters={{"DRAG_AREA_OVER_MASS",s.ballistic,"m**2/kg",true},{"SRP_AREA_OVER_MASS",opt.srp_area_mass,"m**2/kg",false}};
    r.user={{"B_EFF_M2_KG",number(s.ballistic)},{"B_EFF_DEFINITION","(1-kappa)*B; only B_eff is observable from one arc"},
      {"DENSITY_MODEL",dca?"NRLMSISE-00 * exp(DCL log density)":"NRLMSISE-00; DCL absent"},
      {"FIT_RMS_KM",number(s.rms_km)},{"FIT_MAXIMUM_KM",number(s.maximum_km)},
      {"FIT_RESIDUALS_KM",values(s.residuals_km)},{"FIT_END_UTC",jd_to_iso_supgp(s.source.samples.back().epoch_jd)},
      {"FIT_ITERATIONS",std::to_string(s.iterations)},{"SAMPLE_SECONDS",number(opt.sample_seconds)},
      {"SOURCE_FRAME",s.source.meta.source_frame},{"SOURCE",s.source.meta.data_source},
      {"COVARIANCE_RULE",s.has_operator_covariance?"1: operator supplied":"formal only; operator covariance unavailable"},
      {"FORMAL_COVARIANCE_FRAME","GCRF"},{"FORMAL_COVARIANCE_UNITS","products of km and km/s; lower triangular"},
      {"FORMAL_COVARIANCE_INTERPRETATION","unweighted fit uncertainty; not calibrated prediction uncertainty"},
      {"FIT_INTERPRETATION","operator forecast reproduction, not independent prediction accuracy"},
      {"NET_DRAG_BOUND","B_eff >= 0; boundary solutions are not unconstrained estimates"}};
    if(s.has_formal_covariance)r.user.push_back({"FORMAL_COVARIANCE_LTM",values(s.formal_covariance)});
    if(opt.ballistic_prior>0){r.user.push_back({"B_PRIOR_M2_KG",number(opt.ballistic_prior)});r.user.push_back({"KAPPA_GIVEN_B_PRIOR",number(1-s.ballistic/opt.ballistic_prior)});}
    return ocm_fb::build(r);
}
}
