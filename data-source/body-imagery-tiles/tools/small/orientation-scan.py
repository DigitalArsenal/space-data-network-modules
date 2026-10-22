# objective orientation scan: crater-centre contrast vs longitude offset, both mirror choices
import sys, math, numpy as np
from osgeo import gdal, ogr
gdal.UseExceptions(); ogr.UseExceptions()
import os
B = os.environ.get('SMALL_WORK', '.').rstrip('/') + '/'
def run(name, gz, R, types=('Crater',), dmin_px=8, dmax_px=1500, step=1.0, lat_lim=80):
    d = gdal.Open(B+f'src/{name}.tif'); a = d.ReadAsArray().astype(np.float64)
    if a.ndim==3: a = a.mean(0)
    H,W = a.shape; delta=360.0/W; kmpx = R*math.pi/180*delta/1000
    ii = np.zeros((H+1,W+1)); ii[1:,1:] = a.cumsum(0).cumsum(1)
    def box(r0,r1,c0,c1):  # r,c arrays; clipped rows; cols modular handled by caller via doubled image
        return ii[r1,c1]-ii[r0,c1]-ii[r1,c0]+ii[r0,c0]
    # doubled-width integral to allow wrap
    a2 = np.concatenate([a,a],1); ii2 = np.zeros((H+1,2*W+1)); ii2[1:,1:] = a2.cumsum(0).cumsum(1)
    def bx(r0,r1,c0,c1): return ii2[r1,c1]-ii2[r0,c1]-ii2[r1,c0]+ii2[r0,c0]
    ds = ogr.Open('/vsizip/'+B+f'gaz/{gz}.zip'); l = ds.GetLayer(0)
    F=[]
    for f in l:
        if not any(t in (f['type'] or '') for t in types): continue
        D=f['diameter'] or 0; px=D/kmpx
        if px<dmin_px or px>dmax_px or abs(f['center_lat'])>lat_lim: continue
        F.append((f['center_lat'], f['center_lon'], px))
    F=np.array(F)
    if len(F)<5: print('few features',len(F)); return
    res={}
    for mirror in (False,True):
        for off in np.arange(0,360,step):
            # lonE -> src col: no mirror: col = (lonE - off)/delta ; mirror: col = (off - lonE)/delta
            lon=F[:,1]; lat=F[:,0]; px=F[:,2]
            col = ((lon-off) if not mirror else (off-lon))/delta
            col = np.mod(col, W)
            row = (90-lat)/180*H
            c = col.astype(int); r=row.astype(int)
            hin = np.maximum((px*0.25).astype(int),2); hout0=np.maximum((px*0.6).astype(int),3); hout1=np.maximum((px*0.9).astype(int),4)
            def mean_box(h):
                r0=np.clip(r-h,0,H); r1=np.clip(r+h,0,H); c0=np.clip(c+W-h,0,2*W); c1=np.clip(c+W+h,0,2*W)
                s=bx(r0,r1,c0,c1); n=(r1-r0)*(c1-c0); return s/np.maximum(n,1)
            m_in=mean_box(hin)
            # annulus = outer box(hout1) - box(hout0)
            def sum_box(h):
                r0=np.clip(r-h,0,H); r1=np.clip(r+h,0,H); c0=np.clip(c+W-h,0,2*W); c1=np.clip(c+W+h,0,2*W)
                return bx(r0,r1,c0,c1), (r1-r0)*(c1-c0)
            s1,n1=sum_box(hout1); s0,n0=sum_box(hout0)
            m_an=(s1-s0)/np.maximum(n1-n0,1)
            res[(mirror,off)] = np.mean(np.abs(m_in-m_an))
    # report
    allv=np.array(list(res.values())); mu,sd=allv.mean(),allv.std()
    best=sorted(res.items(), key=lambda kv:-kv[1])[:4]
    print(f'{name}: n={len(F)} mean={mu:.2f} sd={sd:.2f}')
    for (m,o),v in best: print(f'   mirror={m} lonE_left_edge={o:.1f}  score={v:.2f}  z={(v-mu)/sd:.1f}')
if __name__=='__main__':
    n,gz,R=sys.argv[1],sys.argv[2],float(sys.argv[3])
    types=tuple(sys.argv[4].split(',')) if len(sys.argv)>4 else ('Crater',)
    run(n,gz,R,types)
