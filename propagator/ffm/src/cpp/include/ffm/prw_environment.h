#pragma once
// The environment inputs of a propagation, as PRW records: Earth orientation
// (PRW.EARTH_ORIENTATION), daily space weather (PRW.SPACE_WEATHER) and the
// JB2008 drivers (PRW.JB2008_INDICES), each read as its model reads it.
#include "ffm/prw_codec.h"
#include "ffm/prw_execution.h"
#include "ffm/density_correction.h"
#include "astrodynamics.h"
#include "EOP_generated.h"
#include "OEM_generated.h"
extern "C" {
#include "erfa.h"
#include "erfam.h"
}
#include "axis_engine.hpp"
#include "eop_series.hpp"
#include <cmath>
#include <cstdio>
#include <limits>
#include <array>
#include <map>
#include <unordered_map>
#include <memory>
#include <string>
#include <vector>

namespace ffm {
namespace dynamics {
using namespace astro;

// GCRF -> ITRF at a two-part TT instant from caller-supplied EOP: IERS
// Conventions 2010, CIO based, IAU 2006/2000A with the EOP's dX/dY, polar
// motion and UT1 (the chain of foundation/frames gcrfToItrf). The CIP
// coordinates X, Y and the CIO locator s of the series are evaluated on whole
// hours of TT and interpolated linearly between them (within 0.02 mas of the
// series); the EOP corrections, polar motion and the Earth rotation angle are
// evaluated at every call. The rotation is a function of time alone, so a
// trajectory does not depend on what else the same tables served before it.
class EarthRotation {
public:
    std::vector<sdn::frames::eop::Row> rows;
    std::string error;
    static bool midnight(const char* date,double mjd) {
        int y=0,m=0,d=0,h=0,mi=0,n=0;double sec=0,jd0=0,day=0;
        if(std::sscanf(date,"%d-%d-%dT%d:%d:%lf%n",&y,&m,&d,&h,&mi,&sec,&n)!=6)return false;
        return !h&&!mi&&!sec&&eraCal2jd(y,m,d,&jd0,&day)==0&&day==mjd;
    }
    // UTC two-part Julian date through ERFA's leap-second table.
    static bool utcAt(const timesys::Instant& instant,double& u1,double& u2) {
        const auto utc=instant.utc();u1=utc.jd1;u2=utc.jd2;
        return std::isfinite(u1)&&std::isfinite(u2);
    }
    // The table's series checks run once (they parse every row's DATE);
    // every later read only brackets and interpolates.
    const std::string& validation() {
        if(!validated){validated=true;invalid=sdn::frames::eop::validate(rows,midnight);}
        return invalid;
    }
    bool covers(const timesys::Instant& instant) {
        double u1,u2;sdn::frames::EarthOrientation e;
        if(!utcAt(instant,u1,u2)){error="eop-out-of-range: Epoch outside the leap-second table.";return false;}
        std::string reason=validation();
        if(reason.empty())reason=sdn::frames::eop::atValidated(rows,u1,u2,&e);
        if(!reason.empty()){error="invalid-earth-orientation: "+reason;return false;}
        return true;
    }
    void matrix(const timesys::Instant& instant,double m[3][3]) {
        const double tt1=instant.jd1,tt2=instant.jd2;
        double u1,u2,ut11,ut12;sdn::frames::EarthOrientation e;
        if(!validation().empty()||!utcAt(instant,u1,u2)||!sdn::frames::eop::atValidated(rows,u1,u2,&e).empty()||eraUtcut1(u1,u2,e.dut1,&ut11,&ut12)<0) {
            for(int i=0;i<3;++i)for(int j=0;j<3;++j)m[i][j]=std::numeric_limits<double>::quiet_NaN();
            return;
        }
        const double fractionHours=tt2*24.0;
        const double k=(tt1-2451545.0)*24.0+std::floor(fractionHours),w=fractionHours-std::floor(fractionHours);
        const auto& a=cip(static_cast<long long>(k));const auto& b=cip(static_cast<long long>(k)+1);
        double rc2i[3][3],rpom[3][3];
        eraC2ixys(a[0]+w*(b[0]-a[0])+e.dX,a[1]+w*(b[1]-a[1])+e.dY,a[2]+w*(b[2]-a[2]),rc2i);
        eraPom00(e.xPole,e.yPole,eraSp00(tt1,tt2),rpom);
        double rc2t[3][3];eraC2tcio(rc2i,eraEra00(ut11,ut12),rpom,rc2t);
        for(int i=0;i<3;++i)for(int j=0;j<3;++j)m[i][j]=rc2t[i][j];
    }
    // UT1 two-part Julian date at this TT instant (NaN outside the table).
    timesys::Instant::Date ut1(const timesys::Instant& instant) {
        double u1,u2,a,b;sdn::frames::EarthOrientation e;
        if(!validation().empty()||!utcAt(instant,u1,u2)||!sdn::frames::eop::atValidated(rows,u1,u2,&e).empty()||eraUtcut1(u1,u2,e.dut1,&a,&b)<0)
            return {std::numeric_limits<double>::quiet_NaN(),0};
        return {a,b};
    }
private:
    // X, Y and s (IAU 2006/2000A, without the EOP's dX/dY) at hour k of TT
    // from J2000.0, kept once evaluated.
    const std::array<double,3>& cip(long long k) {
        const auto found=nodes.find(k);
        if(found!=nodes.end())return found->second;
        const double tt2=static_cast<double>(k)/24.0;double x,y;
        eraXy06(2451545.0,tt2,&x,&y);
        return nodes.emplace(k,std::array<double,3>{x,y,eraS06(2451545.0,tt2,x,y)}).first->second;
    }
    std::unordered_map<long long,std::array<double,3>> nodes;
    bool validated=false;std::string invalid;
};
inline bool positive(double x) {return std::isfinite(x)&&x>0;}
inline bool nonnegative(double x) {return std::isfinite(x)&&x>=0;}
// Daily space weather from PRW.SPACE_WEATHER ($SPW rows), read as
// NRLMSISE-00's driver reads its inputs at a UTC instant on day d: F10.7 is the
// observed flux of day d-1, F10.7a the 81-day centered average of observed flux
// on day d, Ap the daily Ap of day d, and Kp (the HWM14 storm winds) the
// three-hour Kp of the interval. These are also Orekit's
// CssiSpaceWeatherData readings for observed and daily-predicted rows. Each
// row is used as published (monthly predictions are not interpolated).
class SpaceWeatherTable {
public:
    struct Day {double f107Obs=0,f107ObsCentred81=0,apDaily=0,kp[8]{};};
    std::map<long,Day> days;  // by MJD (UTC)
    std::string error;
    // Empty string = success.
    std::string add(const flatbuffers::Vector<flatbuffers::Offset<SPW>>* rows) {
        if(!rows||rows->size()==0)return "No SPW rows.";
        long previous=0;bool first=true;
        for(const SPW* row:*rows) {
            int y=0,m=0,d=0;double jd0=0,mjd=0;
            if(!row->DATE()||std::sscanf(row->DATE()->c_str(),"%d-%d-%d",&y,&m,&d)!=3||eraCal2jd(y,m,d,&jd0,&mjd)!=0)return "SPW DATE must be an ISO 8601 calendar date.";
            const long day=long(mjd);
            if(!first&&day<=previous)return "SPW rows must have strictly increasing DATE.";
            first=false;previous=day;
            Day v;v.f107Obs=row->F107_OBS();v.f107ObsCentred81=row->F107_OBS_CENTER81();v.apDaily=row->AP_AVG();
            const int kp[8]={row->KP1(),row->KP2(),row->KP3(),row->KP4(),row->KP5(),row->KP6(),row->KP7(),row->KP8()};
            for(int i=0;i<8;++i)v.kp[i]=kp[i]/10.0;
            if(!positive(v.f107Obs)||!positive(v.f107ObsCentred81)||!nonnegative(v.apDaily))return "SPW F10.7 must be positive and Ap nonnegative.";
            for(const double k:v.kp)if(!nonnegative(k)||k>9)return "SPW Kp must be within 0 to 9.";
            days[day]=v;
        }
        return "";
    }
    // Model inputs at a UTC Julian date; false if a needed day is missing.
    bool at(double jdUtc,SpaceWeatherData& out) const {
        const double mjd=jdUtc-2400000.5;const long day=long(std::floor(mjd));
        const auto today=days.find(day),yesterday=days.find(day-1);
        if(today==days.end()||yesterday==days.end())return false;
        out.F107=yesterday->second.f107Obs;out.F107a=today->second.f107ObsCentred81;out.Ap=today->second.apDaily;
        const int slot=std::min(7,std::max(0,int((mjd-double(day))*8)));
        out.Kp=out.kp3h=today->second.kp[slot];out.epoch=jdUtc;
        // Jacchia-Roberts: Kp 6.7 h earlier, and the previous day's centered F10.7.
        out.f107aPreviousDay=yesterday->second.f107ObsCentred81;
        const double lagged=mjd-6.7/24.0;const long lagDay=long(std::floor(lagged));
        const auto kpDay=days.find(lagDay);
        if(kpDay==days.end())return false;
        out.kpLag67h=kpDay->second.kp[std::min(7,std::max(0,int((lagged-double(lagDay))*8)))];
        return true;
    }
    bool covers(double jdUtc) const {SpaceWeatherData w;return at(jdUtc,w);}
};
// JB2008 drivers from PRW.JB2008_INDICES, as Orekit 13.1's
// JB2008SpaceEnvironmentData reads SOLFSMY.TXT and DTCFILE.TXT: each day's
// solar indices stand at 12 UT of DATE (as SET reports them) and are
// interpolated linearly in time at the instant minus the model's lag (1 day
// for F10 and S10, 2 for M10, 5 for Y10, the centered values alike); DSTDTC
// is interpolated linearly between the hourly values (hour h of DATE at h:00
// UT), without lag. Rows must be consecutive days.
class JB2008IndicesTable {
public:
    struct Day {double f10,f10B,s10,s10B,m10,m10B,y10,y10B;};
    std::vector<Day> days;std::vector<double> dtc;long firstMjd=0;
    std::string add(const flatbuffers::Vector<flatbuffers::Offset<PRWJB2008Indices>>* rows) {
        if(!rows||rows->size()==0)return "No JB2008 rows.";
        for(const PRWJB2008Indices* row:*rows) {
            int y=0,m=0,d=0;double jd0=0,mjd=0;
            if(!row->DATE()||std::sscanf(row->DATE()->c_str(),"%d-%d-%d",&y,&m,&d)!=3||eraCal2jd(y,m,d,&jd0,&mjd)!=0)return "JB2008 DATE must be an ISO 8601 calendar date.";
            if(days.empty())firstMjd=long(mjd);
            else if(long(mjd)!=firstMjd+long(days.size()))return "JB2008 rows must be consecutive days.";
            const Day v{row->F10(),row->F10_CENTRED_81(),row->S10(),row->S10_CENTRED_81(),row->M10(),row->M10_CENTRED_81(),row->Y10(),row->Y10_CENTRED_81()};
            for(const double x:{v.f10,v.f10B,v.s10,v.s10B,v.m10,v.m10B,v.y10,v.y10B})if(!positive(x))return "JB2008 solar indices must be positive and finite.";
            if(!row->DTC_HOURLY_K()||row->DTC_HOURLY_K()->size()!=24)return "JB2008 DTC_HOURLY_K needs 24 hourly values.";
            for(const double x:*row->DTC_HOURLY_K()){if(!std::isfinite(x))return "JB2008 DTC values must be finite.";dtc.push_back(x);}
            days.push_back(v);
        }
        return "";
    }
    // Model inputs at a UTC Julian date; false outside the rows.
    bool at(double jdUtc,SpaceWeatherData& out) const {
        const double mjd=jdUtc-2400000.5;
        // Value at (mjd - lag), rows at firstMjd + k + 0.5.
        const auto sol=[&](double lag,double Day::*member,double& value){
            const double x=mjd-lag-(double(firstMjd)+0.5);
            const long k=long(std::ceil(x))-1;  // previous < x <= next
            if(k<0||k+1>=long(days.size()))return false;
            const double w=x-double(k);
            value=days[k].*member*(1-w)+days[k+1].*member*w;return true;
        };
        const double h=(mjd-double(firstMjd))*24.0;const long k=long(std::ceil(h))-1;
        if(k<0||k+1>=long(dtc.size()))return false;
        const double w=h-double(k);
        out.dTc=dtc[k]*(1-w)+dtc[k+1]*w;out.epoch=jdUtc;
        return sol(1,&Day::f10,out.F107)&&sol(1,&Day::f10B,out.F107a)&&sol(1,&Day::s10,out.S107)&&sol(1,&Day::s10B,out.S107a)&&
               sol(2,&Day::m10,out.M107)&&sol(2,&Day::m10B,out.M107a)&&sol(5,&Day::y10,out.Y107)&&sol(5,&Day::y10B,out.Y107a);
    }
    bool covers(double jdUtc) const {SpaceWeatherData w;return at(jdUtc,w);}
};

// The environment frames of one propagation request or resident instance,
// verified and read into their tables. `owned` holds copies of the frames the
// tables point into when they must outlive the invocation that supplied them.
// The second trajectory of a CLOSEST_APPROACH event: an OEM's samples, epochs on the TT clock.
struct SecondTrajectory {
    std::vector<TTEpoch> epoch;
    std::vector<std::array<double,6>> state;  // km, km/s, in the request's axes
};
struct Environment {
    std::shared_ptr<SecondTrajectory> secondTrajectory;
    std::shared_ptr<EarthRotation> earth;
    std::shared_ptr<SpaceWeatherTable> weather;
    std::shared_ptr<JB2008IndicesTable> jb2008;
    std::shared_ptr<DensityCorrection> densityCorrection;
    std::vector<std::shared_ptr<std::vector<uint8_t>>> owned;
};
// own: copy the frames first (a resident instance keeps them).
bool loadEnvironment(const PrwEnvironment& frames, bool own, Environment& out, std::string& error);

} // namespace dynamics
} // namespace ffm
