# The four-container fixture set

One trajectory, written four ways. These files are the input to
`tests/ephemeris_propagator_native.cpp` and `tests/module_abi.test.mjs`, and
they are **synthetic** — authored here, not published data.

| file                | bytes  | container                        | SHA-256 |
| ------------------- | ------ | -------------------------------- | ------- |
| `ephemeris.oem`     | 17767  | CCSDS OEM, keyword-value notation | `5a9604070783a65d6f1cb146f7cc8065052da7abd8924c6d02fbe8a2a09fa375` |
| `ephemeris.bsp`     | 10240  | SPK, DAF type 13 (Hermite)        | `05d758324a8e55466d68fe9794e8211145e76a6f5876cb13c47725812770f036` |
| `ephemeris.code500` | 14000  | Code-500 binary, little-endian    | `54c3323e7565f51356352e08f1f30a7400738d8314e86cdeb78d6901e03e2b1e` |
| `ephemeris.e`       | 20198  | STK `.e` ephemeris                | `e7329eb02d9c53cc934c0336d5c1a12d337e907c0b2db261665c8ff25c91a899` |

## Why synthetic, and why that is the right answer here

The acceptance these files serve makes two claims, and neither can be measured
against a published product.

**Four containers of ONE trajectory must agree.** No published dataset ships the
same arc as an OEM *and* an SPK *and* a Code-500 *and* an STK ephemeris. Any real
set of four files is four different arcs from four different producers, and the
disagreement between them is the producers' — force models, fit spans, output
grids — not the readers'. Measuring a reader against that is measuring noise.

**Interpolation error at an INTERIOR epoch must be measurable.** The Hermite
versus Lagrange ordering and the degree sweep both compare an interpolant with
the true state *between* the nodes. A published ephemeris only knows its own
samples: comparing an interpolant with a resampling of the same file measures
the producer's dense output, which is a different question with a different
answer. A closed-form two-body arc knows its value at every instant exactly, so
the error the acceptance prints is the interpolant's and nothing else.

This is a deliberate trade. These fixtures are **not** an independent authority
on any format's byte layout — the published corpus in
`files/orbit-products/fixtures/` is, and that is where SPK is checked against
CSPICE, SP3 against published IGS products and STK against Orekit. These four
carry the one property that corpus cannot: they are the same arc.

## The trajectory

Closed-form two-body (Keplerian) motion. Osculating elements at the arc epoch:

| element                    | value                     |
| -------------------------- | ------------------------- |
| semi-major axis `a`        | 7000.0 km                 |
| eccentricity `e`           | 0.001                     |
| inclination `i`            | 51.6°                     |
| right ascension `Ω`        | 40.0°                     |
| argument of perigee `ω`    | 30.0°                     |
| mean anomaly at epoch `M₀` | 0.0°                      |
| gravitational parameter `μ`| **398600.4418 km³ s⁻²** (WGS-84 / EGM-96 Earth GM) |

Derived: orbital period 5828.517 s.

Kepler's equation is solved by Newton iteration to a residual below 1e-16 rad,
so the node states and the interior truth are at the double's floor rather than
at an iteration budget. Position and velocity are built from the perifocal
closed forms in the eccentric anomaly and rotated by the standard 3-1-3
sequence.

## The sampling

| property   | value |
| ---------- | ----- |
| arc epoch  | 2026-01-01T00:00:00 (820497600.0 s past the J2000 epoch) |
| step       | 60 s, **uniform** |
| nodes      | 121 |
| span       | 7200 s = 1.235 revolutions |
| frame      | J2000 |
| centre     | EARTH |
| time system| UTC |
| declared interpolation | Hermite, degree 7 (a 4-node window) |

The step is uniform because the compact forms need it: Code-500 stores one time
per 50-state record plus a stride, and $OEM's compact `EPHEMERIS_DATA` is an
implicit uniform grid. A variable step would make those layouts illegal rather
than merely inconvenient. The span is one period plus a margin so that a
7th-degree window sits well inside the array at every interior epoch the
acceptance samples, and never against an end where an equispaced Lagrange window
misbehaves for reasons that are not the degree.

