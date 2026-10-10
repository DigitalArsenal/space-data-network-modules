# Environment, 2026-06-28 to 2026-07-20

The three PRW records HPOP reads (`earth_orientation`, `space_weather`,
`jb2008_indices`), framed by `tests/write-environment.mjs` from
propagator/hpop's own fixture writers. They hold space-environment data only,
no ephemerides. The DE440 kernel comes from
`files/orbit-products/tests/fixtures/de440/de440-2026.bsp`.

| Record | Source | sha256 of the source file |
| --- | --- | --- |
| earth_orientation.prw | IERS finals.all.iau2000.txt (Bulletin A), https://datacenter.iers.org/data/latestVersion/finals.all.iau2000.txt, retrieved 2026-10-09 | 0baf00f67a39ab362a3e4f07d2a1f084842178523f56bcf5a861e7ac084d411a |
| space_weather.prw | CelesTrak/CSSI SpaceWeather-All-v1.2.txt (the Orekit data copy) | 02a3af394ac627beb0fb14a0ad6b4e222e798503eae06a284ac535ca2cd63db5 |
| jb2008_indices.prw | Space Environment Technologies SOLFSMY.TXT and DTCFILE.TXT, https://sol.spacenvironment.net/JB2008/indices/, retrieved 2026-10-09 | ced35709d58d57394f2f1bfde5cb3c6dc2ec2c8baf16f1f839f135f3c03f15cc, f6485450c363e9be8e71c37e143ac768462deca77565b727ec2e96c025ab8d91 |

Regenerate:

```sh
node tests/write-environment.mjs tests/fixtures/environment-2026-07 2026-06-28 2026-07-20 \
  --finals finals.all.iau2000.txt --spw SpaceWeather-All-v1.2.txt \
  --solfsmy SOLFSMY.TXT --dtc DTCFILE.TXT \
  --kernel ../../../files/orbit-products/tests/fixtures/de440/de440-2026.bsp
rm tests/fixtures/environment-2026-07/kernel.prw   # framed from the committed kernel at test time
```
