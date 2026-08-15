# Fixture provenance

Every file here is a **verbatim slice of a live GeoNames dump**, captured
2026-08-15 from `https://download.geonames.org/export/dump/`. Nothing was
edited, reformatted or re-serialized — each is the first N lines of the body a
successful `GET` returned, kept because the failure this lane must not repeat is
`cell-tower-provider-endpoints-are-download-pages`: URLs and column contracts
written from documentation rather than from a fetch that actually worked. A
hand-written fixture agrees with whatever the author believed the service
returns. These disagree with the author.

**Licence.** GeoNames publishes these dumps under **CC BY 4.0**
(<https://creativecommons.org/licenses/by/4.0/>). The obligation is discharged
at runtime the same way every other provider's is: `LICENSE`, `LICENSE_URL` and
`ATTRIBUTION` ride in `$GNP.SOURCE` on **every** record this lane emits, because
the standard names no gazetteer and the credit line therefore has to live in the
data. These slices are small extracts kept for regression testing; the full
bodies are fetched at runtime.

| fixture | request | rows |
|---|---|---|
| `geonames-modifications.slice.txt` | `GET modifications-2026-08-14.txt` (30,390 B live) | first 12 |
| `geonames-deletes.slice.txt` | `GET deletes-2026-08-14.txt` | the file's **only** row |
| `admin1CodesASCII.slice.txt` | `GET admin1CodesASCII.txt` (151,536 B live) | first 6 |
| `admin2Codes.slice.txt` | `GET admin2Codes.txt` (2,371,397 B live) | first 6 |
| `countryInfo.slice.txt` | `GET countryInfo.txt` (31,678 B live) | first 60 lines = 50 comment lines + 10 countries |

## What each one is able to FAIL, which is the only property that makes a fixture worth keeping

- **`geonames-modifications.slice.txt` settled the lane's central design
  question.** The daily modifications file was assumed to be a delta format of
  its own. It is not: every row is a **full 19-column geoname row**, identical in
  shape to the seed dump's. So the seed and the delta share ONE decoder and a
  modification is an upsert of exactly the record the seed would have produced.
  A synthetic fixture would have encoded the assumption instead of refuting it.
  The rows are Argentinian (`AR.01`, `AR.13`), which is what lets the admin-join
  test assert a `CC.A1.A2` **miss** leaves `ADMIN2_NAME` unset rather than
  inheriting a neighbouring division's name.

- **`countryInfo.slice.txt` keeps its 50 comment lines on purpose.** The last of
  them is the column header `#ISO	ISO3	…`, which is a perfectly well-formed
  row. A decoder that skips only blank lines turns it into a country whose ISO
  code is `#ISO`, and the count test (`10`, not `11`) is what catches that.

- **`geonames-deletes.slice.txt` is one row because the live file was one row.**
  It is kept verbatim rather than padded, and the multi-row and
  reason-code cases are asserted against inline strings in the test instead —
  padding a live capture would destroy the one thing it is evidence of.
  The **operationally load-bearing fact** recorded alongside it: GeoNames retains
  only the **most recent** day's `deletes-*.txt`. `2026-08-13`, `-12` and `-11`
  all answered **404 with an HTML body** on 2026-08-15. That is why
  `parse_deletes` refuses any row whose first column is not a decimal id — a
  decoder that trusted the body would tombstone places named `<!DOCTYPE`.

- **`admin1CodesASCII.slice.txt` carries `Sant Julià de Loria`**, so the UTF-8
  path through the lookup frame is asserted on real bytes rather than on ASCII
  that would pass either way.

## Not a fixture: the ZIP container

`inflate`'s archives are **built inside the test** (`buildZip`), not committed.
The bytes under test there are the *container's*, and a constructed one can be
made to carry the exact pathologies the decoder must survive — a data-descriptor
local header whose sizes are zero, and a central directory whose stated
uncompressed size disagrees with what inflates. Neither occurs in the live seed
archive, which is precisely why neither would be covered by a slice of it.
