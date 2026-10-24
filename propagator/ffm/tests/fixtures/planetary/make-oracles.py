#!/usr/bin/env python3
"""Writes oracles.json: independently computed values the planetary E2E compares the shipped C++ with.

    make-oracles.py <sources-dir> <naif-kernels-dir> <out.json>

Nothing here shares code with FFM.
  rotation.moon   NAIF CSPICE pxform('J2000', 'MOON_PA_DE440') from moon_pa_de440_200625.bpc + moon_de440_250416.tf.
  rotation.mars   MRO120F's PDS label (jgmro_120f_sha.lbl) Euler-angle model evaluated by a separate implementation (numpy, the label's
                  formula rIN = Rz(-N) Rx(-J) Rz(-PSI) Rx(-I) Rz(-PHI) rBF in EME2000, frame bias from the IAU 2000 values), and the
                  angle between the label's pole and spin and CSPICE's IAU_MARS (pck00011.tpc) at the same epochs.
  fields          the harmonic acceleration (degree 2 up, body-fixed, km/s^2) of the PDS tables' float64 coefficients: the potential
                  V = GM/r sum (R/r)^n sum Pbar_nm(sin phi) (C cos m lambda + S sin m lambda) by the standard forward-column recursion
                  of the fully normalized associated Legendre functions, differentiated by central differences (step 4 m).
  thirdBody       the Moon's harmonic field on a GEO satellite minus its value at the Earth's center: CSPICE positions and rotation,
                  the potential gradient above.
Run with an interpreter that has spiceypy and numpy; os._exit after flushing (spiceypy can stall at exit).
"""
import json, math, os, sys
import numpy as np
import spiceypy as sp

def load(path):
    lines = [l for l in open(path, 'r', encoding='latin1').read().splitlines() if l.strip()]
    h = [float(x) for x in lines[0].split(',')]
    R, GM, deg = h[0], h[1], int(h[3])
    C = np.zeros((deg + 1, deg + 1)); S = np.zeros((deg + 1, deg + 1))
    for l in lines[1:]:
        f = l.split(','); n = int(f[0]); m = int(f[1]); C[n, m] = float(f[2]); S[n, m] = float(f[3])
    return R, GM, deg, C, S

def potential(R, GM, C, S, deg, order, tess, p):
    x, y, z = p; r = math.sqrt(x * x + y * y + z * z)
    sphi = z / r; cphi = math.sqrt(1 - sphi * sphi); lam = math.atan2(y, x)
    P = np.zeros((deg + 1, deg + 1)); P[0, 0] = 1.0
    P[1, 0] = math.sqrt(3) * sphi; P[1, 1] = math.sqrt(3) * cphi
    for m in range(2, deg + 1): P[m, m] = math.sqrt((2 * m + 1) / (2 * m)) * cphi * P[m - 1, m - 1]
    for m in range(0, deg): P[m + 1, m] = math.sqrt(2 * m + 3) * sphi * P[m, m]
    for m in range(0, deg + 1):
        for n in range(m + 2, deg + 1):
            a = math.sqrt((2 * n - 1) * (2 * n + 1) / ((n - m) * (n + m)))
            b = math.sqrt((2 * n + 1) * (n + m - 1) * (n - m - 1) / ((n - m) * (n + m) * (2 * n - 3)))
            P[n, m] = a * sphi * P[n - 1, m] - b * P[n - 2, m]
    cm = [math.cos(m * lam) for m in range(deg + 1)]; sm = [math.sin(m * lam) for m in range(deg + 1)]
    total = 0.0
    for n in range(2, deg + 1):
        s = 0.0
        for m in range(0, min(n, order) + 1):
            if m >= 1 and n > tess: continue
            s += P[n, m] * (C[n, m] * cm[m] + S[n, m] * sm[m])
        total += (R / r) ** n * s
    return GM / r * total

def accel(R, GM, C, S, deg, order, tess, p, h):
    g = []
    for k in range(3):
        a = list(p); b = list(p); a[k] += h; b[k] -= h
        g.append((potential(R, GM, C, S, deg, order, tess, a) - potential(R, GM, C, S, deg, order, tess, b)) / (2 * h))
    return np.array(g)

