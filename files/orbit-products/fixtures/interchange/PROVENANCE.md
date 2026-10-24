# fixtures/interchange — Sentinel EOF and NAIF CK provenance

Nothing here was produced by the code it tests. Each source has its own directory in the lane's scratch area, was
downloaded once, and was never executed.

## Sentinel-1A orbit files (Copernicus POD service)

License: Copernicus Sentinel data are free, full and open (Regulation (EU) No 1159/2013, the Sentinel Data Terms);
redistribution requires the attribution **"Contains modified Copernicus Sentinel data [2024]"**. The excerpts below
are modified (cut to a window).

| file | source | sha256 of the original zip |
| --- | --- | --- |
| `S1A_AUX_POEORB_V20240108_overlap.EOF` | `https://step.esa.int/auxdata/orbits/Sentinel-1/POEORB/S1A/2024/01/S1A_OPER_AUX_POEORB_OPOD_20240129T070738_V20240108T225942_20240110T005942.EOF.zip` | `026cdbc56d409732390aa983834d49c5baac7efc986e49816db55e2995ee244e` |
| `S1A_AUX_POEORB_V20240109_overlap.EOF` | `.../S1A_OPER_AUX_POEORB_OPOD_20240130T070737_V20240109T225942_20240111T005942.EOF.zip` | `a6acd8547d261c9d7be8254f8c7f7691a25c7075973d033b135736935da4ee10` |
| `S1A_AUX_RESORB_V20240109_excerpt.EOF` | `https://step.esa.int/auxdata/orbits/Sentinel-1/RESORB/S1A/2024/01/S1A_OPER_AUX_RESORB_OPOD_20240110T021021_V20240109T221551_20240110T013321.EOF.zip` | `60a3d05bd46cf32084de59749e2be8b528b5f7e9bb053b42e3614efd593900c9` |

Produced by `tests/reference/eof_excerpt.py`: the header, every OSV block whose UTC lies in the window
(`2024-01-09T22:59:42` to `2024-01-10T00:59:42` for the precise files, `23:00:00` to `00:30:00` for the restituted
file) and the closing tags are kept **byte for byte**; the only edit is `List_of_OSVs count`, rewritten to the number
of OSVs kept (721, 721, 541). The two precise windows are the two hours the adjacent daily files share.

`*.reference.tsv`: `tests/reference/eof_reference.py`, Python `xml.etree` reading the committed excerpts. The
module's states must equal them to the bit. `resorb_vs_poeorb.reference.txt`: `tests/reference/eof_resorb_vs_poe.py`.

Sentinel-2 and Sentinel-3 orbit files need a Copernicus Data Space account to download (the catalog is public, the
download answers 401 without a token) and were not obtained.

## NAIF kernels (NASA/JPL NAIF)

Published by NAIF and copied verbatim. NAIF distributes its kernels for use without restriction; credit
NASA/JPL-Caltech NAIF.

Each file is identical to the original at its URL (sha256 below).

| file | source | sha256 |
| --- | --- | --- |
| `msl_surf_rover_tlm_0179_0269_v1.bc` | `https://naif.jpl.nasa.gov/pub/naif/MSL/kernels/ck/` | `37b575196682678c716c014a244f78fb520ab4ef8d13e3e916028ca894e0f65d` |
| `msl_ra_straight_v1.bc` | idem | `d58ee77bbb5ae91b29edce12f740df02af0684caf1fa0c6533c234da940e17b7` |
| `msl_hga_zero_v1.bc` | idem | `51c43d96fd037f98431646f15927aeeeb5d9ec3b85974986075683da2fb2f6e6` |
| `MSL_76_SCLKSCET.00019.tsc` | `https://naif.jpl.nasa.gov/pub/naif/MSL/kernels/sclk/` | `5e325bc664d0c4d5ab0f846acd55f676e700fadf8c744b386d9a658744416c1f` |
| `insight_ida_enc_180505_181127_v1.bc` | `https://naif.jpl.nasa.gov/pub/naif/INSIGHT/kernels/ck/` | `02b77b34f386cb2a9a257420dc4c44364d3f0114670e73a201645fa9662d8314` |
| `insight_surf_nom_v2.bc` (type 2: the refusal case) | idem | `6c279b8216bf8ca3afd472174469835fbdf06662dbf38d856e4bbb2e2dab158f` |
| `NSY_SCLKSCET.00025.tsc` | `https://naif.jpl.nasa.gov/pub/naif/INSIGHT/kernels/sclk/` | `971fd9950d3247404e6ec9589451b5ac358d3057de35c0c4094778b09f663a4b` |

`naif_ck.reference.txt`: `tests/reference/ck_reference.py`, CSPICE N0067 (spiceypy 8.3.0) with `naif0012.tls`.
`naif_ck_written.bc` is a kernel written by `write_naif_ck` from the synthetic attitude in
`tests/lib/ck_synthetic.mjs`; `naif_ck_written.readback.txt` is CSPICE's reading of it
(`tests/reference/ck_readback.py`). The test fails if the module's bytes ever differ from the committed kernel
(`INTERCHANGE_REGENERATE=1` rewrites both).

## CODE MGEX final orbit (the precise reference for the broadcast ephemerides)

`../COD0MGXFIN_20250190000_01D_05M_ORB.48ep.sp3`: the CODE (AIUB) multi-GNSS final orbit of 2025-01-19 from
`ftp://igs.gnsswhu.cn/pub/gps/products/2350/COD0MGXFIN_20250190000_01D_05M_ORB.SP3.gz` (sha256
`e18b018289dfd7695fdf8efe7cdb303c0dc9dee229312755ca270e8bb1f2a5ef`; IGS/MGEX products are open, acknowledge CODE and
the IGS), the epochs whose minute is 0 or 30 (49 of 288), lines byte for byte; the header's number of epochs (288 to 49)
and epoch interval (300 s to 1800 s) are rewritten to match. 368,181 bytes. The 3-epoch excerpt beside it
(`COD0MGXFIN_20250190000_01D_05M_ORB.3ep.sp3`) is the older fixture of the SP3 reader tests.
