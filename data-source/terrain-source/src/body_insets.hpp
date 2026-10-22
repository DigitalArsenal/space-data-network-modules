// Small per-file geometry; the static rows live only in body_plan.hpp.
// The planner transmits the selected row as options alongside byte ranges.
struct BodyInset {
    const char* name="";
    double radius=0;
    uint64_t bytes=0;
    BodyGeoTiff tiff;
    BodyInset() = default;
    constexpr BodyInset(const char* n,double r,uint32_t w,uint32_t h,uint32_t bits,double x,double y,double step,double nd,
              uint64_t first,uint64_t row,uint64_t size,bool le):name(n),radius(r),bytes(size),
              tiff{w,h,bits,x,y,step,step,r,nd,first,row,le} {}
    std::string descriptor() const {
        char s[512];std::snprintf(s,sizeof(s),",%.17g,%u,%u,%u,%.17g,%.17g,%.17g,%.17g,%llu,%llu,%llu,%u",radius,tiff.width,tiff.height,tiff.bits,
            tiff.origin_x,tiff.origin_y,tiff.scale_x,tiff.nodata,static_cast<unsigned long long>(tiff.first_strip),static_cast<unsigned long long>(tiff.row_bytes),static_cast<unsigned long long>(bytes),tiff.little?1:0);
        return std::string(name)+s;
    }
    bool parse(const std::string& s) {
        const auto comma=s.find(',');if(comma==std::string::npos)return false;
        double r,x,y,step,nd;unsigned w,h,bits,le;unsigned long long first,row,size;
        if(std::sscanf(s.c_str()+comma,",%lf,%u,%u,%u,%lf,%lf,%lf,%lf,%llu,%llu,%llu,%u",&r,&w,&h,&bits,&x,&y,&step,&nd,&first,&row,&size,&le)!=12||
           !(r>0&&step>0)||!std::isfinite(x)||!std::isfinite(y)||!w||!h||w>1000000||h>1000000||(bits!=16&&bits!=32)||le>1||row!=static_cast<uint64_t>(w)*(bits/8)||first>size||h>(size-first)/row)return false;
        *this=BodyInset(s.compare(0,4,"HMC_")==0?"HMC_":"inset",r,w,h,bits,x,y,step,nd,first,row,size,le!=0);return true;
    }
};
