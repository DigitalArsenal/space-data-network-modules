// Exact-W comparisons use UTC civil seconds and integer nanoseconds.
#include <cstdint>
#include <cstdio>
#include <string>
namespace catalog_epoch {
constexpr int64_t tolerance_nanoseconds = 1000000;
struct Epoch {int64_t second=0;int64_t nanosecond=0;};
inline bool parse(const std::string& s, Epoch& value) {
 int y,m,d,h,mi,sec,at=0;
 if(std::sscanf(s.c_str(),"%4d-%2d-%2dT%2d:%2d:%2d%n",&y,&m,&d,&h,&mi,&sec,&at)!=6||m<1||m>12||d<1||d>31||h<0||h>23||mi<0||mi>59||sec<0||sec>=60)return false;
 int digits=0;value.nanosecond=0;
 if(s[at]=='.'){++at;while(s[at]>='0'&&s[at]<='9'){if(digits==9)return false;value.nanosecond=value.nanosecond*10+s[at++]-'0';++digits;}if(!digits)return false;}
 while(digits++<9)value.nanosecond*=10;
 if(s[at]=='Z')++at;if(size_t(at)!=s.size())return false;
 y-=m<=2;const int era=(y>=0?y:y-399)/400;const unsigned yy=y-era*400;
 const unsigned doy=(153*(m+(m>2?-3:9))+2)/5+d-1,doe=yy*365+yy/4-yy/100+doy;
 value.second=(int64_t(era)*146097+doe-719468)*86400+h*3600+mi*60+sec;return true;
}
inline bool matches(const std::string& seed,const std::string& actual,int64_t offset_seconds) {
 Epoch a,b;if(!parse(seed,a)||!parse(actual,b))return false;
 const auto delta=b.second-a.second-offset_seconds;if(delta < -1 || delta > 1)return false;
 const auto ns=delta*1000000000+b.nanosecond-a.nanosecond;
 return ns > -tolerance_nanoseconds && ns < tolerance_nanoseconds;
}
}
