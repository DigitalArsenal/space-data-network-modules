# Test fixture provenance

`mlab-asn14593-histogram_daily_stats.sample.json` is a verbatim cut of the
**live** M-Lab statistics-pipeline export for AS14593 (SPACEX-STARLINK),
fetched 2026-08-04 anonymously over HTTPS — no BigQuery, no credentials:

    GET https://statistics.measurementlab.net/v0/asn/14593/2024/histogram_daily_stats.json
    -> HTTP 200, 529,144 bytes, 688 rows, 86 distinct dates
       (2024-01-01 .. 2024-03-26), 8 log-space throughput buckets per date

The same bytes are served from the underlying public bucket at
`https://storage.googleapis.com/statistics-mlab-oti/v0/asn/14593/2024/histogram_daily_stats.json`
(verified byte-identical, HTTP 200, 529,144 bytes).

The fixture keeps **all 8 bucket rows of 3 dates** (24 rows), chosen to
exercise the collapse and the window arithmetic rather than for appearance:

* `2024-01-01` — a year boundary
* `2024-02-29` — a leap day
* `2024-03-26` — the LAST date the pipeline ever published for this ASN

## Freshness, verified rather than assumed

The statistics pipeline is **not currently publishing**. Object listing of the
public bucket on 2026-08-04 returns, for `v0/asn/14593/`, exactly five objects:

| object | size | last written |
| --- | --- | --- |
| `2020/histogram_daily_stats.json` | 6,077 | 2021-06-28T17:01:02Z |
| `2021/histogram_daily_stats.json` | 694,282 | 2021-12-31T13:35:51Z |
| `2022/histogram_daily_stats.json` | 2,219,145 | 2022-12-31T01:52:59Z |
| `2023/histogram_daily_stats.json` | 2,126,260 | 2023-12-31T01:42:44Z |
| `2024/histogram_daily_stats.json` | 529,144 | 2024-03-28T03:00:45Z |

The freeze is pipeline-wide, not ASN-specific: `v0/asn/7922/` (Comcast) and
`v0/NA/US/` show the same terminal 2024-03-28 write. The module therefore
defaults `mlab_year` to `2024` and the live smoke test asserts the endpoint
still answers, so the day the pipeline resumes, the only change needed is the
node CONFIG value.

## Units and semantics (from the upstream query, not inferred)

`m-lab/stats-pipeline`, `statistics/queries/global_asn_histogram.sql`, read
2026-08-04:

* `download_*` / `upload_*` are `a.MeanThroughputMbps` -> **Mbps**
  (`MIN`, `APPROX_QUANTILES(...,100)[ORDINAL(25|50|75)]`, `AVG`, `MAX`)
* `*_minRTT_MED` is the median of `a.MinRTT` -> **milliseconds**
* `*_samples_day` is `COUNT(*)` over one randomly chosen test per client IP
  per day
* the grouping key is `client.Network.ASNumber`, which is why AS14593 **is**
  the Starlink filter
* source views: `measurement-lab.ndt.unified_downloads` /
  `unified_uploads`

## Licence

M-Lab test data is **CC0**. Verified live 2026-08-04 at
<https://www.measurementlab.net/data/>: "All data collected by M-Lab tests are
available to the public without restriction under a No Rights Reserved
Creative Commons Zero Waiver." The same page states the citation format
carried in `CNPProvenance.ATTRIBUTION`:

> The M-Lab NDT Data Set *&lt;date range used&gt;*.
> https://measurementlab.net/tests/ndt

(The measurementlab.net **site material** is CC BY-NC-SA; the **data** is CC0.
`NON_COMMERCIAL_ONLY` is false on this lane for that reason.)
