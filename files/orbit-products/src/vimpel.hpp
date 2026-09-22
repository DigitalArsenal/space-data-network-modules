// Public Vimpel format, https://spacedata.vimpel.ru/en/ (2026-09-21).
// Parsing only: no access credentials, propagation, interpolation or covariance.
#ifndef SDN_VIMPEL_FORMAT_HPP
#define SDN_VIMPEL_FORMAT_HPP
#include <array>
#include <cmath>
#include <cstdlib>
#include <sstream>
#include <set>
#include <string>
#include <vector>
namespace sdn::vimpel {
inline std::string trim(const std::string& x) {
 const auto a=x.find_first_not_of(" \t\r\n"); return a==std::string::npos?"":x.substr(a,x.find_last_not_of(" \t\r\n")-a+1);
}
inline bool digits(const std::string& s) {return !s.empty() && s.find_first_not_of("0123456789")==std::string::npos;}
inline std::string identity(const std::string& s) {const auto p=s.find_first_not_of('0');return p==std::string::npos?"0":s.substr(p);}
inline bool numeric(const std::string& s,double& d) {
 if(s.empty() || s.size()>64 || s.find_first_not_of("0123456789.eE+-")!=std::string::npos)return false;
 char* end=nullptr;d=std::strtod(s.c_str(),&end);return end==s.c_str()+s.size() && std::isfinite(d);
}
inline bool epoch(const std::string& native,std::string& iso) {
 if(native.size()!=15 || native[8]!=' ' || !digits(native.substr(0,8)) || !digits(native.substr(9)))return false;
 auto n=[&](size_t p,size_t c){return std::atoi(native.substr(p,c).c_str());};
 const int y=n(4,4),m=n(2,2),d=n(0,2);int days[]={31,28,31,30,31,30,31,31,30,31,30,31};
 if(y<1900 || y>2200 || m<1 || m>12 || d<1 || n(9,2)>23 || n(11,2)>59 || n(13,2)>59)return false;
 if(y%4==0 && (y%100!=0 || y%400==0))days[1]=29;
 if(d>days[m-1])return false;
 iso=native.substr(4,4)+"-"+native.substr(2,2)+"-"+native.substr(0,2)+"T"+native.substr(9,2)+":"+native.substr(11,2)+":"+native.substr(13,2)+"Z";return true;
}
struct Elements {std::string nativeId,canonicalId,epoch; std::array<double,6> values;};
inline bool elements(const uint8_t* data,size_t length,std::vector<Elements>& out) {
 if(!data || !length || length>8*1024*1024)return false;
 const std::string source(reinterpret_cast<const char*>(data),length);
 if(source.find('\0')!=std::string::npos)return false;
 std::istringstream stream(source);std::string line;std::set<std::string> seen;
 while(std::getline(stream,line)) {
  if(trim(line).empty())continue;
  if(line.size()>1024 || out.size()>=20000)return false;
  std::vector<std::string> f;size_t a=0;
  for(size_t b=0;b<=line.size();++b)if(b==line.size() || line[b]==','){f.push_back(trim(line.substr(a,b-a)));a=b+1;}
  if(f.size()!=15 || !digits(f[0]) || !digits(f[1]) || f[1].size()>12 || identity(f[1])=="0")return false;
  Elements r;r.nativeId=f[1];r.canonicalId=identity(f[1]);std::string date;
  if((f[2]!="-" && !epoch(f[2]+" 000000",date)) || !epoch(f[3],r.epoch) || !seen.insert(r.canonicalId+"/"+r.epoch).second)return false;
  // Only columns 6..11 define the state. Other provider fields may contain
  // unknown markers (including -) and signed age sentinels; preserve them
  // in the original NCD, never coerce them into zero-valued measurements.
  for(size_t j=0;j<6;++j)if(!numeric(f[j+5],r.values[j]))return false;
  const auto& v=r.values;
  if(v[0]<=0 || v[1]<0 || v[1]>180 || v[2]<0 || v[2]>=360 || v[3]<0 || v[3]>=1 || v[4]<0 || v[4]>360 || v[5]<0 || v[5]>=360)return false;
  out.push_back(r);
 }
 return !out.empty();
}
struct Positions {std::string nativeId,epoch;std::vector<std::array<double,3>> rows;};
inline bool positions(const uint8_t* data,size_t length,const std::string& filename,Positions& out) {
 if(!data || !length || length>4*1024*1024)return false;
 const auto slash=filename.find_last_of('/');const auto name=filename.substr(slash==std::string::npos?0:slash+1);
 const auto sep=name.find('_');if(sep==std::string::npos || sep>12 || !digits(name.substr(0,sep)))return false;
 const auto stamp=name.substr(sep+1);
 if(stamp.size()!=15 || stamp[8]!='_' || !digits(stamp.substr(0,8)) || !digits(stamp.substr(9)))return false;
 out.nativeId=identity(name.substr(0,sep));
 if(out.nativeId=="0" || !epoch(stamp.substr(6,2)+stamp.substr(4,2)+stamp.substr(0,4)+" "+stamp.substr(9),out.epoch))return false;
 std::string source(reinterpret_cast<const char*>(data),length);
 if(source.find('\0')!=std::string::npos)return false;
 std::istringstream stream(source);std::string line;
 while(std::getline(stream,line)) {
  if(trim(line).empty())continue;
  if(line.size()>256 || out.rows.size()>=4096)return false;
  for(char& c:line)if(c==',')c=' ';
  std::istringstream row(line);std::array<std::string,4> fields;std::string extra;
  for(auto& f:fields)if(!(row>>f))return false;
  if(row>>extra || !digits(fields[0]) || fields[0].size()>6 || std::strtoul(fields[0].c_str(),nullptr,10)!=out.rows.size())return false;
  std::array<double,3> r;for(size_t j=0;j<3;++j)if(!numeric(fields[j+1],r[j]))return false;
  const double r2=r[0]*r[0]+r[1]*r[1]+r[2]*r[2];if(!std::isfinite(r2) || r2<=6356.7523*6356.7523)return false;
  out.rows.push_back(r);
 }
 return out.rows.size()>=5;
}
}
#endif
