#!/usr/bin/env python3
"""Independent expected values for common_epoch and map_covariance.

Writes tests/stm-reference.json. Nothing here calls the module:
  - SGP4: python-sgp4's pure-Python implementation (sgp4.model.Satrec,
    WGS-72, opsmode 'i'), a separate port of Vallado's code;
  - TEME -> GCRF: pyerfa, GCRF -> TEME = Rz(ee06a) * pnm06a at TT from UTC,
    velocities rotated with the same matrix (as the module does);
  - two-body motion: Kepler's equation in the eccentric anomaly with
    Lagrange f and g (a different formulation from the module's universal
    variables), its STM by central differences with Richardson extrapolation;
  - the Lambert arc: Newton shooting on the initial velocity with that
    propagator, from SGP4's velocity.
Element sets: Vallado's SGP4-VER case 06251 (near Earth, from
analysis/epoch-state/tests/vallado-verification.json), two variants of it,
and a GPS-like set (deep space, 12-hour period) chosen here.

Run: python3 tests/stm-reference.py (python-sgp4 2.27, pyerfa 2.0.1.5, numpy).
"""
import json
import math
import os
from datetime import datetime, timedelta, timezone

import erfa
import numpy as np
import sgp4
from sgp4.api import WGS72
from sgp4.model import Satrec

HERE = os.path.dirname(os.path.abspath(__file__))
MU = 398600.8  # km^3/s^2, WGS-72
DEG = math.pi / 180


def iso(dt):
    return dt.strftime('%Y-%m-%dT%H:%M:%S.%f')


def parse(text):
    return datetime.strptime(text, '%Y-%m-%dT%H:%M:%S.%f').replace(tzinfo=timezone.utc)


def sgp4_epoch(dt):  # days from 1949-12-31 00:00 UTC
    return (dt - datetime(1949, 12, 31, tzinfo=timezone.utc)).total_seconds() / 86400.0


def satrec(s, p=None):
    """SGP4 record of element set s; p overrides the nonsingular elements."""
    n, e, i, node, w, m = s['n'], s['e'], s['i'], s['node'], s['w'], s['m']
    if p is not None:
        n, ex, ey, i, node, lam = p
        e = math.hypot(ex, ey)
        w = math.atan2(ey, ex) if e > 0 else 0.0
        m = lam - w
    sat = Satrec()
    sat.sgp4init(WGS72, 'i', 0, sgp4_epoch(parse(s['epoch'])), s['bstar'], 0.0, 0.0, e, w, i, m, n, node)
    assert sat.error == 0
    return sat


def teme(sat, minutes):
    err, r, v = sat.sgp4_tsince(minutes)
    assert err == 0, err
    return np.array(r + v)


def nonsingular(s):
    return [s['n'], s['e'] * math.cos(s['w']), s['e'] * math.sin(s['w']), s['i'], s['node'], s['m'] + s['w']]


def jacobian(s, minutes):
    p0 = nonsingular(s)
    step = [1e-7 * p0[0], 1e-7, 1e-7, 1e-7, 1e-7, 1e-7]
    out = [np.zeros((6, 6)) for _ in minutes]
    for k in range(6):
        plus, minus = list(p0), list(p0)
        plus[k] += step[k]
        minus[k] -= step[k]
        sp, sm = satrec(s, plus), satrec(s, minus)
        for j, t in enumerate(minutes):
            out[j][:, k] = (teme(sp, t) - teme(sm, t)) / (2 * step[k])
    return out


def gcrf_to_teme(dt):
    u1, u2 = erfa.dtf2d('UTC', dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second + dt.microsecond * 1e-6)
    a1, a2 = erfa.utctai(u1, u2)
    t1, t2 = erfa.taitt(a1, a2)
    ee = erfa.ee06a(t1, t2)
    rz = np.array([[math.cos(ee), math.sin(ee), 0], [-math.sin(ee), math.cos(ee), 0], [0, 0, 1]])
    return rz @ erfa.pnm06a(t1, t2)


def rtn_rows(r, v):
    R = r / np.linalg.norm(r)
    N = np.cross(r, v)
    N /= np.linalg.norm(N)
    return np.array([R, np.cross(N, R), N])


