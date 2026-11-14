// Exact-W comparisons share an unrounded UTC epoch and a strict tolerance.
#include <cmath>
#include <cstdio>
#include <string>
namespace catalog_epoch {
constexpr long double tolerance_seconds = 0.001L;
inline bool seconds(const std::string& s, long double& value) {
 int y,m,d,h,mi;double sec;
 if(std::sscanf(s.c_str(),"%4d-%2d-%2dT%2d:%2d:%lf",&y,&m,&d,&h,&mi,&sec)!=6||m<1||m>12||d<1||d>31||h<0||h>23||mi<0||mi>59||!std::isfinite(sec)||sec<0||sec>=60)return false;
 y-=m<=2;const int era=(y>=0?y:y-399)/400;const unsigned yy=y-era*400;
 const unsigned doy=(153*(m+(m>2?-3:9))+2)/5+d-1,doe=yy*365+yy/4-yy/100+doy;
 value=(static_cast<long double>(era)*146097+doe-719468)*86400+h*3600+mi*60+sec;return true;
}
inline bool matches(const std::string& seed,const std::string& actual,long double offset) {
 long double a,b;return seconds(seed,a)&&seconds(actual,b)&&std::abs((b-a)-offset)<tolerance_seconds;
}
}
