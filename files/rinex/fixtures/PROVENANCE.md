# files/rinex fixtures — provenance

Downloaded once from the IGS data center at BKG into a directory of its own, never executed.

License: IGS data and products are open (no restriction on use; acknowledge the IGS and the station operator).
`igs.bkg.bund.de` publishes no separate license text on its pages, so the IGS open-data terms are the ones recorded.
Station WTZR: Geodetic Observatory Wettzell (BKG), RINEX produced as the file's header states.

| file | source | note |
| --- | --- | --- |
| `WTZR00DEU_R_20250190000_01D_30S_MO.first20.rnx` | `https://igs.bkg.bund.de/root_ftp/IGS/obs/2025/019/WTZR00DEU_R_20250190000_01D_30S_MO.crx.gz` (sha256 `a7abf1e6351f10d250e681e8f9685ef726e1956105796e874e9d78c8f438e468`) | CRINEX decompressed with `hatanaka` (RNXCMP's CRX2RNX); header and the first 20 epochs (00:00:00 to 00:09:30 GPST), lines kept byte for byte. The header is the original's and describes the whole day (2880 epochs). |
| `WTZR00DEU_R_20250190000_01D_30S_MO.first20.reference.tsv` | `tests/reference/rinex_obs_reference.py` | georinex 1.16.2 for what is observed and its value; the indicators from the file's own columns (georinex 1.16.2 reports LLI 0 on some phase observations the file marks). |
| `BRDC00WRD_R_20250190000_01D_GN.head.rnx` | `https://igs.bkg.bund.de/root_ftp/IGS/BRDC/2025/019/BRDC00WRD_R_20250190000_01D_GN.rnx.gz` (sha256 `c8ce15ae422475100685c0853674f8fb4d7512800886936eb7233df304511e43`) | the first 3000 bytes: RINEX 3.05 GPS navigation, the `navigation-not-in-sds` refusal |
| `BRDC00IGS_R_20250190000_01D_MN.head.rnx` | `.../BRDC00IGS_R_20250190000_01D_MN.rnx.gz` (sha256 `a55dbd9fcb8e9867b27f0c2a625f1b5b82695e31805f968cca93806e8008eba7`) | the first 2500 bytes: RINEX 3.04 mixed navigation |
| `BRD400DLR_S_20250190000_01D_MN.head.rnx` | `.../BRD400DLR_S_20250190000_01D_MN.rnx.gz` (sha256 `8c01fb8c2667edcd73edf2478786f6987a5352cf696521bf298d8ae790ab33bf`) | the first 1200 bytes: RINEX 4.02, the `unsupported-rinex-version` refusal |
