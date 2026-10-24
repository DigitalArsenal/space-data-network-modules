"""CSPICE's reading of the NAIF-published CK fixtures, for normalize_naif_ck to be held to.

Not run by the tests: its output is fixtures/interchange/naif_ck.reference.txt, committed. Rerun with the
interpreter that has spiceypy (CSPICE_N0067) and the leap-seconds kernel:

    python3 -I ck_reference.py <fixtures dir> <naif0012.tls> > naif_ck.reference.txt

Every number is a read of the DAF by CSPICE (dafopr / dafgs / dafus / dafgda), never by the module: the raw
words of each type 3 segment (pointing, ticks, interval starts), the C-matrix CSPICE derives from each
quaternion (q2m), CCSDS 504.0-B-2 annex F's frame-transformation matrix of the CCSDS quaternion
(-q1 -q2 -q3 q0), and the time of each tick: sct2e (TDB) taken back to TT with unitim, because the MSL and
InSight clocks are TT-parallel and the module does no time-scale conversion (it reads the clock's TT).
Doubles are printed as 16 hex digits (IEEE-754 bits) where exactness is claimed and as repr() where a
tolerance is.
"""
import math, os, struct, sys
import spiceypy as sp

def bits(x): return struct.pack(">d", x).hex()

def kernel_numbers(path, name):
    """The numbers of one text-kernel variable, read from the file's text with Python's correctly rounded
    float(); CSPICE's own decimal parser (nparsd) can be an ULP off, so the pool is not the reference."""
    import re
    text = open(path).read()
    m = re.search(r"^\s*%s\s*=\s*\(([^)]*)\)" % re.escape(name), text, flags=re.M)
    return [float(t.replace("D", "E").replace("d", "e")) for t in m.group(1).split()]

def clock_formula(path, spacecraft, ticks):
    """NAIF's documented type 1 conversion: on the last coefficient row whose tick is not after the input,
    parallel + (ticks - start) / ticks_per_most_significant_count * rate."""
    sfx = abs(spacecraft)
    coeff = kernel_numbers(path, "SCLK01_COEFFICIENTS_%d" % sfx)
    moduli = kernel_numbers(path, "SCLK01_MODULI_%d" % sfx)
    per_count = 1.0
    for m in moduli[1:]:
        per_count *= m
    rows = [coeff[i:i + 3] for i in range(0, len(coeff), 3)]
    row = rows[0]
    for r in rows:
        if r[0] <= ticks:
            row = r
    return row[1] + (ticks - row[0]) / per_count * row[2]

def annex_f(Q1, Q2, Q3, QC):
    # CCSDS 504.0-B-2 F2.1: X_B = M_BA * X_A
    return [
        [Q1*Q1 - Q2*Q2 - Q3*Q3 + QC*QC, 2*(Q1*Q2 + Q3*QC), 2*(Q1*Q3 - Q2*QC)],
        [2*(Q1*Q2 - Q3*QC), -Q1*Q1 + Q2*Q2 - Q3*Q3 + QC*QC, 2*(Q2*Q3 + Q1*QC)],
        [2*(Q1*Q3 + Q2*QC), 2*(Q2*Q3 - Q1*QC), -Q1*Q1 - Q2*Q2 + Q3*Q3 + QC*QC],
    ]

fixtures, lsk = sys.argv[1], sys.argv[2]
sp.furnsh(lsk)
print("# CSPICE %s via spiceypy %s; leap seconds kernel %s" % (sp.tkvrsn("TOOLKIT"), sp.__version__, os.path.basename(lsk)))
KERNELS = [
    ("msl_surf_rover_tlm_0179_0269_v1.bc", "MSL_76_SCLKSCET.00019.tsc"),
    ("msl_ra_straight_v1.bc", "MSL_76_SCLKSCET.00019.tsc"),
    ("msl_hga_zero_v1.bc", "MSL_76_SCLKSCET.00019.tsc"),
    ("insight_ida_enc_180505_181127_v1.bc", "NSY_SCLKSCET.00025.tsc"),
]
worst_convention = 0.0
for ck, clock in KERNELS:
    sp.furnsh(os.path.join(fixtures, clock))
    print("KERNEL", ck, "SCLK", clock)
    h = sp.dafopr(os.path.join(fixtures, ck))
    sp.dafbfs(h)
    index = 0
    while sp.daffna():
        dc, ic = sp.dafus(sp.dafgs(), 2, 6)
        name = sp.dafgn().strip()
        assert ic[2] == 3, "fixture segments are type 3"
        inst, ref, has_av = int(ic[0]), int(ic[1]), int(ic[3])
        w = [float(v) for v in sp.dafgda(h, int(ic[4]), int(ic[5]))]
        n, nints = int(w[-1]), int(w[-2])
        width = 7 if has_av else 4
        ticks = w[width * n: width * n + n]
        starts = w[width * n + n + (n - 1) // 100: width * n + n + (n - 1) // 100 + nints]
        sc = int(inst / 1000)
        print("SEGMENT %d |%s| instrument %d frame %d type 3 av %d records %d intervals %d begin %d end %d" %
              (index, name, inst, ref, has_av, n, nints, ic[4], ic[5]))
        for j in range(n):
            q = w[j * width: j * width + 4]
            av = w[j * width + 4: j * width + 7] if has_av else []
            et = sp.sct2e(sc, ticks[j])
            tt = sp.unitim(et, "TDB", "TT")
            # q2m and annex F's matrix are the same function of a UNIT quaternion only (their off-unit terms
            # differ), and the published kernels print quaternions to 8-9 digits, so both see q / |q|.
            norm = math.sqrt(sum(x * x for x in q))
            qn = [x / norm for x in q]
            C = sp.q2m(qn)
            M = annex_f(-qn[1], -qn[2], -qn[3], qn[0])
            err = max(abs(C[a][b] - M[a][b]) for a in range(3) for b in range(3))
            worst_convention = max(worst_convention, err)
            interval = max(k for k in range(nints) if starts[k] <= ticks[j])
            print("RECORD %d %d interval %d ticks %s q %s av %s tt %r formula %s convention_error %.3e" %
                  (index, j, interval, bits(ticks[j]), " ".join(bits(x) for x in q),
                   " ".join(bits(x) for x in av) if av else "-", tt, bits(clock_formula(os.path.join(fixtures, clock), sc, ticks[j])), err))
        index += 1
    sp.dafcls(h)
    sp.unload(os.path.join(fixtures, clock))
print("# worst |q2m(q/|q|) - annexF(-q1,-q2,-q3,q0 of q/|q|)| over every record: %.3e" % worst_convention)
