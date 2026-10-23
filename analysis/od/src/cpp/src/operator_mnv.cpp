#include "od/operator_fit.h"
#include "od/meme_parser.h"
#include "MNV_generated.h"
namespace od {
std::vector<uint8_t> operator_mnv(const OperatorManeuver& m,const StateSeriesMeta& meta){
    MNVT r;r.ID="SDN-OD-"+std::to_string(meta.norad_cat_id)+"-"+jd_to_iso_supgp(m.after_jd);
    r.SAT_NO=meta.norad_cat_id;r.ORIG_OBJECT_ID=meta.object_id;r.STATUS=maneuverStatus::DETECTED;
    r.CHARACTERIZATION=maneuverCharacterization::UNKNOWN;
    r.EVENT_START_TIME=jd_to_iso_supgp(m.before_jd);r.EVENT_END_TIME=jd_to_iso_supgp(m.after_jd);
    r.DELTA_VEL=m.velocity_km_s*1000;r.DELTA_POS=m.position_km*1000;
    r.ALGORITHM="FFM-1 Fast adjacent-state innovation";
    r.DESCRIPTION="Detected discontinuity; interval bounds, not a resolved burn epoch. Innovations in m and m/s; magnitude is not an estimated executed delta-v. Fit split at the first post-event sample.";
    r.SOURCED_DATA={meta.data_source};r.SOURCED_DATA_TYPES="operator ephemeris (transient)";
    flatbuffers::FlatBufferBuilder b;FinishSizePrefixedMNVBuffer(b,MNV::Pack(b,&r));return {b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()};
}
}
