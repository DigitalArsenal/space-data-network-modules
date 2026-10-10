# Sources of the Orekit fixtures

- `orekit-reference.json`, `orekit-gnss-srp-reference.json`: outputs of Orekit 13.1
  (CS GROUP, Apache-2.0; see `../../../NOTICE`) run by `OrekitReference.java` and
  `OrekitGnssSrpReference.java`. Orekit's licence and notice travel with them in
  `../../../NOTICE`.
- `eop-2026-06.json`, `eop-2026-08.json`: IERS finals2000A rows (U.S. Government,
  approved for public release) as `$EOP`, by `make-eop.mjs`.
- `jb2008-2026-06.json`, `spw-2026-08.json`: **synthetic** JB2008 drivers and daily
  space weather, `make-jb2008.mjs` and `make-spw.mjs` over the synthetic files of
  `make-synthetic-weather.mjs`. Space Environment Technologies' SOLFSMY.TXT and
  DTCFILE.TXT and CelesTrak's SpaceWeather-All-v1.2.txt state no licence, so no copy
  of their values is kept. The four Orekit cases that read these drivers (W1 and J1,
  LEO400 and SSO700) were rerun on the same synthetic files, so HPOP and Orekit are
  compared on identical inputs; the other 59 cases are unchanged.

To regenerate the four cases:

```sh
node make-synthetic-weather.mjs <dir>/orekit-syn          # beside symlinks to the rest of orekit-data
node make-gfc.mjs <gfc>/EGM2008-hpop.gfc 70 3.986004415e14 6378136.3 egm2008
java -cp "<jars>/*" OrekitReference.java <dir>/orekit-syn <gfc> <out.json> W1-field   # and J1-field
node make-jb2008.mjs <dir>/orekit-syn/Space-Environment-Data/SOLFSMY.TXT <dir>/orekit-syn/Space-Environment-Data/DTCFILE.TXT 2026-06-02 2026-06-13 jb2008-2026-06.json
node make-spw.mjs <dir>/orekit-syn/CSSI-Space-Weather-Data/SpaceWeather-All-v1.2.txt 2026-08-01 2026-08-04 spw-2026-08.json
```
