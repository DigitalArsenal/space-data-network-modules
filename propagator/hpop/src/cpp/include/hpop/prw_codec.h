#pragma once

#include <cmath>
#ifdef SING
#undef SING
#endif
#include "PRW_generated.h"
#include "astrodynamics_types.h"
#include "coords.h"
#include "time_convert.h"
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace hpop {
inline bool prwError(std::string& error, const char* message) { error = message; return false; }
inline bool verifyPrw(const uint8_t* data, size_t size, const PRW*& root, std::string& error) {
    if (!data || size < 12 || flatbuffers::ReadScalar<uint32_t>(data) != size - 4)
        return prwError(error, "invalid-prw: Expected one complete size-prefixed PRW record.");
    flatbuffers::Verifier verifier(data, size);
    if (!VerifySizePrefixedPRWBuffer(verifier))
        return prwError(error, "invalid-prw: PRW FlatBuffer verification failed.");
    root = GetSizePrefixedPRW(data);
    const unsigned arms = !!root->INIT() + !!root->BATCH_REQUEST() + !!root->BATCH_RESPONSE() +
        !!root->EXECUTION_REQUEST() + !!root->EXECUTION_RESULT() + !!root->RESIDENT_STATE() +
        !!root->RESIDENT_REQUEST() + !!root->PREPARE_REQUEST() + !!root->PREPARE_RESULT() +
        !!root->DESCRIBE_REQUEST() + !!root->DESCRIBE_RESULT() + !!root->NATIVE_INPUT() +
        !!root->EPHEMERIS_REQUEST() + !!root->EPHEMERIS_RESULT() + !!root->ATMOSPHERE_REQUEST() +
        !!root->ATMOSPHERE_RESULT() + root->VERSION_QUERY() + !!root->VERSION_RESULT();
    return arms == 1 || prwError(error, "invalid-prw-arm: Exactly one PRW payload arm is required.");
}
inline bool parseIsoEpoch(const std::string& iso, double& jd, std::string& error) {
    int y=0,mo=0,d=0,h=0,mi=0,n=0; double sec=0;
    if (std::sscanf(iso.c_str(), "%d-%d-%dT%d:%d:%lf%n", &y,&mo,&d,&h,&mi,&sec,&n) != 6 ||
        n < 19 || (iso.size() != size_t(n) && !(iso.size()==size_t(n+1) && iso[n]=='Z')) ||
        y < 1600 || y > 9999 || mo<1 || mo>12 || d<1 || d>31 || h<0 || h>23 || mi<0 || mi>59 ||
        !std::isfinite(sec) || sec<0 || sec>=60)
        return prwError(error, "invalid-epoch: Expected finite ISO8601 calendar epoch; leap-second text requires a dedicated timing provider.");
    const bool leap = (y%4==0 && (y%100!=0 || y%400==0));
    const int days[]={31,28+int(leap),31,30,31,30,31,31,30,31,30,31};
    if(d>days[mo-1]) return prwError(error,"invalid-epoch: Invalid calendar day.");
    jd=timesys::Epoch::fromComponents(y,mo,d,h,mi,sec,timesys::TimeScale::TDB).jd;
    return std::isfinite(jd) || prwError(error,"invalid-epoch: Invalid calendar epoch.");
}
inline std::string formatEpoch(double jd) {
    int y,m,d,h,mi; double s;
    timesys::Epoch(jd,timesys::TimeScale::TDB).toComponents(y,m,d,h,mi,s);
    char result[48]; std::snprintf(result,sizeof(result),"%04d-%02d-%02dT%02d:%02d:%012.9f",y,m,d,h,mi,s);
    return result;
}
inline bool convertEpoch(double jd, timingStandard scale, double& tdb, double& utc, std::string& error) {
    if(!std::isfinite(jd) || jd<2305447.5 || jd>5373484.5)
        return prwError(error,"invalid-epoch: Epoch must be finite and within Gregorian years 1600 through 9999.");
    if(scale == timingStandard::TDB) {tdb=jd;utc=timesys::taiToUtc(timesys::ttToTai(timesys::tdbToTt(jd)));return true;}
    if(scale == timingStandard::UTC) {
        if(jd<2441317.5) return prwError(error,"unsupported-time-scale: UTC before 1972 requires historical timing data.");
        utc=jd;tdb=timesys::ttToTdb(timesys::taiToTt(timesys::utcToTai(jd)));return true;
    }
    return prwError(error,"unsupported-time-scale: This profile accepts explicitly tagged UTC and TDB epochs.");
}
inline bool decodeEpoch(const TIMInstant* instant, double& tdb, double& utc, std::string& error) {
    if(!instant) return prwError(error,"invalid-epoch: Missing TIMInstant.");
    if(instant->EPOCH_LABEL() || instant->CCSDS_TIME_CODE() || instant->HAS_GNSS_ROLLOVER_REFERENCE() || instant->GNSS_WEEK())
        return prwError(error,"unsupported-time-representation: TIM auxiliary epoch controls are unsupported.");
    double jd=0;
    switch(instant->EPOCH_FORMAT()) {
        case timEpochRepresentation::JULIAN_DATE: jd=instant->JULIAN_DATE();break;
        case timEpochRepresentation::MODIFIED_JULIAN_DATE: jd=instant->JULIAN_DATE()+2400000.5;break;
        case timEpochRepresentation::ISO8601:
            if(!instant->ISO8601() || !parseIsoEpoch(instant->ISO8601()->str(),jd,error))return false;break;
        case timEpochRepresentation::UNIX_SECONDS:
            if(instant->TIME_SYSTEM()!=timingStandard::UTC)return prwError(error,"unsupported-time-representation: UNIX_SECONDS requires UTC.");
            jd=2440587.5+instant->SECONDS()/86400.0;break;
        default:return prwError(error,"unsupported-time-representation: Unsupported TIM epoch representation.");
    }
    jd+=instant->SUBSECOND_NANOS()/86400e9;
    return convertEpoch(jd,instant->TIME_SYSTEM(),tdb,utc,error);
}
inline bool decodeFrame(const RFMCoordinateSystem* frame, coords::Frame& result, std::string& error) {
    if(!frame || !frame->NAME() || frame->NAME()->size()==0 || !frame->ORIGIN())
        return prwError(error,"invalid-frame: A named coordinate system and explicit origin are required.");
    if(frame->ORIGIN()->KIND()!=rfmOriginKind::CELESTIAL_BODY || frame->ORIGIN()->CELESTIAL_BODY_ID()!=399)
        return prwError(error,"unsupported-frame: HPOP integration requires the Earth center (NAIF 399).");
    if(frame->OBJECT_REFERENCED_AXES() || frame->LOCAL_ALIGNED_CONSTRAINED_AXES() || frame->KERNEL_FRAME_NAME() || frame->KERNEL_FRAME_ID() || frame->EOP_DATA_SET_CID())
        return prwError(error,"unsupported-frame: Additional axis-definition controls are unsupported.");
    if(frame->AXIS_TYPE()==rfmAxisType::ICRF) {result=coords::Frame::GCRF;return true;}
    if(frame->AXIS_TYPE()==rfmAxisType::BODY_FIXED || frame->AXIS_TYPE()==rfmAxisType::TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE)
        return prwError(error,"eop-data-required: This invocation has no authoritative Earth orientation data for the requested axes.");
    return prwError(error,"unsupported-frame: This profile requires Earth-centered ICRF axes (GCRF).");
}
inline bool readVector(const FRMVector3* in, astro::Vec3& out, double scale, std::string& error) {
    if(!in || !std::isfinite(in->X()) || !std::isfinite(in->Y()) || !std::isfinite(in->Z()))
        return prwError(error,"invalid-state: Three finite vector components are required.");
    out=astro::Vec3(in->X()*scale,in->Y()*scale,in->Z()*scale);return true;
}
inline bool decodeResidentState(const PRWResidentState* in, astro::StateVector& out, std::string& error) {
    if(!in || !in->STATE())return prwError(error,"invalid-state: Missing FRM state.");
    coords::Frame frame;
    if(!decodeFrame(in->COORDINATE_SYSTEM(),frame,error))return false;
    const auto* s=in->STATE();
    if(s->REPRESENTATION()!=frmStateRepresentation::CARTESIAN || (s->ELEMENTS() && s->ELEMENTS()->size()))
        return prwError(error,"unsupported-state: Supply Cartesian POSITION and VELOCITY without duplicate ELEMENTS.");
    if(!s->COORDINATE_SYSTEM_NAME() || s->COORDINATE_SYSTEM_NAME()->str()!=in->COORDINATE_SYSTEM()->NAME()->str())
        return prwError(error,"invalid-frame: FRM state coordinate-system name must resolve to the supplied RFM.");
    if(!readVector(s->POSITION(),out.position,0.001,error) || !readVector(s->VELOCITY(),out.velocity,0.001,error))return false;
    if(!s->EPOCH() || !s->EPOCH_TIME_SYSTEM())return prwError(error,"invalid-epoch: FRM state requires explicit ISO epoch and time system.");
    double jd=0,utc=0;if(!parseIsoEpoch(s->EPOCH()->str(),jd,error))return false;
    const auto scale=s->EPOCH_TIME_SYSTEM()->str();
    if(scale!="TDB" && scale!="UTC")return prwError(error,"unsupported-time-scale: FRM state requires TDB or UTC.");
    return convertEpoch(jd,scale=="TDB"?timingStandard::TDB:timingStandard::UTC,out.epoch,utc,error);
}
inline std::unique_ptr<TIMInstantT> makeInstant(double jd,timingStandard scale=timingStandard::TDB) {
    auto out=std::make_unique<TIMInstantT>();out->TIME_SYSTEM=scale;out->EPOCH_FORMAT=timEpochRepresentation::JULIAN_DATE;out->JULIAN_DATE=jd;return out;
}
inline std::unique_ptr<RFMCoordinateSystemT> makeFrame(const std::string& name,rfmAxisType axes=rfmAxisType::ICRF,int origin=399) {
    auto out=std::make_unique<RFMCoordinateSystemT>();out->NAME=name;out->AXIS_TYPE=axes;out->ORIGIN=std::make_unique<RFMOriginT>();
    out->ORIGIN->KIND=origin==0?rfmOriginKind::BARYCENTRE:rfmOriginKind::CELESTIAL_BODY;
    out->ORIGIN->CELESTIAL_BODY_ID=origin;out->ORIGIN->BARYCENTRE_ID=origin;return out;
}
inline std::unique_ptr<FRMVector3T> makeVector(const astro::Vec3& v,double scale=1000) {
    auto out=std::make_unique<FRMVector3T>();out->X=v.x*scale;out->Y=v.y*scale;out->Z=v.z*scale;return out;
}
inline std::unique_ptr<PRWResidentStateT> makeState(const astro::StateVector& in,const RFMCoordinateSystemT& frame,const PRWResidentState* identity=nullptr) {
    auto out=std::make_unique<PRWResidentStateT>();out->STATE=std::make_unique<FRMStateVectorT>();out->COORDINATE_SYSTEM=std::make_unique<RFMCoordinateSystemT>(frame);
    out->STATE->REPRESENTATION=frmStateRepresentation::CARTESIAN;out->STATE->POSITION=makeVector(in.position);out->STATE->VELOCITY=makeVector(in.velocity);
    out->STATE->COORDINATE_SYSTEM_NAME=frame.NAME;out->STATE->EPOCH=formatEpoch(in.epoch);out->STATE->EPOCH_TIME_SYSTEM="TDB";
    if(identity){out->ENTITY_HANDLE=identity->ENTITY_HANDLE();out->CATALOG_NUMBER=identity->CATALOG_NUMBER();if(identity->OBJECT_ID())out->OBJECT_ID=identity->OBJECT_ID()->str();if(identity->INSTANCE())out->INSTANCE.reset(identity->INSTANCE()->UnPack());}
    return out;
}
inline void encodePrw(const PRWT& root,std::vector<uint8_t>& output) {
    flatbuffers::FlatBufferBuilder builder;FinishSizePrefixedPRWBuffer(builder,PRW::Pack(builder,&root));
    output.assign(builder.GetBufferPointer(),builder.GetBufferPointer()+builder.GetSize());
}
} // namespace hpop
