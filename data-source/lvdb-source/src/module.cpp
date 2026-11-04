#include "HttpRequest_generated.h"
#include "HttpResponse_generated.h"
#include "IngestRequest_generated.h"
#include "ModuleConfig_generated.h"
#include "TimerTick_generated.h"
#include "space_data_module_invoke.h"
#include <map>
#include <set>
#include <sstream>
#include <ctime>
#include <cmath>
#include <algorithm>
namespace {
namespace R=sdn::runtime;
using Row=std::map<std::string,std::string>;
using Bytes=std::vector<uint8_t>;
std::string failure;
#define check(b,s) do {if(!(b)){failure=(s);return {};}}while(0)
std::string get(const Row&r,const std::string&k){auto i=r.find(k);return i==r.end()?"":i->second;}
std::string trim(std::string s){auto a=s.find_first_not_of(" \r\n\t");return a==s.npos?"":s.substr(a,s.find_last_not_of(" \r\n\t")-a+1);}
std::string digest(const std::string&s){return ephem::sha256_hex((const uint8_t*)s.data(),s.size());}
std::string iso(uint64_t ms){time_t sec=ms/1000;auto t=*std::gmtime(&sec);char b[32];std::strftime(b,sizeof b,"%Y-%m-%dT%H:%M:%SZ",&t);return b;}
double num(std::string s){if(s.empty()||s=="nan"||s==".nan")return NAN;char* e;double v=strtod(s.c_str(),&e);check(e==s.c_str()+s.size()&&std::isfinite(v),"Invalid numeric cell: "+s);return v;}
// RFC4180 quoting, also used by ECSV with its declared space delimiter.
std::vector<Row> table(const std::string&s,char delim){
 std::vector<std::vector<std::string>> lines;std::vector<std::string> row;std::string cell;bool quoted=false,start=true,comment=false;
 for(size_t i=0;i<=s.size();i++){char c=i<s.size()?s[i]:'\n';if(comment){if(c=='\n'){comment=false;start=true;}continue;}if(start&&c=='#'){comment=true;continue;}start=false;
 if(c=='"'){if(quoted&&i+1<s.size()&&s[i+1]=='"'){cell+='"';i++;}else quoted=!quoted;}
 else if(!quoted&&(c==delim||c=='\n')){row.push_back(cell);cell.clear();if(c=='\n'){if(!(row.size()==1&&row[0].empty()))lines.push_back(row);row.clear();start=true;}}
 else if(c!='\r'||quoted)cell+=c;
 }check(!quoted&&!lines.empty(),"Malformed table");std::vector<Row> out;std::set<std::string> cols(lines[0].begin(),lines[0].end());check(cols.size()==lines[0].size(),"Duplicate columns");
 for(size_t i=1;i<lines.size();i++){check(lines[i].size()==lines[0].size(),"Wrong column count");Row r;for(size_t j=0;j<lines[0].size();j++)r[lines[0][j]]=lines[i][j];out.push_back(std::move(r));}return out;
}
std::string scalar(ryml::ConstNodeRef n){if(!n.valid()||!n.has_val()||n.val_is_null())return "";auto v=n.val();return {v.str,v.len};}
Row mapping(ryml::ConstNodeRef n){Row r;if(n.valid()&&n.is_map())for(auto ch:n.children())if(ch.has_val())r[std::string(ch.key().str,ch.key().len)]=scalar(ch);return r;}
ryml::ConstNodeRef child(ryml::ConstNodeRef n,const char*k){return n.valid()&&n.is_map()&&n.has_child(k)?n[k]:ryml::ConstNodeRef();}
std::vector<std::string> strings(ryml::ConstNodeRef n){std::vector<std::string> r;if(n.valid()){if(n.is_seq())for(auto c:n.children())r.push_back(scalar(c));else if(n.has_val())r.push_back(scalar(n));}return r;}
// Inflate into a fixed bounded buffer; validate both gzip trailer values before tar parsing.
std::map<std::string,std::string> archive(const std::string&gz){
 check(gz.size()>18&&(uint8_t)gz[0]==31&&(uint8_t)gz[1]==139&&gz[2]==8,"Expected gzip");unsigned flags=(uint8_t)gz[3];check(!(flags&0xe0),"Gzip flags");size_t at=10;
 if(flags&4){check(at+2<gz.size(),"Gzip extra");unsigned n=(uint8_t)gz[at]|((uint8_t)gz[at+1]<<8);at+=2+n;}
 for(unsigned f:{8u,16u})if(flags&f){while(at<gz.size()&&gz[at])at++;at++;}if(flags&2)at+=2;check(at<gz.size()-8,"Gzip header");
 auto le=[&](size_t p){return uint32_t((uint8_t)gz[p])|(uint32_t((uint8_t)gz[p+1])<<8)|(uint32_t((uint8_t)gz[p+2])<<16)|(uint32_t((uint8_t)gz[p+3])<<24);};
 uint32_t size=le(gz.size()-4);check(size>1024&&size<=128*1024*1024,"Archive size bound");std::string tar(size,'\0');size_t n=tinfl_decompress_mem_to_mem(tar.data(),tar.size(),gz.data()+at,gz.size()-at-8,0);check(n==size&&mz_crc32(0,(const unsigned char*)tar.data(),n)==le(gz.size()-8),"Gzip CRC/length");
 std::map<std::string,std::string> out;for(size_t p=0;p+512<=tar.size();){if(!tar[p])break;auto oct=[&](size_t off,size_t len){return strtoull(tar.substr(p+off,len).c_str(),nullptr,8);};size_t sz=oct(124,12),sum=0;for(size_t j=0;j<512;j++)sum+=(j>=148&&j<156)?32:(uint8_t)tar[p+j];check(sum==oct(148,8),"Tar checksum");check(sz<=tar.size()-p-512,"Truncated tar");std::string name(tar.data()+p,strnlen(tar.data()+p,100));auto slash=name.find('/');if(slash!=name.npos)name=name.substr(slash+1);
 if(name=="code/release_version.txt"||(name.rfind("data_input/",0)==0&&name.size()>5&&name.substr(name.size()-5)==".yaml")){check(tar[p+156]=='0'||tar[p+156]=='\0',"Not a regular source file");check(!out.count(name),"Duplicate archive path");out[name]=tar.substr(p+512,sz);}p+=512+((sz+511)/512)*512;}check(out.count("code/release_version.txt"),"Missing release marker");return out;
}
std::unique_ptr<EXOParameterT> parameter(const Row&r,const std::string&key,const std::string&unit,const std::string&ref,const std::string&time,int limit=0){
 auto token=get(r,key);if(token.empty())return {};auto p=std::make_unique<EXOParameterT>();p->VALUE=num(token);p->ERR1=num(get(r,key+"_ep"));p->ERR2=-num(get(r,key+"_em"));p->LIMIT=limit;p->UNIT=unit;p->REFERENCE_TEXT=ref;if(ref.size()>=19){auto bib=ref.substr(ref.size()-19);if(std::isdigit(bib[0])&&std::isdigit(bib[1])&&std::isdigit(bib[2])&&std::isdigit(bib[3]))p->REFERENCE_BIBCODE=bib;}p->RETRIEVED_AT=time;return p;
}
using Member=std::unique_ptr<EXOParameterT> SSYT::*;
struct Field{const char* key;Member member;const char* field;const char* unit;const char* ref;};
#define F(k,f,u,r) {k,&SSYT::f,#f,u,r}
const Field fields[]={
 F("ra",RA,"deg","ref_location"),F("dec",DEC,"deg","ref_location"),F("distance_modulus",DISTANCE_MODULUS,"mag","ref_distance"),F("distance",DISTANCE,"kpc",""),
 F("apparent_magnitude_v",APPARENT_MAG_V,"mag","ref_m_v"),F("apparent_magnitude_b",APPARENT_MAG_B,"mag","ref_m_v"),F("apparent_magnitude_i",APPARENT_MAG_I,"mag","ref_m_v"),F("mean_ebv",MEAN_EBV,"mag","ref_m_v"),F("M_V",ABSOLUTE_MAG_V,"mag",""),F("mass_stellar",STELLAR_MASS_LOG,"dex(solMass)",""),
 F("rhalf",RHALF,"arcmin","ref_structure"),F("ellipticity",ELLIPTICITY,"1","ref_structure"),F("position_angle",POSITION_ANGLE,"deg","ref_structure"),F("rhalf_physical",RHALF_PC,"pc",""),F("rhalf_sph_physical",RHALF_SPH_PC,"pc",""),F("surface_brightness_rhalf",SURFACE_BRIGHTNESS_RHALF,"mag/arcsec2",""),F("diameter_holm",HOLMBERG_DIAMETER,"arcmin","ref_structure"),
 F("vlos_systemic",VLOS_SYSTEMIC,"km/s","ref_vlos"),F("vlos_sigma",VLOS_SIGMA,"km/s","ref_vlos"),F("vlos_sigma_central",VLOS_SIGMA_CENTRAL,"km/s","ref_vlos"),F("vlos_rotation",VLOS_ROTATION,"km/s","ref_vlos"),F("velocity_gsr",VELOCITY_GSR,"km/s",""),F("velocity_lg",VELOCITY_LG,"km/s",""),F("pmra",PMRA,"mas/yr","ref_proper_motion"),F("pmdec",PMDEC,"mas/yr","ref_proper_motion"),F("pmra_pmdec_corr",PMRA_PMDEC_CORR,"1","ref_proper_motion"),
 F("metallicity_spectroscopic",METALLICITY_SPECTROSCOPIC,"dex","ref_metallicity_spectroscopic"),F("metallicity_spectroscopic_sigma",METALLICITY_SPECTROSCOPIC_SIGMA,"dex","ref_metallicity_spectroscopic"),F("metallicity_photometric",METALLICITY_PHOTOMETRIC,"dex","ref_metallicity_photometric"),F("metallicity_photometric_sigma",METALLICITY_PHOTOMETRIC_SIGMA,"dex","ref_metallicity_photometric"),F("metallicity_isochrone",METALLICITY_ISOCHRONE,"dex","ref_metallicity_isochrone"),F("metallicity_isochrone_sigma",METALLICITY_ISOCHRONE_SIGMA,"dex","ref_metallicity_isochrone"),F("metallicity",METALLICITY,"dex",""),F("gas_phase_metallicity",GAS_PHASE_METALLICITY,"dex","ref_gas_phase_metallicity"),
 F("age",AGE,"Gyr","ref_age"),F("tau_50",TAU_50,"Gyr","ref_star_formation_history"),F("tau_80",TAU_80,"Gyr","ref_star_formation_history"),F("tau_90",TAU_90,"Gyr","ref_star_formation_history"),
 F("flux_HI",FLUX_HI,"Jy km/s","ref_flux_HI"),F("vlos_systemic_HI",VLOS_SYSTEMIC_HI,"km/s","ref_HI_kinematics"),F("sigma_HI",SIGMA_HI,"km/s","ref_HI_kinematics"),F("vrot_HI",VROT_HI,"km/s","ref_HI_kinematics"),F("HI_line_width_50",HI_LINE_WIDTH_50,"km/s","ref_HI_kinematics"),F("mass_HI",HI_MASS_LOG,"dex(solMass)",""),F("mass_dynamical_wolf",DYNAMICAL_MASS_WOLF_LOG,"dex(solMass)","")};
#undef F
void assign(SSYT&v,const Row&r,const Field&f,const std::string&time){std::string ref=*f.ref?get(r,f.ref):"LVDB value-added";v.*(f.member)=parameter(r,f.key,f.unit,ref,time);for(auto suffix:{"_ul","_ll"}){auto p=parameter(r,std::string(f.key)+suffix,f.unit,ref,time,suffix[1]=='u'?1:-1);if(!p)continue;if(!(v.*(f.member)))v.*(f.member)=std::move(p);else{auto a=std::make_unique<SSYAlternateT>();a->FIELD=f.field;a->VALUE=std::move(p);a->NOTE=std::string("LVDB ")+f.key+suffix;v.ALTERNATES.push_back(std::move(a));}}}
ssyVerdict verdict(const std::string&s){return s=="1"?ssyVerdict::YES:s=="0"?ssyVerdict::NO:ssyVerdict::UNKNOWN;}
bool enrich(SSYT&v,const Row&csv,const std::string&yaml,const std::vector<Row>&pm,const std::vector<Row>&jf){
 auto tree=ryml::parse_in_arena(ryml::to_csubstr(yaml));auto root=tree.crootref();check(root.is_map(),"YAML map required");Row r;
 for(auto section:{"location","name_discovery","structure","distance","m_v","proper_motion","metallicity_spectroscopic","metallicity_photometric","metallicity_isochrone","velocity","flux_HI","HI_kinematics","age","star_formation_history","gas_phase_metallicity"})for(auto&kv:mapping(child(root,section)))r[kv.first]=kv.second;
 for(auto&kv:csv)r[kv.first]=kv.second;
 check(scalar(child(root,"key"))==get(csv,"key"),"YAML identity mismatch");
 for(const auto&f:fields)assign(v,r,f,v.RETRIEVED_AT);
 auto nd=child(root,"name_discovery");Row names=mapping(nd);
 v.NAME=get(csv,"name");v.ABBREVIATION=get(names,"abbreviation");v.MORPHOLOGY=get(names,"type");v.DESIGNATIONS=strings(child(nd,"other_name"));v.DISCOVERY_REFS=strings(child(nd,"ref_discovery"));v.FALSE_POSITIVE_REFS=strings(child(nd,"ref_false_positive"));v.NOTES=strings(child(root,"notes"));
 if(!get(names,"discovery_year").empty())v.DISCOVERY_YEAR=int(num(get(names,"discovery_year")));
 if(!get(names,"false_positive").empty())v.FALSE_POSITIVE=ssyFalsePositiveVerdict(int(num(get(names,"false_positive")))+1);
 const char* ids[]={"name_lvg","name_hyperleda","name_ned_lvs","name_sga"};const char* cats[]={"LVG","HyperLEDA","NED-LVS","SGA"};for(int i=0;i<4;i++)if(!get(names,ids[i]).empty()){auto x=std::make_unique<SSYCrossIdentifierT>();x->CATALOG=cats[i];x->IDENTIFIER=get(names,ids[i]);v.CROSS_IDS.push_back(std::move(x));}
 v.HOST_ID=get(csv,"host").empty()?"":"lvdb:"+get(csv,"host");v.CONFIRMED_REAL=verdict(get(csv,"confirmed_real"));v.CONFIRMED_GALAXY=verdict(get(csv,"confirmed_galaxy"));v.CONFIRMED_STAR_CLUSTER=verdict(get(csv,"confirmed_star_cluster"));
 auto tab=get(csv,"table");v.SYSTEM_CLASS=tab.rfind("dwarf_",0)==0?ssySystemKind::DWARF_GALAXY:tab=="misc"?ssySystemKind::GALAXY:tab=="gc_ambiguous"?ssySystemKind::AMBIGUOUS:tab.rfind("gc_",0)==0?ssySystemKind::GLOBULAR_CLUSTER:ssySystemKind::UNSPECIFIED;
 if(tab=="candidate"){if(v.CONFIRMED_GALAXY==ssyVerdict::YES)v.SYSTEM_CLASS=ssySystemKind::DWARF_GALAXY;else if(v.CONFIRMED_STAR_CLUSTER==ssyVerdict::YES)v.SYSTEM_CLASS=ssySystemKind::GLOBULAR_CLUSTER;}
 v.STRUCTURE_MODEL=get(r,"spatial_model");v.DISTANCE_METHOD_TEXT=get(csv,"distance_measurement_method");std::map<std::string,int> dm={{"host",1},{"trgb",2},{"sbf",3},{"tf",4},{"btf",5},{"cmd",6},{"rrl",7},{"hb",8},{"nam",9},{"bs",10},{"sn",11},{"cepheid",12},{"parallax",13},{"kinematic",14}};v.DISTANCE_METHOD=ssyDistanceTechnique(v.DISTANCE_METHOD_TEXT.empty()?0:dm.count(v.DISTANCE_METHOD_TEXT)?dm[v.DISTANCE_METHOD_TEXT]:15);
 v.METALLICITY_BASIS=get(csv,"metallicity_type")=="spectroscopic"?ssyMetallicityTechnique::SPECTROSCOPIC:get(csv,"metallicity_type")=="photometric"?ssyMetallicityTechnique::PHOTOMETRIC:get(csv,"metallicity_type")=="isochrone"?ssyMetallicityTechnique::ISOCHRONE:ssyMetallicityTechnique::UNSPECIFIED;
 v.GAS_PHASE_METALLICITY_METHOD=get(r,"gas_phase_metallicity_method");v.PLACEMENT=std::make_unique<SSYPlacementT>();auto&p=*v.PLACEMENT;
#define PLACE(k,f,u) p.f=parameter(csv,k,u,"LVDB value-added",v.RETRIEVED_AT)
 PLACE("ll",GALACTIC_L_DEG,"deg");PLACE("bb",GALACTIC_B_DEG,"deg");PLACE("sg_xx",SUPERGALACTIC_X_KPC,"kpc");PLACE("sg_yy",SUPERGALACTIC_Y_KPC,"kpc");PLACE("sg_zz",SUPERGALACTIC_Z_KPC,"kpc");PLACE("distance_gc",DISTANCE_GALACTIC_CENTER_KPC,"kpc");PLACE("distance_m31",DISTANCE_M31_KPC,"kpc");PLACE("distance_lg",DISTANCE_LOCAL_GROUP_KPC,"kpc");PLACE("distance_host",DISTANCE_HOST_KPC,"kpc");
#undef PLACE
 for(auto model:{"king","sersic","eff","plummer","exponential"}){
  std::string sec="structure_"+std::string(model);Row fit=mapping(child(root,sec.c_str()));if(fit.empty())continue;auto f=std::make_unique<SSYProfileFitT>();std::string ref=get(fit,"ref_"+sec),unit=get(fit,"spatial_units");if(unit.empty())unit="arcmin";
  f->MODEL=std::string(model)=="king"?ssyProfileModel::KING:std::string(model)=="sersic"?ssyProfileModel::SERSIC:std::string(model)=="eff"?ssyProfileModel::EFF:std::string(model)=="plummer"?ssyProfileModel::PLUMMER:ssyProfileModel::EXPONENTIAL;
  const char* radius=std::string(model)=="sersic"?"rad_sersic":std::string(model)=="eff"?"rad_eff":std::string(model)=="plummer"?"rplummer":"rexponential";
#define FIT(k,m,u) f->m=parameter(fit,k,u,ref,v.RETRIEVED_AT)
  FIT(radius,RADIUS,unit);FIT("rcore",CORE_RADIUS,unit);FIT("rking",TIDAL_RADIUS,unit);FIT("king_concentration",CONCENTRATION,"1");FIT(std::string(model)=="eff"?"gamma_eff":"n_sersic",SHAPE_INDEX,"1");FIT("ellipticity",ELLIPTICITY,"1");FIT("position_angle",POSITION_ANGLE,"deg");FIT("central_surface_brightness",CENTRAL_SURFACE_BRIGHTNESS,"mag/arcsec2");
#undef FIT
  if(!f->ELLIPTICITY)f->ELLIPTICITY=parameter(fit,"ellipticity_ul","1",ref,v.RETRIEVED_AT,1);
  if(std::string(model)=="king"){f->CORE_RADIUS=parameter(csv,"rcore","arcmin",get(csv,"ref_structure_king"),v.RETRIEVED_AT);f->TIDAL_RADIUS=parameter(csv,"rking","arcmin",get(csv,"ref_structure_king"),v.RETRIEVED_AT);}
  if(std::string(model)=="sersic"){f->RADIUS=parameter(csv,"rad_sersic","arcmin",get(csv,"ref_structure_sersic"),v.RETRIEVED_AT);f->SHAPE_INDEX=parameter(csv,"n_sersic","1",get(csv,"ref_structure_sersic"),v.RETRIEVED_AT);}
  v.PROFILE_FITS.push_back(std::move(f));
 }
 for(auto&r:pm)if(get(r,"key")==v.SOURCE_KEY){auto p=std::make_unique<SSYProperMotionT>();auto ref=get(r,"ref_cite");p->PMRA=parameter(r,"pmra","mas/yr",ref,v.RETRIEVED_AT);p->PMDEC=parameter(r,"pmdec","mas/yr",ref,v.RETRIEVED_AT);p->CORRELATION=parameter(r,"pmra_pmdec_corr","1",ref,v.RETRIEVED_AT);p->METHOD=get(r,"method");p->COMMENTS=get(r,"comments");p->ADOPTED=ref==get(csv,"ref_proper_motion");v.PROPER_MOTIONS.push_back(std::move(p));}
 for(auto&r:jf)if(get(r,"key")==v.SOURCE_KEY){auto j=std::make_unique<SSYJFactorT>();auto ref=get(r,"ref_cite");j->ANGLE_DEG=parameter(r,"angle","deg",ref,v.RETRIEVED_AT);j->LOG_J=parameter(r,"logj","dex(GeV2 cm-5)",ref,v.RETRIEVED_AT);j->LOG_J_P05=parameter(r,"logj_em05","dex(GeV2 cm-5)",ref,v.RETRIEVED_AT);j->LOG_J_P95=parameter(r,"logj_ep95","dex(GeV2 cm-5)",ref,v.RETRIEVED_AT);
  // LVDB stores interval widths; SSY names percentile coordinates.
  if(j->LOG_J_P05&&j->LOG_J)j->LOG_J_P05->VALUE=j->LOG_J->VALUE-j->LOG_J_P05->VALUE;
  if(j->LOG_J_P95&&j->LOG_J)j->LOG_J_P95->VALUE=j->LOG_J->VALUE+j->LOG_J_P95->VALUE;
  j->LOG_J_UPPER_LIMIT_95=parameter(r,"logj_ul95","dex(GeV2 cm-5)",ref,v.RETRIEVED_AT,1);j->SELECTION=get(r,"selection");j->USE=get(r,"use");j->COMMENTS=get(r,"comments");v.J_FACTORS.push_back(std::move(j));}
 return failure.empty();
}
const std::string marker="https://raw.githubusercontent.com/apace7/local_volume_database/main/code/release_version.txt";
std::vector<std::string> urls(const std::string&release){std::string base="https://github.com/apace7/local_volume_database/releases/download/"+release+"/";return {base+"comb_all.ecsv",base+"pm_overview.csv",base+"j_factor.csv","https://api.github.com/repos/apace7/local_volume_database/tarball/"+release};}
bool validRelease(const std::string&s){if(s.size()<6||s.size()>30||s[0]!='v')return false;int dots=0;for(size_t i=1;i<s.size();i++)if(s[i]=='.')dots++;else if(!isdigit(s[i]))return false;return dots==2;}
std::vector<const plugin_input_frame_t*> inputs(const char*port){std::vector<const plugin_input_frame_t*> out;bool config=false;for(uint32_t i=0;i<plugin_get_input_count();i++){auto f=plugin_get_input_frame(i);check(f&&f->payload&&f->port_id,"Invalid frame");if(!strcmp(f->port_id,"config")){check(!config&&f->payload_length<=65536,"Config bound");config=true;flatbuffers::Verifier v(f->payload,f->payload_length);check(R::VerifyModuleConfigBuffer(v),"Expected MCFG");auto c=R::GetModuleConfig(f->payload);check(!c->ENTRIES()||c->ENTRIES()->size()==0,"No configurable settings");}else{check(!strcmp(f->port_id,port),"Unexpected port");out.push_back(f);}}return out;}
const R::HttpResponse* response(const plugin_input_frame_t*f){check(f->payload_length<32*1024*1024,"HTTP bound");flatbuffers::Verifier v(f->payload,f->payload_length);check(R::VerifyHttpResponseBuffer(v),"Expected HRSP");auto h=R::GetHttpResponse(f->payload);check(h->STATUS()==200&&h->URL()&&h->BODY()&&h->RETRIEVED_MS()>0,"HTTP failure or missing retrieval time");return h;}
std::string body(const R::HttpResponse*h){return {(const char*)h->BODY()->data(),h->BODY()->size()};}
int push(const char*port,const char*schema,const char*id,const char*root,const flatbuffers::FlatBufferBuilder&b){return plugin_push_output_ex(port,schema,id,PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,root,0,0,b.GetBufferPointer(),b.GetSize());}
bool request(const std::string&url){R::HttpRequestT r;r.METHOD="GET";r.URL=url;r.TIMEOUT_MS=90000;r.MAX_BYTES=31*1024*1024;flatbuffers::FlatBufferBuilder b;R::FinishHttpRequestBuffer(b,R::HttpRequest::Pack(b,&r));check(push("request","HttpRequest.fbs","HREQ","HttpRequest",b)>=0,"Request emission");return true;}
int planRelease(){auto fs=inputs("tick");check(failure.empty()&&fs.size()==1,"One tick required");flatbuffers::Verifier v(fs[0]->payload,fs[0]->payload_length);check(R::VerifyTimerTickBuffer(v),"Expected TICK");request(marker);return 0;}
int planCatalog(){auto fs=inputs("response");check(failure.empty()&&fs.size()==1,"One release response required");auto h=response(fs[0]);check(h&&h->URL()->str()==marker,"Wrong marker source");auto release=trim(body(h));check(validRelease(release),"Invalid release marker");for(auto&u:urls(release))request(u);return 0;}
int parseCatalog(){auto fs=inputs("response");check(failure.empty()&&fs.size()==4,"Four release sources required");std::map<std::string,const R::HttpResponse*> hs;for(auto f:fs){auto h=response(f);check(h,"Invalid response");check(!hs.count(h->URL()->str()),"Duplicate response");hs[h->URL()->str()]=h;}
 const R::HttpResponse*tar=nullptr;std::string release;for(auto&kv:hs)if(kv.first.rfind("https://api.github.com/repos/apace7/local_volume_database/tarball/",0)==0){tar=kv.second;release=kv.first.substr(kv.first.rfind('/')+1);}check(tar&&validRelease(release),"Missing tagged archive");auto us=urls(release);for(auto&u:us)check(hs.count(u),"Incomplete/mixed release");auto files=archive(body(tar));check(failure.empty()&&trim(files["code/release_version.txt"])==release,"Archive release mismatch");
 auto rows=table(body(hs[us[0]]),' '),pm=table(body(hs[us[1]]),','),jf=table(body(hs[us[2]]),',');check(failure.empty()&&!rows.empty(),"Empty/invalid release");std::set<std::string> keys;for(auto&r:rows)check(keys.insert(get(r,"key")).second&&!get(r,"key").empty(),"Duplicate/empty source key");
 std::vector<std::string> hashes;for(auto&u:us)hashes.push_back(digest(body(hs[u])));Bytes stream;std::string time=iso(hs[us[0]]->RETRIEVED_MS());
 for(auto&r:rows){SSYT v;v.SOURCE_KEY=get(r,"key");std::string yp="data_input/"+v.SOURCE_KEY+".yaml";check(files.count(yp),"Missing YAML: "+yp);v.ID="lvdb:"+v.SOURCE_KEY;v.SOURCE_CATALOG="Local Volume Database";v.SOURCE_RELEASE=release;v.SOURCE_TABLE=get(r,"table");v.SOURCE_URL="https://raw.githubusercontent.com/apace7/local_volume_database/"+release+"/"+yp;v.SOURCE_SHA256=hashes;v.SOURCE_SHA256.push_back(digest(files[yp]));v.CITATION="Pace 2025, OJAp 8, 142";v.LICENSE="CC0-1.0";v.RETRIEVED_AT=time;v.UNCERTAINTY_CONVENTION="ERR1/ERR2 = positive upper / negative lower errors at 84th/16th percentiles";v.LIMIT_CONFIDENCE=.95;check(enrich(v,r,files[yp],pm,jf),"Invalid row "+v.SOURCE_KEY+": "+failure);flatbuffers::FlatBufferBuilder b;FinishSizePrefixedSSYBuffer(b,SSY::Pack(b,&v));stream.insert(stream.end(),b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize());}
 R::IngestRequestT m;m.SCHEMA="SSY.fbs";m.RECONCILE=R::reconcileMode_Current;m.TAGS=std::make_unique<R::SourceTagsT>();auto&t=*m.TAGS;t.PROVIDER_ID="lvdb";t.SOURCE_NAME="comb-all";t.BATCH_ID=digest(hashes[0]+hashes[1]+hashes[2]+hashes[3]);t.SOURCE_URL=us[0];t.LICENSE="CC0-1.0";t.LICENSE_URL="https://creativecommons.org/publicdomain/zero/1.0/";t.CITATION="Pace 2025, OJAp 8, 142";m.PROVENANCE=std::make_unique<R::ProvenanceT>();m.PROVENANCE->PARSER="lvdb-source";m.PROVENANCE->PARSER_VERSION="0.1.0";m.PROVENANCE->NORMALIZED_COUNT=rows.size();m.PROVENANCE->SCHEMAS={m.SCHEMA};m.PROVENANCE->SCHEMA_COUNTS={rows.size()};flatbuffers::FlatBufferBuilder b;R::FinishIngestRequestBuffer(b,R::IngestRequest::Pack(b,&m));check(push("meta","IngestRequest.fbs","INGQ","IngestRequest",b)>=0,"Emit metadata");check(plugin_push_output_ex("records","SSY.fbs","$SSY",PLUGIN_PAYLOAD_WIRE_FORMAT_FLATBUFFER,"SSY",0,0,stream.data(),stream.size())>=0,"Emit records");return 0;
}
template<class F>int guard(F f){plugin_reset_output_state();failure.clear();int rc=f();if(!failure.empty()){plugin_reset_output_state();plugin_set_error("lvdb-source",failure.c_str());return 1;}return rc;}
}
extern "C" int plan_release(){return guard(planRelease);}
extern "C" int plan_catalog(){return guard(planCatalog);}
extern "C" int parse_catalog(){return guard(parseCatalog);}
