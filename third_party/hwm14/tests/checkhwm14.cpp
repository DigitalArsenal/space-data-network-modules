// C++ transcription of the NRL test driver nrl/checkhwm14.f90. Its output must
// be byte-identical to nrl/Check/gfortran.txt, the published gfortran result.
#include "../hwm14.hpp"

#include <cmath>
#include <cstdio>
#include <string>

#pragma STDC FP_CONTRACT OFF
#if defined(__clang__)
#pragma clang fp contract(off)
#elif defined(__GNUC__)
#pragma GCC optimize("fp-contract=off")
#endif

namespace {

std::string out;

// FORTRAN edit descriptors.
void A(int w, const std::string& s) {
    if (static_cast<int>(s.size()) >= w) out += s.substr(0, w);
    else out += std::string(w - s.size(), ' ') + s;
}
void I(int w, int v) {
    std::string s = std::to_string(v);
    if (static_cast<int>(s.size()) > w) out += std::string(w, '*');
    else out += std::string(w - s.size(), ' ') + s;
}
void F(int w, int d, float x) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.*f", d, static_cast<double>(x));
    std::string s = buf;
    if (d == 0) s += ".";
    if (static_cast<int>(s.size()) > w) {
        // gfortran drops the optional leading zero before overflowing.
        if (s.rfind("0.", 0) == 0) s.erase(0, 1);
        else if (s.rfind("-0.", 0) == 0) s.erase(1, 1);
    }
    if (static_cast<int>(s.size()) > w) out += std::string(w, '*');
    else out += std::string(w - s.size(), ' ') + s;
}
void listDirected(const std::string& s) { out += " " + s + "\n"; }
void nl() { out += "\n"; }

float pershift(float x, float lo, float hi) {
    const float tol = 1e-4f;
    float pershiftv = x;
    const float a = lo;
    const float span = hi - lo;
    float offset = 0, offset1 = 0;
    if (span != 0) {
        offset = x - a;
        offset1 = std::fmod(offset, span);
        if (std::fabs(offset1) < tol) offset1 = 0;
    }
    pershiftv = a + offset1;
    if (offset < 0 && offset1 != 0) pershiftv = pershiftv + span;
    return pershiftv;
}

void header3() {
    out += std::string(6, ' ');
    A(22, "quiet"); A(22, "disturbed"); A(22, "total");
    nl();
}
void columns(int w0, const char* first) {
    A(w0, first);
    for (int k = 0; k < 3; ++k) { A(12, "mer"); A(10, "zon"); }
    nl();
}
void row(float qw[2], float dw[2], float w[2]) {
    F(12, 3, qw[0]); F(10, 3, qw[1]);
    F(12, 3, dw[0]); F(10, 3, dw[1]);
    F(12, 3, w[0]); F(10, 3, w[1]);
    nl();
}

}  // namespace

