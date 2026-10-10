#!/usr/bin/env python3
"""Independent expected values for fit_elements and element_residuals.

Writes tests/fit-reference.json. Nothing here calls the module:
  - SGP4: python-sgp4 (Vallado's C++ through its accelerated wrapper, WGS-72,
    opsmode 'i'); its pure-Python port for the Vallado cases' truth elements;
  - frames: pyerfa, GCRF -> TEME = Rz(ee06a) * pnm06a at TT from UTC, and the
    IAU 2006 frame bias (eraBp06) for EME2000;
  - fitting: scipy.optimize.least_squares (Levenberg-Marquardt) in classical
    elements, a different parameterization and solver from the module's.

Cases:
  vallado    Vallado's published SGP4 verification output (SGP4-VER.TLE and
             tcppver.out, as python-sgp4 ships them): the published TEME states
             of each case. Fitting them must recover the case's elements.
  synthetic  Seeded random element sets across regimes (low, Starlink-like and
             high LEO, sun-synchronous, GNSS MEO, GEO, Molniya, GTO), spans and
             samplings, propagated by python-sgp4 and written in GCRF, EME2000
             or TEME. Noise-free: the fit must recover the elements and the
             half-split closure (first half fitted, second half predicted) must
             stay within 1 cm.
  noisy      A Starlink-like case with seeded 50 m Gaussian noise per
             coordinate, fitted here by scipy. The module must find the same
             least-squares optimum, RMS and covariance.
  iss        The NASA ISS OEM fixture in analysis/od/tests/data/supgp-reference
             (EME2000/UTC, public US Government data), fitted here by scipy, and
             CelesTrak's Segment-01 SupGP set from the same fixture scored on it.

Run: python3 tests/fit-reference.py (python-sgp4 2.27, pyerfa 2.0.1.5,
scipy 1.18.1, numpy 2.5.3).
"""
import csv
import json
import math
import os
import random
from datetime import datetime, timedelta, timezone

import erfa
import numpy as np
import scipy
import sgp4
from scipy.optimize import least_squares
from sgp4.api import WGS72, Satrec

HERE = os.path.dirname(os.path.abspath(__file__))
SGP4_DIR = os.path.dirname(sgp4.__file__)
OD_ISS = os.path.join(HERE, '..', '..', 'od', 'tests', 'data', 'supgp-reference', 'iss')
EPOCH0 = datetime(1949, 12, 31, tzinfo=timezone.utc)
DEG = math.pi / 180
MU = 398600.8
RE = 6378.135


def iso(t):
    return t.strftime('%Y-%m-%dT%H:%M:%S.%f')


def tt_of(t):
    d1, d2 = erfa.dtf2d('UTC', t.year, t.month, t.day, t.hour, t.minute, t.second + t.microsecond * 1e-6)
    a1, a2 = erfa.utctai(d1, d2)
    return erfa.taitt(a1, a2)


BIAS = erfa.bp06(2451545.0, 0.0)[0]


def gcrf_to_teme(t):
    t1, t2 = tt_of(t)
    return erfa.rz(erfa.ee06a(t1, t2), erfa.pnm06a(t1, t2))


def satrec(epoch, el):
    """el: n (rev/day), e, i, raan, argp, M (deg), bstar."""
    s = Satrec()
    s.sgp4init(WGS72, 'i', 1, (epoch - EPOCH0).total_seconds() / 86400, el[6], 0.0, 0.0, el[1], el[4] * DEG,
               el[2] * DEG, el[5] * DEG, el[0] * 2 * math.pi / 1440, el[3] * DEG)
    return s


def teme(s, epoch, t):
    e, r, v = s.sgp4_tsince((t - epoch).total_seconds() / 60)
    if e != 0:
        raise ValueError(f'SGP4 error {e}')
    return np.array(r), np.array(v)


def frame_states(states, frame):
    """TEME states (t, r, v) to `frame` (TEME, GCRF or EME2000), velocities rotated with the same matrix."""
    out = []
    for t, r, v in states:
        if frame == 'TEME':
            out.append((t, r, v))
            continue
        m = gcrf_to_teme(t).T  # TEME -> GCRF
        rg, vg = m @ r, m @ v
        if frame == 'EME2000':
            rg, vg = BIAS @ rg, BIAS @ vg
        out.append((t, rg, vg))
    return out


def to_teme(states, frame):
    out = []
    for t, r, v in states:
        if frame == 'EME2000':
            r, v = BIAS.T @ r, BIAS.T @ v
        if frame != 'TEME':
            m = gcrf_to_teme(t)
            r, v = m @ r, m @ v
        out.append((t, r, v))
    return out


