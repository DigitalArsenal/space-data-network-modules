// Discovery mirrors the pinned upstream registry, not similarly named feeds.
// All returned resources are credential-free replay descriptors.
#include <algorithm>
#include <functional>
#include <map>
#include <regex>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace ephemeris {
using Json = nlohmann::json;
using Fetch = std::function<std::string(const std::string&)>;
inline std::string& error_text(){static std::string value;return value;}
inline bool has_error(){return !error_text().empty();}
inline void clear_error(){error_text().clear();}
inline void record_error(const char* message){if(!has_error())error_text()=message;}
struct Failure {template<typename T> operator T() const {return T{};}};
#define require(condition,message) do { if(::ephemeris::has_error() || !(condition)){::ephemeris::record_error(message);return ::ephemeris::Failure{};} } while(false)
inline std::string trim(std::string s) {
  const auto a=s.find_first_not_of(" \r\n\t");
  return a==std::string::npos ? "" : s.substr(a,s.find_last_not_of(" \r\n\t")-a+1);
}
inline bool ends(const std::string& s,const std::string& suffix) {
  return s.size()>=suffix.size() && s.compare(s.size()-suffix.size(),suffix.size(),suffix)==0;
}
inline std::vector<std::string> lines(const std::string& text) {
  std::vector<std::string> result; size_t from=0;
  while(from<text.size()) { const auto end=text.find('\n',from); result.push_back(trim(text.substr(from,end-from))); if(end==std::string::npos)break; from=end+1; }
  return result;
}
inline std::string basename(const std::string& s) { return s.substr(s.find_last_of('/')+1); }
inline std::string html_decode(std::string s) {
  for(size_t p=0;(p=s.find("&amp;",p))!=std::string::npos;)s.replace(p,5,"&");
  return s;
}
inline std::vector<std::string> matches(const std::string& text,const std::string& pattern,size_t group=1) {
  std::regex re(pattern,std::regex::icase); std::vector<std::string> result;
  for(std::sregex_iterator i(text.begin(),text.end(),re),end;i!=end;++i) {
    require(result.size()<100000,"Discovery listing exceeds the resource limit.");
    result.push_back(html_decode((*i)[group].str()));
  }
  return result;
}
inline std::string origin(const std::string& url) {
  const auto start=url.find("://"); require(start!=std::string::npos,"Invalid upstream URL.");
  const auto end=url.find('/',start+3); return url.substr(0,end);
}
inline bool validate_url(const Json& source,const std::string& url) {
  require(source.is_object() && source.contains("origins") && source["origins"].is_array(),"Invalid source origin policy.");
  require(url.size()<=4096 && url.find_first_of("\r\n\t\\") == std::string::npos,"Invalid upstream URL.");
  require(url.find("/../")==std::string::npos && url.find("/./")==std::string::npos && url.find('#')==std::string::npos,"Unsafe upstream path.");
  const auto host=origin(url); bool allowed=false;
  for(const auto& entry:source["origins"]) if(entry==host)allowed=true;
  require(allowed,"Discovered URL is outside the source's permitted origins.");return true;
}
inline Json resource(const Json& source,const std::string& url,const std::string& format="",const std::string& id="") {
  require(validate_url(source,url),"Invalid resource URL.");
  return {{"source_id",source["source_id"]},{"resource_id",id.empty()?basename(url):id},{"url",url},
    {"format",format.empty()?source["format"].get<std::string>():format}};
}
inline std::string newest(const std::string& html,const std::vector<std::string>& prefixes,const std::string& suffix) {
  const auto names=matches(html,"href\\s*=\\s*[\"']([^\"']+)[\"']");
  for(const auto& prefix:prefixes) {
    std::string best;
    for(const auto& path:names) { const auto name=basename(path); if(name.rfind(prefix,0)==0 && ends(name,suffix) && name>best) best=name; }
    if(!best.empty()) return best;
  }
  return "";
}
// First-round request plan for browser orchestration. Replies are keyed by URL
// and supplied to discover_sources; orbital interpretation stays downstream.
inline Json initial_requests(const Json& source,int64_t epoch) {
  const auto id=source["source_id"].get<std::string>();Json urls=Json::array();
  if(id=="spacex-starlink")urls.push_back("https://api.starlink.com/public-files/ephemerides/MANIFEST.txt");
  else if(id=="ses")urls.push_back("https://www.ses.com/network-and-technology/technical-data-and-tools/satellite-orbital-data");
  else if(id=="intelsat")urls.push_back("https://my.intelsat.com/ephemeris/public");
  else if(id=="telesat")urls.push_back("https://app.telesat.com/data/FleetLong.csv");
  else if(id=="css-tiangong")urls.push_back("https://www.cmse.gov.cn/gfgg/zgkjzgdcs/");
  else if(id=="eumetsat")urls.push_back("https://service.eumetsat.int/tle/");
  else if(id=="cpf")urls.push_back("http://navigation-office.esa.int/products/cpf_predictions/");
  else if(id=="gps-precise" || id=="glonass-precise" || id=="esa-pod") {
    const int64_t week=(epoch-315964800)/(7*86400);const std::string base=id=="gps-precise"?"https://igs.bkg.bund.de/root_ftp/IGS/products/":"http://navigation-office.esa.int/products/gnss-products/";
    urls.push_back(base+std::to_string(week)+"/");urls.push_back(base+std::to_string(week-1)+"/");
    if(id=="esa-pod"){urls.push_back("http://navigation-office.esa.int/products/swarm/");urls.push_back("http://navigation-office.esa.int/products/cryosat2/");}
  } else require(!source["credentialed"].get<bool>(),"Authenticated discovery requires its restricted adapter.");
  Json out=Json::array();for(const auto& url:urls){validate_url(source,url);out.push_back({{"url",url},{"method","GET"}});}return out;
}
inline Json discover_public(const Json& source,int64_t epoch,const Fetch& fetch) {
  const auto id=source["source_id"].get<std::string>(); Json out=Json::array();
  auto add=[&](const std::string& url,const std::string& format="",const std::string& name="") { out.push_back(resource(source,url,format,name)); };
  if(id=="spacex-starlink") {
    const std::string base="https://api.starlink.com/public-files/ephemerides/";
    for(const auto& name:lines(fetch(base+"MANIFEST.txt"))) if(ends(name,".txt")) {
      require(name.find('/')==std::string::npos && name.find('?')==std::string::npos,"Invalid Starlink manifest filename."); add(base+name);
    }
  } else if(id=="eutelsat-oneweb") add("https://ephemeris.oneweb.net/ltef/ltef.csv");
  else if(id=="planet") { add("https://ephemerides.planet-labs.com/planet.states"); add("https://ephemerides.planet-labs.com/planet_mc.tle","tle"); }
  else if(id=="iss") add("https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt");
  else if(id=="ses") {
    const auto html=fetch("https://www.ses.com/network-and-technology/technical-data-and-tools/satellite-orbital-data");
    for(const auto& url:matches(html,"href\\s*=\\s*[\"']([^\"']+)[\"']"))
      if(url.find("ses-satellite-orbital-data-public")!=std::string::npos && url.find("/ephemeris/")!=std::string::npos && ends(url,".I11"))add(url);
  } else if(id=="intelsat") {
    const auto html=fetch("https://my.intelsat.com/ephemeris/public");
    for(const auto& name:matches(html,"<option[^>]*\\bvalue\\s*=\\s*[\"']([^\"']+)[\"']")) if(name.find("_e_")!=std::string::npos) {
      require(name.find_first_of("/?#")==std::string::npos,"Invalid Intelsat filename."); add("https://my.intelsat.com/Resource/Ephemeris/"+name+".txt");
    }
  } else if(id=="telesat") {
    const auto csv=lines(fetch("https://app.telesat.com/data/FleetLong.csv"));
    for(size_t i=1;i<csv.size();++i) {const auto name=trim(csv[i].substr(0,csv[i].find(',')));if(name.empty())continue;
      require(name.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-. ")==std::string::npos,"Invalid Telesat filename.");
      std::string escaped;for(char c:name)escaped+=c==' '?"%20":std::string(1,c);add("https://app.telesat.com/data/"+escaped+".C.csv");}
  } else if(id=="css-tiangong") {
    const std::string base="https://www.cmse.gov.cn/gfgg/zgkjzgdcs/";
    const auto zips=matches(fetch(base),"\\./([0-9]{6}/W[0-9]+\\.zip)"); if(!zips.empty())add(base+zips.front());
  } else if(id=="gps-precise" || id=="glonass-precise" || id=="esa-pod") {
    const int64_t week=(epoch-315964800)/(7*86400); require(week>0 && week<10000,"Invalid GPS discovery week.");
    const std::string base=id=="gps-precise"?"https://igs.bkg.bund.de/root_ftp/IGS/products":"http://navigation-office.esa.int/products/gnss-products";
    const std::vector<std::string> prefixes=id=="gps-precise"?std::vector<std::string>{"IGS0OPSULT","IGS0OPSRAP"}:
      id=="glonass-precise"?std::vector<std::string>{"ESA0OPSULT","ESA0OPSRAP"}:std::vector<std::string>{"ESA0MGNFIN","ESA0OPSRAP","ESA0OPSULT"};
    bool gnss=false;
    for(int offset=0;offset<2;++offset) {
      const auto dir=base+"/"+std::to_string(week-offset)+"/"; std::string html;
      html=fetch(dir);
      const auto name=newest(html,prefixes,"_ORB.SP3.gz");if(!name.empty()){add(dir+name);gnss=true;break;}
    }
    require(gnss,"No current or previous-week GNSS orbit product was discovered.");
    if(id=="esa-pod") {
      const std::string base="http://navigation-office.esa.int/products/";
      const auto swarm=newest(fetch(base+"swarm/"),{"SWRAesoc"},".sp3.gz");
      require(!swarm.empty(),"ESA Swarm product was not discovered.");add(base+"swarm/"+swarm);
      const auto cryoHtml=fetch(base+"cryosat2/");auto cryo=newest(cryoHtml,{""},".cs2.v4.sp3.gz");
      if(cryo.empty())cryo=newest(cryoHtml,{""},".cs2.v3.sp3.gz");require(!cryo.empty(),"ESA CryoSat product was not discovered.");add(base+"cryosat2/"+cryo);
    }
  } else if(id=="eumetsat") {
    const auto html=fetch("https://service.eumetsat.int/tle/");
    for(const auto& name:matches(html,"data_content_([a-z0-9]+)\\.js"))add("https://service.eumetsat.int/tle/javascript/data_content_"+name+".js");
  } else if(id=="cpf") {
    const std::string base="http://navigation-office.esa.int/products/cpf_predictions/";
    const auto html=fetch(base);const std::regex re("([a-z0-9]+)_cpf_([0-9]{6})_([0-9]+)\\.esa",std::regex::icase);
    std::map<std::string,std::tuple<std::string,uint64_t,std::string>> best;
    for(std::sregex_iterator i(html.begin(),html.end(),re),end;i!=end;++i) {
      const auto target=(*i)[1].str(),date=(*i)[2].str(); const auto seq=std::stoull((*i)[3].str());
      auto& old=best[target]; if(std::make_pair(date,seq)>std::make_pair(std::get<0>(old),std::get<1>(old)))old={date,seq,(*i)[0].str()};
    }
    for(const auto& entry:best)add(base+std::get<2>(entry.second));
  } else {record_error("This source requires the restricted credential adapter.");return Json();}
  require(!out.empty(),"Upstream discovery returned no resources; this is not a successful empty feed.");
  require(out.size()<=100000,"Discovery resource limit exceeded.");
  std::map<std::string,Json> unique;for(const auto& item:out)unique[item["url"].get<std::string>()]=item;
  out=Json::array();for(const auto& entry:unique)out.push_back(entry.second);
  return out;
}
}
