#!/usr/bin/env python3
"""Independent check of one encoded body (python3 -I verify.py --body KEY --out DIR --work DIR).
1. the deepest level re-assembled from the encoded files vs the source area-averaged by this script's own float64 separable
   average over the GDAL georeference (literal east longitude): mean abs diff, and the shift of 4 patches (must be <= 1 px);
2. orientation by the IAU gazetteer: crater/feature contrast on the ENCODED mosaic peaks at no mirror, left edge 180E.
"""
import argparse, json, math, os, subprocess, sys
import numpy as np
from osgeo import gdal, ogr
gdal.UseExceptions(); ogr.UseExceptions()
HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser(); ap.add_argument('--body'); ap.add_argument('--out'); ap.add_argument('--work')
ap.add_argument('--gaz', default='')
a = ap.parse_args()
bodies = {b['key']: b for b in json.load(open(os.path.join(HERE, 'bodies.json')))['bodies']}
b = bodies[a.body]; L = b['max_level']; R = b['radius_m']; mdeg = R * math.pi / 180
pgm = os.path.join(a.work, f'{b["naif"]}_L{L}.pgm')
subprocess.check_call(['node', os.path.join(HERE, 'assemble.mjs'), '--dir', a.out, '--naif', str(b['naif']), '--level', str(L), '--out', pgm])
enc = gdal.Open(pgm).ReadAsArray().astype(np.float64)
H, W = enc.shape
d = gdal.Open(os.path.join(a.work, b['file'])); gt = d.GetGeoTransform(); src = d.ReadAsArray().astype(np.float64)
if src.ndim == 3: src = src.mean(0)   # RGB: luminance as the channel mean (the encoded mosaic is assembled the same way)
sh, sw = src.shape
lon_left = (b['clon'] + gt[0] / mdeg) % 360.0                    # literal
valid = (src > 0).astype(np.float64); val = src * valid
def avg_axis(v, w, edges_src, axis):
    # area average along axis between fractional source edges, valid-weighted: returns sum(v*)/sum(w)
    n = len(edges_src) - 1
    def cum(x):
        c = np.cumsum(x, axis=axis)
        return np.concatenate([np.zeros_like(np.take(c, [0], axis=axis)), c], axis=axis)
    cv, cw = cum(v), cum(w)
    def at(c, e):
        i = np.clip(np.floor(e).astype(int), 0, c.shape[axis] - 1); f = np.clip(e - np.floor(e), 0, 1)
        i1 = np.clip(i + 1, 0, c.shape[axis] - 1)
        return np.take(c, i, axis=axis) * (1 - f if axis == 1 else (1 - f)[:, None]) + np.take(c, i1, axis=axis) * (f if axis == 1 else f[:, None]) if False else None
    return None
# simple exact separable area average by integral lookup with linear interpolation of the cumulative sum
def integ(x, axis):
    c = np.cumsum(x, axis=axis); z = np.zeros_like(np.take(c, [0], axis=axis)); return np.concatenate([z, c], axis=axis)
def lookup(c, e, axis):
    n = c.shape[axis] - 1; e = np.clip(e, 0, n); i = np.minimum(np.floor(e).astype(int), n - 1); f = e - i
    c0 = np.take(c, i, axis=axis); c1 = np.take(c, i + 1, axis=axis)
    sh_ = [1, 1]; sh_[axis] = -1; f = f.reshape(sh_)
    return c0 * (1 - f) + c1 * f
# output edges in source pixel coordinates
ow = 512 << L - 1 + 1 if False else (2 << L) * 256
oh = (1 << L) * 256
lon_e = -180.0 + np.arange(ow + 1) * 360.0 / ow                     # tile scheme: x from 180W (east longitude)
colE = ((lon_e - lon_left) % 360.0)  # degrees from the left edge, 0..360
px_deg = gt[1] / mdeg
colE = colE / px_deg
colE[-1] = colE[0] + 360.0 / px_deg if False else colE[-1]
# make monotone with wrap: last edge = first + 360/px_deg
colE = colE[0] + np.arange(ow + 1) * (360.0 / ow) / px_deg
lat_e = 90.0 - np.arange(oh + 1) * 180.0 / oh
rowE = (gt[3] - lat_e * mdeg) / gt[1]
# rows first (valid-weighted), columns with wrap by tiling the source twice
def reduce_axis(v, w, edges, axis):
    cv, cw = integ(v, axis), integ(w, axis)
    return lookup(cv, edges, axis), lookup(cw, edges, axis)
