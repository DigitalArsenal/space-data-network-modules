"""SGP4 trajectories for a window of an element-set history, the detector's
input. Each element set is initialized from its OMM fields with python-sgp4
(Vallado's SGP4, WGS 72) and sampled every <step> s in TEME from the epoch two
sets before it to the epoch two sets after it.

Writes <out>.json (one entry per set: comment, norad, object id, start, count)
and <out>.bin (float64 x, y, z, vx, vy, vz in km and km/s, sets in order).

usage: python3 gp_trajectories.py <history.json> <from-iso> <to-iso> <step-s> <out>
"""
import datetime as dt, json, sys
import numpy as np
from sgp4 import omm
from sgp4.api import Satrec

sets = json.load(open(sys.argv[1]))
lo, hi, step, out = sys.argv[2], sys.argv[3], float(sys.argv[4]), sys.argv[5]
sets = [s for s in sets if lo <= s['EPOCH'] < hi]
UTC = dt.timezone.utc
def seconds(text): return dt.datetime.fromisoformat(text[:26]).replace(tzinfo=UTC).timestamp()
def satrec(r):
    s = Satrec()
    fields = {k: str(v) for k, v in r.items() if v is not None}
    fields.setdefault('OBJECT_NAME', ''); fields.setdefault('CLASSIFICATION_TYPE', 'U'); fields['EPHEMERIS_TYPE'] = '0'
    omm.initialize(s, fields)
    return s
epochs = np.array([seconds(s['EPOCH']) for s in sets])
meta, chunks = [], []
for j, r in enumerate(sets):
    a = epochs[max(0, j - 2)]; b = epochs[min(len(sets) - 1, j + 2)]
    start = np.ceil(a / step) * step
    t = np.arange(start, b + 1e-9, step)
    if len(t) < 2: continue
    jd = 2440587.5 + np.floor(t / 86400); fr = (t % 86400) / 86400
    err, pos, vel = satrec(r).sgp4_array(jd, fr)
    if np.any(err): continue
    chunks.append(np.hstack([pos, vel]).astype('<f8'))
    meta.append(dict(comment=f"GP_ID {r.get('GP_ID', '')} EPOCH {r['EPOCH']}", norad=int(r['NORAD_CAT_ID']),
                     object_id=r.get('OBJECT_ID', ''), start=float(start), count=len(t)))
json.dump(dict(step=step, frame='TEMEOFDATE', sets=meta), open(out + '.json', 'w'))
(np.vstack(chunks) if chunks else np.zeros((0, 6))).tofile(out + '.bin')
