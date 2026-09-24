// VCM -> $OCM projection.
//
// Authority: the published VCM sample and format description
// (fixtures/PROVENANCE.md) and CCSDS 502.0-B-3 (ODM Blue Book, OCM keyword
// definitions). Checks are transcription and identity: every mapped value in
// the finished, verified $OCM buffer must equal the source value exactly, and
// every value carried as text must parse back to the identical double.

// macOS <math.h> still defines the SVID error constants, one of which
// collides with a country code in the generated LCC header.
#include <cmath>
#undef SING
#undef DOMAIN
#undef OVERFLOW
#undef UNDERFLOW
#undef TLOSS
#undef PLOSS

#include "OCM_generated.h"
#include "VCM_generated.h"
#include "vcm_ocm.hpp"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

namespace {
int cases=0,failures=0;
void check(bool ok,const char* name){++cases;if(!ok){++failures;std::printf("FAIL %s\n",name);}}

bool frameFor(const std::string& name,CelestialFrame* out){
 if(name=="EME2000"){*out=CelestialFrame::EME2000;return true;}
 if(name=="GCRF"){*out=CelestialFrame::GCRF;return true;}
 return false;
}

std::vector<uint8_t> finish(const OCMT& ocm){
 flatbuffers::FlatBufferBuilder b(4096);
 b.Finish(CreateOCM(b,&ocm),OCMIdentifier());
 return {b.GetBufferPointer(),b.GetBufferPointer()+b.GetSize()};
}

const OCM* read(const std::vector<uint8_t>& bytes){
 flatbuffers::Verifier v(bytes.data(),bytes.size());
 return VerifyOCMBuffer(v)?GetOCM(bytes.data()):nullptr;
}

std::string param(const OCM* o,const std::string& name){
 if(!o->USER_DEFINED_PARAMETERS())return "";
 for(const auto* p:*o->USER_DEFINED_PARAMETERS())if(p->PARAM_NAME() && p->PARAM_NAME()->str()==name && p->PARAM_VALUE())return p->PARAM_VALUE()->str();
 return "";
}

std::vector<double> numbers(const std::string& text){
 std::vector<double> out;std::istringstream in(text);std::string t;
 while(in>>t){char* end=nullptr;double d=std::strtod(t.c_str(),&end);if(end!=t.c_str()+t.size())return {};out.push_back(d);}
 return out;
}
}  // namespace

