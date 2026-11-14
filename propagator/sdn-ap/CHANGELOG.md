# Changelog

## AP coefficient forms (source change)

Four of 942 synthetic fitted records end farther from their numerical flight by more than 1 cm; the largest increase is 0.152457 m. Strong drag has a median cost 0.260% higher, ratio 1.002597 [0.998698, 1.004848]; eccentric has a median cost 0.773% higher, ratio 1.007726 [0.991527, 1.024483]; high eccentric has a median cost 0.824% higher, ratio 1.008237 [1.001407, 1.023386]; deep resonance has a median cost 0.767% higher, ratio 1.007674 [0.990502, 1.023074]. Forms A, CM, and R add 768 B per cache-holding set and per thread that needs their m-daily derivative rows. U and C add no derivative-row storage. The fifteen tested threshold neighborhoods have a maximum switch residual of 0.016281421 m and a regression bound of 0.063 m. A separate eccentric neighborhood reaches 0.111527867 m; neither figure is a global bound. Selection is fixed for the entire flight. Derivative rows resolve from the held-set identity, removing 12 unused pointer-maintenance instructions per non-AP state; the executed instruction count matches released 0.6.59. The paired timing and the shared time-table initialization proof are documented in SPEC.

AP thread startup prepares ERFA's shared leap-second lookup before parallel evaluation. This removes an initialization race inherited from 0.6.59 that can cache an incorrect Sun/Moon node. Deterministic readiness and forced-interleaving regressions pass with unchanged zero-bit state comparisons. No numerical formula or retained storage changes.

The selector fixed from epoch elements and the initialization-time gravity selection preserves the old path for U and instantiates one shared coefficient implementation for U, A, C, CM, and R. The 17-class boundary and direct-evaluation test passes. All 942 numerical-flight comparisons retain the within-100 m class counts, with no new crossing. Ascending, descending, shuffled, cross-epoch, and mixed four-thread state-purity checks pass. U regimes and SGP4/SGP4XP controls remain bit for bit. The poison regression invalidates the half-day table identity before overwriting its padded rows. The former refusal was caused by the test retaining that identity, and released builds do not execute the poison function.

No version or distribution artifact is changed.

## 0.6.59 — An AP set's state is a function of the set and the time

What gets worse: every set holds 16 more bytes, the upper node's time in its drag-pass cache (768 to 784 bytes a set, 1.6 MB at 100,000 objects). The 80 MiB store of 6,000 SGP4XP sets without AP's terms
(`test/memory-limit.e2e.mjs`, part 4) answers 2,473 sets where 0.6.55 to 0.6.58 answered 2,480; each state it answers is the same bits.

**Fits that fly their set on both sides of its epoch give different records than on 0.6.58**: different fitted elements, so different states from the record. Those are the fits whose
epoch is not the first state of the fit interval (fit_oem.inc, the epoch placement): an arc under 24 hours on a block that is not eccentric (the epoch is the arc's last state; the arc is
before it, the held-out and carried states after it), the hand-over fit (OUTPUT.START_TIME without STOP_TIME: the epoch is the arc's last state, the later states held out), and the diagnostic
placements of `sdnap_fit_epoch_diagnostic` (the middle state, the last). A fit with the default placement, the epoch at the first state, flies its set forward from the epoch only and its record
is the same bytes as 0.6.58's: the catalog fit to a forecast from the cutoff (0 to 120 h; 84 stored cases of seven classes, byte for byte), the conversion of a set's own SGP4 flight from 2.5 days
before its epoch to 5 days after (20 sets, byte for byte), and the carried-forecast and covariance flights of such a fit. Measured on the 12 h arcs of the carried classes of `test/lib/carried.mjs`, 0.6.58
against this build: the four AP classes change (LEO 300 km, LEO 830 km, MEO, GEO), the eight SGP4-XP classes do not; the largest element changes are 1.4e-5 degrees of mean anomaly (LEO 300 km), 3.7e-6 m²/kg of
AGOM (LEO 830 km) and 1.3e-8 degrees of argument of perigee (GEO), and the two records' flights over the carried day differ by up to 7.3 mm (LEO 300 km), 7.1 mm (LEO 830 km), 0.16 mm (MEO) and 0.08 mm (GEO).
No command in this repository prints these figures; the digests of `test/epoch-carried-pool.e2e.mjs` (the fitted records' bytes and the states flown from them, pinned apart) are what moved with them.

What moves besides: on every release through 0.6.58, an AP set asked at a time after another time on the other side of its epoch, inside the first bracket either side, answered a state that
differed from the same state asked once. The bracket after the epoch and the bracket before it shared one identity (the set's context and the lower node's index, 0 for both)
in the tesseral and m-daily bake caches, and the drag-pass segment above e 0.3 was kept under the lower node's time alone, the epoch's for both. A time-ordered flight that
crosses the epoch, which a catalog set asked at a clock time ahead of its epoch does, is such a series. Largest differences by class (this checkout with the two old keys put back; `STATE_PURITY_AS_0_6_56=1 node test/state-purity.e2e.mjs` prints them):
a decaying set (perigee 200 km, BTERM 0.01) 714 mm, a transfer orbit 7.5 mm, e 0.25 1.8 mm, 500 km 0.30 mm, e 0.1 0.22 mm, the 8 h class 0.18 mm, 830 km 0.17 mm, half-day class 6.5 to 31 um
(a blend of two sets 86 um), the 16 h class 31 um, Molniya 0.47 um, geosynchronous with tesseral 31 0.02 um, geosynchronous without tesseral terms none; strong-drag sets with perigee under about 350 km up to
49.7 mm on the pooled path of 0.6.58 (no command of this repository prints the 49.7 mm). The bracket's identity is now the set's context and the smaller of its two nodes' indexes (signed by
side), and the drag-pass segment is kept under both nodes' times and the perigee time.

What does not move, against 0.6.58's committed wasm (a6095d2c): a state of a set asked only after its epoch, or only before it, is the same bits (`node test/kernel-cost.mjs --diff ... --bound 0,0`, the default
list and `--tesseral 70 --slow`, 132 flights each, in time order, in reverse and shuffled; and the 942 stored AP records flown only after their epoch and only before it in three orders each, 226,080 states a flight kind
and order; and the replay of the 942 records through `propagate` with their covariance, 226,736 states and 4,761,456 covariance elements; no command of this repository runs the last two). The flights that differ are the ones asking on both
sides of their epoch: of the 942 records flown in time order from 2.5 days before the epoch to 5 days after (30 min), 237 differ (148 of 220 medium and other high-perigee records up to 1.0 mm, 55 of 62 geosynchronous-class
up to 0.43 mm, 34 of 350 of e 0.3 and over up to 20.5 mm; none of the 310 low records, perigee up to 1,400 km, on that schedule). A state no longer depends on what the set was asked before, on the caches it flew
with, or on the order of the calls (SPEC 9), on any number of threads while one thread flies a given set at a time (a set above e 0.3 stays on the calling thread), except the exception SPEC 9 states (a record that carries a covariance,
flown through `propagate`).
`test/state-purity.e2e.mjs` is the test; `test/epoch-pool.e2e.mjs` and `test/epoch-carried-pool.e2e.mjs` have the digests of this release.

