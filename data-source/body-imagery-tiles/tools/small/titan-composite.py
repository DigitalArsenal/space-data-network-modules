#!/usr/bin/env python3
# Titan: Cassini ISS 450 m partial (65S-45N, Float32 I/F) over the 4 km global (8-bit), one 8-bit raster on the 450 m lattice,
# strip-ordered, uncompressed, 0 = no data (values 1..255). Owner rule 10-21: fill no-data from the next coarser product, feather edges.
import numpy as np, sys, math
from osgeo import gdal
gdal.UseExceptions()
import os
B=os.environ.get('SMALL_WORK','.').rstrip('/')+'/'   # holds src/titan450.tif, src/titan4k.tif; writes derived/titan_composite_450m.tif
R=2575000.0; mdeg=R*math.pi/180
d=gdal.Open(B+'src/titan450.tif'); gt=d.GetGeoTransform(); P=d.ReadAsArray()
h,w=P.shape; px=450.0
valid=(P>0)&np.isfinite(P)&(P>-1e30)
print('partial',w,h,'valid frac',valid.mean())
g=gdal.Open(B+'src/titan4k.tif'); G=g.ReadAsArray().astype(np.float32); ggt=g.GetGeoTransform(); gh,gw=G.shape
def sampleG(lat,lon):   # bilinear, lon east deg (wraps), lat deg; 4k lattice: col=(clon+x/mdeg-... ) literal: lon_E = 180+(ggt0 + (c+.5)*px)/mdeg
    x=(lon-180.0)*mdeg; cf=(x-ggt[0])/ggt[1]-0.5; rf=(ggt[3]-lat*mdeg)/(-ggt[5])-0.5
    c0=np.floor(cf).astype(int); r0=np.floor(rf).astype(int); fc=(cf-c0).astype(np.float32); fr=(rf-r0).astype(np.float32)
    r0c=np.clip(r0,0,gh-1); r1c=np.clip(r0+1,0,gh-1); c0m=np.mod(c0,gw); c1m=np.mod(c0+1,gw)
    return (G[r0c,c0m]*(1-fc)*(1-fr)+G[r0c,c1m]*fc*(1-fr)+G[r1c,c0m]*(1-fc)*fr+G[r1c,c1m]*fc*fr)
# radiometric fit on 9x9 block means
k=9; hb,wb=h//k,w//k
Pm=np.where(valid,P,0).astype(np.float64)[:hb*k,:wb*k].reshape(hb,k,wb,k)
Vm=valid[:hb*k,:wb*k].reshape(hb,k,wb,k).mean((1,3)); Sm=Pm.sum((1,3))/np.maximum(valid[:hb*k,:wb*k].reshape(hb,k,wb,k).sum((1,3)),1)
rr,cc=np.meshgrid(np.arange(hb),np.arange(wb),indexing='ij')
lat=(gt[3]-((rr*k+k/2.0))*px)/mdeg; lon=180.0+(gt[0]+(cc*k+k/2.0)*px)/mdeg
G4=sampleG(lat,np.mod(lon,360.0))
m=(Vm>0.95)&(G4>0)
x=Sm[m]; y=G4[m]
a,b=np.polyfit(x,y,1)
for it in range(4):
    res=y-(a*x+b); s=np.std(res); keep=np.abs(res)<2.0*s
    a,b=np.polyfit(x[keep],y[keep],1)
print('fit a=%.1f b=%.2f  n=%d  corr=%.3f resid_sd=%.2f'%(a,b,m.sum(),np.corrcoef(x,y)[0,1],np.std(y-(a*x+b))))
# composite lattice
top=gt[3]; n_n=int(math.ceil((R*math.pi/2-top)/px)); n_s=int(math.ceil((R*math.pi/2+(top-h*px))/px)) if False else int(math.ceil((R*math.pi/2+(top-h*px)*-1)/px))
# bottom of partial = top - h*px (negative); south needed: (pi/2 R) - |bottom|
bottom=top-h*px; n_s=int(math.ceil((R*math.pi/2-(-bottom))/px))
H=n_n+h+n_s; ytop=top+n_n*px
print('composite',w,H,'ytop',ytop,'rows north/south',n_n,n_s)
out=np.zeros((H,w),np.uint8)
# 4 km fill, chunked
colx=(gt[0]+(np.arange(w)+0.5)*px); lonrow=np.mod(180.0+colx/mdeg,360.0)
for r0 in range(0,H,512):
    r1=min(H,r0+512)
    latv=(ytop-(np.arange(r0,r1)+0.5)*px)/mdeg
    LAT,LON=np.meshgrid(latv,lonrow,indexing='ij')
    out[r0:r1]=np.clip(np.rint(sampleG(LAT,LON)),1,255).astype(np.uint8)
