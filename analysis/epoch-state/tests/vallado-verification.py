#!/usr/bin/env python3
"""GCRF of the published TEME states in tests/vallado-verification.json, by the TEME of AIAA 2006-6753.

The TEME rows (temeR, temeV) are the t=0 rows of tcppver.out for the sets of SGP4-VER.TLE (Vallado, Crawford, Hujsak
and Kelso, "Revisiting Spacetrack Report #3", AIAA 2006-6753), as python-sgp4 2.27 ships them. This rewrites only
gcrfR and gcrfV. Nothing here calls a module:
  - TEME: the paper's sec. II.D eq. 1, r_PEF = R3(GMST82(UT1)) r_TEME, with PEF = R3(GAST06) NPB06 GCRF by IAU 2006/2000A,
    so GCRF -> TEME = R3(GAST06 - GMST82) NPB06 (pyerfa gst06, gmst82, pnm06a), at TT from UTC and UT1 = UTC;
  - velocity: v_GCRF = R' (v_TEME - Rdot r_GCRF), Rdot by a +/-600 s central difference in UTC.

Run: python3 tests/vallado-verification.py (pyerfa 2.0.1.5, numpy).
"""
import json
import os
from datetime import datetime, timedelta, timezone

import erfa
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RATE_HALF_STEP_S = 600.0


def gcrf_to_teme(dt):
    u1, u2 = erfa.dtf2d('UTC', dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second + dt.microsecond * 1e-6)
    a1, a2 = erfa.utctai(u1, u2)
    t1, t2 = erfa.taitt(a1, a2)
    npb = erfa.pnm06a(t1, t2)
    return erfa.rz(erfa.gst06(u1, u2, t1, t2, npb) - erfa.gmst82(u1, u2), npb)


def teme_to_gcrf(dt, r_teme, v_teme):
    rot = gcrf_to_teme(dt)
    rdot = (gcrf_to_teme(dt + timedelta(seconds=RATE_HALF_STEP_S)) - gcrf_to_teme(dt - timedelta(seconds=RATE_HALF_STEP_S))) / (2 * RATE_HALF_STEP_S)
    r = rot.T @ r_teme
    v = rot.T @ (v_teme - rdot @ r)
    return r, v


def main():
    path = os.path.join(HERE, 'vallado-verification.json')
    fixture = json.load(open(path))
    fixture['source'] = ('Vallado SGP4-VER.TLE and tcppver.out (t=0 rows) as shipped in python-sgp4 2.27; GCRF expectations '
                         'by tests/vallado-verification.py with pyerfa ' + erfa.__version__ + ': the TEME of AIAA 2006-6753 '
                         '(GCRF->TEME = R3(GAST06 - GMST82) NPB06 at TT from UTC, UT1 = UTC), velocity with the '
                         'central-difference frame rate (+/-600 s).')
    for case in fixture['cases']:
        epoch = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=case['epochUnix'])
        r, v = teme_to_gcrf(epoch, np.array(case['temeR']), np.array(case['temeV']))
        case['gcrfR'] = [float(x) for x in r]
        case['gcrfV'] = [float(x) for x in v]
    with open(path, 'w') as out:
        json.dump(fixture, out, indent=1)
        out.write('\n')


if __name__ == '__main__':
    main()
