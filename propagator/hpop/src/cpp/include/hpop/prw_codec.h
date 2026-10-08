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
// ---------------------------------------------------------------------------
// The integration clock.
//
// HPOP integrates on TT. GCRS dynamics are written in TCG; TT = TCG (1 - L_G)
// with L_G = 6.969290134e-10 (IAU 2000 B1.9), so integrating in TT seconds
// requires the TT-compatible Earth GM (3.986004415e14 m^3/s^2 for EGM2008;
// the TCG-compatible value is 3.986004418e14). TDB, with its periodic
// TDB - TT terms, serves only the planetary-ephemeris lookups; UTC and UT1
// serve only Earth rotation.
//
// An epoch is held as TT seconds since J2000.0 TT (2000-01-01T12:00:00 TT) in
// an integral and a fractional part. A Julian date in one double resolves
// only about 40 microseconds near 2026 (0.3 m of LEO motion); the two parts
// keep elapsed time exact to well under a nanosecond.
// ---------------------------------------------------------------------------
struct TTEpoch {
    double whole = 0;     // integral TT seconds since J2000.0 TT
    double fraction = 0;  // [0, 1) seconds
    double jdTt() const { return 2451545.0 + (whole + fraction) / 86400.0; }
};
inline double elapsedSeconds(const TTEpoch& from, const TTEpoch& to) {
    return (to.whole - from.whole) + (to.fraction - from.fraction);
}
inline TTEpoch normalizeTT(double whole, double fraction) {
    const double carry = std::floor(fraction);
    TTEpoch out; out.whole = whole + carry; out.fraction = fraction - carry; return out;
}
// Days from the civil date to 2000-01-01 (proleptic Gregorian; H. Hinnant).
inline long long daysFromCivil(long long y, unsigned m, unsigned d) {
    y -= m <= 2;
    const long long era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + static_cast<long long>(doe) - 730425;  // 0 at 2000-01-01
}
inline void civilFromDays(long long z, int& y, int& m, int& d) {
    z += 730425;
    const long long era = (z >= 0 ? z : z - 146096) / 146097;
    const unsigned doe = static_cast<unsigned>(z - era * 146097);
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned mp = (5 * doy + 2) / 153;
    d = static_cast<int>(doy - (153 * mp + 2) / 5 + 1);
    m = static_cast<int>(mp < 10 ? mp + 3 : mp - 9);
    y = static_cast<int>(yoe + era * 400 + (m <= 2));
}
// "YYYY-MM-DDTHH:MM:SS[.f...][Z]" -> seconds of the named scale since
// 2000-01-01T12:00:00 of that scale, integral and fractional parts exact.
inline bool parseIsoSeconds(const std::string& iso, double& whole, double& fraction, double& jd, std::string& error) {
    const char* c = iso.c_str();
    auto digits = [&](size_t at, size_t n, int& v) {
        if (iso.size() < at + n) return false;
        v = 0; for (size_t i = at; i < at + n; ++i) { if (c[i] < '0' || c[i] > '9') return false; v = v * 10 + (c[i] - '0'); }
        return true;
    };
    int y, mo, d, h, mi, sec;
    if (!digits(0, 4, y) || c[4] != '-' || !digits(5, 2, mo) || c[7] != '-' || !digits(8, 2, d) || c[10] != 'T' ||
        !digits(11, 2, h) || c[13] != ':' || !digits(14, 2, mi) || c[16] != ':' || !digits(17, 2, sec))
        return prwError(error, "invalid-epoch: Expected ISO8601 YYYY-MM-DDTHH:MM:SS[.fraction][Z].");
    size_t at = 19; fraction = 0;
    if (at < iso.size() && c[at] == '.') {
        double scale = 0.1; ++at;
        if (at >= iso.size() || c[at] < '0' || c[at] > '9') return prwError(error, "invalid-epoch: Empty fractional seconds.");
        while (at < iso.size() && c[at] >= '0' && c[at] <= '9') { fraction += (c[at] - '0') * scale; scale *= 0.1; ++at; }
    }
    if (at < iso.size() && c[at] == 'Z') ++at;
    if (at != iso.size()) return prwError(error, "invalid-epoch: Trailing characters after the ISO8601 epoch.");
    const bool leap = (y % 4 == 0 && (y % 100 != 0 || y % 400 == 0));
    const int days[] = {31, 28 + int(leap), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (y < 1600 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > days[mo - 1] || h > 23 || mi > 59 || sec > 59)
        return prwError(error, "invalid-epoch: Calendar epoch out of range; leap-second text requires a dedicated timing provider.");
    whole = double(daysFromCivil(y, mo, d)) * 86400.0 + h * 3600.0 + mi * 60.0 + sec - 43200.0;
    jd = 2451545.0 + (whole + fraction) / 86400.0;
    return true;
}
// TDB - TT in seconds at a TT Julian date (time_convert's series).
inline double tdbMinusTtSeconds(double jdTt) { return (timesys::ttToTdb(jdTt) - jdTt) * 86400.0; }
// Seconds of `scale` -> TT epoch.
inline bool toTT(double whole, double fraction, double jdScale, timingStandard scale, TTEpoch& out, std::string& error) {
    if (!std::isfinite(jdScale) || jdScale < 2305447.5 || jdScale > 5373484.5)
        return prwError(error, "invalid-epoch: Epoch must be finite and within Gregorian years 1600 through 9999.");
    switch (scale) {
        case timingStandard::TT: out = normalizeTT(whole, fraction); return true;
        case timingStandard::TAI: out = normalizeTT(whole + 32.0, fraction + 0.184); return true;
        case timingStandard::UTC: {
            if (jdScale < 2441317.5) return prwError(error, "unsupported-time-scale: UTC before 1972 requires historical timing data.");
            out = normalizeTT(whole + double(timesys::getLeapSeconds(jdScale)) + 32.0, fraction + 0.184); return true;
        }
        case timingStandard::TDB: {
            // TT = TDB - (TDB - TT); the periodic term is evaluated at TT,
            // which differs from the TDB argument by milliseconds (negligible).
            const double dt = tdbMinusTtSeconds(jdScale);
            out = normalizeTT(whole, fraction - dt); return true;
        }
        default: return prwError(error, "unsupported-time-scale: This profile accepts explicitly tagged UTC, TAI, TT and TDB epochs.");
    }
}
inline bool decodeEpochTT(const TIMInstant* instant, TTEpoch& out, std::string& error) {
    if (!instant) return prwError(error, "invalid-epoch: Missing TIMInstant.");
    if (instant->EPOCH_LABEL() || instant->CCSDS_TIME_CODE() || instant->HAS_GNSS_ROLLOVER_REFERENCE() || instant->GNSS_WEEK())
        return prwError(error, "unsupported-time-representation: TIM auxiliary epoch controls are unsupported.");
    double whole = 0, fraction = 0, jd = 0;
    switch (instant->EPOCH_FORMAT()) {
        case timEpochRepresentation::ISO8601:
            if (!instant->ISO8601() || !parseIsoSeconds(instant->ISO8601()->str(), whole, fraction, jd, error)) return false;
            break;
        case timEpochRepresentation::JULIAN_DATE:
        case timEpochRepresentation::MODIFIED_JULIAN_DATE: {
            // A Julian date in one double carries its own ~40 us resolution.
            jd = instant->JULIAN_DATE() + (instant->EPOCH_FORMAT() == timEpochRepresentation::MODIFIED_JULIAN_DATE ? 2400000.5 : 0.0);
            const double days = std::floor(jd - 2451545.0);
            whole = days * 86400.0; fraction = (jd - 2451545.0 - days) * 86400.0;
            const double w = std::floor(fraction); whole += w; fraction -= w;
            break;
        }
        default: return prwError(error, "unsupported-time-representation: Use ISO8601 (exact) or a Julian date.");
    }
    if (instant->SUBSECOND_NANOS()) fraction += instant->SUBSECOND_NANOS() * 1e-9;
    return toTT(whole, fraction, jd, instant->TIME_SYSTEM(), out, error);
}
// TT epoch -> ISO8601 text on TDB with nine decimals (the PRW output scale).
inline std::string formatTdb(const TTEpoch& tt) {
    TTEpoch tdb = normalizeTT(tt.whole, tt.fraction + tdbMinusTtSeconds(tt.jdTt()));
    double seconds = tdb.whole + 43200.0;                 // since 2000-01-01T00:00
    const double days = std::floor(seconds / 86400.0);
    double sod = seconds - days * 86400.0;
    long long ns = static_cast<long long>(std::llround(tdb.fraction * 1e9));
    if (ns >= 1000000000LL) { ns -= 1000000000LL; sod += 1; }
    long long dayCount = static_cast<long long>(days);
    if (sod >= 86400.0) { sod -= 86400.0; ++dayCount; }
    int y, m, d; civilFromDays(dayCount, y, m, d);
    const int isod = static_cast<int>(sod);
    char out[48];
    std::snprintf(out, sizeof(out), "%04d-%02d-%02dT%02d:%02d:%02d.%09lld", y, m, d, isod / 3600, (isod / 60) % 60, isod % 60, ns);
    return out;
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
    if(scale!="TDB" && scale!="UTC" && scale!="TT")return prwError(error,"unsupported-time-scale: FRM state requires TDB, TT or UTC.");
    if(scale=="TT"){out.epoch=timesys::ttToTdb(jd);return true;}
    return convertEpoch(jd,scale=="TDB"?timingStandard::TDB:timingStandard::UTC,out.epoch,utc,error);
}
// The same state's epoch on the integration clock, exactly.
inline bool decodeStateEpochTT(const PRWResidentState* in, TTEpoch& out, std::string& error) {
    const auto* s=in->STATE();
    double whole=0,fraction=0,jd=0;
    if(!parseIsoSeconds(s->EPOCH()->str(),whole,fraction,jd,error))return false;
    const auto scale=s->EPOCH_TIME_SYSTEM()->str();
    return toTT(whole,fraction,jd,scale=="TDB"?timingStandard::TDB:scale=="TT"?timingStandard::TT:timingStandard::UTC,out,error);
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