## 0.6.58 — The epoch store's first pass on the pool; the memory grown in steps of 4 MiB

`sdnap_epochs_at` without a covariance plane builds and flies each series' sets on the pool's threads, one thread a series, in chunks of 16 series, and every
state and status is the calling thread's to the bit, but for the case below. A series holding a wide set (AP above e 0.05 in no resonance class, above e 0.3 in one) and a call with a
covariance plane stay on the calling thread. A call runs in slices of at most 4,096 series, each reserving its room before its batch; no memory grows inside a
batch, and a series that needed a growth is computed again on the calling thread. Such a series, or a set refused its caches inside a batch, can answer a
different state when it is an AP set that was asked on both sides of its epoch before (one cache id for the brackets on both sides of a set's epoch; pull
request 86 removes it): under a millimeter in every class measured but strong drag, where 49.7 mm was measured on one of eight sets with perigee under about
350 km. Which series are deferred depends on the threads' timing, so two runs of the same calls can differ by that much (SPEC 9). `sbrk` keeps the allocator's break and grows the memory by at least 4 MiB at a
time, never serving pages a host grew. A pool thread's stack is 256 KiB, 192 KiB more of the instance a thread. `sdnap_pool_stats(out, count)` takes the number of
doubles the caller has room for and writes at most 16 (among them the memory's growths, the epoch store's halved and serial slices, and the rows run on pool
threads). After a batch taken for dead, `load_epochs` and `load_epochs_open` refuse `pool-dead` while a pool thread is active, leaving the store in place, and
`sdnap_drag_orbit_check` answers 9. 20,000 near-circular AP series take 0.035 of 0.6.57's time on 15 pool threads, and 0.47 of it on the calling thread alone.

## 0.6.57 — A catalog loaded in parts: load_epochs_open, load_epochs_part, load_epochs_close

A host that cannot stage a whole catalog in the module's memory loads it in parts. `load_epochs_open` starts a load (the $PCF EPOCH_STORE read once, the store
emptied, a load already open dropped), `load_epochs_part` decodes one part's 'ocm' frames (any number of times; nothing of a part's bytes is kept, so a host reuses
one staging buffer), and `load_epochs_close` does the sort and the install. The store built from any partition of a list of frames is the store `load_epochs`
builds from the whole list, set for set and in order, and every state and covariance is as in 0.6.56 to the bit. `load_epochs` is the three in sequence on one
payload, with its meaning unchanged. A non-zero status of any of the three closes the load and empties the store, except `load-not-open` (a part or a close with no
load open), which changes nothing. While a load is open the store is empty and serves no state; the eighth statistic of `sdnap_epochs_stats` counts what the open load
holds. A record's forecast, copied out of a part's bytes, and its arrays of segments are counted allocations refused `out-of-memory`.
A load that builds while a counted allocation failed now answers `out-of-memory` with the store empty (through 0.6.56 the built store stayed in place). The failure-injection
seam of the tests fails every counted site again (it had stopped matching in 0.6.56). At 100,000 AP records with covariance, at 2 MiB initial memory, the instance
holds 1,504.7 bytes per object (143.5 MiB) when loaded in parts of 1,000 and 6,465.8 (616.6 MiB) in one call.

