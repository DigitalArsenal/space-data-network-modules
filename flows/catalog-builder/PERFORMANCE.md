# Catalog resident capacity

Attempt-state replacement, scanning, instance replacement and durable publication add work. Sustained throughput, full-build time, processing memory and compressed transfer size are unmeasured for this configuration.

`tests/capacity.test.mjs` exercises the compiled controller with synthetic seeds, identities and selected-product indexes. Successful objects have no operational attempt entry. Each object accounts for 1,820 bytes, including three 256-byte entry allowances. Weather and failed state are empty in this fixture. The default 67,108,864-byte cap retains all three inputs for 36,873 objects; the boundary plus one reports a partial scan. This is fixture-dependent accounting, not total heap usage. Longer names/reasons, larger seeds, weather and live failures consume space.

| Catalog objects | Partitions | Retained complete objects per tested partition | Accounted bytes | Result |
| ---: | ---: | ---: | ---: | --- |
| 36873 | 1 | 36873 | 67108860 | Complete |
| 36874 | 1 | 36869 | 67108720 | Partial |
| 33000 | 1 | 33000 | 60060000 | Complete |
| 33000 | 2 | 16500 | 30030000 | Complete |
| 100000 | 8 | 12500 | 22750000 | Complete |

This fixture retains 33,000 objects in one partition and 100,000 across eight. Inspect resident bytes and partial-scan warnings with actual inputs. Partitioning reads shared seed/identity/weather sources and retains only its own objects. Operational sources are separate per partition. Configure 4,096 memory pages (256 MiB) for the service. Accounting excludes runtime/compiler memory, transient pages and numerical working buffers. Operational state has a separate combined bound of 4,096 live attempts/quarantine keys and an 8 MiB serialized snapshot.

The batch ceiling is 1,024 changes, subject to elapsed budget and adaptive reserve. It is a limit, not measured completed-batch capacity. Memory sufficiency does not establish daily processing or publication capacity. Deployment sizing requires measurements including startup, scans, state replacement, numerical work, product/index commits and publication retention.
