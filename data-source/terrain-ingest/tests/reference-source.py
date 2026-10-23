#!/usr/bin/env python3
"""Independent packed-post oracle: GDAL reads source pixels and georeference.
Units: meters above source sphere; planetographic=planetocentric on a sphere.
Tolerance: one quantized-mesh height quantum plus 1e-5 m numerical rounding.
"""
import json,sys,math
import numpy as np
from osgeo import gdal

gdal.UseExceptions();cfg=json.load(open(sys.argv[1]));queries=json.load(open(sys.argv[2]))
d=gdal.Open(cfg['sourceFile']);b=d.GetRasterBand(1);gt=d.GetGeoTransform();crs=d.GetSpatialRef()
r=crs.GetSemiMajor();center=crs.GetProjParm('central_meridian');w,h=d.RasterXSize,d.RasterYSize
scale=b.GetScale() or 1;offset=b.GetOffset() or 0
if cfg['naif'] in (2000001,2000004):offset-=cfg['radiusM']
nodata=b.GetNoDataValue();band=cfg['options']['featherPixels'];fail=0;maxq=0;examples=[];counts={0:0,1:0,2:0}
for q in queries:
 delta=(q['lon']-center+180)%360-180
 x=(math.radians(delta)*r-gt[0])/gt[1]-.5;y=(gt[3]-math.radians(q['lat'])*r)/(-gt[5])-.5
 ix=math.floor(x+.5)%w;iy=max(0,min(h-1,math.floor(y+.5)))
 dn=float(b.ReadAsArray(ix,iy,1,1)[0,0]);expected=0.;flag=0
 if math.isfinite(dn) and dn!=nodata and abs(q['lat'])<90:
  distance=min(band,max(0,min(y+.5,h-.5-y)))
  # Independent brute-force footprint; only 35x35 source cells per query.
  xs=np.arange(math.floor(x-band-1),math.ceil(x+band+1)+1,dtype=np.int64)
  ys=np.arange(max(0,math.floor(y-band-1)),min(h-1,math.ceil(y+band+1))+1,dtype=np.int64)
  for yy in ys:
   # Rows are a GDAL-native source decode, including source scalar type.
   row=b.ReadAsArray(0,int(yy),w,1)[0];v=row[xs%w]
   invalid=(v==nodata)|~np.isfinite(v)
   if invalid.any():
    dx=np.maximum(0,np.abs(xs[invalid]-x)-.5);dy=max(0,abs(float(yy)-y)-.5)
    distance=min(distance,float(np.sqrt(dx*dx+dy*dy).min()))
  if distance>0:
   expected=dn*scale+offset
   if distance>=band:flag=1
   else:
    flag=2;t=distance/band;expected*=t*t*(3-2*t)
 error=abs(q['height']-expected);quanta=error/max(q['quantum'],1e-5);maxq=max(maxq,quanta);counts[flag]+=1
 if error>q['quantum']+1e-5 or q['flag']!=flag:
  fail+=1
  if len(examples)<10:examples.append(dict(q,expected=expected,expectedFlag=flag,errorM=error,errorQuanta=quanta,sourceX=ix,sourceY=iy))
extra={}
if cfg['naif']==199:
 extra['longitudeOrigin']={'pass':center==180 and fail==0, 'centralMeridianDeg':center, 'testedPackedPosts':len(queries), 'method':'GDAL CRS central meridian and original source pixels independently resolve every packed post longitude'}
if cfg['naif']==2000001:
 equatorY=int(math.floor(gt[3]/(-gt[5])));raw=b.ReadAsArray(0,equatorY-1,w,2);valid=raw[np.isfinite(raw)&(raw!=nodata)].astype(float)*(b.GetScale() or 1)+(b.GetOffset() or 0)
 extra['equatorialRadiusM']=float(valid.max())
 extra['equator']={'method':'Original GDAL pixels in two equatorial rows; radius = DN * scale + offset','posts':int(valid.size),'minimumRadiusM':float(valid.min()),'maximumRadiusM':float(valid.max()),'meanRadiusM':float(valid.mean())}
print(json.dumps({**extra,'tested':len(queries),'failed':fail,'maxErrorQuanta':maxq,'classes':counts,'examples':examples,'oracle':'GDAL original scalar pixel + independent cell-distance feather'}))
