#!/usr/bin/env python3
"""Generate GJ8 coefficient rows with exact rational arithmetic."""
from fractions import Fraction as Q
from math import comb
from pathlib import Path
import argparse

q = [Q(1)] + [Q(0)] * 10
for k in range(1, 11):
    q[k] = -sum((Q(1, j + 1) * q[k - j] for j in range(1, k + 1)), Q(0))
q2 = [sum((q[j] * q[k - j] for j in range(k + 1)), Q(0)) for k in range(11)]
a, b = q2[2:11], q[1:10]
b[0] += Q(1, 2)
ap = [sum(a[:k + 1], Q(0)) for k in range(9)]
bp = [Q(1, 2) + sum(b[:k + 1], Q(0)) for k in range(9)]

def ordinate(row):
    return [sum((row[k] * (-1) ** j * comb(k, j) for k in range(j, 9)), Q(0)) for j in range(9)]

def lagrange(i, x):
    v = Q(1)
    for j in range(9):
        if i != j:
            v *= Q(x - j, i - j)
    return v

sa = [[Q(0)] * 9 for _ in range(9)]
sb = [[Q(0)] * 9 for _ in range(9)]
for at in range(9):
    for i in range(9):
        for k in range(9):
            delta = sum((Q((-1) ** j * comb(k, j)) * lagrange(i, at - j) for j in range(k + 1)), Q(0))
            sa[at][i] += a[k] * delta
            sb[at][i] += b[k] * delta

# Independent centered Bernoulli moments and translated endpoint identities.
ma = [Q(1, 12), 0, Q(-1, 120), 0, Q(1, 252), 0, Q(-1, 240), 0, Q(1, 132)]
mb = [0, Q(-1, 12), 0, Q(1, 120), 0, Q(-1, 252), 0, Q(1, 240), 0]
for k in range(9):
    assert sum((sa[4][j] * (j - 4) ** k for j in range(9)), Q(0)) == ma[k]
    assert sum((sb[4][j] * (j - 4) ** k for j in range(9)), Q(0)) == mb[k]
assert sa[8] == list(reversed(ordinate(a)))
assert sb[8] == list(reversed(ordinate(b)))

def row(values):
    return '{{' + ', '.join(f'{v.numerator}.0 / {v.denominator}.0' for v in values) + '}}'

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
header = 'struct Coefficients {\n'
for name, values in [('ac', ordinate(a)), ('bc', ordinate(b)), ('apc', ordinate(ap)), ('bpc', ordinate(bp))]:
    header += f'    Row {name} = {row(values)};\n'
for name, values in [('startupA', sa), ('startupB', sb)]:
    header += f'    std::array<Row, 9> {name} = ' + '{{\n        ' + ',\n        '.join(map(row, values)) + '\n    }};\n'
header += '};\n'
path = Path(__file__).resolve().parents[1] / 'lib/ffm_gj_core.h'
original = path.read_text()
start, end = original.index('struct Coefficients {'), original.index('inline constexpr Coefficients')
updated = original[:start] + header + original[end:]
if args.check:
    if updated != original:
        raise SystemExit('GJ coefficients differ from exact generation')
else:
    path.write_text(updated)
print('GJ8 coefficients: exact Bernoulli moments and translation identities verified.')