`M₀ = 0` puts the arc epoch at perigee. Identity is NAIF target **-999999**,
centre 399, frame 1 — a target id outside every assigned range, because a
fixture must not claim a real object's identifier.

## Time, and what is NOT done to it

No time-scale conversion happens anywhere in this set. Each container declares
its own scale and its own origin, and the epochs are the same instants expressed
on each container's own axis:

| container | scale label | epoch axis |
| --------- | ----------- | ---------- |
| OEM       | `UTC`       | absolute ISO-8601 instants |
| SPK       | `TDB`       | seconds past J2000 (the DAF fixes this label; the numbers are the same) |
| Code-500  | `UTC`       | seconds from the DUT origin 1999-12-31 |
| STK       | `UTC`       | seconds from `ScenarioEpoch` 2026-01-01T00:00:00 |

The SPK carries a TDB label because a DAF has no other option; nothing converts
between that and the UTC the other three declare, and no leap second is applied,
assumed or needed. Every acceptance number is differential — four containers
against each other, propagation against direct interpolation of the same file,
an interpolant against the analytic arc — so the shared axis is what matters and
the labels are carried, not reconciled. A consumer that genuinely needs to mix
scales routes through `foundation/time`, which owns the leap-second table.

The Code-500 DUT origin is **1999-12-31** and not the format's customary
1957-09-18. Code-500 packs that origin as a two-digit year, so it cannot express
a 21st-century date at all and 1999-12-31 is the latest origin the field can
hold. Choosing it deliberately keeps the container's DUT round trip (seconds →
hundredths of a day → seconds) at a fraction of a microsecond instead of the
tens of microseconds a 1957 origin costs.

## Known, measured properties

* **Code-500 epochs wobble by ~1.2e-7 s at record boundaries.** The container
  stores each 50-state record's base time in DUT (1/100 day), and a 60 s grid is
  not exactly representable in that unit. It does not touch any state, and it is
  the reason `Series::uniform_step()` reports false for this one container. It
  is asserted, not tolerated in silence: `sources.agree.epochs.sec` bounds it at
  1e-6 s and measures 1.192e-7 s.
* **Code-500 positions round-trip to ~1.3e-12 km.** Distances are stored in DUL
  (1 DUL = 10000 km) and velocities in DUL/DUT, so each value takes two
  multiplications. That is the largest source divergence in the set, and it is
  what `sources.agree.nodes` reports as its worst pair (`oem/code500`).
* **The Code-500 frame tag is `2000`, not `J2000`.** The container's frame field
  is four characters wide, so `J2000` cannot be written into it — `2000` is the
  format's own J2000 tag. The module's `abi_frame_for()` table carries a row for
  it; without that row every Code-500 file is refused as an unknown frame.
* **A Julian date resolves 40 microseconds at this epoch.** JD 2461041 lies in
  [2²¹, 2²²), so one double ulp is 2⁻³¹ days = 4.02e-5 s. Any epoch handed to
  `plugin_propagate` that is not on that grid round-trips to within half of it —
  measured as `epoch.map.jd.quantum.sec` = 1.98e-5 s, which is 0.15 m of
  position at 7.5 km/s. This is a property of carrying an absolute epoch in one
  double, not of this module, and the acceptance samples the exact-map assertions
  on multiples of 1/1024 day, which ARE on that grid, so that the mapping's own
  exactness is measurable separately from the date's width.

## Regenerating

```sh
cd data-source/spk-source
c++ -std=c++17 -O2 -I ../../files/orbit-products/src \
    tests/make_containers.cpp -o /tmp/make_containers
/tmp/make_containers fixtures
```

The generator writes each file and then reads it back through
`ephem::load_container` with the format left **AUTO** before it exits, so a
fixture that no consumer can identify never reaches disk. Output is
deterministic — the OEM's `CREATION_DATE` is a fixed constant, never "now" — and
`tests/ephemeris_propagator_native.cpp` re-emits all four in memory on every run
and asserts the committed bytes are byte-identical
(`fixtures.reproducible.<format>`). A stale fixture therefore cannot quietly
become the thing being measured.

