#!/usr/bin/env python3
"""Offline synthetic fixtures; native upstream ERFA reference, no module oracle."""
from pathlib import Path
import subprocess
root = Path(__file__).resolve().parents[1]
erfa = root.parents[1] / 'higherpop/third_party/erfa'
cache = root / '.sdk-build/ephemeris-fixtures'
cache.mkdir(parents=True, exist_ok=True)
files = sorted(p for p in erfa.glob('*.c') if p.name not in ['t_erfa_c.c', 't_erfa_c_extra.c', 'erfaversion.c'])
subprocess.run(['c++', '-std=c++17', '-O2', '-Wno-deprecated', '-I'+str(erfa), '-I'+str(root/'src/cpp/include'), str(root/'scripts/generate-ephemeris-fixtures.cpp'), *map(str, files), '-o', str(cache/'generate')], check=True)
subprocess.run([str(cache/'generate'), str(root/'tests/fixtures/ephemeris-upload')], check=True)
# Text-only mutations of the synthetic fixtures: one rejected input per rule.
import json
out = root / 'tests/fixtures/ephemeris-upload'
nasa = (out/'A-nasa.txt').read_text()
oem = (out/'A-oem-eme2000.kvn').read_text()
cases = {}
def bad(name, text, code, **options):
    (out/(name+'.txt')).write_text(text)
    cases[name] = {'error': code, **options}
bad('future-states', nasa, 'insufficient-future-states', reference='2006-01-02T00:01:30Z')
bad('span-long', nasa.replace('06002000200.000', '06024000200.000'), 'span-too-long')
short = '\n'.join(f'0600200000{i}.000 7000 0 0 0 7.5 0' for i in range(6))+'\n'
bad('span-short', short, 'span-too-short')
bad('below-surface', nasa.replace(' 7000 ', ' 6000 ', 1), 'below-earth-surface')
bad('speed', nasa.replace(' 7.5 ', ' 71 ', 1), 'speed-limit')
bad('state-frame', oem.replace('REF_FRAME = EME2000', 'REF_FRAME = TEME', 1), 'unsupported-frame')
bad('time-system', oem.replace('TIME_SYSTEM = UTC', 'TIME_SYSTEM = TAI'), 'unsupported-time-system')
start = oem.index('EPOCH = ')
end = oem.index('EPOCH = ', start+1)
bad('missing-covariance', oem[:start]+oem[end:], 'missing-covariance')
bad('non-psd', oem[:start]+oem[start:].replace('\n0.01\n', '\n-0.01\n', 1), 'covariance-not-psd')
bad('covariance-frame-presence', oem.replace('COV_REF_FRAME = RTN\n', '', 1), 'covariance-frame-required')
bad('covariance-frame', oem.replace('COV_REF_FRAME = RTN', 'COV_REF_FRAME = TNW', 1), 'unsupported-covariance-frame')
bad('epoch-order', nasa+nasa.splitlines()[-1]+'\n', 'non-increasing-epochs')
bad('bad-epoch', nasa.replace('06002000000.000', '06367000000.000'), 'invalid-epoch', format='NASA')
bad('bad-state', nasa.replace(' 7000 ', ' nan ', 1), 'invalid-state', format='NASA')
bad('ocm', 'CCSDS_OCM_VERS = 3.0\n', 'unsupported-format')
bad('xml', '<oem/>\n', 'unsupported-format')
bad('duplicate-covariance', oem[:end]+oem[start:end]+oem[end:], 'duplicate-covariance')
bad('truncated-itc', '\n'.join((out/'A-itc.txt').read_text().splitlines()[:6])+'\n', 'invalid-covariance')
(out/'failures.json').write_text(json.dumps(cases,indent=2)+'\n')