## 0.6.56 — An allocation that fails at the memory limit is refused; a stored set's covariance is built on the record's own set (stacks #600, #599)

At its memory limit the module refuses a state instead of aborting. A thread makes the caches a set's theory reads before
that set's first state or initialization, through the counted allocator: all nine for AP (1,796,968 bytes), and only the
645,432-byte step cache for SGP4XP without AP's terms. A thread that cannot make them answers the theory's refusal code,
and a method answers `out-of-memory`. Through 0.6.55 the module aborted (a wasm `unreachable`) when the 192 KiB coefficient
block was first needed with the memory full: 547 AP sets at 500 km held to 128 MiB answered 543 and then aborted; they now
answer 541 in each of two passes, every state the one given with memory to spare. That part changes no state and no
covariance.

The epoch store (`sdnap_epochs_at`, `propagate_epochs`), `sdnap_covariance_at`, `sdnap_covariance_full_at` and
`sdnap_test_epoch_floor` build a record's covariance on the record's own set, as `propagate` always did; through 0.6.55
they built that set again from the parameter vector. At one time to the bit every entry's covariance equals
`propagate`'s, element for element. On the 942 stored AP records of the synthetic set the store's covariance changes on
385 records (86 by more than 1e-6 of the matrix's largest element, up to 0.80 of it), and the three exports' covariance on
381 and their returned state on 378 (up to 0.15 m and 18 µm/s). `propagate`, and every state of the store, the row store
and `propagate_epochs`, are unchanged. The bank's nominal borrows the stored set's tables: 1,000 copies of a fitted 500 km
record take 356 KB a set with the covariance (391 KB in 0.6.55), and the store's byte count now includes the bank.

## 0.6.55 — What a loaded catalog holds

`load_epochs` holds less while it decodes and after it finishes, and every state is as in 0.6.54. The records of a load are held in blocks of 1,024
allocated as they arrive, so the memory follows the records decoded and not the frame count the payload claims (a payload of a million 12-byte frames
grew the instance by 544 MB before it was refused; it now grows by the 12 MB payload). The kept sets, entries and series are sized from the kept count.
A stored covariance is one square matrix at its own size, and a series of one set holds one cache slot. The weather pool doubles when full and live
atmospheres are marked in one pass; two series are one when every row, node and node value is bit-for-bit equal. A refused load leaves no snapshot.
A covariance matrix that cannot be allocated is refused `out-of-memory`, not `invalid-covariance`. At 100,000 objects and 2 MiB initial memory the
instance holds 1,249 bytes per object for SGP4 (1,651 before), 3,466 for AP without covariance (8,547), and 6,466 with covariance (9,837).

## 0.6.54 — Zonal long-period terms (stack #595)

AP carries the zonal tail's long-period terms with 2 <= |w| <= 6 at epoch eccentricity at or below 0.3.
Their finite Hansen coefficients use a value-and-slope match at the center of a 0.002 eccentricity cell,
selected from the state alone with an e 0.01 floor. A separate 3,992-byte per-thread coefficient cache avoids
recomputing the closed form when semimajor axis changes. At degree70 the table grows from 1,552 to 6,768 bytes.
The output map and wide-eccentricity terms retain their definitions. Shared tables are immutable; the added
contribution is identical under either owner, while legacy |w| <= 1 entries retain nominal-eccentricity dependence.

Two same-field tests bound day-1/day-5 once-per-revolution amplitude by 10 m and maximum 3D error by 20 m.
Checks also cover the full half-cell envelope, three epoch seed placements, a verified cell crossing, exact
query-order independence, and the e0 0.2999 full-harmonic control (0.796426 m, compared with 0.270331 m before
the grid). The boundary-side residual difference is 0.004882 m over five days. SPEC 16.3 records the costs:
measured hp300/i55 and hp800/i20 fits take 1.242354 and 1.755229 times 0.6.48; some cold calls also increase.

## 0.6.53

AP initialization shares eccentricity samples, inclination columns, division chains, and constant field magnitudes within their complete keys. Counted allocation failures refuse the call as `out-of-memory`. Scalar-reference and set-order tests cover the memo keys and four-thread flights. The force model and arithmetic order are unchanged.

## 0.6.52

A stored AP set keeps only what a flight reads: the output table's raw term list is kept only where the field census builds the set, and the half-day class’s half-day table is kept at its count. Every state and every covariance element is unchanged (stack #583).

## 0.6.51

AP reuses a warm set’s compact tesseral coefficients, memoizes its bracket’s semimajor axis, eccentricity, and inclination cosine, and checks bake keys before synchronization. The force model and arithmetic order are unchanged (stack #441).
