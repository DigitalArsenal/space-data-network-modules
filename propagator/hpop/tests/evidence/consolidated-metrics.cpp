// Independent reductions for check-all: no propagation or physics in JavaScript.
// Sources: pinned per-tool summaries and the 72-case export. Position units are
// metres, GCRF (EME2000 where exported), at each exported UTC epoch over 24 h.
// Limits come from protocol.tolerancesM; row-based evidence retains its own
// published printing / frame / ephemeris limits and rationale. Equality is
// intentional except Horizons' documented strict bounds. STM has no pass limit.
#include <nlohmann/json.hpp>
#include <array>
#include <cmath>
#include <iomanip>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <vector>
using J = nlohmann::json;
void require(bool ok, const std::string& why) { if (!ok) throw std::runtime_error(why); }
double number(const J& v) { require(v.is_number(), "missing numeric score/limit"); double n=v.get<double>(); require(std::isfinite(n)&&n>=0,"invalid numeric score/limit"); return n; }
std::string scalar(double n) { std::ostringstream s; s << std::setprecision(6) << n; return s.str(); }
std::string distance(double m) {
  if (m==0) return "0 mm";
  std::ostringstream s;
  if(m<1e-6) s << std::scientific << std::setprecision(3) << m*1000 << " mm";
  else if(m<1) s << std::fixed << std::setprecision(3) << m*1000 << " mm";
  else s << std::fixed << std::setprecision(3) << m << " m";
  return s.str();
}
std::string quantity(double n,const std::string& unit,int precision=-1) {
 if(precision>=0) {
  require(precision<=6,"unsupported display precision");
  const double scale=unit=="s-as-us"?1e6:unit=="m-as-cm"?100:1;
  const std::string suffix=unit=="s-as-us"?"us":unit=="m-as-cm"?"cm":unit;
  std::ostringstream out;out<<std::fixed<<std::setprecision(precision)<<n*scale<<" "<<suffix;return out.str();
 }
 if(unit=="m")return distance(n);
 if(unit=="s-as-us")return scalar(n*1e6)+" us";
 return scalar(n)+" "+unit;
}
bool cause(const J& c) {return c.is_object()&&c.contains("classification")&&c.at("classification").is_string()&&!c.at("classification").get<std::string>().empty()&&c.contains("statement")&&c.at("statement").is_string()&&!c.at("statement").get<std::string>().empty()&&c.contains("evidence")&&!c.at("evidence").empty();}
J counts() {return J{{"scored",0},{"skipped",0},{"met",0},{"missed",0},{"untoleranced",0},{"diagnostic",0},{"decomposition",0}};}
void inc(J& c,const std::string& key){c[key]=c.at(key).get<int>()+1;}
void checkVerdict(const J& actual,const J& expected,const std::string& label){
  require(expected.is_object()&&!expected.empty(),label+": missing stored verdict");
  for(auto it=expected.begin();it!=expected.end();++it) require(actual.at(it.key())==it.value(),label+": recomputed "+it.key()+" differs from verdict");
}