v_r, w_r = reduce_axis(val, valid, rowE, 0)
vr = np.diff(v_r, axis=0); wr = np.diff(w_r, axis=0)
vr2 = np.concatenate([vr, vr, vr], 1); wr2 = np.concatenate([wr, wr, wr], 1)
off = (colE[0] % sw) + sw; e = colE - colE[0] + off
v_c, w_c = reduce_axis(vr2, wr2, e, 1)
V = np.diff(v_c, axis=1); Wt = np.diff(w_c, axis=1)
ref = np.where(Wt > 1e-9, V / np.maximum(Wt, 1e-9), 0)
if os.environ.get('VERIFY_DUMP'): np.save(os.environ['VERIFY_DUMP'], ref)
m = (ref > 0) & (enc > 0)
mad = np.abs(ref[m] - enc[m]).mean()
print(f'{a.body}: level {L} {ow}x{oh}  measured pixels {m.mean():.3f}  mean|enc-ref| = {mad:.2f}/255')
# registration: 4 high-detail patches, shift by cross-correlation of gradient magnitude
def shift(p, q, r=3):
    best = (-9, 0, 0)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            pp = p[r:-r, r:-r]; qq = np.roll(np.roll(q, dy, 0), dx, 1)[r:-r, r:-r]
            c = np.corrcoef(pp.ravel(), qq.ravel())[0, 1]
            if c > best[0]: best = (c, dx, dy)
    return best
