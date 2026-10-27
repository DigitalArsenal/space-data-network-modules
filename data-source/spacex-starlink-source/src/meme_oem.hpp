#pragma once
// SpaceX Modified ITC text and lossless SDS OEM encoding. No host ABI.

// math.h SVID matherr macros (SING/DOMAIN/...) collide with generated enum ids on
// native builds; undef before the generated header (the em++/WASI sysroot is clean).
#include <cmath>
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

#include <cstdint>
#include <array>
#include <memory>
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

// A typed-contracts build inlines the SDS $OEM types (lib/cpp, unscoped enums) and oem_fb_builder.hpp ahead of this
// header and defines MEME_OEM_TYPES_INLINED, MEME_OEM_FRAME and MEME_OEM_TIME_SYSTEM; the native test includes the
// licensing/core headers (scoped enums).
#ifndef MEME_OEM_TYPES_INLINED
#include "OEM_generated.h"
#include "oem_fb_builder.hpp"
#endif
#ifndef MEME_OEM_FRAME
#define MEME_OEM_FRAME CelestialFrame::EME2000
#endif
#ifndef MEME_OEM_TIME_SYSTEM
#define MEME_OEM_TIME_SYSTEM timingStandard::UTC
#endif
#ifndef MEME_OEM_COV_ORBIT_FRAME
#define MEME_OEM_COV_ORBIT_FRAME OrbitFrame::RSW_INERTIAL
#endif

