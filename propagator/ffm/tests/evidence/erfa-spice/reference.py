#!/usr/bin/env python3
"""ERFA and NAIF SPICE references for FFM's clock, Earth orientation, TEME
axes and third-body states at the reference cases' hourly sample epochs.

    python -I reference.py <ffm-reference-cases.json> <ffm-frames.json>
        <naif-kernel-dir> <de440 kernel> > reference.json

Every value is computed here by pyerfa (ERFA 2.0.1) or SpiceyPy (CSPICE N0067)
from the case export's UTC epochs and EOP rows, with Julian dates kept in two
parts. <ffm-frames.json> (run-erfa-spice.mjs: FFM's native harness) supplies
only the instants FFM itself evaluates (its single-double TDB Julian date and
the TT it derives from it), so that the same reference can also be evaluated at
FFM's own instant: that separates FFM's clock from its composition.

Conventions, as the case export states them (earthOrientation, timeScales):
- UTC -> TAI -> TT by ERFA's leap-second table (eraUtctai, eraTaitt).
- TDB - TT: eraDtdb at the geocenter (Fairhead & Bretagnon 1990, 787 terms).
- EOP at a UTC instant: the daily rows interpolated linearly in TAI between
  the bracketing midnights; UT1 - TAI interpolated (continuous through leap
  seconds). This is the interpolation rule the case export's rows are given
  with (foundation/frames/src/eop_series.hpp); any rule applied to both sides
  cancels in the comparison.
- GCRS -> ITRS: IERS Conventions 2010, CIO based, IAU 2006/2000A: X, Y from
  eraXy06 plus the rows' dX, dY; s from eraS06; ERA from eraEra00 at UT1;
  s' from eraSp00; polar motion by eraPom00; eraC2tcio.
- GMST: eraGmst06 at UT1 and TT (IERS Conventions 2010 eq. 5.32).
- TEME (the SGP4 axes) in two definitions: true equator of date (eraPnm06a)
  rotated by the equation of the equinoxes eraEe06a (the definition
  foundation/frames and propagator/sgp4 use), and the FK5 one, eraPnm80 rotated
  by eraEqeq94 (Vallado et al. 2006, AIAA 2006-6753), for the spread between
  the two.
- SPICE: J2000 -> ITRF93 from the high-precision binary Earth PCK
  (earth_latest_high_prec.bpc, its own EOP); Sun (10) and Moon (301) relative
  to the Earth (399), geometric, J2000 axes, from the case export's DE440 file.
"""
import json
import sys
from fractions import Fraction

import erfa
import numpy as np
import spiceypy as sp

DJ00 = 2451545.0
MAS = np.pi / 180 / 3600 / 1000


def two_part_utc(iso):
    d, t = iso.split("T")
    y, m, dd = (int(x) for x in d.split("-"))
    hh, mm, ss = t.split(":")
    return erfa.dtf2d("UTC", y, m, dd, int(hh), int(mm), float(ss))


def eop_at(rows, u1, u2):
    """Linear in TAI between the bracketing daily rows (arcsec, s, mas in)."""
    mjd = (u1 - 2400000.5) + u2
    for a, b in zip(rows, rows[1:]):
        if a["mjd"] <= mjd <= b["mjd"]:
            break
    else:
        raise ValueError(f"EOP rows do not bracket MJD {mjd}")

    def tai(mjd_utc):
        t1, t2 = erfa.utctai(2400000.5, mjd_utc)
        return (t1 - 2400000.5) + t2

    def dat(mjd_utc):
        y, mo, d, fd = erfa.jd2cal(2400000.5, mjd_utc)
        return erfa.dat(y, mo, d, fd)

    ta, tb = tai(a["mjd"]), tai(b["mjd"])
    q1, q2 = erfa.utctai(u1, u2)
    w = (((q1 - 2400000.5) - ta) + q2) / (tb - ta)
    lerp = lambda key: lerp_pair(a[key], b[key], w)
    ut1_tai = lerp_pair(a["ut1MinusUtcS"] - dat(a["mjd"]), b["ut1MinusUtcS"] - dat(b["mjd"]), w)
    return {
        "xp": lerp("xPoleArcsec") * erfa.DAS2R,
        "yp": lerp("yPoleArcsec") * erfa.DAS2R,
        "dut1": ut1_tai + dat(mjd),
        "dX": lerp("dXMas") * MAS,
        "dY": lerp("dYMas") * MAS,
    }


def lerp_pair(x, y, w):
    return x + w * (y - x)


def c2t_iers2010(tt1, tt2, rows):
    tai1, tai2 = erfa.tttai(tt1, tt2)
    u1, u2 = erfa.taiutc(tai1, tai2)
    e = eop_at(rows, u1, u2)
    ut11, ut12 = erfa.utcut1(u1, u2, e["dut1"])
    x, y = erfa.xy06(tt1, tt2)
    s = erfa.s06(tt1, tt2, x, y)
    rc2i = erfa.c2ixys(x + e["dX"], y + e["dY"], s)
    rpom = erfa.pom00(e["xp"], e["yp"], erfa.sp00(tt1, tt2))
    return erfa.c2tcio(rc2i, erfa.era00(ut11, ut12), rpom), (ut11, ut12)