def fit(states_teme, epoch, x0, fit_bstar=True, start=None):
    """scipy least squares on TEME positions from `start` (default x0); x: n rev/day, e, i, raan, argp, M (deg)[, bstar].
    The covariance is s2 (J'J)^-1 with J by central differences at the solution."""
    def model(x):
        el = list(x[:6]) + [x[6] if fit_bstar else x0[6]]
        s = satrec(epoch, el)
        out = []
        for t, r, _ in states_teme:
            e, rr, _ = s.sgp4_tsince((t - epoch).total_seconds() / 60)
            out.extend(np.array(rr) - r if e == 0 else [1e3] * 3)
        return np.array(out)
    x = np.array((start if start is not None else x0)[:7 if fit_bstar else 6], dtype=float)
    scale = np.array([1e-6, 1e-6, 1e-4, 1e-4, 1e-2, 1e-2, 1e-5][:len(x)])
    sol = least_squares(model, x, x_scale=scale, method='lm', xtol=1e-15, ftol=1e-15, gtol=1e-15, max_nfev=20000)
    r = sol.fun.reshape(-1, 3)
    m, p = r.size, len(sol.x)
    s2 = (r ** 2).sum() / (m - p)
    steps = [1e-9 * sol.x[0], 1e-9, 1e-7, 1e-7, 1e-7, 1e-7, 1e-9 + 1e-5 * abs(sol.x[-1])][:p]
    J = np.zeros((m, p))
    for j in range(p):
        xp, xm = sol.x.copy(), sol.x.copy()
        xp[j] += steps[j]
        xm[j] -= steps[j]
        J[:, j] = (model(xp) - model(xm)) / (2 * steps[j])
    N = J.T @ J
    try:
        cov = s2 * np.linalg.inv(N)
    except np.linalg.LinAlgError:
        cov = s2 * np.linalg.pinv(N)
    el = list(sol.x[:6]) + [sol.x[6] if fit_bstar else x0[6]]
    return el, r, cov


def perturbed(el):
    return [el[0] + 1e-6, el[1] + 1e-6 if el[1] > 2e-6 else el[1] + 1e-7, el[2] + 1e-4, el[3] + 1e-4, el[4] + 1e-3, el[5] - 1e-3,
            el[6] * 1.1 + 1e-7]


def stats(r):
    d2 = (r ** 2).sum(axis=1)
    return {'n': len(r), 'rms3dKm': math.sqrt(d2.mean()), 'rmsPerCoordinateKm': math.sqrt(d2.mean() / 3), 'max3dKm': math.sqrt(d2.max())}


def elements_of(s):
    return [s.no_kozai * 1440 / (2 * math.pi), s.ecco, s.inclo / DEG, s.nodeo / DEG, s.argpo / DEG, s.mo / DEG, s.bstar]


# ── Vallado's published cases ──
def vallado():
    tles = {}
    lines = open(os.path.join(SGP4_DIR, 'SGP4-VER.TLE')).read().splitlines()
    for i, l in enumerate(lines):
        if l.startswith('1 ') and i + 1 < len(lines) and lines[i + 1].startswith('2 '):
            tles[int(l[2:7])] = (l[:69], lines[i + 1][:69])
    blocks, cur = {}, None
    for l in open(os.path.join(SGP4_DIR, 'tcppver.out')).read().splitlines():
        p = l.split()
        if len(p) == 2 and p[1] == 'xx':
            cur = int(p[0])
            blocks[cur] = []
        elif cur is not None and len(p) >= 7:
            blocks[cur].append([float(x) for x in p[:7]])
    chosen = [5, 6251, 28057, 22312, 8195, 9880, 25954, 28129, 28626, 26975, 29238]
    out = []
    for satnum in chosen:
        l1, l2 = tles[satnum]
        s = Satrec.twoline2rv(l1, l2, WGS72)
        jd = s.jdsatepoch + s.jdsatepochF
        epoch = datetime(2000, 1, 1, 12, tzinfo=timezone.utc) + timedelta(days=jd - 2451545.0)
        epoch = epoch.replace(microsecond=int(round(epoch.microsecond)))
        rows = blocks[satnum]
        states = [(epoch + timedelta(minutes=row[0]), np.array(row[1:4]), np.array(row[4:7])) for row in rows]
        truth = elements_of(s)
        el, r, _ = fit(states, epoch, truth, fit_bstar=True, start=perturbed(truth))
        out.append({'satnum': satnum, 'tle': [l1, l2], 'epoch': iso(epoch), 'truth': truth, 'scipy': el,
                    'scipyStats': stats(r), 'regime': 'deep space' if 2 * math.pi / s.no_kozai >= 225 else 'near earth',
                    'states': [[row[0]] + row[1:7] for row in rows]})
    return out


