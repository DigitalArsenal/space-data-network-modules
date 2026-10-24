"""RESORB against POEORB for the same arc: a different product of the same orbit, compared outside the module.

usage: eof_resorb_vs_poe.py <fixtures dir>   (writes resorb_vs_poeorb.reference.txt there)

The states are the committed reference tables (tests/reference/eof_reference.py: the doubles Python's xml.etree
read, which the module is held to bit for bit, so these ARE the module's states). The precise orbit is interpolated
to each restituted epoch with a 6-node Hermite polynomial (positions and velocities), and the 3D position difference
is measured. The restituted product (NRT) is documented at ~10 cm.
"""
import datetime as dt, math, os, sys

def table(path):
    rows = []
    for line in open(path):
        if line.startswith("#") or not line.strip():
            continue
        f = line.split("\t")
        t = dt.datetime.fromisoformat(f[0]).replace(tzinfo=dt.timezone.utc).timestamp()
        rows.append((t, [float(x) for x in f[1:7]]))
    return rows

def hermite(nodes, t, comp):
    """Hermite interpolation of component comp (0..2) from (time, [x y z vx vy vz]) nodes."""
    xs, q = [], []
    for time, s in nodes:
        xs += [time - nodes[0][0]] * 2
        q += [s[comp]] * 2
    m = len(xs)
    cols = [q[:]]
    for j in range(1, m):
        prev, col = cols[-1], []
        for i in range(m - j):
            if xs[i + j] == xs[i]:
                col.append(nodes[i // 2][1][comp + 3])      # the derivative at a doubled node
            else:
                col.append((prev[i + 1] - prev[i]) / (xs[i + j] - xs[i]))
        cols.append(col)
    tt = t - nodes[0][0]
    acc, prod = 0.0, 1.0
    for j in range(m):
        acc += cols[j][0] * prod
        prod *= tt - xs[j]
    return acc

d = sys.argv[1]
poe = table(os.path.join(d, "S1A_AUX_POEORB_V20240108_overlap.reference.tsv"))
res = table(os.path.join(d, "S1A_AUX_RESORB_V20240109_excerpt.reference.tsv"))
times = [p[0] for p in poe]
diffs = []
for t, s in res:
    if t < times[3] or t > times[-4]:
        continue
    k = max(i for i in range(len(times)) if times[i] <= t)
    nodes = poe[k - 2: k + 4]
    p = [hermite(nodes, t, c) for c in range(3)]
    diffs.append(math.dist(p, s[:3]) * 1000.0)
diffs.sort()
line = ("RESORB (NRT restituted) against POEORB (precise), Sentinel-1A, 2024-01-09/10: %d restituted states inside the "
        "precise arc, 3D position difference max %.4f m, rms %.4f m, median %.4f m (6-node Hermite of the precise states)" %
        (len(diffs), diffs[-1], math.sqrt(sum(x * x for x in diffs) / len(diffs)), diffs[len(diffs) // 2]))
open(os.path.join(d, "resorb_vs_poeorb.reference.txt"), "w").write(line + "\n")
print(line)