int main(int argc, char** argv) {
    hwm14::Model model;
    int iyd;
    float sec, alt, glat, glon, stl = 0, f107a = 0, f107 = 0;
    float ap[2] = {0, 0}, apqt[2] = {0, 0};
    float w[2], qw[2], dw[2];
    float mlt, mlat, kp, mmpwind, mzpwind, ut;
    int day;
    auto triple = [&]() {
        model.hwm14(iyd, sec, alt, glat, glon, stl, f107a, f107, apqt, qw);
        model.dwm07(iyd, sec, alt, glat, glon, ap, dw);
        model.hwm14(iyd, sec, alt, glat, glon, stl, f107a, f107, ap, w);
    };

    // Height profile.
    day = 150; iyd = 95000 + day; ut = 12.0f; sec = ut * 3600.0f; glat = -45.0f; glon = -85.0f;
    stl = pershift(ut + glon / 15.0f, 0.0f, 24.0f);
    ap[1] = 80.0f; apqt[1] = -1.0f;
    listDirected("height profile");
    A(5, "day="); I(3, day); A(5, ", ut="); F(4, 1, ut); A(7, ", glat="); F(5, 1, glat);
    A(7, ", glon="); F(6, 1, glon); A(6, ", stl="); F(4, 1, stl); A(5, ", ap="); F(5, 1, ap[1]); nl();
    header3(); columns(6, "alt");
    for (int ialt = 0; ialt <= 400; ialt += 25) {
        alt = static_cast<float>(ialt);
        triple();
        F(6, 0, alt); row(qw, dw, w);
    }
    nl(); nl();

    // Latitude profile.
    day = 305; iyd = 95000 + day; ut = 18.0f; sec = ut * 3600.0f; alt = 250.0f; glon = 30.0f;
    stl = pershift(ut + glon / 15.0f, 0.0f, 24.0f);
    ap[1] = 48.0f; apqt[1] = -1.0f;
    listDirected("latitude profile");
    A(5, "day="); I(3, day); A(5, ", ut="); F(4, 1, ut); A(6, ", alt="); F(5, 1, alt);
    A(7, ", glon="); F(6, 1, glon); A(6, ", stl="); F(4, 1, stl); A(5, ", ap="); F(5, 1, ap[1]); nl();
    header3(); columns(6, "glat");
    for (int ilat = -90; ilat <= 90; ilat += 10) {
        glat = static_cast<float>(ilat);
        triple();
        F(6, 1, glat); row(qw, dw, w);
    }
    nl(); nl();

    // Local time profile.
    day = 75; iyd = 95000 + day; alt = 125.0f; glat = 45.0f; glon = -70.0f;
    ap[1] = 30.0f; apqt[1] = -1.0f;
    listDirected("local time profile");
    A(5, "day="); I(3, day); A(6, ", alt="); F(5, 1, alt); A(7, ", glat="); F(5, 1, glat);
    A(7, ", glon="); F(6, 1, glon); A(5, ", ap="); F(5, 1, ap[1]); nl();
    out += std::string(5, ' '); A(22, "quiet"); A(22, "disturbed"); A(22, "total"); nl();
    columns(5, "stl");
    for (int istl = 0; istl <= 16; ++istl) {
        stl = 1.5f * static_cast<float>(istl);
        sec = (stl - glon / 15.0f) * 3600.0f;
        triple();
        F(5, 1, stl); row(qw, dw, w);
    }
    nl(); nl();

    // Longitude profile.
    day = 330; iyd = 95000 + day; ut = 6.0f; sec = ut * 3600.0f; alt = 40.0f; glat = -5.0f;
    ap[1] = 4.0f; apqt[1] = -1.0f;
    listDirected("longitude profile");
    A(5, "day="); I(3, day); A(5, ", ut="); F(4, 1, ut); A(6, ", alt="); F(5, 1, alt);
    A(7, ", glat="); F(5, 1, glat); A(7, ", glon="); F(6, 1, glon); A(5, ", ap="); F(5, 1, ap[1]); nl();
    header3(); columns(6, "glon");
    for (int ilon = -180; ilon <= 180; ilon += 20) {
        glon = static_cast<float>(ilon);
        triple();
        F(6, 0, glon); row(qw, dw, w);
    }
    nl(); nl();

    // Day of year profile.
    ut = 21.0f; sec = ut * 3600.0f; alt = 200.0f; glat = -65.0f; glon = -135.0f;
    stl = pershift(ut + glon / 15.0f, 0.0f, 24.0f);
    ap[1] = 15.0f; apqt[1] = -1.0f;
    listDirected("day of year profile");
    A(4, "ut="); F(4, 1, ut); A(6, ", alt="); F(5, 1, alt); A(7, ", glat="); F(5, 1, glat);
    A(7, ", glon="); F(6, 1, glon); A(6, ", stl="); F(4, 1, stl); A(5, ", ap="); F(5, 1, ap[1]); nl();
    header3(); columns(6, "day");
    for (day = 0; day <= 360; day += 20) {
        iyd = 95000 + day;
        triple();
        I(6, day); row(qw, dw, w);
    }
    nl(); nl();

    // Magnetic activity profile.
    day = 280; iyd = 95000 + day; ut = 21.0f; sec = ut * 3600.0f; alt = 350.0f; glat = 38.0f; glon = 125.0f;
    stl = pershift(ut + glon / 15.0f, 0.0f, 24.0f);
    ap[1] = 48.0f; apqt[1] = -1.0f;
    listDirected("magnetic activity profile");
    A(5, "day="); I(3, day); A(5, ", ut="); F(4, 1, ut); A(6, ", alt="); F(5, 1, alt);
    A(7, ", glat="); F(5, 1, glat); A(7, ", glon="); F(6, 1, glon); A(6, ", stl="); F(4, 1, stl); nl();
    header3(); columns(6, "ap");
    for (int iap = 0; iap <= 260; iap += 20) {
        ap[1] = static_cast<float>(iap);
        triple();
        F(6, 1, ap[1]); row(qw, dw, w);
    }
    nl(); nl();

    // DWM magnetic latitude profile.
    kp = 6.0f; mlt = 3.0f;
    listDirected("dwm: magnetic latitude profile");
    A(5, "mlt="); F(4, 1, mlt); A(5, ", kp="); F(3, 1, kp); nl();
    A(6, "mlat"); A(12, "mag mer"); A(10, "mag zon"); nl();
    for (int imlat = -90; imlat <= 90; imlat += 10) {
        mlat = static_cast<float>(imlat);
        model.dwm07b(mlt, mlat, kp, &mmpwind, &mzpwind);
        F(6, 1, mlat); F(12, 3, mmpwind); F(10, 3, mzpwind); nl();
    }
    nl(); nl();

    // DWM magnetic local time profile.
    kp = 6.0f; mlat = 45.0f;
    listDirected("dwm: magnetic local time profile");
    A(6, "mlat="); F(5, 1, mlat); A(5, ", kp="); F(3, 1, kp); nl();
    A(6, "mlt"); A(12, "mag mer"); A(10, "mag zon"); nl();
    for (int imlt = 0; imlt <= 16; ++imlt) {
        mlt = static_cast<float>(imlt) * 1.5f;
        model.dwm07b(mlt, mlat, kp, &mmpwind, &mzpwind);
        F(6, 1, mlt); F(12, 3, mmpwind); F(10, 3, mzpwind); nl();
    }
    nl(); nl();

    // DWM kp profile.
    mlat = -50.0f; mlt = 3.0f;
    listDirected("dwm: kp profile");
    A(6, "mlat="); F(5, 1, mlat); A(6, ", mlt="); F(4, 1, mlt); nl();
    A(6, "kp"); A(12, "mag mer"); A(10, "mag zon"); nl();
    for (int ikp = 0; ikp <= 18; ++ikp) {
        kp = static_cast<float>(ikp) * 0.5f;
        model.dwm07b(mlt, mlat, kp, &mmpwind, &mzpwind);
        F(6, 1, kp); F(12, 3, mmpwind); F(10, 3, mzpwind); nl();
    }
    nl(); nl();

    if (argc > 1) {
        FILE* f = std::fopen(argv[1], "wb");
        if (!f) return 2;
        std::fwrite(out.data(), 1, out.size(), f);
        std::fclose(f);
    } else {
        std::fwrite(out.data(), 1, out.size(), stdout);
    }
    return 0;
}
