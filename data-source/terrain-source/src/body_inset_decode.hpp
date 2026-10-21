struct BodyInsetFile {
    std::shared_ptr<BodyInset> inset;
    std::vector<BodyTiffRange> ranges;
};
bool decode_body_insets(const std::vector<BodyInsetFile>& files,const std::vector<TileExtent>& boxes,
                       DecodeBudget* budget,std::vector<DemGrid>* grids,std::string* error,double halo=0) {
    double west=1e300,east=-1e300,south=1e300,north=-1e300;
    for(const auto& b:boxes){west=std::min(west,b.west);east=std::max(east,b.east);south=std::min(south,b.south);north=std::max(north,b.north);}
    for(const auto& file:files) {
        const auto& in=*file.inset;const auto& t=in.tiff;BodyTiffWindow w;
        if(!t.window(west,south,east,north,halo,&w))continue;
        DemGrid g;g.inset=file.inset;g.width=w.x1-w.x0+1;g.height=w.y1-w.y0+1;g.off_x=w.x0;g.off_y=w.y0;
        const uint64_t bytes=static_cast<uint64_t>(g.width)*g.height*4;
        if(bytes>kDecodeByteBudget||!budget->admit(static_cast<size_t>(bytes))){*error="inset decode exceeds memory budget";return false;}
        const double arc=in.radius*kPolarPi/180;
        g.origin_lon=(t.origin_x+t.scale_x/2)/arc;g.origin_lat=(t.origin_y-t.scale_y/2)/arc;
        g.scale_lon=t.scale_x/arc;g.scale_lat=t.scale_y/arc;g.full_rows=t.height;
        if(!t.decode(w,file.ranges,&g.samples,kNoData)){*error="inset rows missing from requested ranges";return false;}
        g.ok=true;g.covers=true;grids->push_back(std::move(g));
    }
    return true;
}

// The feather mask is ALWAYS the 32 m overview (HMC: native 50 m), independent
// of the level's height source. Global coordinates make shared edges exact.
// A natively valid post in an invalid overview pixel footprint has d=0 => h=f.
// HMC files are assembled before indexing: internal file borders are not holes.
struct BodyInsetMask {
    BodyGeoTiff geometry;
    long left=0,top=0;
    uint32_t width=0,height=0;
    std::vector<float> mask;
    std::vector<std::array<int32_t,2>> boundary;
    static void order(std::vector<std::array<int32_t,2>>& points,size_t lo,size_t hi,unsigned axis) {
        if(lo>=hi)return;const size_t mid=(lo+hi)/2;
        std::nth_element(points.begin()+lo,points.begin()+mid,points.begin()+hi,[axis](const auto& a,const auto& b){return a[axis]<b[axis];});
        order(points,lo,mid,1-axis);order(points,mid+1,hi,1-axis);
    }
    void nearest(size_t lo,size_t hi,unsigned axis,double x,double y,double* best) const {
        if(lo>=hi)return;const size_t mid=(lo+hi)/2;const auto& p=boundary[mid];
        const double dx=x-p[0],dy=y-p[1],split=axis?dy:dx;*best=std::min(*best,dx*dx+dy*dy);
        if(split<0){nearest(lo,mid,1-axis,x,y,best);if(split*split<*best)nearest(mid+1,hi,1-axis,x,y,best);}
        else{nearest(mid+1,hi,1-axis,x,y,best);if(split*split<*best)nearest(lo,mid,1-axis,x,y,best);}
    }
    bool ready=false;
    bool build(const std::vector<DemGrid>& grids,const std::vector<TileExtent>& boxes,double band,DecodeBudget* budget) {
        if(grids.empty())return true;geometry=grids[0].inset->tiff;
        // HMC uses a fixed global origin for EVERY window/file selection. Its
        // source grids have integer 50 m centres; avoid file-dependent rounding.
        if(geometry.radius_m==3396000){geometry.origin_x=-25;geometry.origin_y=25;}
        double x0=1e300,y0=1e300,x1=-1e300,y1=-1e300;
        for(const auto& b:boxes){double x,y;geometry.pixel(b.west,b.north,&x,&y);x0=std::min(x0,x);y0=std::min(y0,y);geometry.pixel(b.east,b.south,&x,&y);x1=std::max(x1,x);y1=std::max(y1,y);}
        const double pad=band/geometry.scale_x+3;
        left=static_cast<long>(std::floor(x0-pad));top=static_cast<long>(std::floor(y0-pad));
        const uint32_t w=static_cast<uint32_t>(std::ceil(x1+pad)-left+1),h=static_cast<uint32_t>(std::ceil(y1+pad)-top+1);
        const uint64_t bytes=static_cast<uint64_t>(w)*h*24;
        if(bytes>kDecodeByteBudget||!budget->admit(static_cast<size_t>(bytes)))return false;
        width=w;height=h;mask.assign(static_cast<size_t>(w)*h,kNoData);boundary.clear();
        for(const auto& g:grids) {
            const auto& t=g.inset->tiff;
            const long dx=std::lround((t.origin_x-geometry.origin_x)/geometry.scale_x)+g.off_x-left;
            const long dy=std::lround((geometry.origin_y-t.origin_y)/geometry.scale_y)+g.off_y-top;
            for(long j=std::max(0L,-dy);j<g.height&&j+dy<h;j++)for(long i=std::max(0L,-dx);i<g.width&&i+dx<w;i++)
                if(g.samples[static_cast<size_t>(j)*g.width+i]!=kNoData)mask[static_cast<size_t>(j+dy)*w+i+dx]=1;
        }
        // Only invalid pixels adjacent to valid pixels can be nearest to a
        // valid mask footprint. The spatial index is invocation-local, derived
        // from fetched pixels; nothing about this boundary is compiled.
        for(uint32_t j=1;j+1<h;j++)for(uint32_t i=1;i+1<w;i++)if(mask[static_cast<size_t>(j)*w+i]==kNoData) {
            bool near=false;
            for(int dy=-1;dy<=1&&!near;dy++)for(int dx=-1;dx<=1;dx++)if(mask[static_cast<size_t>(j+dy)*w+i+dx]!=kNoData){near=true;break;}
            if(near)boundary.push_back({static_cast<int32_t>(left+i),static_cast<int32_t>(top+j)});
        }
        order(boundary,0,boundary.size(),0);ready=true;return true;
    }
    double distance(double lon,double lat,double band) const {
        if(!ready)return 0;double x,y;geometry.pixel(lon,lat,&x,&y);
        const long i=static_cast<long>(std::floor(x+.5))-left,j=static_cast<long>(std::floor(y+.5))-top;
        if(i<0||j<0||i>=width||j>=height||mask[static_cast<size_t>(j)*width+i]==kNoData)return 0;
        double best=std::pow(band/geometry.scale_x,2);nearest(0,boundary.size(),0,x,y,&best);
        return std::sqrt(best)*geometry.scale_x;
    }
};