def mars_matrix(et):
    # MRO120F label: angles in degrees, T days since J2000; seasonal spin terms in milliarcseconds from January 1999.
    d = math.radians
    T = et / 86400.0
    N, J = 3.37919183, 24.67682669
    psi = 81.9683921212 - 0.0000057829 * T
    inc = 25.1893814715 - 0.000000001 * T
    phi = 133.386372559 + 350.891985314 * T
    ang = 2 * math.pi * (T - (-365.5)) / 687.0
    for k, (c, s) in enumerate([(488, -117), (-108, -99), (-16, -9), (3, -2)], start=1):
        phi += (c * math.cos(k * ang) + s * math.sin(k * ang)) / 3.6e6
    def Rz(t): c, s = math.cos(t), math.sin(t); return np.array([[c, s, 0], [-s, c, 0], [0, 0, 1]])
    def Rx(t): c, s = math.cos(t), math.sin(t); return np.array([[1, 0, 0], [0, c, s], [0, -s, c]])
    M = Rz(d(phi)) @ Rx(d(inc)) @ Rz(d(psi)) @ Rx(d(J)) @ Rz(d(N))
    # GCRF -> EME2000: the IAU 2000 frame bias (SOFA bi00 and the pole offsets, as ERFA eraBp00 at J2000).
    dpsibi, depsbi, dra0 = -0.041775 / 206264.80624709636, -0.0068192 / 206264.80624709636, -0.0146 / 206264.80624709636
    eps0 = 84381.448 / 206264.80624709636
    B = Rz(0) @ np.eye(3)
    # first-order bias matrix: rotations about x, y, z of (-depsbi, dpsibi sin eps0, dra0)
    B = np.array([[1, dra0, -dpsibi * math.sin(eps0)], [-dra0, 1, -depsbi], [dpsibi * math.sin(eps0), depsbi, 1]])
    return M @ B

def main():
    sources, kernels, out = sys.argv[1:4]
    for k in ['naif0012.tls', 'pck00011.tpc', 'moon_de440_250416.tf', 'moon_pa_de440_200625.bpc', 'de440s.bsp']:
        sp.furnsh(os.path.join(kernels, k))
    data = {'_comment': 'Independent oracles for tests/planetary.e2e.mjs; see make-oracles.py.'}
    ets = [7.0e8, 7.6e8, 8.0e8, 8.2e8, 8.5e8, 9.0e8]   # inside the embedded libration window (2022-2037)
    data['rotation'] = {'epochsTdbSeconds': ets,
        'moon': [sp.pxform('J2000', 'MOON_PA_DE440', e).flatten().tolist() for e in ets],
        'mars': [mars_matrix(e).flatten().tolist() for e in ets]}
    iau = []
    for e in ets:
        M = mars_matrix(e); I = sp.pxform('J2000', 'IAU_MARS', e)
        pole = math.degrees(math.acos(max(-1, min(1, float(np.dot(M[2], I[2])))))) * 3600
        total = math.degrees(math.acos(max(-1, min(1, (np.trace(M @ I.T) - 1) / 2)))) * 3600
        iau.append({'poleArcsec': pole, 'rotationArcsec': total})
    data['rotation']['marsVsIau'] = iau
    fields = []
    plan = [('301', 'grail', 'gggrx_0660pm_sha.tab', 'src-pds-grail-grgm660prim', [(70, 70, 70), (150, 150, 150), (100, 30, 20)],
             [[1800.0, 300.0, 700.0], [-1745.0, 120.0, -420.0], [300.0, 1700.0, -900.0], [1740.0, 5.0, 12.0]]),
            ('499', 'mro', 'jgmro_120f_sha.tab', 'src-pds-mro-mars-gravity', [(120, 120, 120), (60, 40, 30)],
             [[3700.0, 400.0, 1200.0], [-3500.0, -900.0, 800.0], [500.0, 3600.0, -1500.0]])]
    for body, _, file, directory, truncs, points in plan:
        R, GM, deg, C, S = load(os.path.join(sources, directory, file))
        for (d, o, t) in truncs:
            fields.append({'body': int(body), 'degree': d, 'order': o, 'tesseral': t, 'points': points,
                           'acceleration': [accel(R, GM, C, S, d, o, t, p, 0.004).tolist() for p in points]})
    data['fields'] = fields
    # Third body: the Moon's harmonic field on a GEO satellite (position x 42164 km) at ET 8.3e8, minus its value at the Earth's center.
    R, GM, deg, C, S = load(os.path.join(sources, 'src-pds-grail-grgm660prim', 'gggrx_0660pm_sha.tab'))
    et = 8.3e8
    M = sp.pxform('J2000', 'MOON_PA_DE440', et)
    rm = np.array(sp.spkez(301, et, 'J2000', 'NONE', 399)[0][:3])
    sat = np.array([42164.0, 0.0, 0.0])
    third = []
    for d in (2, 10):
        harm = lambda rel: M.T @ accel(R, GM, C, S, d, d, d, (M @ np.array(rel)).tolist(), 0.5)
        third.append({'central': 399, 'degree': d, 'etTdb': et, 'satellite': sat.tolist(), 'moonPosition': rm.tolist(),
                      'harmonic': (harm(sat - rm) - harm(-rm)).tolist()})
    data['thirdBody'] = third
    json.dump(data, open(out, 'w'), indent=1)
    print('oracles written', os.path.getsize(out), 'bytes')
    sys.stdout.flush()

if __name__ == '__main__':
    main()
    os._exit(0)