# ── synthetic cases ──
def random_cases(rng):
    def leo(h0, h1, e0, e1, i_choices, bstar0, bstar1):
        h = rng.uniform(h0, h1)
        a = RE + h
        n = math.sqrt(MU / a ** 3) * 86400 / (2 * math.pi)
        return [n, rng.uniform(e0, e1), rng.choice(i_choices) + rng.uniform(-0.2, 0.2), rng.uniform(0, 360), rng.uniform(0, 360),
                rng.uniform(0, 360), rng.uniform(bstar0, bstar1)]

    def deep(a, e0, e1, i0, i1):
        n = math.sqrt(MU / a ** 3) * 86400 / (2 * math.pi)
        return [n, rng.uniform(e0, e1), rng.uniform(i0, i1), rng.uniform(0, 360), rng.uniform(0, 360), rng.uniform(0, 360), 0.0]

    specs = [
        ('leo-low', leo(320, 480, 2e-4, 2e-3, [28.5, 51.6, 97.4], 1e-4, 4e-4), 1.0, 120, 'GCRF', True, 6),
        ('leo-starlink', leo(540, 560, 1.5e-4, 3e-4, [43.0, 53.0, 70.0, 97.6], 1e-5, 2e-4), 2.0, 240, 'EME2000', True, 6),
        ('leo-starlink-low-e', leo(545, 555, 2e-5, 8e-5, [53.0], 1e-5, 1e-4), 1.5, 180, 'GCRF', True, 6),
        ('leo-high', leo(800, 1400, 1e-4, 5e-3, [86.4, 87.9, 99.0], 1e-6, 5e-5), 2.0, 300, 'TEME', True, 6),
        ('leo-position-only', leo(500, 700, 5e-4, 2e-3, [97.8], 1e-5, 1e-4), 1.0, 60, 'GCRF', True, 3),
        ('meo-gnss', deep(26560 + rng.uniform(-30, 30), 2e-3, 2e-2, 54, 56), 4.0, 900, 'GCRF', False, 6),
        ('meo-glonass', deep(25508 + rng.uniform(-20, 20), 1e-4, 2e-3, 64, 66), 3.0, 900, 'EME2000', False, 3),
        ('geo', deep(42164 + rng.uniform(-15, 15), 1e-5, 4e-4, 0.01, 3.0), 6.0, 1800, 'GCRF', False, 6),
        ('molniya', deep(26600, 0.70, 0.74, 62.8, 63.6), 3.0, 600, 'GCRF', False, 6),
        ('gto', deep((RE + 250 + RE + 35786) / 2, 0.72, 0.73, 6, 28), 2.0, 600, 'EME2000', False, 6),
    ]
    out = []
    for name, el, days, step, frame, fit_bstar, size in specs:
        epoch = datetime(2026, 10, 1, tzinfo=timezone.utc) + timedelta(seconds=rng.randrange(0, 86400 * 30))
        start = epoch + timedelta(seconds=rng.choice([0, 0, 600, 3600]))
        s = satrec(epoch, el)
        states = []
        t = start
        while t <= start + timedelta(days=days):
            r, v = teme(s, epoch, t)
            states.append((t, r, v))
            t += timedelta(seconds=step)
        fs = frame_states(states, frame)
        data = []
        for _, r, v in fs:
            data.extend([round(x, 9) for x in r])
            if size == 6:
                data.extend([round(x, 12) for x in v])
        out.append({'name': name, 'epoch': iso(epoch), 'truth': el, 'frame': frame, 'start': iso(start), 'stepSeconds': step,
                    'stateVectorSize': size, 'fitBstar': fit_bstar, 'data': data, 'count': len(fs)})
    return out


