#!/usr/bin/env python3
"""Optional offline scientific audit; reads user-supplied data, emits aggregates only.
No credentials, network calls, identity binding, covariance generation or ingestion.
Usage: python3 tools/audit-vimpel-epoch.py ELEMENTS_FILE EPHEMERIS_RAR
"""
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tempfile

MU = 398600.4418  # Earth, km^3/s^2. J2000 axes, UTC epoch, km and km/s.
STEP = 600.0  # Provider's documented cadence since 2014-09-15.


def state(row):
    a, inc, node, e, u, w = map(float, row[5:11])
    inc, node, u, w = map(math.radians, (inc, node, u, w))
    nu = u - w  # Field 10 is argument of latitude, NOT mean anomaly.
    p = a * (1 - e * e)
    if not (a > 0 and 0 <= e < 1 and p > 0):
        raise ValueError('Audit supports finite bound elliptic elements only')
    P = (math.cos(node)*math.cos(w)-math.sin(node)*math.sin(w)*math.cos(inc),
         math.sin(node)*math.cos(w)+math.cos(node)*math.sin(w)*math.cos(inc),
         math.sin(w)*math.sin(inc))
    Q = (-math.cos(node)*math.sin(w)-math.sin(node)*math.cos(w)*math.cos(inc),
         -math.sin(node)*math.sin(w)+math.cos(node)*math.cos(w)*math.cos(inc),
         math.cos(w)*math.sin(inc))
    r = [p/(1+e*math.cos(nu))*(P[j]*math.cos(nu)+Q[j]*math.sin(nu)) for j in range(3)]
    v = [math.sqrt(MU/p)*(-P[j]*math.sin(nu)+Q[j]*(e+math.cos(nu))) for j in range(3)]
    if not all(map(math.isfinite, r+v)):
        raise ValueError('Non-finite state')
    return r, v


def norm(values):
    return math.sqrt(sum(x*x for x in values))


def sha(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def summary(values):
    values = sorted(values)
    return {'minimum': values[0], 'median': values[len(values)//2], 'maximum': values[-1]}


def archive_key(name):
    native, day, clock = name.split('/')[-1].split('_')
    return f'{int(native)}_{day}_{clock}'


def audit(elements, archive):
    rows = {}
    for line in Path(elements).read_text().splitlines():
        row = [x.strip() for x in line.split(',')]
        if len(row) != 15:
            raise ValueError('Expected fifteen fields per element record')
        epoch = row[3]
        if not re.fullmatch(r'\d{8} \d{6}', epoch):
            raise ValueError('Invalid element epoch')
        key = f'{int(row[1])}_{epoch[4:8]}{epoch[2:4]}{epoch[:2]}_{epoch[9:]}'
        if key in rows:
            raise ValueError('Duplicate native identity and epoch')
        rows[key] = row
    names = subprocess.check_output(['bsdtar', '-tf', archive], text=True).splitlines()
    # Only regular provider ephemeris names under one directory are eligible.
    names = sorted(n for n in names if re.fullmatch(r'ephem\.\d{8}/\d+_\d{8}_\d{6}', n)
                   and archive_key(n) in rows)
    if not names:
        raise ValueError('No matching native identities and exact epochs')
    # Deterministic stratified sample across the archive, capped at 64 objects.
    selected = [names[i*(len(names)-1)//min(63,len(names)-1)] for i in range(min(64,len(names)))] if len(names)>1 else names
    positions, velocities, stencil_changes, counts = [], [], [], []
    with tempfile.TemporaryDirectory(prefix='sdn-vimpel-audit-') as directory:
        subprocess.run(['bsdtar', '-xf', archive, '-C', directory, *selected], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for name in selected:
            records = [[float(x) for x in line.split(',')]
                       for line in (Path(directory)/name).read_text().splitlines() if line.strip()]
            if len(records)<5 or any(len(r)!=4 or r[0]!=i or not all(map(math.isfinite,r)) for i,r in enumerate(records)):
                raise ValueError('Expected contiguous zero-based indices and finite Cartesian positions')
            pts = [r[1:] for r in records]
            r, v = state(rows[archive_key(name)])
            fd5 = [sum(c*(pts[k][j]-pts[0][j]) for k,c in enumerate((-25,48,-36,16,-3)))/(12*STEP) for j in range(3)]
            fd3 = [(-3*pts[0][j]+4*pts[1][j]-pts[2][j])/(2*STEP) for j in range(3)]
            positions.append(norm([r[j]-pts[0][j] for j in range(3)]))
            velocities.append(norm([v[j]-fd5[j] for j in range(3)]))
            stencil_changes.append(norm([fd5[j]-fd3[j] for j in range(3)]))
            counts.append(len(pts))
    return {'scope':'Offline format/epoch diagnostic; not propagation validation or identity proof',
            'elementSha256':sha(elements), 'archiveSha256':sha(archive),
            'elementRecords':len(rows),'matchedArchiveEntries':len(names),'sampledEntries':len(selected),
            'frame':'J2000','timeSystem':'UTC','stepSeconds':STEP,'sampleCounts':summary(counts),
            'epochPositionDifferenceKm':summary(positions),'epochVelocityDifferenceKmS':summary(velocities),
            'threeVsFivePointVelocityDifferenceKmS':summary(stencil_changes),
            'limitations':['Rounded elements and positions; residuals are not absolute orbit errors',
                           'Endpoint differentiation has sampling/truncation and quantization error',
                           'No tolerance has been calibrated for catalog identity acceptance']}

if __name__ == '__main__':
    if len(sys.argv)!=3:
        raise SystemExit(__doc__)
    print(json.dumps(audit(*sys.argv[1:]), indent=2))