// Row roles govern report counts independently of the original numerical gate.
// Diagnostic bounds are still independently checked, including their causes.
void countRow(J& total, const std::string& role, bool toleranced, bool met) {
 if (role=="primary") {inc(total,"scored");inc(total,met?"met":"missed");}
 else inc(total,role);
 if (!toleranced) inc(total,"untoleranced");
}
// Independently assess the requested per-sample norm inequality. Table maxima
// cannot be substituted for the paired timeOnly/module samples in this gate.
J reduceConsistency(const J& row) {
 const auto& input=row.at("consistency"),samples=input.at("samples"),expected=input.at("expected");
 require(samples.size()==row.at("samples").get<std::size_t>(),"Vallado consistency sample count differs");
 const double printingR=std::sqrt(3.0)*number(input.at("printing").at("positionKm"))*1000;
 const double printingV=std::sqrt(3.0)*number(input.at("printing").at("velocityKms"))*1000;
 int exceeded=0,positionExceeded=0,velocityExceeded=0;
 double maxR=-INFINITY,maxV=-INFINITY,absoluteR=0,absoluteV=0;
 for(const auto& sample:samples) {
  const double r=number(sample.at("wasm").at("position3dM")),v=number(sample.at("wasm").at("velocity3dMs"));
  const double rBound=number(sample.at("timeOnly").at("position3dM"))+number(sample.at("module").at("position3dM"))+printingR;
  const double vBound=number(sample.at("timeOnly").at("velocity3dMs"))+number(sample.at("module").at("velocity3dMs"))+printingV;
  const double rExcess=r-rBound,vExcess=v-vBound;
  positionExceeded+=rExcess>0;velocityExceeded+=vExcess>0;exceeded+=rExcess>0||vExcess>0;
  maxR=std::max(maxR,rExcess);maxV=std::max(maxV,vExcess);absoluteR=std::max(absoluteR,r);absoluteV=std::max(absoluteV,v);
 }
 require(!samples.empty(),"missing Vallado per-sample consistency evidence");
 const auto close=[](double a,double b){return std::isfinite(a)&&std::isfinite(b)&&std::abs(a-b)<=1e-12+1e-12*std::abs(b);};
 require(close(absoluteR,number(row.at("metrics").at(0).at("value")))&&close(absoluteV,number(row.at("metrics").at(1).at("value"))),"Vallado request maxima differ from summary");
 require(expected.at("samples")==samples.size()&&expected.at("exceeded")==exceeded&&expected.at("positionExceeded")==positionExceeded&&expected.at("velocityExceeded")==velocityExceeded,"Vallado per-sample consistency counts differ");
 require(close(maxR,expected.at("maxPositionExcessM").get<double>())&&close(maxV,expected.at("maxVelocityExcessMs").get<double>()),"Vallado per-sample consistency excess differs");
 return {{"met",exceeded==0},{"samples",samples.size()},{"exceeded",exceeded},{"positionExceeded",positionExceeded},{"velocityExceeded",velocityExceeded},
  {"maxPositionExcessM",maxR},{"maxVelocityExcessMs",maxV},{"positionExceedanceDisplay",distance(std::max(0.0,maxR))},{"velocityExceedanceDisplay",quantity(std::max(0.0,maxV),"m/s")},
  {"worstPosition",expected.at("worstPosition")},{"sourceResidualDisplay",distance(number(expected.at("worstPosition").at("source").at("position3dM")))},
  {"printingNormPositionDisplay",distance(printingR)},{"printingNormVelocityDisplay",quantity(printingV,"m/s")}};
}
void reduceRows(const J& tool, J& result, std::set<std::string>& seen) {
 const std::string id=tool.at("id"); J groups=J::object();
 for (const auto& row:tool.at("rows")) {
  const std::string rid=row.at("id");require(seen.insert(rid).second,id+": duplicate row "+rid);
  bool met=true,toleranced=false,printingMet=true,printingBound=false;J metrics=J::array();
  for (const auto& metricInput:row.at("metrics")) {
   double value=number(metricInput.at("value"));const auto& bound=metricInput.at("limit");J metric=metricInput;
   metric["display"]=quantity(value,metric.at("unit"));
   metric["limitDisplay"]=bound.is_null()?"not specified":quantity(number(bound),metric.at("unit"));
   if (!bound.is_null()) {
    const bool passed=metric.value("strict",false)?value<number(bound):value<=number(bound);
    if(metric.value("diagnostic",false)){printingBound=true;printingMet=printingMet&&passed;}
    else {toleranced=true;met=met&&passed;}
   }
   metrics.push_back(metric);
  }
  J consistency;
  if(row.contains("consistency")){consistency=reduceConsistency(row);toleranced=true;met=consistency.at("met");}
  if(row.contains("expectedPrintingMet"))require(printingBound&&row.at("expectedPrintingMet")==printingMet,id+" "+rid+": printing diagnostic differs");
  if(printingBound&&!printingMet)require(cause(row.value("cause",J())),id+" "+rid+": printing exceedance without cause");
  const J numericalVerdict=toleranced?J(met):J();
  if (row.contains("expectedMet")) require(row.at("expectedMet")==numericalVerdict,id+" "+rid+": stored verdict differs");
  if (toleranced&&!met) require(cause(row.value("cause",J())),id+" "+rid+": exceeded bound without cause");
  const std::string role=row.value("role",toleranced?"primary":"diagnostic");
  require(role=="primary"||role=="diagnostic"||role=="decomposition",id+" "+rid+": invalid row role");
  require(role!="primary"||toleranced,id+" "+rid+": primary row has no stated limit");
  countRow(result["counts"],role,toleranced,met);
  if (row.contains("group")) {
   const std::string group=row.at("group");if(!groups.contains(group))groups[group]=counts();
   countRow(groups[group],role,toleranced,met);
  }
  J output=row;output.erase("expectedMet");output.erase("expectedPrintingMet");output["metrics"]=metrics;output["role"]=role;
  if(!consistency.is_null())output["consistency"]=consistency;
  if(printingBound)output["printingWithinEnvelope"]=printingMet;
  output["status"]=role=="primary"?(met?"met":"missed"):role;
  output["met"]=role=="primary"?numericalVerdict:J();result["rows"].push_back(output);
 }
 result["stm"]={{"display","not exposed"},{"statement",tool.at("stmStatement")}};
 if(tool.contains("expected"))checkVerdict(result.at("counts"),tool.at("expected"),id);
 if(tool.contains("expectedGroups"))for(auto it=tool.at("expectedGroups").begin();it!=tool.at("expectedGroups").end();++it)checkVerdict(groups.at(it.key()),it.value(),id+" "+it.key());
 result["groups"]=groups;
}

