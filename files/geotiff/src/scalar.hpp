#pragma once
// Numeric source windows, independent of imagery stretching and Earth CRS.
// TIFF codecs/layouts remain owned by image.hpp; ISIS3 owns only its PVL/core.
// Sources: TIFF 6.0; GDAL TIFFTAG_GDAL_METADATA; USGS ISIS3 cube format and
// SpecialPixel.h. Values are double precision DN * scale + offset; missing
// pixels have a separate mask and a zero value, never an invented elevation.
namespace scalar {
constexpr uint64_t kWindowPixels = 4 * 1024 * 1024;
constexpr uint64_t kChunkBytes = 64 * 1024 * 1024;
struct Window { uint32_t x, y, w, h; };
struct Result {
  uint32_t width=0, height=0, bits=0, format=0;
  double scale=1, offset=0, nodata=0;
  bool hasNodata=false;
  std::vector<double> values;
  std::vector<uint8_t> valid;
  std::string error;
  bool fail(const std::string& s) { error=s; return false; }
  bool allocate(const Window& w) {
    if (!w.w || !w.h || uint64_t(w.w)*w.h>kWindowPixels ||
        uint64_t(w.x)+w.w>width || uint64_t(w.y)+w.h>height)
      return fail("pixel window is empty, too large, or outside the source");
    values.assign(size_t(w.w)*w.h,0); valid.assign(values.size(),0); return true;
  }
  void put(size_t i,double dn,bool special=false) {
    const double value=dn*scale+offset;
    if (!special && std::isfinite(dn) && std::isfinite(value) && (!hasNodata || dn!=nodata)) {
      values[i]=value; valid[i]=1;
    }
  }
};
inline std::string trim(std::string s) {
  const auto a=s.find_first_not_of(" \t\r\n\"");
  if(a==std::string::npos)return "";
  return s.substr(a,s.find_last_not_of(" \t\r\n\"")-a+1);
}
inline bool number(const std::string& s,double* out) {
  char* end=nullptr; *out=std::strtod(s.c_str(),&end);
  return end!=s.c_str() && *end=='\0' && std::isfinite(*out);
}
inline bool xmlScale(const std::string& xml,const char* role,double* value) {
  size_t at=0;
  while((at=xml.find("<Item",at))!=std::string::npos) {
    const auto end=xml.find('>',at), close=xml.find("</Item>",end);
    if(end==std::string::npos || close==std::string::npos)return false;
    const auto tag=xml.substr(at,end-at);
    if(tag.find(std::string("role=\"")+role+"\"")!=std::string::npos &&
       (tag.find("sample=")==std::string::npos || tag.find("sample=\"0\"")!=std::string::npos))
      return number(trim(xml.substr(end+1,close-end-1)),value);
    at=close+7;
  }
  return true; // absent: the TIFF default
}
inline double sample(const uint8_t* p,uint32_t bits,uint32_t format) {
  if(bits==8)return format==2?double(int8_t(*p)):double(*p);
  if(bits==16){uint16_t v;std::memcpy(&v,p,2);return format==2?double(int16_t(v)):double(v);}
  if(format==3){float v;std::memcpy(&v,p,4);return v;}
  uint32_t v;std::memcpy(&v,p,4);return format==2?double(int32_t(v)):double(v);
}
inline bool tiffWindow(tiff::Sparse& src,const Window& w,Result& out) {
  image::Image im; im.file.src=&src;
  if(!image::load(im,false))return src.need.empty()?out.fail(im.file.error):false;
  if(im.levels.empty() || im.spp!=1 || im.photometric>1 || im.compression==7)
    return out.fail("elevation requires one scalar band and a lossless TIFF codec");
  const auto& lv=im.levels[0];
  out.width=lv.w;out.height=lv.h;out.bits=im.bps;out.format=im.sampleFormat;
  out.hasNodata=im.hasNodata;out.nodata=im.nodata;
  if(im.file.tag(0,42112)) {
    const uint8_t* p=nullptr;size_t n=0;
    if(!im.file.bytes(0,42112,&p,&n))return false;
    const std::string xml(reinterpret_cast<const char*>(p),n);
    if(!xmlScale(xml,"scale",&out.scale)||!xmlScale(xml,"offset",&out.offset))
      return out.fail("invalid GDAL scale/offset metadata");
  }
  if(!out.allocate(w))return false;
  const uint32_t xEnd=w.x+w.w,yEnd=w.y+w.h,step=im.bps/8;
  for(uint32_t cy=w.y/lv.chunkH;cy<=(yEnd-1)/lv.chunkH;++cy)
    for(uint32_t cx=w.x/lv.chunkW;cx<=(xEnd-1)/lv.chunkW;++cx) {
      const size_t index=size_t(cy)*lv.across+cx;
      if(uint64_t(lv.chunkW)*lv.chunkH*step>kChunkBytes || lv.counts[index]>kChunkBytes)
        return out.fail("TIFF chunk exceeds the 64 MiB scalar decode budget");
      std::vector<uint8_t> bytes;
      if(!image::decode(im,lv,index,false,&bytes)) {
        if(!src.need.empty())continue;
        return out.fail(im.file.error);
      }
      for(uint32_t y=std::max(w.y,cy*lv.chunkH);y<std::min(yEnd,(cy+1)*lv.chunkH);++y)
        for(uint32_t x=std::max(w.x,cx*lv.chunkW);x<std::min(xEnd,(cx+1)*lv.chunkW);++x) {
          const size_t pos=(size_t(y%lv.chunkH)*lv.chunkW+x%lv.chunkW)*step;
          if(pos+step>bytes.size())return out.fail("short decoded TIFF chunk");
          out.put(size_t(y-w.y)*w.w+x-w.x,sample(bytes.data()+pos,im.bps,im.sampleFormat));
        }
    }
  return src.need.empty();
}

struct Cube {
  uint64_t start=0;uint32_t width=0,height=0,tileW=0,tileH=0,bits=0,format=0;
  double base=0,multiplier=1;bool big=false,tiled=false;
};
inline bool cubeHeader(tiff::Sparse& src,uint64_t size,Cube& c,Result& out) {
  // Attached labels only. Bound the search; arbitrary binary never becomes PVL.
  std::string label;
  for(uint64_t n=std::min<uint64_t>(4096,size);n && n<=262144;n=std::min(n*2,size)) {
    const uint8_t* p=src.view(0,n);if(!p)return false;
    label.assign(reinterpret_cast<const char*>(p),size_t(n));
    if(label.find("\nEnd\n")!=std::string::npos || label.find("\nEnd\r\n")!=std::string::npos)break;
    if(n==size || n==262144)return out.fail("ISIS3 attached PVL End not found within 256 KiB");
  }
  std::vector<std::string> scope;std::map<std::string,std::string> core;
  for(size_t at=0;at<label.size();) {
    size_t end=label.find('\n',at);if(end==std::string::npos)end=label.size();
    std::string line=trim(label.substr(at,end-at));at=end+1;
    if(line=="End")break;
    const auto eq=line.find('=');const std::string key=trim(line.substr(0,eq));
    const std::string value=eq==std::string::npos?"":trim(line.substr(eq+1));
    if(key=="Object"||key=="Group"){scope.push_back(value);continue;}
    if(key=="End_Object"||key=="End_Group"){if(scope.empty())return out.fail("unbalanced ISIS PVL");scope.pop_back();continue;}
    if(std::find(scope.begin(),scope.end(),"Core")!=scope.end()) {
      if(key=="^Core")return out.fail("detached ISIS3 cores are not supported");
      if(eq!=std::string::npos && !core.emplace(key,value).second)return out.fail("duplicate ISIS3 Core field: "+key);
    }
  }
  const auto integer=[&](const char* key,uint64_t max,uint64_t* result) {
    double v=0;if(!number(core[key],&v)||v<1||v>double(max)||v!=std::floor(v))return false;
    *result=uint64_t(v);return true;
  };
  uint64_t width=0,height=0,start=0,bands=0;
  if(!integer("Samples",10000000,&width)||!integer("Lines",10000000,&height)||
     !integer("Bands",1,&bands)||!integer("StartByte",size,&start))return out.fail("invalid ISIS3 Core dimensions or StartByte");
  c.width=uint32_t(width);c.height=uint32_t(height);c.start=start-1;
  if(core["Type"]=="SignedWord"){c.bits=16;c.format=2;}
  else if(core["Type"]=="Real"){c.bits=32;c.format=3;}
  else return out.fail("ISIS3 elevation requires SignedWord or Real samples");
  if(core["ByteOrder"]!="Lsb" && core["ByteOrder"]!="Msb")return out.fail("unknown ISIS3 byte order");
  c.big=core["ByteOrder"]=="Msb";
  if(!number(core["Base"],&c.base)||!number(core["Multiplier"],&c.multiplier))return out.fail("invalid ISIS3 pixel scale/offset");
  c.tileW=c.width;c.tileH=1;
  if(core["Format"]=="Tile") {
    uint64_t tw=0,th=0;
    if(!integer("TileSamples",10000000,&tw)||!integer("TileLines",10000000,&th))return out.fail("invalid ISIS3 tile size");
    c.tileW=uint32_t(tw);c.tileH=uint32_t(th);c.tiled=true;
  }else if(core["Format"]!="BandSequential")return out.fail("unknown ISIS3 core format");
  const uint64_t chunks=((width+c.tileW-1)/c.tileW)*((height+c.tileH-1)/c.tileH);
  const uint64_t chunkBytes=uint64_t(c.tileW)*c.tileH*(c.bits/8);
  if(chunkBytes>kChunkBytes || c.start>size || chunks>(size-c.start)/chunkBytes)
    return out.fail("ISIS3 core exceeds file bounds or the 64 MiB chunk budget");
  return true;
}
inline bool cubeWindow(tiff::Sparse& src,uint64_t size,const Window& w,Result& out) {
  Cube c;if(!cubeHeader(src,size,c,out))return false;
  out.width=c.width;out.height=c.height;out.bits=c.bits;out.format=c.format;
  out.scale=c.multiplier;out.offset=c.base;
  if(!out.allocate(w))return false;
  const uint64_t step=c.bits/8,chunkBytes=uint64_t(c.tileW)*c.tileH*step;
  const uint64_t across=(uint64_t(c.width)+c.tileW-1)/c.tileW;
  for(uint32_t cy=w.y/c.tileH;cy<=(w.y+w.h-1)/c.tileH;++cy)
    for(uint32_t cx=w.x/c.tileW;cx<=(w.x+w.w-1)/c.tileW;++cx) {
      const uint8_t* bytes=src.view(c.start+(uint64_t(cy)*across+cx)*chunkBytes,chunkBytes);
      if(!bytes)continue;
      for(uint32_t y=std::max(w.y,cy*c.tileH);y<std::min(w.y+w.h,(cy+1)*c.tileH);++y)
        for(uint32_t x=std::max(w.x,cx*c.tileW);x<std::min(w.x+w.w,(cx+1)*c.tileW);++x) {
          const uint8_t* p=bytes+(uint64_t(y%c.tileH)*c.tileW+x%c.tileW)*step;uint8_t tmp[4];
          for(size_t b=0;b<step;++b)tmp[b]=p[c.big?step-1-b:b];
          const double dn=sample(tmp,c.bits,c.format);
          // ISIS reserves all SignedWord values below -32752 and Real values
          // below VALID_MIN4 (including Null/LRS/LIS/HIS/HRS).
          const bool special=c.format==2?dn < -32752:dn < -3.4028226550889044521e38;
          out.put(size_t(y-w.y)*w.w+x-w.x,dn,special);
        }
    }
  return src.need.empty();
}
} // namespace scalar