def rz(angle):
    r = np.eye(3)
    return erfa.rz(angle, r)


def split(jd):
    """A single-double Julian date as two parts, exactly (Sterbenz)."""
    return DJ00, jd - DJ00


def seconds_since_j2000(d1, d2):
    return float(((Fraction(d1) - Fraction(DJ00)) + Fraction(d2)) * 86400)


def main():
    cases_path, ffm_path, naif, de440 = sys.argv[1:5]
    cases = json.load(open(cases_path))
    ffm = {row["utc"]: row for row in json.load(open(ffm_path))["epochs"]}
    sp.furnsh(f"{naif}/naif0012.tls")
    sp.furnsh(f"{naif}/earth_latest_high_prec.bpc")
    sp.furnsh(de440)

    sets = {}
    for c in cases["cases"]:
        sets.setdefault(c["earthOrientation"], c["sampleEpochsUtc"])
    out = {"tools": {"pyerfa": erfa.__version__, "erfa": erfa.version.erfa_version,
                     "sofa": erfa.version.sofa_version, "spiceypy": sp.__version__,
                     "cspice": sp.tkvrsn("TOOLKIT"), "numpy": np.__version__},
           "epochs": []}
    for eop_id, epochs in sets.items():
        rows = cases["earthOrientation"][eop_id]["rows"]
        for utc in epochs:
            h = ffm[utc]
            u1, u2 = two_part_utc(utc)
            tai1, tai2 = erfa.utctai(u1, u2)
            tt1, tt2 = erfa.taitt(tai1, tai2)
            y, mo, d, fd = erfa.jd2cal(u1, u2)
            c2t, (ut11, ut12) = c2t_iers2010(tt1, tt2, rows)
            ut_frac = (ut11 - 0.5) % 1.0 + ut12
            dtdb = erfa.dtdb(tt1, tt2, ut_frac, 0.0, 0.0, 0.0)
            # The same chain at the instant FFM evaluates (its jdTtUsed).
            c2t_ffm_instant, _ = c2t_iers2010(h["tt1"], h["tt2"], rows)
            gmst = erfa.gmst06(ut11, ut12, tt1, tt2)
            gmst_ffm_instant = erfa.gmst06(h["ut11"], h["ut12"], h["tt1"], h["tt2"])
            teme06 = rz(erfa.ee06a(tt1, tt2)) @ erfa.pnm06a(tt1, tt2)
            # IAU 1976/1980 pieces at FFM's own TT, and the classical
            # Earth-fixed chain (UT1 = UTC, no polar motion, no frame bias)
            # that FFM's no-EOP fallback states it implements.
            ht1, ht2 = h["tt1"], h["tt2"]
            hu1, hu2 = erfa.taiutc(*erfa.tttai(ht1, ht2))
            classical = rz(erfa.gst94(hu1, hu2)) @ erfa.nutm80(ht1, ht2) @ erfa.pmat76(ht1, ht2)
            teme80 = rz(erfa.eqeq94(tt1, tt2)) @ erfa.pnm80(tt1, tt2)

            et_spice = sp.str2et(utc.replace("T", " ") + " UTC")
            tt_s = seconds_since_j2000(tt1, tt2)
            et_erfa = tt_s + dtdb
            et_ffm = h["etTdb"]
            spice_tdb_minus_tt = et_spice - sp.unitim(et_spice, "ET", "TDT")

            def body(target, et):
                state, _ = sp.spkgeo(target, et, "J2000", 399)
                return list(state)

            out["epochs"].append({
                "utc": utc, "earthOrientation": eop_id,
                "leapSeconds": erfa.dat(y, mo, d, fd),
                "leapSecondsSpice": round(sp.deltet(et_spice, "ET") - 32.184),
                "tt1": tt1, "tt2": tt2,
                "tdbMinusTtErfaS": dtdb,
                "tdbMinusTtSpiceS": spice_tdb_minus_tt,
                "etErfa": et_erfa, "etSpice": et_spice, "etFfm": et_ffm,
                "c2tErfa": c2t.ravel().tolist(),
                "c2tErfaAtFfmInstant": c2t_ffm_instant.ravel().tolist(),
                "c2tSpiceItrf93": np.array(sp.pxform("J2000", "ITRF93", et_spice)).ravel().tolist(),
                "gmst06": gmst, "gmst06AtFfmInstant": gmst_ffm_instant,
                "gcrfToTemeErfa06": teme06.ravel().tolist(),
                "pmat76AtFfmInstant": erfa.pmat76(ht1, ht2).ravel().tolist(),
                "nutm80AtFfmInstant": erfa.nutm80(ht1, ht2).ravel().tolist(),
                "gcrfToTemeFk5AtFfmInstant": (rz(erfa.eqeq94(ht1, ht2)) @ erfa.pnm80(ht1, ht2)).ravel().tolist(),
                "c2tClassicalAtFfmInstant": classical.ravel().tolist(),
                "gcrfToTemeFk5": teme80.ravel().tolist(),
                "sunSpiceAtFfmInstant": body(10, et_ffm),
                "moonSpiceAtFfmInstant": body(301, et_ffm),
                "sunSpiceAtErfaTdb": body(10, et_erfa),
                "moonSpiceAtErfaTdb": body(301, et_erfa),
            })
    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main()
