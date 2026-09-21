#include "od/ocm_fb_builder.h"
#include "od/covariance_validation.h"
#include <cstdlib>
#include <iostream>
#include <limits>
#include <string>
#ifdef SING
#undef SING
#endif
#ifdef DOMAIN
#undef DOMAIN
#endif
#ifdef OVERFLOW
#undef OVERFLOW
#endif
#ifdef UNDERFLOW
#undef UNDERFLOW
#endif
#ifdef TLOSS
#undef TLOSS
#endif
#ifdef PLOSS
#undef PLOSS
#endif
#include "OCM_generated.h"

static void check(bool ok, const char* message) {
    if (!ok) { std::cerr << message << '\n'; std::exit(1); }
}
static const OCM* decode(const std::vector<uint8_t>& bytes) {
    flatbuffers::Verifier verifier(bytes.data(), bytes.size());
    check(VerifySizePrefixedOCMBuffer(verifier), "invalid OCM wire data");
    return GetSizePrefixedOCM(bytes.data());
}
static void unavailable(const od::OCMInputs& input, bool expect_state) {
    auto bytes = od::build_ocm_flatbuffer(input);
    const auto* o = decode(bytes);
    check(!o->COVARIANCE_DATA(), "unavailable covariance was fabricated");
    check(bool(o->STATE_DATA()) == expect_state, "state availability lost");
    check(o->ORBIT_DETERMINATION()->OD_COV_REDUCTION()->str() == "UNAVAILABLE", "missing unavailable status");
}
static double encoded_value(uint64_t bits) {
    volatile uint64_t input = bits; const uint64_t copy = input;
    double value; std::memcpy(&value, &copy, sizeof(value)); return value;
}
int main() {
    od::SGP4Elements el{}; el.epoch_iso = "2026-01-01T00:00:00.000Z"; el.object_name = "REFERENCE";
    od::OCMInputs in{}; in.el = &el; in.rms_km = 100; in.converged = true;
    unavailable(in, false); // RMS is not a covariance estimate.
    in.has_state = true; in.state_teme[0] = 7000; in.state_teme[4] = 7.5;
    unavailable(in, true);
    // Closed-form SPD reference, TEME at the epoch above, km and km/s:
    // independent (x,vx), (y,vy), (z,vz) 2x2 blocks have determinants
    // 4*1-1^2=3, 9*4-(-2)^2=32, 16*9-3^2=135, all positive.
    // Wire round-trip is exact, so tolerance is zero (no numerical transform).
    const double covariance[21] = {4,0,9,0,0,16,1,0,0,1,0,-2,0,0,4,0,0,3,0,0,9};
    std::copy(covariance,covariance+21,in.covariance); in.has_covariance = true;
    auto bytes = od::build_ocm_flatbuffer(in); const auto* o = decode(bytes);
    check(o->COVARIANCE_DATA() && o->COVARIANCE_DATA()->size()==21, "valid full covariance omitted");
    for (int i=0;i<21;i++) check(o->COVARIANCE_DATA()->Get(i)==covariance[i], "cross term changed");
    check(o->STATE_DATA()->Get(0)==7000, "state changed");
    check(o->METADATA()->START_TIME()->str()==el.epoch_iso, "state epoch missing");
    check(o->METADATA()->TIME_SYSTEM()->str()=="UTC", "time scale missing");
    bool frame=false,units=false;
    for(const auto* p:*o->USER_DEFINED_PARAMETERS()) {
        if(p->PARAM_NAME()->str()=="STATE_REFERENCE_FRAME") frame=p->PARAM_VALUE()->str()=="TEME";
        if(p->PARAM_NAME()->str()=="STATE_UNITS") units=p->PARAM_VALUE()->str()=="km,km,km,km/s,km/s,km/s";
    }
    check(frame&&units,"frame or units missing");
    in.covariance[1]=20; unavailable(in,true); // positive diagonals, indefinite full matrix
    std::copy(covariance,covariance+21,in.covariance);
    in.covariance[6]=2; unavailable(in,true); // singular x/vx block
    std::copy(covariance,covariance+21,in.covariance);
    in.covariance[4]=encoded_value(UINT64_C(0x7ff8000000000001)); unavailable(in,true);
    in.covariance[4]=encoded_value(UINT64_C(0x7ff0000000000000)); unavailable(in,true);
    std::copy(covariance,covariance+21,in.covariance);
    in.converged=false; unavailable(in,true);
    in.converged=true; in.state_teme[2]=encoded_value(UINT64_C(0x7ff8000000000001)); unavailable(in,false);
    in.state_teme[2]=0; el.epoch_iso.clear(); unavailable(in,false);
    const double full[] = {4,2,1}, rank_deficient[] = {4,2,0}, ill_conditioned[] = {4,2,1e-14};
    check(od::full_rank_normal_spectrum(full,3),"full-rank normal matrix rejected");
    check(!od::full_rank_normal_spectrum(rank_deficient,3),"zero singular value treated as zero uncertainty");
    check(!od::full_rank_normal_spectrum(ill_conditioned,3),"unobservable mode admitted");
    std::cout << "Covariance publication: exact SPD cross terms, absent/invalid/unconverged rejection, epoch/frame/units, rank gates PASS\n";
}
