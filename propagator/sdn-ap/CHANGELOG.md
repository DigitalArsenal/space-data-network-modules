# Changelog

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
