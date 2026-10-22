// Arithmetic access to verified uncompressed, one-row-strip GeoTIFF editions.
// inset-overviews.mjs checks every strip offset/byte count and translated pixel.
// No strip arrays or raster values are compiled; If-Match pins each edition.
struct BodyTiffRange { uint64_t first=0; const std::string* bytes=nullptr; };
struct BodyTiffWindow { uint32_t x0=0,y0=0,x1=0,y1=0; };
struct BodyGeoTiff {
    uint32_t width=0,height=0,bits=0;
    double origin_x=0,origin_y=0,scale_x=0,scale_y=0,radius_m=0,nodata=0;
    uint64_t first_strip=0,row_bytes=0;
    bool little=true;
    void pixel(double lon,double lat,double* x,double* y) const {
        constexpr double rad=3.14159265358979323846/180;
        *x=(lon*radius_m*rad-origin_x)/scale_x-.5;
        *y=(origin_y-lat*radius_m*rad)/scale_y-.5;
    }
    bool window(double west,double south,double east,double north,double halo_m,BodyTiffWindow* out) const {
        double x0,y0,x1,y1;pixel(west,north,&x0,&y0);pixel(east,south,&x1,&y1);
        x0=std::floor(x0-halo_m/scale_x)-2;y0=std::floor(y0-halo_m/scale_y)-2;
        x1=std::ceil(x1+halo_m/scale_x)+2;y1=std::ceil(y1+halo_m/scale_y)+2;
        if(x1<0||y1<0||x0>=width||y0>=height)return false;
        out->x0=static_cast<uint32_t>(std::max(0.0,x0));out->y0=static_cast<uint32_t>(std::max(0.0,y0));
        out->x1=static_cast<uint32_t>(std::min<double>(width-1,x1));out->y1=static_cast<uint32_t>(std::min<double>(height-1,y1));return true;
    }
    std::vector<std::pair<uint64_t,uint64_t>> ranges(const BodyTiffWindow& w,uint64_t maximum_bytes) const {
        std::vector<std::pair<uint64_t,uint64_t>> out;
        const uint64_t rows=std::max<uint64_t>(1,maximum_bytes/row_bytes);
        for(uint64_t y=w.y0;y<=w.y1;y+=rows)out.push_back({first_strip+y*row_bytes,std::min<uint64_t>(rows,w.y1-y+1)*row_bytes});
        return out;
    }
    bool decode(const BodyTiffWindow& w,const std::vector<BodyTiffRange>& ranges,std::vector<float>* samples,float absent) const {
        const size_t cols=w.x1-w.x0+1,step=bits/8;samples->resize(cols*(w.y1-w.y0+1));
        for(uint64_t y=w.y0;y<=w.y1;y++) {
            const uint64_t at=first_strip+y*row_bytes+w.x0*step,bytes=cols*step;const uint8_t* p=nullptr;
            for(const auto& r:ranges)if(r.bytes&&at>=r.first&&at-r.first<=r.bytes->size()&&bytes<=r.bytes->size()-(at-r.first)){p=reinterpret_cast<const uint8_t*>(r.bytes->data())+at-r.first;break;}
            if(!p)return false;
            for(size_t x=0;x<cols;x++) {
                uint32_t u=0;for(size_t b=0;b<step;b++)u|=static_cast<uint32_t>(p[x*step+(little?b:step-1-b)])<<(8*b);
                float v;if(bits==16)v=static_cast<int16_t>(u);else std::memcpy(&v,&u,4);
                (*samples)[(y-w.y0)*cols+x]=std::isfinite(v)&&v!=nodata?v:absent;
            }
        }
        return true;
    }
};
