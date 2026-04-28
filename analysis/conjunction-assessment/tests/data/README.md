# Local Conjunction Test Data

This directory is the package-local handoff point for large conjunction
validation data. Everything here is ignored by git except this README.

Place SOCRATES/CelesTrak catalog files directly in this directory:

- `socrates_current.csv`
- `socrates_full.csv`
- `socrates_maxprob.csv`
- `socrates_minrange_current.csv`
- `socrates_norad_ids.txt`
- `socrates_gp/gp_*.json`

Place Aerospace IVV archive files in `aerospace-archives/`:

- `aerospace-archives/AerospaceIVVDataset_20251009a.tar.gz`
- `aerospace-archives/AerospaceIVVDataset_20251009a_Size_ScreeningVolumes.csv.gz`
- `aerospace-archives/IVV_Releasable_Dataset_SFSH_DiscreteHBR.csv.gz`
- `aerospace-archives/IVV_Releasable_Dataset_Spherical_DefaultHBR.csv.gz`
- `aerospace-archives/Conjunction_Screening_Testset_Users_Guide.pdf`

Place extracted Aerospace replay data in `aerospace-ivv/`:

- `aerospace-ivv/docs/Conjunction_Screening_Testset_Users_Guide.txt`
- `aerospace-ivv/csv/IVV_Releasable_Dataset_Spherical_DefaultHBR.csv`
- `aerospace-ivv/csv/IVV_Releasable_Dataset_SFSH_DiscreteHBR.csv`
- `aerospace-ivv/csv/AerospaceIVVDataset_20251009a_Size_ScreeningVolumes.csv`
- `aerospace-ivv/ocm/AerospaceIVVDataset_20251009/...`

The tests use these paths by default. Override with
`CONJUNCTION_ASSESSMENT_ARCHIVE_ROOT`, `AEROSPACE_IVV_ARCHIVE_ROOT`,
`CONJUNCTION_ASSESSMENT_SOCRATES_ROOT`, `SOCRATES_LOCAL_ROOT`, or
`AEROSPACE_IVV_EXTRACTED_ROOT` when needed.