def block(rows):
    b = np.zeros((6, 6))
    b[:3, :3] = rows
    b[3:, 3:] = rows
    return b


def rtn_difference(x, origin):
    A = rtn_rows(origin[:3], origin[3:])
    return list(A @ (x[:3] - origin[:3])) + list(A @ (x[3:] - origin[3:]))


def lower(m):
    return [0.5 * (m[a, b] + m[b, a]) for a in range(6) for b in range(a + 1)]


def full(low):
    m = np.zeros((6, 6))
    t = 0
    for a in range(6):
        for b in range(a + 1):
            m[a, b] = m[b, a] = low[t]
            t += 1
    return m


# ── two-body: eccentric anomaly ──
def kepler(x0, dt):
    r0, v0 = np.array(x0[:3]), np.array(x0[3:])
    r = np.linalg.norm(r0)
    a = 1.0 / (2.0 / r - v0 @ v0 / MU)
    n = math.sqrt(MU / a ** 3)
    ecos, esin = 1.0 - r / a, (r0 @ v0) / math.sqrt(MU * a)
    E0 = math.atan2(esin, ecos)
    e = math.hypot(ecos, esin)
    M = E0 - esin + n * dt
    E = M
    for _ in range(100):
        dE = (E - e * math.sin(E) - M) / (1 - e * math.cos(E))
        E -= dE
        if abs(dE) < 1e-15:
            break
    d = E - E0
    f = 1 - a / r * (1 - math.cos(d))
    g = dt - math.sqrt(a ** 3 / MU) * (d - math.sin(d))
    rv = f * r0 + g * v0
    rn = np.linalg.norm(rv)
    fd = -math.sqrt(MU * a) / (r * rn) * math.sin(d)
    gd = 1 - a / rn * (1 - math.cos(d))
    return np.concatenate([rv, fd * r0 + gd * v0])


def kepler_stm(x0, dt):
    hs = [1e-3, 1e-3, 1e-3, 1e-6, 1e-6, 1e-6]
    phi = np.zeros((6, 6))
    for k in range(6):
        def central(h):
            p, m = np.array(x0, float), np.array(x0, float)
            p[k] += h
            m[k] -= h
            return (kepler(p, dt) - kepler(m, dt)) / (2 * h)
        phi[:, k] = (4 * central(hs[k] / 2) - central(hs[k])) / 3
    return phi


def shoot(r1, v_guess, r2, dt):
    """Newton on v1 with a backtracking line search on the miss."""
    def miss_of(v):
        x = kepler(np.concatenate([r1, v]), dt) if 2.0 / np.linalg.norm(r1) - v @ v / MU > 0 else None
        return None if x is None else x[:3] - r2
    v = np.array(v_guess, float)
    miss = miss_of(v)
    for _ in range(100):
        if np.linalg.norm(miss) < 1e-10:
            break
        phi = kepler_stm(np.concatenate([r1, v]), dt)
        step = np.linalg.solve(phi[:3, 3:], miss)
        lam = 1.0
        while True:
            trial = miss_of(v - lam * step)
            if trial is not None and np.linalg.norm(trial) < np.linalg.norm(miss):
                break
            lam /= 2
            assert lam > 1e-12, 'line search failed'
        v, miss = v - lam * step, trial
    assert np.linalg.norm(miss) < 1e-8
    return v