double finiteNumber(const J& value) {
 require(value.is_number(),"missing numeric coordinate");const double n=value.get<double>();
 require(std::isfinite(n),"nonfinite coordinate");return n;
}
using Vec3=std::array<double,3>;
using Triad=std::array<Vec3,3>;
Vec3 cross(const Vec3& a,const Vec3& b) {
 return {a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]};
}
Vec3 unit(const Vec3& a) {
 const double norm=std::hypot(a[0],a[1],a[2]);require(norm>0&&std::isfinite(norm),"invalid GMAT initial triad");
 return {a[0]/norm,a[1]/norm,a[2]/norm};
}
Triad triad(const Vec3& r,const Vec3& v) {
 const Vec3 e1=unit(r),e3=unit(cross(r,v));return {e1,cross(e3,e1),e3};
}
Vec3 vectorAt(const J& values,std::size_t first) {
 require(values.is_array()&&values.size()>=first+3,"invalid coordinate row");
 return {finiteNumber(values.at(first)),finiteNumber(values.at(first+1)),finiteNumber(values.at(first+2))};
}
void validateSamples(const J& samples,const J& exportedCase) {
 const auto& offsets=exportedCase.at("sampleOffsetsS");
 require(samples.is_array()&&samples.size()==25&&samples.size()==offsets.size(),"diagnostic requires 25 exported samples");
 for(std::size_t i=0;i<samples.size();++i) {
  const auto& row=samples.at(i);require(row.is_array()&&row.size()==7,"diagnostic sample must have time, position and velocity");
  for(const auto& value:row)finiteNumber(value);
  require(std::abs(finiteNumber(row.at(0))-number(offsets.at(i)))<=1e-3,"diagnostic sample offset differs from export");
 }
}
double decimalRound(double value,int digits) {
 // Match run-gmat.mjs's decimal report transport, before subtracting HPOP.
 std::ostringstream out;out<<std::fixed<<std::setprecision(digits)<<value;return std::stod(out.str());
}
J gmatSamples(const J& diagnostic,const J& exportedCase) {
 const double eps=number(diagnostic.at("eps")),baseCd=number(diagnostic.at("baseCd")),cd=number(diagnostic.at("Cd"));
 require(std::abs(cd-baseCd*(1+eps))<=1e-14,"GMAT diagnostic script Cd differs from anomalous-oxygen correction");
 require(exportedCase.at("frame")=="GCRF","GMAT diagnostic only supports the recorded GCRF drag cases");
 std::istringstream input(diagnostic.at("gmatReport").get<std::string>());std::string line;J rows=J::array();
 while(std::getline(input,line)) {
  if(line.find_first_not_of(" \t\r\n")==std::string::npos)continue;
  std::istringstream values(line);double value;J row=J::array();
  while(values>>value){require(std::isfinite(value),"nonfinite GMAT report value");row.push_back(value);}
  require(values.eof()&&row.size()==13,"GMAT report must have exactly 13 numeric columns");rows.push_back(row);
 }
 const auto& offsets=exportedCase.at("sampleOffsetsS");
 require(rows.size()==25&&rows.size()==offsets.size(),"GMAT diagnostic report must have 25 samples");
 const Triad mj=triad(vectorAt(rows.at(0),1),vectorAt(rows.at(0),4));
 const Triad icrf=triad(vectorAt(rows.at(0),7),vectorAt(rows.at(0),10));
 Triad rotation{};
 for(int i=0;i<3;++i)for(int j=0;j<3;++j)for(int k=0;k<3;++k)rotation[i][j]+=icrf[k][i]*mj[k][j];
 J samples=J::array();
 for(std::size_t i=0;i<rows.size();++i) {
  const auto& row=rows.at(i);const double offset=number(offsets.at(i));
  require(std::abs((finiteNumber(row.at(0))-finiteNumber(rows.at(0).at(0)))*86400-offset)<=1e-3,"GMAT report epoch differs from exported offset");
  J sample=J::array({offset});
  for(int first:{1,4})for(int axis=0;axis<3;++axis) {
   double rotated=0;for(int k=0;k<3;++k)rotated+=rotation[axis][k]*finiteNumber(row.at(first+k));
   sample.push_back(decimalRound(rotated*1000,first==1?6:9));
  }
  samples.push_back(sample);
 }
 validateSamples(samples,exportedCase);return samples;
}
double positionDifference(const J& hpop,const J& samples) {
 const auto& positions=hpop.at("positions");
 require(positions.is_array()&&positions.size()==24&&samples.size()==25,"diagnostic replay requires 24 propagated positions");
 double worst=0;
 for(std::size_t i=0;i<positions.size();++i) {
  require(positions.at(i).is_array()&&positions.at(i).size()==3,"HPOP position must have three components");
  const auto p=vectorAt(positions.at(i),0),r=vectorAt(samples.at(i+1),1);
  const double separation=std::hypot(p[0]*1000-r[0],p[1]*1000-r[1],p[2]*1000-r[2]);
  require(std::isfinite(separation),"nonfinite diagnostic separation");worst=std::max(worst,separation);
 }
 return worst;
}
J diagnosticScore(const J& diagnostic,const J& exportedCase) {
 J result={{"id",diagnostic.at("id")}};
 if(diagnostic.contains("suiteM")) {
  result["suiteM"]=number(diagnostic.at("suiteM"));return result;
 }
 const J samples=diagnostic.contains("gmatReport")?gmatSamples(diagnostic,exportedCase):diagnostic.at("samples");
 validateSamples(samples,exportedCase);
 const auto& expected=diagnostic.at("expected");const std::string setting=expected.at("setting");
 const double stored=number(expected.at("worstM")),replayed=positionDifference(diagnostic.at("hpop").at(setting),samples);
 const double residual=std::abs(stored-replayed);
 constexpr double replayToleranceM=2e-8;
 require(residual<=replayToleranceM,diagnostic.at("id").get<std::string>()+": corrected diagnostic replay differs from stored "+setting+" score (residual "+scalar(residual)+" m)");
 result["replay"]={{"setting",setting},{"storedM",stored},{"recomputedM",replayed},{"residualM",residual},{"toleranceM",replayToleranceM},{"toleranceRationale","20 nm allows native norm reduction and GMAT triad/decimal-transport roundoff; below the 1 micrometre GMAT position transport precision and the comparison limits."}};
 result["suiteM"]=positionDifference(diagnostic.at("hpop").at("suite"),samples);return result;
}
J reduceDragDiagnostics(const J& input,const std::map<std::string,J>& exportedCases) {
 J output=J::array();std::set<std::string> toolsSeen;
 for(const auto& diagnostic:input.value("dragDiagnostics",J::array())) {
  const std::string id=diagnostic.at("id");require(toolsSeen.insert(id).second,"duplicate drag diagnostic tool");
  const J* tool=nullptr;for(const auto& candidate:input.at("tools"))if(candidate.at("id")==id)tool=&candidate;
  require(tool!=nullptr&&tool->at("kind")=="propagation",id+": diagnostic has no propagation tool");
  std::map<std::string,J> stockCases;
  for(const auto& row:tool->at("cases"))if(exportedCases.at(row.at("id")).at("row")=="drag")stockCases.emplace(row.at("id"),row);
  J result={{"id",id},{"label",diagnostic.at("label")},{"setting",diagnostic.at("setting")},{"adjustment",diagnostic.at("adjustment")},{"evidence",diagnostic.at("evidence")},{"pins",diagnostic.at("pins")},{"rows",J::array()},{"cases",J::array()}};
  require(result.at("setting")=="suite",id+": drag diagnostic must use the suite setting");
  require(!result.at("evidence").empty()&&!result.at("pins").empty(),id+": missing diagnostic provenance");
  std::set<std::string> seen;std::map<std::string,J> groups;
  const std::string toleranceGroup=id=="gmat-2026"?"gmat":"default";
  const double limit=number(input.at("export").at("protocol").at("tolerancesM").at(toleranceGroup).at("drag"));
  for(const auto& row:diagnostic.at("cases")) {
   const std::string cid=row.at("id");require(stockCases.count(cid)&&seen.insert(cid).second,id+": unknown or repeated diagnostic case "+cid);
   const auto& exported=exportedCases.at(cid);const std::string orbit=exported.at("orbit");
   const double stock=number(row.at("stockM"));require(stock==number(stockCases.at(cid).at("suite").at("worstM")),id+" "+cid+": diagnostic stock score differs from suite");
   J scored=diagnosticScore(row,exported);const double corrected=number(scored.at("suiteM"));
   scored["orbit"]=orbit;scored["stockM"]=stock;scored["limitM"]=limit;scored["met"]=corrected<=limit;scored["stockMet"]=stock<=limit;result["cases"].push_back(scored);
   if(!groups.count(orbit))groups[orbit]={{"orbit",orbit},{"cases",0},{"stockM",0},{"correctedM",0},{"limitM",limit}};
   auto& group=groups.at(orbit);inc(group,"cases");group["stockM"]=std::max(number(group.at("stockM")),stock);group["correctedM"]=std::max(number(group.at("correctedM")),corrected);
  }
  require(seen.size()==stockCases.size(),id+": diagnostic does not cover every supported drag case");
  for(const auto& [cid,row]:stockCases)require(seen.count(cid),id+": missing drag diagnostic "+cid);
  for(auto& [orbit,group]:groups) {
   const double stock=number(group.at("stockM")),corrected=number(group.at("correctedM"));
   group["stockDisplay"]=distance(stock);group["correctedDisplay"]=distance(corrected);group["limitDisplay"]=distance(limit);group["met"]=corrected<=limit;group["stockMet"]=stock<=limit;result["rows"].push_back(group);
  }
  output.push_back(result);
 }
 require(toolsSeen==std::set<std::string>({"gmat-2026","nyx","basilisk"}),"missing required drag diagnostic tool");
 return output;
}
J reduce(const J& input) {
 const auto& exported=input.at("export"); std::map<std::string,J> cases;
 for(const auto& c:exported.at("cases")) require(cases.emplace(c.at("id"),c).second,"duplicate export ID");
 require(cases.size()==72,"export must contain 72 cases");
 J out={{"tools",J::array()},{"positionTable",J::array()},{"formatted",J::object()}};
 std::map<std::string,std::map<std::string,double>> grouped;
 std::map<std::string,std::map<std::string,int>> groupedCount;
 for(const auto& t:input.at("tools")) {
  const std::string id=t.at("id"), kind=t.at("kind"); J result={{"id",id},{"counts",counts()},{"rows",J::array()}}; auto& ct=result["counts"];
  ct["skipped"]=t.at("skipped").size();
  std::set<std::string> seen;
  for(const auto& skip:t.at("skipped")){require(skip.contains("id")&&skip.contains("reason")&&!skip.at("reason").get<std::string>().empty(),id+": invalid skip");require(seen.insert(skip.at("id")).second,id+": duplicate skip");}
  if(kind=="propagation") {
   result["settings"]=J::object();
   for(const auto& setting:exported.at("protocol").at("stepSettings"))result["settings"][setting.at("id").get<std::string>()]=counts();
   J stm={{"compared",0},{"maxRelativeColumnDifference",nullptr},{"parameters",J::object()},{"statement",t.at("stmStatement")}};
   for(const auto& row:t.at("cases")) {
    const std::string cid=row.at("id");require(cases.count(cid)&&seen.insert(cid).second,id+": absent, unknown or duplicate case "+cid);
    const auto& c=cases.at(cid); const std::string family=c.at("row"),orbit=c.at("orbit"),tclass=c.at("toleranceClass");
    double limit=number(exported.at("protocol").at("tolerancesM").at(t.at("toleranceGroup").get<std::string>()).at(tclass));
    J scored={{"id",cid},{"toleranceM",limit}};
    for(const auto& setting:exported.at("protocol").at("stepSettings")) {
     const std::string key=setting.at("id");const auto& score=row.at(key);double n=number(score.at("worstM"));bool met=n<=limit;
     if(score.contains("met"))require(score.at("met")==met,id+" "+cid+" "+key+": stored met differs");
     if(!met)require(cause(row.value("cause",J())),id+" "+cid+" "+key+": miss without cause");
     auto& settingCounts=result["settings"][key];inc(settingCounts,"scored");inc(settingCounts,met?"met":"missed");
     scored[key]={{"worstM",n},{"display",distance(n)},{"met",met}};
     if(key=="suite") {inc(ct,"scored");inc(ct,met?"met":"missed");if(row.contains("met"))require(row.at("met")==met,id+" "+cid+": case verdict differs");}
     if(key=="suite"||(id=="orekit"&&key=="finest")) {
      const std::string col=id+(key=="finest"?"-finest":""),group=orbit+"/"+family;
      grouped[group][col]=std::max(grouped[group][col],n);groupedCount[group][col]++;
     }
    }
    if(row.contains("stm")&&!row.at("stm").is_null()) {
     const auto& s=row.at("stm"); double n=number(s.at("worst"));inc(stm,"compared");
     if(stm["maxRelativeColumnDifference"].is_null()||n>stm["maxRelativeColumnDifference"].get<double>())stm["maxRelativeColumnDifference"]=n;
     J params=s.value("parameters",J::object());
     for(auto it=params.begin();it!=params.end();++it) {double p=number(it.value());if(!stm["parameters"].contains(it.key())||p>stm["parameters"][it.key()].get<double>())stm["parameters"][it.key()]=p;}
    }
    if(row.contains("cause"))scored["cause"]=row["cause"];
    result["rows"].push_back(scored);
   }
   require(seen.size()==cases.size(),id+": scored/skipped coverage is not 72");
   for(const auto& [cid,c]:cases)require(seen.count(cid),id+": missing "+cid);
   stm["display"]=stm["maxRelativeColumnDifference"].is_null()?"not exposed":scalar(stm["maxRelativeColumnDifference"]);
   result["stm"]=stm;checkVerdict(ct,t.at("expected"),id);
   if(t.contains("expectedSettings"))for(auto it=t.at("expectedSettings").begin();it!=t.at("expectedSettings").end();++it)checkVerdict(result.at("settings").at(it.key()),it.value(),id+" "+it.key());
  } else reduceRows(t,result,seen);
  out["tools"].push_back(result);
 }
 for(const auto& orbit:input.at("orbits"))for(const auto& family:input.at("families")) {
  const std::string group=orbit.get<std::string>()+"/"+family.get<std::string>();
  J row={{"orbit",orbit},{"forceClass",family},{"cells",J::object()}};
  for(const auto& col:input.at("columns")){std::string name=col;if(groupedCount[group][name])row["cells"][name]={{"maxM",grouped[group][name]},{"scored",groupedCount[group][name]},{"display",distance(grouped[group][name])}};else row["cells"][name]=nullptr;}
  out["positionTable"].push_back(row);
 }
 for(auto it=input.at("format").begin();it!=input.at("format").end();++it)out["formatted"][it.key()]=quantity(number(it.value().at("value")),it.value().at("unit"),it.value().value("precision",-1));
 out["dragDiagnostics"]=reduceDragDiagnostics(input,cases);
 return out;
}
int main(){try{J input;std::cin>>input;std::cout<<reduce(input).dump()<<'\n';}catch(const std::exception& e){std::cout<<J{{"error",e.what()}}.dump()<<'\n';return 1;}}
