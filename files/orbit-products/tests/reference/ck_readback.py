"""CSPICE reads a CK this module wrote, and says how far it is from the attitude that was intended.

usage: ck_readback.py <written.bc> <clock.tsc> <leap seconds.tls> <expected.txt>

expected.txt has one line per record, in file order: segment, record, TT seconds past J2000, then the CCSDS
quaternion Q1 Q2 Q3 QC (from the reference frame to the instrument) and the angular velocity in rad/s that
the test fed the writer. For each record:

  * the tick CSPICE finds in the kernel's own words (dafgda), against the tick it computes for the intended
    time (unitim TT to TDB, then sce2c);
  * ckgp / ckgpav at that stored tick, in the segment's own frame, tolerance 0: the C-matrix and the angular
    velocity CSPICE returns;
  * the rotation between that C-matrix and q2m of the intended quaternion as (QC, -Q1, -Q2, -Q3) -- the
    NAIF quaternion of the CCSDS one -- measured as the angle of the relative rotation (2 atan2(|v|, |w|) of
    m2q, which stays exact near zero where acos does not).
"""
import math, sys
import spiceypy as sp

ck, clock, lsk, expected = sys.argv[1:5]
sp.furnsh(lsk); sp.furnsh(clock); sp.furnsh(ck)
rows = {}
for line in open(expected):
    f = line.split()
    rows.setdefault(int(f[0]), []).append([float(x) for x in f[2:]])

# The DAF search state is global in CSPICE and ckgpav uses it, so the segments are collected first.
h = sp.dafopr(ck)
sp.dafbfs(h)
segments = []
while sp.daffna():
    dc, ic = sp.dafus(sp.dafgs(), 2, 6)
    segments.append((ic, [float(v) for v in sp.dafgda(h, int(ic[4]), int(ic[5]))]))
sp.dafcls(h)

worst_rot = worst_av = worst_tick = 0.0
count = 0
for index, (ic, w) in enumerate(segments):
    inst, ref, has_av = int(ic[0]), int(ic[1]), int(ic[3])
    n = int(w[-1])
    width = 7 if has_av else 4
    ticks = w[width * n: width * n + n]
    refname = {1: "J2000", 17: "ECLIPJ2000"}[ref]
    sc = int(inst / 1000)
    assert len(rows[index]) == n, (len(rows[index]), n)
    for j, r in enumerate(rows[index]):
        t_tt, Q1, Q2, Q3, QC = r[0], r[1], r[2], r[3], r[4]
        av = r[5:8]
        norm = math.sqrt(Q1 * Q1 + Q2 * Q2 + Q3 * Q3 + QC * QC)
        intended = sp.q2m([QC / norm, -Q1 / norm, -Q2 / norm, -Q3 / norm])
        want_ticks = sp.sce2c(sc, sp.unitim(t_tt, "TT", "TDB"))
        worst_tick = max(worst_tick, abs(ticks[j] - want_ticks))
        # ckgpav answers only from a segment that stores rates; ckgp reads one that does not. Either raises
        # NotFoundError when the kernel has no pointing at the tick.
        if has_av:
            cmat, got_av, clkout = sp.ckgpav(inst, ticks[j], 0.0, refname)
        else:
            cmat, clkout = sp.ckgp(inst, ticks[j], 0.0, refname)
        rel = [[sum(cmat[a][k] * intended[b][k] for k in range(3)) for b in range(3)] for a in range(3)]
        q = sp.m2q(rel)
        angle = 2.0 * math.atan2(math.sqrt(q[1] ** 2 + q[2] ** 2 + q[3] ** 2), abs(q[0]))
        worst_rot = max(worst_rot, angle)
        if has_av:
            worst_av = max(worst_av, max(abs(got_av[k] - av[k]) for k in range(3)))
        count += 1
print("CSPICE %s read %d records of %d segments: worst rotation difference %.3e rad; worst angular velocity difference %.3e rad/s; worst tick difference %.3e ticks"
      % (sp.tkvrsn("TOOLKIT"), count, len(segments), worst_rot, worst_av, worst_tick))
