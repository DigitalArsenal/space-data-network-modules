// Offline, independent geometry fixtures. No production classifier is included.
// Sun cases: Meeus ch. 25 low-precision solar longitude/radius (km, ICRF,
// J2000 TDB), independent of the production Standish EMB orbit. Threshold
// radial margins are >= 100,000 km except Earth exclusion (60,000 km).
// The 44/46 degree cone cases at 1,500,000 km have a 1-degree (~26,000 km)
// transverse margin, exceeding the solar approximation error near J2000
// (~10,000 km). Catalogs and run endpoints are exact discrete expectations;
// daily times below are elapsed TDB days from J2000 noon, with zero tolerance.
// Moon point: Meeus example 47.a, 1992-04-12 00:00 dynamical time:
// lambda=133.162655 deg, beta=-3.229126 deg, distance=368409.7 km.
// TT/TDB differences are immaterial at the 60,000 km classification radius.
// Body windows use constant Cartesian states (v=0), a closed-form geometry
// case. Boundaries have zero tolerance; no integration or orbit model is used.
#include <iomanip>
#include <sstream>

namespace fixture {
using Json = nlohmann::json;
constexpr double pi = 3.14159265358979323846, rad = pi/180, au = 149597870.7;
using Vec = std::array<double, 3>;
Vec rotate(double r, double lon, double lat) {
  const double x = r*std::cos(lat)*std::cos(lon), y = r*std::cos(lat)*std::sin(lon), z = r*std::sin(lat);
  return {x, y*std::cos(23.43928*rad)-z*std::sin(23.43928*rad), y*std::sin(23.43928*rad)+z*std::cos(23.43928*rad)};
}
Vec earth(int64_t seconds) {
  const double t = double(seconds)/(36525*86400.0);
  const double l = 280.46646 + 36000.76983*t + .0003032*t*t;
  const double m = (357.52911 + 35999.05029*t - .0001537*t*t)*rad;
  const double c = (1.914602 - .004817*t - .000014*t*t)*std::sin(m) +
      (.019993 - .000101*t)*std::sin(2*m) + .000289*std::sin(3*m);
  const double e = .016708634 - .000042037*t - .0000001267*t*t;
  const double radius = 1.000001018*(1-e*e)/(1+e*std::cos(m+c*rad))*au;
  return rotate(radius, (l+c+180 - (5029.0966*t+1.11113*t*t)/3600)*rad, 0);
}
Vec lunarL1() {
  double epoch; horizons::parseCalendar("1992-04-12T00:00:00", epoch);
  const double t = epoch/(36525*86400.0);
  return rotate(368409.7*.8369, (133.162655-(5029.0966*t+1.11113*t*t)/3600)*rad, -3.229126*rad);
}
Vec sunPosition(int64_t time, const std::string& regime) {
  Vec p = earth(time);
  if (regime == "sun-earth-l1" || regime == "sun-earth-l2") {
    const double r = std::sqrt(p[0]*p[0]+p[1]*p[1]+p[2]*p[2]);
    const double offset = regime == "sun-earth-l1" ? -1500000 : 1500000;
    for (double& v : p) v *= 1+offset/r;
  } else if (regime == "cislunar") p[2] += 200000;
  else if (regime == "heliocentric") p[2] += 5000000;
  return p;
}
Json group(int64_t start, int64_t step, int center, const std::vector<Vec>& rows, const char* label = "fixture") {
  std::string data;
  for (const auto& p : rows) packed_rows::append(data, {p[0],p[1],p[2],0,0,0});
  return {{"start",start}, {"stop", start+int64_t(rows.size()-1)*step}, {"step",step}, {"center",center},
      {"label",label}, {"data",data}, {"received",rows.size()}};
}
Json state(const Json& groups, int id, size_t archive = 0) {
  return {{"stage",1},{"planned",true},{"config",Json::object()},{"page_rows",80000},{"next",0},
      {"queue",Json::array()},{"pending",Json::array()}, {"craft",Json::array({{
        {"id",id},{"lo",groups[0]["start"].get<int64_t>()-86400},{"hi",groups.back()["stop"].get<int64_t>()+86400},
        {"groups",groups},{"archive_groups",archive},{"terminal",false}}})}};
}
Json cases() {
  Json out = Json::array();
  const auto body = [&](const char* label, int id, int center, std::vector<Vec> rows, const char* expected, int64_t start=0) {
    out.push_back({{"name",label}, {"expected",Json::array({expected})},
        {"state",state(Json::array({group(start,300,center,rows)}),id)}});
  };
  body("Moon maximum boundary",-85,301,{{30000,0,0},{30000,0,0}},"lunar-orbit");
  body("Moon maximum, not median",-85,301,{{1000,0,0},{30001,0,0},{1000,0,0}},"earth-moon-lagrange");
  body("Moon Lagrange boundary",-1176,301,{{120000,0,0},{120000,0,0}},"earth-moon-lagrange");
  body("Moon outer boundary",-192,301,{{120001,0,0},{120001,0,0}},"cislunar");
  body("Earth exclusion",-95,399,{{59999,0,0},{59999,0,0}},"dropped");
  body("Earth exclusion boundary",-95,399,{{60000,0,0},{60000,0,0}},"cislunar");
  double moonEpoch; horizons::parseCalendar("1992-04-12T00:00:00",moonEpoch);
  body("Published Meeus lunar L1 point",-95,399,{lunarL1(),lunarL1()},"earth-moon-lagrange",int64_t(moonEpoch));
  const int centers[] = {199,299,499,599,699}, ids[] = {-236,-248,-74,-61,-82};
  const double radii[] = {2439.7,6051.8,3389.5,69911,58232};
  const char* names[] = {"mercury-orbit","venus-orbit","mars-orbit","jupiter-orbit","saturn-orbit"};
  for (size_t i=0; i<5; ++i) {
    const double boundary = 100*radii[i];
    body(names[i],ids[i],centers[i],{{boundary-1,0,0},{boundary-1,0,0}},names[i]);
    body("Planet strict boundary",ids[i],centers[i],{{boundary,0,0},{boundary,0,0}},"heliocentric");
    body("Planet median ignores outlier",ids[i],centers[i],{{1000,0,0},{boundary*2,0,0},{1000,0,0}},names[i]);
  }
  // Closed-form offsets: +/-1.5 million km along the Earth-Sun axis are
  // L2/L1; a +200,000 km ICRF z offset is cislunar; +5 million km
  // is heliocentric. Expected spans follow elapsed durations, never output.
  const auto sun = [&](const char* name, const std::vector<std::string>& kinds,
                       const std::vector<std::string>& expected, const Json& spans) {
    std::vector<Vec> rows;
    for (size_t i=0; i<kinds.size(); ++i) rows.push_back(sunPosition(int64_t(i)*86400,kinds[i]));
    out.push_back({{"name",name},{"expected",expected},{"expected_spans",spans},
        {"state",state(Json::array({group(0,86400,10,rows,"daily")}),-170,1)}});
  };
  const auto sequence = [](std::initializer_list<std::pair<int,const char*>> runs) {
    std::vector<std::string> rows;
    for (const auto& run : runs) rows.insert(rows.end(),run.first,run.second);
    return rows;
  };
  for (const char* kind : {"dropped","cislunar","sun-earth-l1","sun-earth-l2","heliocentric"})
    sun(kind,std::vector<std::string>(41,kind),{kind},
        std::string(kind)=="dropped" ? Json::array() : Json::array({{kind,0,40}}));
  // A run ends at the next run's first row; a final run ends at its last row.
  sun("Three shared-edge segments",sequence({{25,"cislunar"},{40,"sun-earth-l1"},{41,"sun-earth-l2"}}),
      {"cislunar","sun-earth-l1","sun-earth-l2"},
      {{"cislunar",0,25},{"sun-earth-l1",25,65},{"sun-earth-l2",65,105}});
  for (int days : {2,15,19,20}) {
    const bool folds = days < 20;
    sun((std::to_string(days)+"-day launch leg").c_str(),sequence({{days,"cislunar"},{41,"sun-earth-l2"}}),
        folds ? std::vector<std::string>{"sun-earth-l2"} : std::vector<std::string>{"cislunar","sun-earth-l2"},
        folds ? Json::array({{"sun-earth-l2",0,days+40}}) : Json::array({{"cislunar",0,days},{"sun-earth-l2",days,days+40}}));
  }
  sun("Short middle run merges backward",sequence({{25,"heliocentric"},{2,"cislunar"},{41,"sun-earth-l2"}}),
      {"sun-earth-l2","heliocentric"},{{"heliocentric",0,27},{"sun-earth-l2",27,67}});
  sun("Short final run merges backward",sequence({{25,"heliocentric"},{3,"cislunar"}}),
      {"heliocentric"},{{"heliocentric",0,27}});
  sun("Three-day middle run survives",sequence({{25,"heliocentric"},{3,"cislunar"},{41,"sun-earth-l2"}}),
      {"cislunar","sun-earth-l2","heliocentric"},{{"heliocentric",0,25},{"cislunar",25,28},{"sun-earth-l2",28,68}});
  sun("Three-day final run survives",sequence({{25,"heliocentric"},{4,"cislunar"}}),
      {"cislunar","heliocentric"},{{"heliocentric",0,25},{"cislunar",25,28}});
  // Bound both cones by long heliocentric legs: a short pass cannot survive
  // simply because it is the only run. 29/30 days pin the exact dwell threshold.
  for (const char* cone : {"sun-earth-l1","sun-earth-l2"}) for (int days : {5,29,30,40}) {
    const bool survives = days >= 30;
    sun((std::to_string(days)+"-day dwell in "+cone).c_str(),
        sequence({{25,"heliocentric"},{days,cone},{31,"heliocentric"}}),
        survives ? std::vector<std::string>{cone,"heliocentric"} : std::vector<std::string>{"heliocentric"},
        survives ? Json::array({{"heliocentric",0,25},{cone,25,25+days},{"heliocentric",25+days,55+days}})
                 : Json::array({{"heliocentric",0,55+days}}));
  }
  // An independently published lunar point also exercises the Sun-centered EM rule.
  std::vector<Vec> sunLunar;
  for (int64_t time : {int64_t(moonEpoch),int64_t(moonEpoch)+600}) {
    auto p=earth(time); const auto l1=lunarL1();
    for (size_t i=0;i<3;++i) p[i]+=l1[i];
    sunLunar.push_back(p);
  }
  out.push_back({{"name","Sun window at published lunar L1"},{"expected",Json::array({"earth-moon-lagrange"})},
      {"state",state(Json::array({group(int64_t(moonEpoch),600,10,sunLunar)}),-170)}});
  for (const int direction : {-1,1}) for (const double angle : {44.0,46.0}) {
    std::vector<Vec> rows;
    for (int i=0;i<=40;++i) {
      auto p=earth(i*86400); const double r=std::sqrt(p[0]*p[0]+p[1]*p[1]+p[2]*p[2]);
      const double xy=std::hypot(p[0],p[1]);
      const Vec perpendicular={-p[1]/xy,p[0]/xy,0};
      // Orthonormal basis: |delta|=1,500,000 km and axis cosine=+/-cos(angle).
      for (size_t j=0;j<3;++j) p[j]+=1500000*(direction*std::cos(angle*rad)*p[j]/r+std::sin(angle*rad)*perpendicular[j]);
      rows.push_back(p);
    }
    const char* expected = angle<45 ? (direction<0 ? "sun-earth-l1" : "sun-earth-l2") : "heliocentric";
    out.push_back({{"name",std::to_string(int(angle))+" degree "+(direction<0 ? "sunward" : "outward")+" cone"},
        {"expected",Json::array({expected})},{"expected_spans",{{expected,0,40}}},
        {"state",state(Json::array({group(0,86400,10,rows,"daily")}),-170,1)}});
  }
  for (const double distance : {2400000.0,2600000.0}) {
    std::vector<Vec> rows;
    for (int i=0;i<=40;++i) {
      auto p=earth(i*86400); const double r=std::sqrt(p[0]*p[0]+p[1]*p[1]+p[2]*p[2]);
      for (double& v:p) v*=1+distance/r;
      rows.push_back(p);
    }
    out.push_back({{"name","Solar outer radius"},{"expected",Json::array({distance<2500000 ? "sun-earth-l2" : "heliocentric"})},
        {"state",state(Json::array({group(0,86400,10,rows,"daily")}),-170,1)}});
  }
  std::vector<Vec> daily,dense;
  const auto mixedPosition = [&](int64_t time) {
    return sunPosition(time,time<25*86400 ? "cislunar" : time<65*86400 ? "sun-earth-l2" : "heliocentric");
  };
  for (int i=0;i<=67;++i) daily.push_back(mixedPosition(i*86400));
  for (int64_t time=22*86400;time<=28*86400;time+=600) dense.push_back(mixedPosition(time));
  auto sparse=group(0,86400,10,daily,"daily"); std::string kept;
  for (size_t i=0;i<daily.size();++i) if (i<=22 || i>=28)
    packed_rows::append(kept,{daily[i][0],daily[i][1],daily[i][2],0,0,0});
  sparse["data"]=kept;
  out.push_back({{"name","Mixed daily and ten-minute rows"},{"expected",Json::array({"cislunar","sun-earth-l2"})},
      {"expected_spans",{{"cislunar",0,22},{"cislunar",22,25},{"sun-earth-l2",25,28},{"sun-earth-l2",28,67}}},
      {"state",state(Json::array({sparse,group(22*86400,600,10,dense,"encounter")}),-170,2)}});
  // One identity, two reference centers and two catalogs.
  std::vector<Vec> archive;
  for (int i=0;i<8;++i) archive.push_back(sunPosition(i*86400,"heliocentric"));
  out.push_back({{"name","Juno archive and phase"},{"expected",Json::array({"jupiter-orbit","heliocentric"})},
      {"state",state(Json::array({group(0,86400,10,archive,"daily"),group(0,600,599,{{100000,0,0},{100000,0,0}})}),-61,1)}});
  return out;
}
std::string page(const Json& query) {
  double a,b;
  horizons::parseCalendar(query["start"].get<std::string>(),a);
  horizons::parseCalendar(query["stop"].get<std::string>(),b);
  const int center = query["center"], id = query["id"], step = query["step"];
  std::ostringstream text;
  text << std::setprecision(17) << "Target body name: Synthetic (" << id << ")\nCenter body name: Synthetic (" << center
       << ")\nOutput units: KM-S\nReference frame: ICRF\nOutput type: GEOMETRIC cartesian states\n"
          "Output format: 2 (position and velocity)\nJDTDB, Calendar Date (TDB), X, Y, Z, VX, VY, VZ,\n$$SOE\n";
  for (int64_t t=int64_t(a); t<=int64_t(b); t+=step) {
    // Stationary relative geometry; Sun case is far from every Earth region.
    const Vec p = center==10 ? Vec{0,0,500000000} : Vec{100000,0,0};
    text << 2451545.0+double(t)/86400 << ", " << horizons::formatCalendar(t) << ", "
         << p[0] << ", " << p[1] << ", " << p[2] << ", 0, 0, 0,\n";
  }
  return text.str()+"$$EOE\n";
}
} // namespace fixture
extern "C" int make_fixture() {
  const auto* f = plugin_get_input_frame(0);
  const auto query = fixture::Json::parse(f->payload,f->payload+f->payload_length);
  const auto result = query.contains("id") ? fixture::Json(fixture::page(query)) : fixture::cases();
  const std::string text = result.dump();
  return plugin_push_output_ex("result",nullptr,nullptr,PLUGIN_PAYLOAD_WIRE_FORMAT_ALIGNED_BINARY,
      nullptr,0,1,reinterpret_cast<const uint8_t*>(text.data()),text.size()) < 0 ? 1 : 0;
}
