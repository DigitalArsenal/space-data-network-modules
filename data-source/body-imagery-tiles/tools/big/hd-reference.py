#!/usr/bin/env python3
"""Independent pixel-center sampler: GDAL reads source pixels, NumPy resamples.

Does not call the encoder's GDAL Warp or its radiometry implementation.
The finite-support radiometric specification is applied by separable convolution.
"""
import json
import math
import sys
from pathlib import Path
import numpy as np
from osgeo import gdal

gdal.UseExceptions()
gdal.SetCacheMax(64*1024*1024)
gdal.SetConfigOption('GDAL_DISABLE_READDIR_ON_OPEN','EMPTY_DIR')
gdal.SetConfigOption('GDAL_HTTP_MAX_RETRY','5')
sources=json.loads(Path(__file__).with_name('hd-sources.json').read_text())


def sample(url,etag,lon,lat):
    gdal.SetConfigOption('GDAL_HTTP_HEADERS',f'If-Match: "{etag}"')
    ds=gdal.Open('/vsicurl/'+url)
    gt=ds.GetGeoTransform();srs=ds.GetSpatialRef()
    radius=srs.GetSemiMajor();center=srs.GetProjParm('central_meridian',0)
    longitude=(lon-center+180)%360-180
    xx=(longitude*math.pi/180*radius-gt[0])/gt[1]-.5
    yy=(lat*math.pi/180*radius-gt[3])/gt[5]-.5
    ix=np.floor(xx).astype(int);iy=np.floor(yy).astype(int)
    x0=max(0,int(ix.min()));y0=max(0,int(iy.min()))
    x1=min(ds.RasterXSize-1,int(ix.max()+1));y1=min(ds.RasterYSize-1,int(iy.max()+1))
    if x1<x0 or y1<y0: raise ValueError('reference has no coverage')
    # One region-bounded read from the primary source, with no overviews.
    band=ds.GetRasterBand(1);a=band.ReadAsArray(x0,y0,x1-x0+1,y1-y0+1).astype(float)
    nodata=band.GetNoDataValue();a[a==nodata]=np.nan
    value=np.zeros((len(lat),len(lon)));weight=np.zeros_like(value)
    for dy in (0,1):
        for dx in (0,1):
            xs=ix+dx;ys=iy+dy
            v=a[np.clip(ys-y0,0,y1-y0)[:,None],np.clip(xs-x0,0,x1-x0)[None,:]]
            w=(1-np.abs(yy-(iy+dy)))[:,None]*(1-np.abs(xx-(ix+dx)))[None,:]
            ok=np.isfinite(v)&(xs>=0)[None,:]&(xs<ds.RasterXSize)[None,:]&(ys>=0)[:,None]&(ys<ds.RasterYSize)[:,None]
            value+=np.where(ok,v*w,0);weight+=np.where(ok,w,0)
    return np.divide(value,weight,out=np.full_like(value,np.nan),where=weight>0)


e=json.loads(Path(sys.argv[1]).read_text());u=e['unit'];s=sources[u['source']];p=e['provenance']
span=180/2**u['level'];step=span/256;halo=64
lon=-180+u['x']*span+(np.arange(u['tiles']*256+128)-halo+.5)*step
lat=-90+(u['row']+1)*span-(np.arange(384)-halo+.5)*step
raw=sample(s['url'],p['etag'],lon,lat);base=sample(s['base'],p['baseEtag'],lon,lat)
valid=np.isfinite(raw);base=np.nan_to_num(base,nan=0)
if p['stretch']:
    low,high=p['stretch'];raw=np.clip((raw-low)*254/(high-low)+1,1,255)
raw=np.where(valid,raw,base);offset=base-raw
kernel=np.ones(33)/33
for _ in range(3):
    for axis in (0,1):
        offset=np.apply_along_axis(lambda a:np.convolve(np.pad(a,(16,16),mode='edge'),kernel,mode='valid'),axis,offset)
image=np.clip(np.floor(raw+offset+.5),1,255);image[~valid]=base[~valid]
Path(sys.argv[2]).write_bytes(image[halo:-halo,halo:-halo].astype(np.uint8).tobytes())
