# Catalog resident capacity

Attempt events, scanning, instance replacement and durable publication add
work. Sustained throughput, full-build time, processing memory and compressed
transfer size are unmeasured for this configuration. No older timing or export
fixture establishes those quantities.

`tests/capacity.test.mjs` exercises the compiled controller with synthetic seed,
identity, selected-product index and operational attempt records. Each object
accounts for 2,540 bytes, including the four 256-byte entry allowances. Weather
is empty in this capacity fixture. The default 67,108,864-byte cap retains all
four inputs for 26,420 objects; the boundary plus one reports a partial scan.
This is a fixture-dependent accounting limit, not a heap guarantee. Longer
names/reasons, larger seeds, weather and quarantine bookkeeping consume space.

| Catalog objects | Partitions | Retained complete objects per tested partition | Accounted bytes | Result |
| ---: | ---: | ---: | ---: | --- |
| 26,420 | 1 | 26,420 | 67,106,800 | Complete |
| 26,421 | 1 | 26,419 | 67,108,556 | Partial; no unknown selection treated as new |
| 33,000 | 1 | 1 | 67,108,712 | Partial; increase partitions |
| 33,000 | 2 | 16,500 | 41,910,000 | Complete |
| 100,000 | 8 | 12,500 | 31,750,000 | Complete |

For this fixture, use two partitions for 33,000 objects and eight for 100,000
at the default cap. Inspect the reported resident bytes and partial-scan
warnings with the actual inputs. Partitioning still reads the shared sources;
it bounds retained per-instance data. Configure 4,096 memory pages (256 MiB)
for the service. The controller's accounting excludes runtime/compiler memory,
transient pages and numerical working buffers.

The configured batch ceiling is 1,024 changes, subject to elapsed budget and
adaptive reserve. It is a limit, not a measured completed-batch capacity.
Memory sufficiency does not establish a daily processing rate or publication
capacity. Deployment sizing requires measurements including startup, scans,
attempt writes, numerical work, product/index commits and publication retention.