gy, gx = np.gradient(ref); g = np.hypot(gx, gy); g[~m] = 0
S = 128; shifts = []
bl = g[:H // S * S, :W // S * S].reshape(H // S, S, W // S, S).mean((1, 3)); idx = np.dstack(np.unravel_index(np.argsort(-bl.ravel()), bl.shape))[0]
picked = []
for (i, j) in idx:
    if all(abs(i - pi) > 2 or abs(j - pj) > 2 for pi, pj in picked): picked.append((i, j))
    if len(picked) == 4: break
for (i, j) in picked:
    c, dx, dy = shift(ref[i * S:(i + 1) * S, j * S:(j + 1) * S], enc[i * S:(i + 1) * S, j * S:(j + 1) * S])
    shifts.append((dx, dy)); print(f'   patch ({i},{j}) best shift dx={dx} dy={dy} corr={c:.3f}')
ok_reg = all(abs(dx) <= 1 and abs(dy) <= 1 for dx, dy in shifts)
# orientation by the gazetteer on the encoded mosaic
import importlib.util
gz = a.gaz or b['body'].upper()
if b.get('orientation'):
    print('   orientation: ' + b['orientation'])
    print('RESULT', json.dumps({'body': a.body, 'mad': round(float(mad), 3), 'registration_ok': bool(ok_reg), 'orientation_ok': None}))
    sys.exit(0 if (ok_reg and mad < 4) else 1)
if not os.path.exists(os.path.join(a.work, 'gaz', gz + '.zip')):
    print('   no IAU gazetteer for this body (giant planet): orientation by the published map convention only')
    print('RESULT', json.dumps({'body': a.body, 'mad': round(float(mad), 3), 'registration_ok': bool(ok_reg), 'orientation_ok': None}))
    sys.exit(0 if (ok_reg and mad < 4) else 1)
gzpath = os.path.join(os.path.dirname(a.work.rstrip('/')), 'gaz', gz + '.zip') if False else os.path.join(a.work, 'gaz', gz + '.zip')
ds = ogr.Open('/vsizip/' + gzpath); lay = ds.GetLayer(0)
F = []
kmpx = R * math.pi / 180 * (360.0 / ow) / 1000
for f in lay:
    D = f['diameter'] or 0; p = D / kmpx
    if 6 <= p <= 1500 and abs(f['center_lat']) <= 80: F.append((f['center_lat'], f['center_lon'], p, f['clean_name']))
if len(F) < 8:   # no feature sizes (Triton): features must sit on measured, detailed pixels at no mirror / 180 E, as they do nowhere else
    allf = [(f['center_lat'], f['center_lon']) for f in lay] if False else None
    lay.ResetReading(); P = np.array([(f['center_lat'], f['center_lon']) for f in lay])
    gy, gx = np.gradient(enc); gm = np.hypot(gx, gy)
    def cover(mirror, offd):
        col = np.mod(((P[:, 1] - offd) if not mirror else (offd - P[:, 1])) / (360.0 / ow), ow).astype(int); row = np.clip(((90 - P[:, 0]) / 180 * oh).astype(int), 0, oh - 1)
        return np.mean((enc[row, col] > 0) & (gm[row, col] > np.percentile(gm[enc > 0], 50)))
    cs = {(mm, o): cover(mm, o) for mm in (False, True) for o in range(0, 360, 2)}
    lit = cover(False, 180); best = max(cs.values())
    print(f'   gazetteer (no sizes) n={len(P)}: features on detailed measured pixels: literal {lit:.2f}, best other {max(v for k, v in cs.items() if k != (False, 180) and not (not k[0] and abs(k[1]-180) < 8)):.2f}')
    print('RESULT', json.dumps({'body': a.body, 'mad': round(float(mad), 3), 'registration_ok': bool(ok_reg), 'orientation_ok': bool(lit >= best - 0.05)}))
    sys.exit(0 if (ok_reg and lit >= best - 0.05 and mad < 4) else 1)
F = np.array([(x[0], x[1], x[2]) for x in F]); names = None
a2 = enc.copy(); ii = np.zeros((oh + 1, 2 * ow + 1)); ii[1:, 1:] = np.concatenate([a2, a2], 1).cumsum(0).cumsum(1)
def score(mirror, offd):
    lon = F[:, 1]; lat = F[:, 0]; p = F[:, 2]
    col = np.mod(((lon - offd) if not mirror else (offd - lon)) / (360.0 / ow), ow).astype(int); row = np.clip(((90 - lat) / 180 * oh).astype(int), 0, oh - 1)
    def box(h):
        r0 = np.clip(row - h, 0, oh); r1 = np.clip(row + h, 0, oh); c0 = np.clip(col + ow - h, 0, 2 * ow); c1 = np.clip(col + ow + h, 0, 2 * ow)
        return ii[r1, c1] - ii[r0, c1] - ii[r1, c0] + ii[r0, c0], (r1 - r0) * (c1 - c0)
    hin = np.maximum((p * .25).astype(int), 2); h0 = np.maximum((p * .6).astype(int), 3); h1 = np.maximum((p * .9).astype(int), 4)
    s_in, n_in = box(hin); s1, n1 = box(h1); s0, n0 = box(h0)
    return np.mean(np.abs(s_in / np.maximum(n_in, 1) - (s1 - s0) / np.maximum(n1 - n0, 1)))
res = {(mm, o): score(mm, o) for mm in (False, True) for o in range(0, 360, 1)}
best = max(res, key=res.get); base = np.mean(list(res.values())); sd = np.std(list(res.values()))
print(f'   gazetteer n={len(F)}: best mirror={best[0]} left edge {best[1]} E, z={(res[best]-base)/sd:.1f}  (expected mirror=False, 180 E)')
ok_or = (not best[0]) and min(abs(best[1] - 180), 360 - abs(best[1] - 180)) <= 3
print('RESULT', json.dumps({'body': a.body, 'mad': round(float(mad), 3), 'registration_ok': bool(ok_reg), 'orientation_ok': bool(ok_or)}))
sys.exit(0 if (ok_reg and ok_or and mad < 4) else 1)