def main():
    vallado = json.load(open(os.path.join(HERE, '../../epoch-state/tests/vallado-verification.json')))['cases']
    c = next(x for x in vallado if x['satnum'] == 6251)
    epoch = datetime.strptime(c['epochIso'], '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)
    rev = lambda x: x * 2 * math.pi / 1440.0  # rev/day -> rad/min
    base = dict(norad=6251, n=rev(c['MEAN_MOTION']), e=c['ECCENTRICITY'], i=c['INCLINATION'] * DEG,
                node=c['RA_OF_ASC_NODE'] * DEG, w=c['ARG_OF_PERICENTER'] * DEG, m=c['MEAN_ANOMALY'] * DEG, bstar=c['BSTAR'])
    sets = {
        'leo': dict(base, epoch=iso(epoch)),
        'leo-b': dict(base, epoch=iso(epoch + timedelta(days=0.4)), m=base['m'] + 30 * DEG, n=base['n'] * (1 + 2e-6)),
        'leo-c': dict(base, epoch=iso(epoch - timedelta(days=0.7)), node=base['node'] + 0.5 * DEG, e=base['e'] + 2e-4),
        'gps': dict(norad=99001, epoch='2025-11-10T03:17:42.123456', n=rev(2.00563012), e=0.0071, i=55.2 * DEG,
                    node=121.4 * DEG, w=43.0 * DEG, m=210.5 * DEG, bstar=0.0),
    }
    out = {'source': __doc__.strip().splitlines()[0], 'versions': {'python-sgp4': sgp4.__version__, 'pyerfa': erfa.__version__,
           'numpy': np.__version__}, 'sets': {}}
    for name, s in sets.items():
        out['sets'][name] = dict(norad=s['norad'], EPOCH=s['epoch'], MEAN_MOTION=s['n'] * 1440.0 / (2 * math.pi),
                                 ECCENTRICITY=s['e'], INCLINATION=s['i'] / DEG, RA_OF_ASC_NODE=s['node'] / DEG,
                                 ARG_OF_PERICENTER=s['w'] / DEG, MEAN_ANOMALY=s['m'] / DEG, BSTAR=s['bstar'])
        # The module's elements are these degree and rev/day values: recompute the radians from them.
        st = out['sets'][name]
        s.update(n=st['MEAN_MOTION'] * 2 * math.pi / 1440.0, i=st['INCLINATION'] * DEG, node=st['RA_OF_ASC_NODE'] * DEG,
                 w=st['ARG_OF_PERICENTER'] * DEG, m=st['MEAN_ANOMALY'] * DEG)

    def gcrf_at(s, when):
        minutes = (when - parse(s['epoch'])).total_seconds() / 60.0
        x = teme(satrec(s), minutes)
        m = gcrf_to_teme(when).T
        return np.concatenate([m @ x[:3], m @ x[3:]])

    # ── common_epoch: three sets of 06251 at one target epoch ──
    target = epoch + timedelta(days=0.37)
    names = ['leo', 'leo-b', 'leo-c']
    states = {k: gcrf_at(sets[k], target) for k in names}
    A = rtn_rows(states['leo'][:3], states['leo'][3:])
    truth = states['leo'] + np.concatenate([A.T @ [0.5, -1.2, 0.3], A.T @ [1e-3, 0.0, -2e-3]])
    mean = sum(states.values()) / 3
    later = target + timedelta(seconds=20)  # a second reference epoch, for afterSeconds
    states_later = {k: gcrf_at(sets[k], later) for k in names}
    truth_later = states_later['leo'] + np.array([0.2, 0.1, -0.1, 0, 0, 0])
    out['commonEpoch'] = {
        'target': iso(target), 'later': iso(later), 'sets': names,
        'ages': {k: (target - parse(sets[k]['epoch'])).total_seconds() / 86400 for k in names},
        'reference': list(truth), 'referenceLater': list(truth_later),
        'expected': {
            'reference': {k: rtn_difference(states[k], truth) for k in names},
            'mean': {k: rtn_difference(states[k], mean) for k in names},
            'meanState': list(mean),
            'set': {k: rtn_difference(states[k], states['leo-b']) for k in names},
            'afterSeconds': {k: rtn_difference(states_later[k], truth_later) for k in names},
        },
    }

    # ── map_covariance, sgp4: Phi = J(t) J(t0)^-1 ──
    P0 = full([0.04, 0.01, 0.25, -0.002, 0.003, 0.01, 1e-5, 2e-6, -1e-6, 4e-8, -3e-6, 1e-5, 5e-7, 1e-9, 9e-8,
               1e-7, -2e-7, 3e-7, -1e-9, 2e-10, 5e-8])
    assert np.all(np.linalg.eigvalsh(P0) > 0)
    cases = []
    for name, t0_min, targets in [('leo', 0.0, [10.0, 1440.0, 4320.0, 10080.0]), ('gps', 120.0, [1440.0, 4320.0, 10080.0, -600.0])]:
        s = sets[name]
        minutes = [t0_min] + targets
        J = jacobian(s, minutes)
        J0inv = np.linalg.inv(J[0])
        nominal = satrec(s)
        x0 = teme(nominal, t0_min)
        B0 = block(rtn_rows(x0[:3], x0[3:]))
        cart0 = B0.T @ P0 @ B0
        dx0_rtn = np.array([0.01, -0.03, 0.005, 1e-5, -2e-5, 1e-5])
        dp = J0inv @ (B0.T @ dx0_rtn)
        p0 = np.array(nonsingular(s))
        rows = []
        for k, t in enumerate(targets):
            phi = J[k + 1] @ J0inv
            x = teme(nominal, t)
            Bt = block(rtn_rows(x[:3], x[3:]))
            ct = Bt @ phi @ cart0 @ phi.T @ Bt.T
            # Finite-difference truth: the element perturbation that moves the state at t0 by dx0,
            # propagated by SGP4 both ways (the linear part to third order).
            xp, xm = teme(satrec(s, list(p0 + dp)), t), teme(satrec(s, list(p0 - dp)), t)
            rows.append(dict(minutes=t, epoch=iso(parse(s['epoch']) + timedelta(minutes=t)), stm=list(phi.flatten()),
                             covariance=lower(ct), perturbation=list((xp - xm) / 2)))
        cases.append(dict(set=name, fromMinutes=t0_min, fromEpoch=iso(parse(s['epoch']) + timedelta(minutes=t0_min)),
                          covariance=lower(P0), perturbationRtn=list(dx0_rtn), perturbationTeme=list(B0.T @ dx0_rtn),
                          targets=rows))
    out['sgp4'] = cases

    # ── map_covariance, two-body: Phi of Keplerian motion from SGP4's state ──
    tb = []
    for name, targets in [('leo', [1440.0, 4320.0, 10080.0, -600.0]), ('gps', [1440.0, 4320.0, 10080.0])]:
        s = sets[name]
        x0 = teme(satrec(s), 0.0)
        tb.append(dict(set=name, targets=[dict(minutes=t, epoch=iso(parse(s['epoch']) + timedelta(minutes=t)),
                                               stm=list(kepler_stm(x0, t * 60.0).flatten())) for t in targets]))
    out['twoBody'] = tb

    # ── map_covariance, lambert: the arc through SGP4's positions ──
    lam = []
    for name, targets in [('gps', [1.1 * 1440, 3.3 * 1440]), ('leo', [0.3 * 1440, 2.2 * 1440])]:
        s = sets[name]
        sat = satrec(s)
        x1 = teme(sat, 0.0)
        a = 1.0 / (2.0 / np.linalg.norm(x1[:3]) - x1[3:] @ x1[3:] / MU)
        period = 2 * math.pi * math.sqrt(a ** 3 / MU)
        rows = []
        for t in targets:
            x2 = teme(sat, t)
            dt = t * 60.0
            v1 = shoot(x1[:3], x1[3:], x2[:3], dt)
            arc = np.concatenate([x1[:3], v1])
            ap = 1.0 / (2.0 / np.linalg.norm(x1[:3]) - v1 @ v1 / MU)
            rows.append(dict(minutes=t, epoch=iso(parse(s['epoch']) + timedelta(minutes=t)),
                             revolutions=math.floor(dt / period), arcRevolutions=math.floor(dt / (2 * math.pi * math.sqrt(ap ** 3 / MU))),
                             v1=list(v1), stm=list(kepler_stm(arc, dt).flatten())))
        lam.append(dict(set=name, targets=rows))
    out['lambert'] = lam

    # ── axes: leo-b's RTN rows to leo's at leo's epoch (TEME, both SGP4 states there) ──
    xa = teme(satrec(sets['leo']), 0.0)
    minutes_b = (parse(sets['leo']['epoch']) - parse(sets['leo-b']['epoch'])).total_seconds() / 60.0
    xb = teme(satrec(sets['leo-b']), minutes_b)
    rot = rtn_rows(xa[:3], xa[3:]) @ rtn_rows(xb[:3], xb[3:]).T
    out['axes'] = {'leoBToLeoAtLeoEpoch': list(rot.flatten())}
    with open(os.path.join(HERE, 'stm-reference.json'), 'w') as f:
        json.dump(out, f, indent=1)
        f.write('\n')


if __name__ == '__main__':
    main()
