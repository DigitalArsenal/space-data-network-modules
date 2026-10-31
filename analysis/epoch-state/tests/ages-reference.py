#!/usr/bin/env python3
"""Independent GCRF states of Vallado's verification element sets at the epoch plus 0.5, 1 and 3 days.

Writes tests/ages-reference.json. Nothing here calls the module:
  - SGP4: python-sgp4's pure-Python implementation (sgp4.model.Satrec, WGS-72, opsmode 'a': the AFSPC mode the module runs,
    set by sgp4init on the elements of the TLE lines of tests/vallado-verification.json), evaluated at the elapsed time in
    minutes. The improved mode (opsmode 'i') differs on 23599, a low-inclination deep-space set whose node passes 0: by 0.9 to 1.2 km
    at 0.5 to 3 days;
  - TEME -> GCRF: pyerfa, GCRF->TEME = Rz(ee06a)*pnm06a at TT from UTC at the row's instant, velocity with the
    central-difference frame rate (+/-600 s), as tests/vallado-verification.json's source states.

Run: python3 tests/ages-reference.py (python-sgp4 2.26, pyerfa 2.0.1.5, numpy).
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
AGES_DAYS = [0.5, 1.0, 3.0]
RATE_HALF_STEP_S = 600.0


def gcrf_to_teme(dt):
    u1, u2 = erfa.dtf2d('UTC', dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second + dt.microsecond * 1e-6)
    a1, a2 = erfa.utctai(u1, u2)
    t1, t2 = erfa.taitt(a1, a2)
    ee = erfa.ee06a(t1, t2)
    rz = np.array([[math.cos(ee), math.sin(ee), 0], [-math.sin(ee), math.cos(ee), 0], [0, 0, 1]])
    return rz @ erfa.pnm06a(t1, t2)


def teme_to_gcrf(dt, r_teme, v_teme):
    rot = gcrf_to_teme(dt)
    rdot = (gcrf_to_teme(dt + timedelta(seconds=RATE_HALF_STEP_S)) - gcrf_to_teme(dt - timedelta(seconds=RATE_HALF_STEP_S))) / (2 * RATE_HALF_STEP_S)
    r = rot.T @ r_teme
    v = rot.T @ (v_teme - rdot @ r)
    return r, v


# A query of the detector's propagator port: the TEME trajectory of case 06251 from its epoch to half a day later,
# every hour (13 samples).
TRAJECTORY_SATNUM = 6251
TRAJECTORY_STOP_DAYS = 0.5
TRAJECTORY_STEP_S = 3600.0


def satrec(tle):
    """The set of two TLE lines, initialised in the AFSPC operation mode."""
    sat = Satrec.twoline2rv(tle[0], tle[1], WGS72)
    sat.sgp4init(WGS72, 'a', sat.satnum, sat.jdsatepoch + sat.jdsatepochF - 2433281.5, sat.bstar, sat.ndot, sat.nddot, sat.ecco, sat.argpo, sat.inclo,
                 sat.mo, sat.no_kozai, sat.nodeo)
    return sat


def main():
    fixture = json.load(open(os.path.join(HERE, 'vallado-verification.json')))
    out = {'source': __doc__.strip().splitlines()[0], 'versions': {'python-sgp4': sgp4.__version__, 'pyerfa': erfa.__version__},
           'agesDays': AGES_DAYS, 'cases': []}
    for case in fixture['cases']:
        sat = satrec(case['tle'])
        epoch = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=case['epochUnix'])
        rows = []
        for age in AGES_DAYS:
            err, r, v = sat.sgp4_tsince(age * 1440.0)
            if err != 0:
                rows.append({'ageDays': age, 'error': err})
                continue
            at = epoch + timedelta(seconds=age * 86400.0)
            rg, vg = teme_to_gcrf(at, np.array(r), np.array(v))
            rows.append({'ageDays': age, 'epochIso': at.strftime('%Y-%m-%dT%H:%M:%S.%fZ'), 'temeR': list(r), 'temeV': list(v),
                         'gcrfR': [float(x) for x in rg], 'gcrfV': [float(x) for x in vg]})
        out['cases'].append({'satnum': case['satnum'], 'entityId': case['entityId'], 'rows': rows})
    case = next(c for c in fixture['cases'] if c['satnum'] == TRAJECTORY_SATNUM)
    sat = satrec(case['tle'])
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=case['epochUnix'])
    steps = int(round(TRAJECTORY_STOP_DAYS * 86400.0 / TRAJECTORY_STEP_S))
    samples = []
    for k in range(steps + 1):
        err, r, v = sat.sgp4_tsince(k * TRAJECTORY_STEP_S / 60.0)
        assert err == 0
        samples.append({'epochIso': (epoch + timedelta(seconds=k * TRAJECTORY_STEP_S)).strftime('%Y-%m-%dT%H:%M:%S.%fZ'), 'temeR': list(r), 'temeV': list(v)})
    out['trajectory'] = {'satnum': TRAJECTORY_SATNUM, 'stepSeconds': TRAJECTORY_STEP_S, 'samples': samples}
    json.dump(out, open(os.path.join(HERE, 'ages-reference.json'), 'w'), indent=1)
    open(os.path.join(HERE, 'ages-reference.json'), 'a').write('\n')


if __name__ == '__main__':
    main()
