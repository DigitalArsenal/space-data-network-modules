#include "od/operator_fit.h"
#include "od/meme_parser.h"
#include "OCM_generated.h"
#include "ocm_fb_builder.hpp"
namespace od {
// One fitted segment as an $OCM: the GCRF epoch state, the operator's covariance (or the formal one), the fitted
// effective ballistic coefficient and the fixed radiation-pressure area-to-mass ratio, and FIT_STATISTICS over the
// segment's samples. Empty bytes when the record cannot be written (the builder's refusal is the module's error).
std::vector<uint8_t> operator_ocm(const OperatorSegment& s,const OperatorFitOptions& opt,bool){
    ocm_fb::Record r;
    r.originator="SDN-OD";r.objectName=s.source.meta.object_name;r.internationalDesignator=s.source.meta.object_id;
    r.catalogName=std::to_string(s.source.meta.norad_cat_id);r.timeSystem="UTC";
    r.epoch=jd_to_iso_supgp(s.source.samples.front().epoch_jd);r.creationDate=r.epoch;
    r.state.assign(s.state.begin(),s.state.end());r.frame="GCRF";r.centerName="EARTH";
    if(s.has_operator_covariance)r.covariance.assign(s.operator_covariance.begin(),s.operator_covariance.end());
    else if(s.has_formal_covariance)r.covariance.assign(s.formal_covariance.begin(),s.formal_covariance.end());
    if(!r.covariance.empty()){
        r.covarianceFrame="GCRF";r.covType="CARTPV";r.ordering="LTM";r.covSize=6;r.covUnits={"km","km","km","km/s","km/s","km/s"};
        if(!s.has_operator_covariance)r.calibration=covarianceCalibration::Uncalibrated;
    }
    r.od.present=true;r.od.method="DIFFERENTIAL_CORRECTION";r.od.algorithm="FFM-1_FAST_LM_STATE_B_EFF";r.od.epoch=r.epoch;
    r.od.observationsUsed=s.source.samples.size();r.od.weightedRms=s.rms_km;
    r.od.covReduction=s.has_operator_covariance?"OPERATOR_RULE_1":s.has_formal_covariance?"FORMAL_UNWEIGHTED_NORMAL_EQUATIONS":"UNAVAILABLE";
    r.od.actualSpanDays=s.source.samples.back().epoch_jd-s.source.samples.front().epoch_jd;
    r.od.dynamicParameters={{prwDynamicParameter::DRAG_AREA_OVER_MASS,s.ballistic,"m**2/kg",true},{prwDynamicParameter::SRP_AREA_OVER_MASS,opt.srp_area_mass,"m**2/kg",false}};
    ocm_fb::Record::FitStatistics fit;
    fit.states=static_cast<uint32_t>(s.source.samples.size());fit.rmsKm=s.rms_km;fit.maximumKm=s.maximum_km;
    fit.iterations=s.iterations>0?static_cast<uint32_t>(s.iterations):0u;fit.converged=s.converged;
    fit.start=r.epoch;fit.stop=jd_to_iso_supgp(s.source.samples.back().epoch_jd);
    r.od.fit=fit;
    std::string refusal;
    return ocm_fb::build(r,&refusal);
}
}