The arc itself and all four emitters live in `tests/fixture_arc.hpp`, which the
generator and the acceptance share. One Kepler solve, one set of writers: a
second copy would let the files and the truth they are graded against drift apart
while every printed line still said PASS.

### Epoch text

Epoch text comes from `ephem::oem::iso_from_seconds` in
`files/orbit-products/src/oem_projection.hpp` — the spine's own formatter, not a
second copy living here.

It briefly was a second copy. That function shifted its day count to the
0000-03-01 era with **730120** where the count it is handed needs **730425**
(Hinnant's 719468 plus the 10957 days from 1970-01-01 to 2000-01-01), so it
rendered every epoch exactly **305 days early** — it printed this arc's start,
820497600 s past J2000, as `2025-03-02T00:00:00`. These fixtures were generated
against a local formatter while that was outstanding. The constant is now fixed
upstream, the local formatter is deleted, and regenerating all four containers
through the spine reproduces the committed bytes **exactly**, which is the
evidence that the two agreed and that nothing in this set was ever built on the
wrong dates.

Worth recording how the defect hid: the states were right and only the epochs
were wrong, which is the shape that survives every state comparison.
`sources.agree.nodes` passed at 1.3e-12 km with the OEM's epoch axis 305 days
displaced, because it compares positions row by row. `sources.agree.epochs.sec`
and `sources.agree.epochs.absolute.sec` exist for that reason and stay.

# The mixed-segment kernels

Two SPK files whose segments are NOT all of a type the propagator reads as state
rows. Unlike the four-container set above, every byte of these was **written by
the official NAIF toolkit** (CSPICE N0067 through spiceypy 8.2.0), and the
reference state is CSPICE's own `spkpvn` on the readable segment. Nothing here
was produced by the code it tests. Input to `tests/mixed_segment_kernel.test.mjs`.

| file                       | bytes | segments (file order)                                   | SHA-256 |
| -------------------------- | ----- | ------------------------------------------------------- | ------- |
| `spk_mixed_t2_t13.bsp`     | 8192  | type 2 Chebyshev (target -961), type 13 Hermite (-960)  | `cc332d1ece2f5f741cb2145ed5f4036ee7bc2281498e23980f09e8d28a55e41e` |
| `spk_chebyshev_only.bsp`   | 8192  | type 2 Chebyshev (-962), type 3 Chebyshev (-963)        | `b8170ea6329f69fdd74dcc4dfa9be3c8d7faa0897e98158e6cfb907b7ada65e7` |
| `spk_mixed_reference.json` | —     | what CSPICE wrote and the `spkpvn` reference state      | — |

* **Arcs.** Circular two-body, μ = 398600.4418 km³ s⁻², from ET 830995200 s
  (2026-05-02T12:00:00 TDB) for 3600 s, center 399, frame J2000. The type-13
  body flies r = 7000 km, i = 51.6°, 61 states at 60 s, degree 7
  (`spkw13`). The Chebyshev bodies fly r = 26560 km, i = 55°, 600 s records of
  degree 9 (`spkw02`, `spkw03`), least-squares fitted on Chebyshev nodes — so a
  state served from the wrong segment is off by ~20000 km, never by round-off.
* **Probes.** Two, each a dyadic fraction of a day so the Julian date is exact
  and the propagator's JD → ET mapping adds no rounding: **interior**, ET
  830997225 s = JD 2461163.0234375 (33.75 steps in, a real Hermite
  interpolation), and **node**, ET 830997900 s = JD 2461163.03125 (node 45, the
  stored state). Measured on the built 0.1.1 module: interior |Δr| = 4.7e-10 m;
  node |Δr| = 0, |Δv| = 2.3e-13 m/s. Between nodes the propagator's type-13
  velocity is a Lagrange fit of the stored velocities, not SPKE13's derivative
  of the position polynomial, and lands 2.3e-3 m/s from CSPICE — so the test
  grades velocity only at the node.
* **Regenerating.** `python3 fixtures/make_mixed_kernels.py fixtures` with
  spiceypy and numpy installed; two runs write byte-identical files.