def noisy(rng):
    el = [15.06, 1.8e-4, 53.05, 120.0, 85.0, 10.0, 6e-5]
    epoch = datetime(2026, 10, 5, 3, 14, 42, tzinfo=timezone.utc)
    s = satrec(epoch, el)
    nrng = np.random.default_rng(20261010)
    states = []
    t = epoch
    while t <= epoch + timedelta(days=1):
        r, v = teme(s, epoch, t)
        states.append((t, r + nrng.normal(0, 0.05, 3), v))
        t += timedelta(seconds=120)
    fs = frame_states(states, 'GCRF')
    sol, r, cov = fit(to_teme(fs, 'GCRF'), epoch, el, fit_bstar=True, start=perturbed(el))
    data = []
    for _, rr, vv in fs:
        data.extend([round(x, 9) for x in rr] + [round(x, 12) for x in vv])
    return {'epoch': iso(epoch), 'truth': el, 'frame': 'GCRF', 'start': iso(epoch), 'stepSeconds': 120, 'stateVectorSize': 6,
            'data': data, 'count': len(fs), 'scipy': sol, 'scipyStats': stats(r),
            'scipyCovarianceClassical': [cov[i][j] for i in range(7) for j in range(i + 1)],
            'covarianceUnits': 'n rev/day, e, i/raan/argp/M degrees, B*'}


def iss():
    lines = open(os.path.join(OD_ISS, 'ISS.OEM_J2K_EPH.trimmed.txt')).read().splitlines()
    states = []
    for l in lines:
        p = l.split()
        if len(p) == 7 and len(p[0]) > 10 and p[0][4] == '-' and 'T' in p[0]:
            t = datetime.fromisoformat(p[0]).replace(tzinfo=timezone.utc)
            states.append((t, np.array([float(x) for x in p[1:4]]), np.array([float(x) for x in p[4:7]])))
    tem = to_teme(states, 'EME2000')
    rows = list(csv.DictReader(open(os.path.join(OD_ISS, 'celestrak_supgp_iss-e_2026-07-13.csv'))))
    seg1 = rows[0]
    sup = [float(seg1['MEAN_MOTION']), float(seg1['ECCENTRICITY']), float(seg1['INCLINATION']), float(seg1['RA_OF_ASC_NODE']),
           float(seg1['ARG_OF_PERICENTER']), float(seg1['MEAN_ANOMALY']), float(seg1['BSTAR'])]
    sup_epoch = datetime.fromisoformat(seg1['EPOCH']).replace(tzinfo=timezone.utc)
    s = satrec(sup_epoch, sup)
    r_sup = np.array([teme(s, sup_epoch, t)[0] - r for t, r, _ in tem])
    six = sup_epoch + timedelta(hours=6)
    r_six = np.array([teme(s, sup_epoch, t)[0] - r for t, r, _ in tem if sup_epoch <= t <= six])
    epoch = states[0][0]
    el, r, _ = fit(tem, epoch, sup, fit_bstar=True, start=perturbed(sup))
    return {'file': 'analysis/od/tests/data/supgp-reference/iss/ISS.OEM_J2K_EPH.trimmed.txt', 'frame': 'EME2000',
            'states': [[iso(t)] + list(r) + list(v) for t, r, v in states], 'epoch': iso(epoch), 'scipy': el, 'scipyStats': stats(r),
            'supgp': {'epoch': seg1['EPOCH'], 'elements': sup, 'publishedRmsKm': float(seg1['RMS']), 'recomputed': stats(r_sup),
                      'window6h': {'from': iso(sup_epoch), 'to': iso(six), **stats(r_six)}}}


def main():
    rng = random.Random(20261010)
    ref = {
        'generator': 'tests/fit-reference.py',
        'versions': {'sgp4': sgp4.__version__, 'erfa': erfa.__version__, 'scipy': scipy.__version__, 'numpy': np.__version__},
        'units': 'km, km/s, ISO 8601 UTC; elements n rev/day, e, i/raan/argp/M degrees, B* 1/earth radii',
        'vallado': vallado(),
        'synthetic': random_cases(rng),
        'noisy': noisy(rng),
        'iss': iss(),
    }
    with open(os.path.join(HERE, 'fit-reference.json'), 'w') as f:
        json.dump(ref, f, separators=(',', ':'))
    print('vallado', len(ref['vallado']), 'synthetic', len(ref['synthetic']))
    for v in ref['vallado']:
        d = max(abs(a - b) for a, b in zip(v['scipy'][:6], v['truth'][:6]))
        print(f"  vallado {v['satnum']:5d} {v['regime']:10s} n={len(v['states'])} rms={v['scipyStats']['rms3dKm']:.2e} max|el-truth|={d:.2e}")
    print('  noisy scipy rms', ref['noisy']['scipyStats'])
    print('  iss scipy', ref['iss']['scipyStats'], 'supgp 6h', ref['iss']['supgp']['window6h'], 'published', ref['iss']['supgp']['publishedRmsKm'])


if __name__ == '__main__':
    main()