namespace meme_oem {

struct MemeMeta {
    long norad_cat_id = 0;
    std::string object_name;   // STARLINK-#####
    std::string status;        // Operational
    std::string created_iso;   // from `created:` header
    std::string start_iso;     // from `ephemeris_start:` header
    std::string stop_iso;      // from `ephemeris_stop:` header
    std::string ephemeris_source;  // blend
    long step_size = 0;
};

// Normalize a MEME header UTC stamp ("2026-05-14 02:02:54 UTC") to ISO 8601
// ("2026-05-14T02:02:54Z"). Idempotent for already-ISO strings.
inline std::string normalize_utc(const std::string& in) {
    std::string s;
    // trim
    size_t a = in.find_first_not_of(" \t\r\n");
    size_t b = in.find_last_not_of(" \t\r\n");
    if (a == std::string::npos) return s;
    s = in.substr(a, b - a + 1);
    // strip trailing " UTC"
    if (s.size() >= 4 && s.compare(s.size() - 4, 4, " UTC") == 0) s = s.substr(0, s.size() - 4);
    // date/time separator space -> 'T'
    size_t sp = s.find(' ');
    if (sp != std::string::npos) s[sp] = 'T';
    // ensure trailing Z
    if (!s.empty() && s.back() != 'Z') s.push_back('Z');
    return s;
}

inline std::vector<std::string> split_ws(const std::string& line) {
    std::vector<std::string> toks;
    size_t i = 0;
    while (i < line.size()) {
        while (i < line.size() && (line[i] == ' ' || line[i] == '\t' || line[i] == '\r')) i++;
        size_t j = i;
        while (j < line.size() && line[j] != ' ' && line[j] != '\t' && line[j] != '\r') j++;
        if (j > i) toks.push_back(line.substr(i, j - i));
        i = j;
    }
    return toks;
}

// A MEME state line's first token is a YYYYDDDHHMMSS.sss stamp (>=13 leading
// digits, no exponent) — distinct from the scientific-notation covariance rows.
inline bool is_state_epoch_token(const std::string& t) {
    size_t digits = 0;
    for (char c : t) {
        if (c == '.') break;
        if (c < '0' || c > '9') return false;
        digits++;
    }
    return digits >= 13;
}

// Parse the MEME filename metadata.
// MEME_{NORAD}_{NAME}_{COSPAR-internal}_{Status}_{UnixTS}_UNCLASSIFIED.txt
// The 4th field is a SpaceX-internal id, NOT an international designator, so
// OBJECT_ID is intentionally left unset (per A2.2a labeling rules).
inline void parse_meme_filename(const std::string& filename, MemeMeta* m) {
    std::vector<std::string> parts;
    size_t start = 0;
    while (start <= filename.size()) {
        size_t us = filename.find('_', start);
        parts.push_back(filename.substr(start, (us == std::string::npos ? filename.size() : us) - start));
        if (us == std::string::npos) break;
        start = us + 1;
    }
    if (parts.size() >= 6 && parts[0] == "MEME") {
        m->norad_cat_id = strtol(parts[1].c_str(), nullptr, 10);
        m->object_name = parts[2];
        m->status = parts[4];
    }
}


// SpaceX Space Safety, Trajectories / Modified ITC: state epochs are UTC,
// states are EME2000 km and km/s, followed by 21 lower-triangle covariance
// entries in three rows. Preserve the declared UVW/EME2000 frame and values.
// No covariance adjustment, state interpolation, or uniform-time assumption.
struct Row {
    std::string epoch, ordering;
    std::array<double, 6> state{};
    std::array<double, 21> covariance{};
    bool has_covariance = false;
};
struct Document {
    MemeMeta meta;
    std::string covariance_frame;
    std::vector<Row> rows;
    bool truncated_tail = false;
};
inline std::string trim(const std::string& s) {
    auto a=s.find_first_not_of(" \t\r\n"), b=s.find_last_not_of(" \t\r\n");
    return a==std::string::npos ? "" : s.substr(a,b-a+1);
}
inline bool finite_number(const std::string& s, double* x) {
    char* end=nullptr;
    *x=std::strtod(s.c_str(), &end);
    return end!=s.c_str() && !*end && std::isfinite(*x);
}
// Calendar formatting uses integers; it never rounds an epoch through JD.
inline bool epoch_iso(const std::string& s, std::string* iso, std::string* ordering) {
    if(s.size()<13 || s.size()>23) return false;
    for(size_t i=0;i<13;i++) if(s[i]<'0'||s[i]>'9') return false;
    std::string fraction;
    if(s.size()>13) {
        if(s[13]!='.' || s.size()==14) return false;
        fraction=s.substr(14);
        for(char c:fraction)if(c<'0'||c>'9')return false;
    }
    const int y=std::atoi(s.substr(0,4).c_str()), doy=std::atoi(s.substr(4,3).c_str()), h=std::atoi(s.substr(7,2).c_str()),
              minute=std::atoi(s.substr(9,2).c_str()), second=std::atoi(s.substr(11,2).c_str());
    const bool leap=y%4==0 && (y%100!=0 || y%400==0);
    if(y<1||doy<1||doy>365+leap||h>23||minute>59||second>60) return false;
    int days[]={31,28+leap,31,30,31,30,31,31,30,31,30,31},m=0,d=doy;
    while(d>days[m])d-=days[m++];
    if(second==60 && !(h==23 && minute==59 && ((m==5&&d==30)||(m==11&&d==31))))return false;
    char base[40];std::snprintf(base,sizeof(base),"%04d-%02d-%02dT%02d:%02d:%02d",y,m+1,d,h,minute,second);
    *iso=std::string(base)+(fraction.empty()?"":"."+fraction)+"Z";
    *ordering=std::string(base)+"."+fraction+std::string(9-fraction.size(),'0');
    return true;
}
inline bool parse_document(const std::string& content, const MemeMeta& identity,
                           bool partial_range, Document* out, std::string* why) {
    *out=Document{};out->meta=identity;
    std::vector<std::string> lines;
    size_t begin=0;
    while(begin<content.size()) {
        size_t end=content.find('\n',begin);
        if(end==std::string::npos)end=content.size();
        lines.push_back(trim(content.substr(begin,end-begin)));begin=end+1;
    }
    auto fail=[&](const std::string& message){*why=message;return false;};
    if(lines.size()<4)return fail("Modified ITC requires three header lines and a covariance frame");
    out->covariance_frame=lines[3];
    if(out->covariance_frame!="UVW" && out->covariance_frame!="EME2000")return fail("Unsupported covariance frame: "+out->covariance_frame);
    std::vector<std::string> data;
    for(size_t i=4;i<lines.size();i++)if(!lines[i].empty())data.push_back(lines[i]);
    bool any_cov=false, any_without=false;
    for(size_t i=0;i<data.size();) {
        Row row;const auto tokens=split_ws(data[i++]);
        if(tokens.size()!=7) {
            if(partial_range && i==data.size() && content.back()!='\n'){out->truncated_tail=true;break;}
            return fail("State row must have one epoch and six values");
        }
        if(!epoch_iso(tokens[0],&row.epoch,&row.ordering))return fail("Invalid UTC state epoch: "+tokens[0]);
        if(!out->rows.empty() && row.ordering<=out->rows.back().ordering)return fail("State epochs must increase strictly");
        for(int j=0;j<6;j++)if(!finite_number(tokens[j+1],&row.state[j]))return fail("Nonfinite or malformed state value");
        if(i<data.size() && !is_state_epoch_token(split_ws(data[i])[0])) {
            if(data.size()-i<3 || (partial_range && data.size()-i==3 && content.back()!='\n')) {
                if(partial_range){out->truncated_tail=true;break;}
                return fail("Incomplete covariance: three rows required");
            }
            for(int j=0;j<3;j++) {
                const auto cov=split_ws(data[i+j]);
                if(cov.size()!=7) {
                    if(partial_range && i+j+1==data.size() && content.back()!='\n'){out->truncated_tail=true;break;}
                    return fail("Covariance row must have seven values");
                }
                for(int k=0;k<7;k++)if(!finite_number(cov[k],&row.covariance[j*7+k]))return fail("Nonfinite or malformed covariance value");
            }
            if(out->truncated_tail)break;
            i+=3;row.has_covariance=true;any_cov=true;
        } else if(partial_range && i==data.size()) {
            // A range ending immediately after a state cannot prove absence
            // of its covariance; keep only the preceding complete records.
            out->truncated_tail=true;break;
        } else any_without=true;
        out->rows.push_back(row);
    }
    if(out->rows.empty())return fail("No complete state records");
    if(any_cov && any_without)return fail("Mixed supplied and missing covariance: per-state availability would be lost by interpolation");
    return true;
}
inline std::vector<uint8_t> build_oem_fb(const Document& doc) {
    OEMT oem;
    std::unique_ptr<ephemerisDataBlockT> b(new ephemerisDataBlockT());
    b->OBJECT.reset(new CATT());b->OBJECT->OBJECT_NAME=doc.meta.object_name;
    b->OBJECT->NORAD_CAT_ID=static_cast<uint32_t>(doc.meta.norad_cat_id);
    b->CENTER_NAME="EARTH";b->TIME_SYSTEM=MEME_OEM_TIME_SYSTEM;b->STATE_VECTOR_SIZE=6;
    b->START_TIME=doc.rows.front().epoch;b->STOP_TIME=doc.rows.back().epoch;
    b->REFERENCE_FRAME.reset(new RFMT());b->REFERENCE_FRAME->NAME="EME2000";
    CelestialFrameWrapperT inertial;inertial.frame=MEME_OEM_FRAME;b->REFERENCE_FRAME->REFERENCE_FRAME.Set(inertial);
    b->COMMENT="Source: SpaceX Modified ITC. Exact row epochs and supplied covariance retained; no covariance calibration or repair.";
    if(doc.truncated_tail)b->COMMENT+=" HTTP range omitted an incomplete trailing record.";
    if(doc.rows.front().has_covariance) {
        b->COV_REFERENCE_FRAME.reset(new RFMT());b->COV_REFERENCE_FRAME->NAME=doc.covariance_frame;
        if(doc.covariance_frame=="UVW") {
            OrbitFrameWrapperT axes;axes.frame=MEME_OEM_COV_ORBIT_FRAME;b->COV_REFERENCE_FRAME->REFERENCE_FRAME.Set(axes);
        } else b->COV_REFERENCE_FRAME->REFERENCE_FRAME.Set(inertial);
    }
    for(const Row& row:doc.rows) {
        std::unique_ptr<ephemerisDataLineT> p(new ephemerisDataLineT());
        p->EPOCH=row.epoch;p->X=row.state[0];p->Y=row.state[1];p->Z=row.state[2];
        p->X_DOT=row.state[3];p->Y_DOT=row.state[4];p->Z_DOT=row.state[5];
        b->EPHEMERIS_DATA_LINES.push_back(std::move(p));
        if(!row.has_covariance)continue;
        const auto& v=row.covariance;std::unique_ptr<covarianceMatrixLineT> c(new covarianceMatrixLineT());c->EPOCH=row.epoch;
        c->CX_X=v[0];c->CY_X=v[1];c->CY_Y=v[2];c->CZ_X=v[3];c->CZ_Y=v[4];c->CZ_Z=v[5];
        c->CX_DOT_X=v[6];c->CX_DOT_Y=v[7];c->CX_DOT_Z=v[8];c->CX_DOT_X_DOT=v[9];
        c->CY_DOT_X=v[10];c->CY_DOT_Y=v[11];c->CY_DOT_Z=v[12];c->CY_DOT_X_DOT=v[13];c->CY_DOT_Y_DOT=v[14];
        c->CZ_DOT_X=v[15];c->CZ_DOT_Y=v[16];c->CZ_DOT_Z=v[17];c->CZ_DOT_X_DOT=v[18];c->CZ_DOT_Y_DOT=v[19];c->CZ_DOT_Z_DOT=v[20];
        b->COVARIANCE_MATRIX_LINES.push_back(std::move(c));
    }
    oem.EPHEMERIS_DATA_BLOCK.push_back(std::move(b));
    flatbuffers::FlatBufferBuilder builder(65536);FinishOEMBuffer(builder,CreateOEM(builder,&oem));
    return {builder.GetBufferPointer(),builder.GetBufferPointer()+builder.GetSize()};
}
} // namespace meme_oem