# weight: erode valid by r, blur by r
r=32
def boxmean(a,rad):  # separable box mean via cumsum, float32 rows chunked
    a=a.astype(np.float32); n=2*rad+1
    c=np.cumsum(np.pad(a,((0,0),(rad+1,rad)),mode='edge'),axis=1,dtype=np.float64); a=((c[:,n:]-c[:,:-n])/n).astype(np.float32)
    c=np.cumsum(np.pad(a,((rad+1,rad),(0,0)),mode='edge'),axis=0,dtype=np.float64); return ((c[n:]-c[:-n])/n).astype(np.float32)
ev=boxmean(valid.astype(np.float32),r)>=0.9999
wt=boxmean(ev.astype(np.float32),r)
wt[~valid]=0
qs=np.linspace(0,100,401); qx=np.percentile(x,qs); qy=np.percentile(y,qs)
qx=np.maximum.accumulate(qx+np.arange(len(qx))*1e-12)
A=np.clip(np.rint(np.interp(P,qx,qy)),1,255)
# local low-frequency correction: smoothed (4 km product - mapped 450 m) block field added back
Ab=(np.where(valid,A,0).astype(np.float64)[:hb*k,:wb*k].reshape(hb,k,wb,k).sum((1,3)))/np.maximum(valid[:hb*k,:wb*k].reshape(hb,k,wb,k).sum((1,3)),1)
wv=(Vm>0.5)&(G4>0)
D=np.where(wv,G4-Ab,0.0); Wt=wv.astype(np.float64)
def sm(a,rad,it=3):
    for _ in range(it):
        n=2*rad+1
        c=np.cumsum(np.pad(a,((0,0),(rad+1,rad)),mode='wrap'),axis=1); a=(c[:,n:]-c[:,:-n])/n
        c=np.cumsum(np.pad(a,((rad+1,rad),(0,0)),mode='edge'),axis=0); a=(c[n:]-c[:-n])/n
    return a
Ds=sm(D,2)/np.maximum(sm(Wt,2),1e-6); Ds[sm(Wt,2)<1e-3]=0
print('low-freq correction mean %.1f sd %.1f'%(Ds[wv].mean(),Ds[wv].std()))
# bilinear upsample of Ds (block centres at (i+.5)k) to full res, rows then cols
ri=(np.arange(h)+0.5)/k-0.5; ci=(np.arange(w)+0.5)/k-0.5
r0=np.clip(np.floor(ri).astype(int),0,hb-1); r1=np.clip(r0+1,0,hb-1); fr=np.clip(ri-r0,0,1)[:,None]
c0=np.clip(np.floor(ci).astype(int),0,wb-1); c1=np.clip(c0+1,0,wb-1); fc=np.clip(ci-c0,0,1)[None,:]
Dfull=np.empty((h,w),np.float32)
for a0 in range(0,h,1024):
    a1=min(h,a0+1024)
    rows=Ds[r0[a0:a1]]*(1-fr[a0:a1])+Ds[r1[a0:a1]]*fr[a0:a1]
    Dfull[a0:a1]=(rows[:,c0]*(1-fc)+rows[:,c1]*fc).astype(np.float32)
A=np.clip(A+Dfull,1,255)
blend=np.where(valid,wt*A+(1-wt)*out[n_n:n_n+h].astype(np.float32),out[n_n:n_n+h].astype(np.float32))
out[n_n:n_n+h]=np.clip(np.rint(blend),1,255).astype(np.uint8)
drv=gdal.GetDriverByName('GTiff')
o=drv.Create(B+'derived/titan_composite_450m.tif',w,H,1,gdal.GDT_Byte,['COMPRESS=NONE','TILED=NO','BLOCKYSIZE=1','BIGTIFF=IF_SAFER'])
o.SetGeoTransform((gt[0],px,0,ytop,0,-px)); o.GetRasterBand(1).WriteArray(out); o=None
print('written')
