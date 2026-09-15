"""Translate published Hipparchus measurements to the existing $EST test port.
No output from estimation.cpp is used. Run from any directory with Python 3.
The state transition is the closed-form constant-velocity equation F(rv)=dt.
"""
import json
from pathlib import Path
root = Path(__file__).resolve().parent
rows = [[float(v) for v in line.split()] for line in (root / 'hipparchus-cv-smoother.txt').read_text().splitlines() if line and not line.startswith('#')][1:]
samples, observations = [], []
for t, z, *_ in rows:
    epoch = {'jd_day': 2451545, 'seconds': t}
    stm = [float(i % 7 == 0) for i in range(36)]
    for i in range(3):
        stm[i*6+i+3] = t
    samples.append({'epoch': epoch, 'state': [-.5*t, 0, 0, -.5, 0, 0], 'stm': stm})
    observations.append({'epoch': epoch, 'value': [z, 0, 0, 0], 'sigma': [.001**.5, 1, 1, 1]})
(root / 'hipparchus-cv-inputs.json').write_text(json.dumps({'samples': samples, 'observations': observations}, separators=(',', ':'))+'\n')
