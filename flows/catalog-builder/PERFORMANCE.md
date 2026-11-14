# Catalog throughput measurements

The compact product averages about 9.86 KB in the fitted synthetic sample. Parallel execution increases peak CPU and process memory. A deadline failure poisons the interrupted guest and requires replacement. Publication retention and export costs are outside these measurements. The measured host did not journal pending publication bytes; the integrated durable-retention host has additional synchronous write costs.

A complete 2,000-object first-build measurement is unavailable. The larger-catalog numbers below are arithmetic from 32-object samples. Eight distinct installed services passed a functional eight-object probe, which does not establish eight-service throughput.

## Controlled measurements

Inputs are synthetic near-circular orbits with 37 repeating phases and common weather. Every selected product uses exact W, compact seven-block annotation and native durable product/index writes. The benchmark uses SDK 0.9.14, standards 1.279.0, repacked fit inputs, retained instances and complete product scans. It does not measure the raw-fit preservation, selected-batch lookup, deadline reserve or instance-release configuration. The host supports complete indexed reads, per-service execution budgets and interruptible AOT.

Each comparison contains eight A–B–B–A rounds with independent stores and a primed runtime. Trigger intervals include complete scans, fitting, covariance and product/index writes. Input preparation, instantiation, prewarming and shutdown are excluded. Whole-process RSS includes setup. The two-instance comparison uses the default compiled program in separate instances; the four-service comparison uses distinct compiled IDs registered with the node plugin manager. Both use the same numerical guest objects.

| Comparison | Objects per invocation | Median A/B runtime | Middle half | Width / median |
| --- | ---: | ---: | --- | ---: |
| 2 instances / 1 | 32 | 0.5086 | 0.5078–0.5137 | 1.15% |
| 4 services / 1 | 32 | 0.2574 | 0.2561–0.2630 | 2.67% |

Both completed comparisons satisfy the 5% middle-half stability rule.

| Services | Average active CPUs | Peak aggregate guest memory | Peak process RSS | 33,000 processing hours | 100,000 processing hours |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 1.01 | 6,225,920 bytes | 625,082,368 bytes | 4.63 | 14.02 |
| 2 | 1.95 | 12,255,232 bytes | 657,489,920 bytes | 2.37 | 7.18 |
| 4 | 3.84 | 24,510,464 bytes | 738,230,272 bytes | 1.19 | 3.62 |

The two larger-catalog columns are arithmetic, excluding scan growth, harder fits, publication processing and exports. Guest figures sum the linear-memory high-water marks observed after each invocation.

## Batch and scheduled capacity

A single service completed 1,024 products and indexes within its ten-minute execution budget. Its guest used 7,405,568 bytes against the configured 268,435,456-byte limit; whole-process peak RSS was 627,539,968 bytes. A 1,280-object request reached the deadline after 1,195 complete product/index pairs. Thus 1,024 is the largest fully completed tested batch, with limited deadline headroom. The controller ceiling is 1,024; its deadline reserve can stop a batch sooner.

At 128 changes per ten-minute tick, each service admits 18,432 changes per day. Two services admit 36,864, four admit 73,728 and eight admit 147,456. Thus default-batch schedule arithmetic needs two services for 33,000 daily changes and eight for 100,000. Eight-service processing capacity is unmeasured. These counts also require the timer and retrieval-debounce settings in the README.

A single service with batch 256 admits 36,864 changes per day. Two services with batch 512 each admit 147,456 with two concurrent fitting threads. These settings cover 33,000 and 100,000 respectively in scheduling arithmetic; concurrent 512-object batches and full-size scan memory are not directly measured. At two services with batch 512, an initial 33,000-object build requires 33 ten-minute slots, about 5.5 hours of slots. At eight services with batch 512 it requires nine slots, about 90 minutes, also arithmetic.

The controller pages live seed/identity/index sources and retains only its partition. Product recovery uses a batch lookup. Memory bounds, the deadline reserve, instance replacement and durable publication costs can lower the arithmetic rates. The benchmark does not establish full-catalog publication capacity or sustained daily throughput.