int main(int argc,char** argv){
 if(argc<2){std::printf("usage: vcm-ocm-native <fixture>\n");return 2;}
 std::ifstream in(argv[1],std::ios::binary);std::stringstream buffer;buffer<<in.rdbuf();
 const std::string text=buffer.str();
 sdn::vcm::Message m;std::string error;
 check(sdn::vcm::parse(reinterpret_cast<const uint8_t*>(text.data()),text.size(),m,error),"sample parses");

 // Legacy text.
 OCMT legacy;sdn::vcm::projectLegacy(m,legacy);
 const auto bytes=finish(legacy);
 const OCM* o=read(bytes);
 check(o!=nullptr,"verified $OCM buffer");
 if(!o){std::printf("FAIL vcm-ocm cases=%d failures=%d\n",cases,failures+1);return 1;}
 check(OCMBufferHasIdentifier(bytes.data()),"$OCM identifier");
 check(o->HEADER()->CCSDS_OCM_VERS()->str()=="3.0" && o->HEADER()->CREATION_DATE()->str()=="2023-01-07T22:45:06.000","header");
 check(o->HEADER()->ORIGINATOR()->str()=="FAKE_CENTER","originator");
 check(o->METADATA()->OBJECT_DESIGNATOR()->str()=="00000" && o->METADATA()->INTERNATIONAL_DESIGNATOR()->str()=="0000-000A","identity");
 check(o->METADATA()->OBJECT_NAME()==nullptr,"blank common name is not invented");
 check(o->METADATA()->TIME_SYSTEM()->str()=="UTC" && o->METADATA()->EPOCH_TZERO()->str()=="2023-01-07T21:39:08.414","epoch");
 check(o->METADATA()->TAIMUTC_AT_TZERO()==37 && o->METADATA()->UT1MUTC_AT_TZERO()==-0.01719,"time offsets");
 check(o->METADATA()->NEXT_LEAP_EPOCH()==nullptr,"leap-second placeholder not published");
 check(o->TRAJ_TYPE()==trajectoryType::CARTESIAN_PV && o->STATE_VECTOR_SIZE()==6,"trajectory type");
 check(o->STATE_DATA()->size()==6,"one state");
 bool same=o->STATE_DATA()->size()==6;
 for(int i=0;same && i<6;++i)same=o->STATE_DATA()->Get(i)==m.j2k[i];
 check(same,"state is the J2K state");
 check(o->CENTER_NAME()->str()=="EARTH","center");
 check(o->TRAJ_REF_FRAME()->NAME()->str()=="EME2000" &&
       o->TRAJ_REF_FRAME()->REFERENCE_FRAME_type()==RFMUnion::CelestialFrameWrapper &&
       o->TRAJ_REF_FRAME()->REFERENCE_FRAME_as_CelestialFrameWrapper()->frame()==CelestialFrame::EME2000,"frame");
 check(o->ORB_REVNUM()==37693,"revolution number");
 check(o->PERTURBATIONS()->GRAVITY_MODEL()->str()=="EGM-96" && o->PERTURBATIONS()->GRAVITY_DEGREE()==70 && o->PERTURBATIONS()->GRAVITY_ORDER()==70,"gravity");
 check(o->PERTURBATIONS()->N_BODY_PERTURBATIONS()->size()==2,"lunar and solar bodies");
 check(o->PERTURBATIONS()->FIXED_F10P7()==153 && o->PERTURBATIONS()->FIXED_F10P7_MEAN()==137 && o->PERTURBATIONS()->FIXED_GEOMAG_AP()==10,"space weather");
 check(o->ORBIT_DETERMINATION()->SEDR()==0.39E-02 && o->ORBIT_DETERMINATION()->WEIGHTED_RMS()==0.11498E+01,"SEDR and weighted RMS");
 check(o->PHYSICAL_PROPERTIES()==nullptr,"Cd*A/m product is not split into Cd and area");
 check(o->COVARIANCE_DATA()==nullptr,"equinoctial covariance is not converted");
 check(numbers(param(o,"VCM_BALLISTIC_COEF_M2_PER_KG"))==std::vector<double>{m.ballisticCoefficient},"ballistic coefficient carried exactly");
 check(numbers(param(o,"VCM_COVARIANCE_EQUINOCTIAL_LOWER_TRIANGLE"))==m.covariance,"covariance carried exactly");
 check(param(o,"VCM_COVARIANCE_EQUINOCTIAL_DIMENSION")=="7","covariance dimension");
 check(numbers(param(o,"VCM_UVW_POSITION_SIGMAS_KM"))==std::vector<double>(m.positionSigmas.begin(),m.positionSigmas.end()),"sigmas carried exactly");
 check(numbers(param(o,"VCM_ECI_TRUE_EQUATOR_MEAN_EQUINOX_OF_DATE_STATE_KM_KM_PER_S"))==std::vector<double>(m.eci.begin(),m.eci.end()),"ECI state carried exactly");
 check(numbers(param(o,"VCM_EFG_EARTH_FIXED_STATE_KM_KM_PER_S"))==std::vector<double>(m.efg.begin(),m.efg.end()),"EFG state carried exactly");
 check(sdn::vcm::shortest(0.826455E-02)=="0.00826455","shortest decimal text");

 // A known next leap second is published; a previous one is not.
 sdn::vcm::Message leap=m;leap.leapSecondUnknown=false;
 leap.leapSecond.iso="2024-06-30T23:59:60.000";
 OCMT withLeap;sdn::vcm::projectLegacy(leap,withLeap);
 check(withLeap.METADATA->NEXT_LEAP_EPOCH=="2024-06-30T23:59:60.000","next leap second");
 leap.leapSecond.iso="2016-12-31T23:59:60.000";
 OCMT previousLeap;sdn::vcm::projectLegacy(leap,previousLeap);
 check(previousLeap.METADATA->NEXT_LEAP_EPOCH.empty(),"previous leap second withheld");

 // $VCM record.
 VCMT record;
 record.CREATION_DATE="2024-01-01T00:00:00";record.ORIGINATOR="ORIGINATOR";record.OBJECT_NAME="OBJECT";
 record.OBJECT_ID="2020-001A";record.CENTER_NAME="EARTH";record.REF_FRAME="EME2000";record.TIME_SYSTEM="UTC";
 record.NORAD_CAT_ID=45000;record.REV_AT_EPOCH=1234;record.MASS=1200;record.DRAG_AREA=12.5;record.DRAG_COEFF=2.2;
 record.SOLAR_RAD_AREA=20;record.SOLAR_RAD_COEFF=1.3;record.GM=398600.4418;record.BSTAR=1.5e-5;record.CLASSIFICATION_TYPE="U";
 record.STATE_VECTOR=std::make_unique<VCMStateVectorT>();
 record.STATE_VECTOR->EPOCH="2024-01-01T00:00:00";
 record.STATE_VECTOR->X=7000;record.STATE_VECTOR->Y=1;record.STATE_VECTOR->Z=2;
 record.STATE_VECTOR->X_DOT=0.1;record.STATE_VECTOR->Y_DOT=7.5;record.STATE_VECTOR->Z_DOT=0.2;
 record.COVARIANCE={1e-6,2e-7,3e-6};record.COV_REFERENCE_FRAME="UVW";
 flatbuffers::FlatBufferBuilder vb(2048);vb.Finish(CreateVCM(vb,&record),VCMIdentifier());
 OCMT fromRecord;
 check(sdn::vcm::projectRecord(*GetVCM(vb.GetBufferPointer()),fromRecord,frameFor,error),"record projects");
 const auto recordBytes=finish(fromRecord);const OCM* r=read(recordBytes);
 check(r!=nullptr,"verified record $OCM");
 if(r){
  check(r->STATE_DATA()->Get(1)==1 && r->STATE_DATA()->Get(4)==7.5,"record state");
  check(r->TRAJ_REF_FRAME()->REFERENCE_FRAME_type()==RFMUnion::CelestialFrameWrapper,"record frame on the roster");
  check(r->PHYSICAL_PROPERTIES()->WET_MASS()==1200 && r->PHYSICAL_PROPERTIES()->DRAG_CONST_AREA()==12.5 &&
        r->PHYSICAL_PROPERTIES()->DRAG_COEFF_NOM()==2.2 && r->PHYSICAL_PROPERTIES()->SRP_CONST_AREA()==20 &&
        r->PHYSICAL_PROPERTIES()->SOLAR_RAD_COEFF()==1.3,"record physical properties");
  check(r->PERTURBATIONS()->GM()==398600.4418 && r->ORB_REVNUM()==1234,"record GM and revolution");
  check(r->METADATA()->OBJECT_DESIGNATOR()->str()=="45000" && r->HEADER()->CLASSIFICATION()->str()=="U","record identity");
  check(numbers(param(r,"VCM_COVARIANCE"))==record.COVARIANCE && param(r,"VCM_COV_REFERENCE_FRAME")=="UVW","record covariance carried");
 }
 // Off-roster frame keeps its name without a roster value.
 record.REF_FRAME="TOD";
 flatbuffers::FlatBufferBuilder tb(2048);tb.Finish(CreateVCM(tb,&record),VCMIdentifier());
 OCMT tod;
 check(sdn::vcm::projectRecord(*GetVCM(tb.GetBufferPointer()),tod,frameFor,error) && tod.TRAJ_REF_FRAME->NAME=="TOD" &&
       tod.TRAJ_REF_FRAME->REFERENCE_FRAME.type==RFMUnion::NONE,"off-roster frame named, not guessed");
 // Refusals.
 record.REF_FRAME="";
 flatbuffers::FlatBufferBuilder nb(2048);nb.Finish(CreateVCM(nb,&record),VCMIdentifier());
 OCMT noFrame;
 check(!sdn::vcm::projectRecord(*GetVCM(nb.GetBufferPointer()),noFrame,frameFor,error),"missing frame refused");
 record.REF_FRAME="EME2000";record.TIME_SYSTEM="";
 flatbuffers::FlatBufferBuilder ns(2048);ns.Finish(CreateVCM(ns,&record),VCMIdentifier());
 OCMT noTime;
 check(!sdn::vcm::projectRecord(*GetVCM(ns.GetBufferPointer()),noTime,frameFor,error),"missing time system refused");

 std::printf("%s vcm-ocm cases=%d failures=%d\n",failures==0?"PASS":"FAIL",cases,failures);
 return failures==0?0:1;
}
