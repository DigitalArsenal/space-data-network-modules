# Provider-format fixtures

Every file here is SYNTHETIC. No real operator ephemeris or element set is stored
in this repository: each state was computed from a made-up circular orbit (or made-up
parameters) and written in the exact layout of its format. They exist so
`tests/native/formats_probe.cpp` and the `odhpop::formats` parsers can be exercised
without any provider data.

Orbits are circular Keplerian (mu = 398600.4418 km^3/s^2) with invented elements; Earth-fixed
files rotate the inertial state by the Earth rotation rate 7.292115e-5 rad/s.

| File | Format token | How it was built |
| --- | --- | --- |
| `css_synthetic.oem` | (source of the zip) | CCSDS OEM KVN, object `SYNTHETIC-STATION`, 2 META blocks x 20 states at 60 s, EME2000, UTC, two COMMENT lines announcing a maneuver and an attitude change. |
| `css_synthetic.zip` | `css-oem-zip` | Python `zipfile`: `README.txt` stored (method 0) and `W0SYNTHETIC.oem` deflated (method 8), holding the OEM above. |
| `planet_synthetic.states` | `planet-states` | Six rows `id t x y z vx vy vz c9 inf` in m and m/s, one state per satellite, `t` = seconds past J2000 ending in `.184` (TT), sun-synchronous planes. |
| `iess412_synthetic.i11` | `iess412-i11` | SES `.I11` layout with invented parameters; the 170 h check line was computed by an independent Python replica of the model, so the parser's check gate passes. |
| `oneweb_synthetic_ltef.csv` | `oneweb-ltef` | Eight rows of 17 integers shaped like the LTEF encoding (invented values). The parser must answer `not-an-ephemeris`. |
| `moditc_synthetic.txt` | `moditc` | Three free header lines + `UVW`, then 24 points `yyyyDDDhhmmss.sss x y z dx dy dz` (km, km/s), each followed by three 7-value covariance rows (invented diagonal covariance). |
| `sp3_synthetic.sp3` | `sp3` | SP3-d, `IGS20`, GPS time, two satellites (`G01`, `E11`) x 12 epochs at 900 s; `G01` has V records; one `E11` epoch carries the 0/999999.999999 bad flag and is skipped. |
| `cpf_synthetic.cpf` | `cpf` | CPF v2: H1, H2 (reference frame code 0), H9, 31 record-10 lines at 300 s, metres, UTC, `99`. |

Build and run the probe:

```
nice clang++ -std=c++17 -O1 -I analysis/od/hpop-fit/src analysis/od/hpop-fit/src/formats/*.cpp \
  analysis/od/hpop-fit/tests/native/formats_probe.cpp -o formats_probe
./formats_probe tests/fixtures/formats/css_synthetic.zip css-oem-zip
```

Expected results: css 1 object / 40 samples / 2 events; planet 6 objects; iess412 1 object / 10201
samples (60 s over 170 h); oneweb `not-an-ephemeris`; moditc 1 object / 24 samples; sp3 2 objects / 23
samples (12 with velocity); cpf 1 object / 31 samples.
