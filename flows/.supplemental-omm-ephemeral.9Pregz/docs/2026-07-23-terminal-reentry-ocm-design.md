# Terminal-Reentry OCM Design

**Date:** 2026-07-23  
**Status:** Approved by the owner  
**Scope:** `flows/supplemental-omm/**` only

## Decision

An ordered complete ephemeris whose final transformed state is at or below the
120 km geocentric-altitude reentry interface is a terminal-reentry source. OD
must not fabricate an SGP4 OMM for it. The independently signed OD WASM node
instead emits one canonical SDS `$OCM` containing every state from the complete
source trajectory and emits no `$OMM`.

The terminal OCM is a source trajectory, not an orbit-determination result:

- `TRAJ_TYPE` is `CARTESIAN_PV`;
- `STATE_DATA` contains every TEME position/velocity state in source order;
- `STATE_STEP_SIZE`, `START_TIME`, `STOP_TIME`, and `TIME_SPAN` describe the
  complete uniformly sampled trajectory;
- the covariance vector and `ORBIT_DETERMINATION` block are absent rather than
  fabricated;
- the trajectory description identifies terminal reentry and the TEME frame;
- deterministic identity and source metadata remain present; and
- the transaction completes after FlatSQL durably stores the one OCM record,
  allowing the provider's contiguous restart cursor to advance.

## Nonterminal OD

Nonterminal files retain the existing strict `RMS < 12 km` and convergence
gates. OD first uses overlapping eight-hour windows at six-hour spacing. If any
nominal window fails either gate, the complete file is retried using overlapping
four-hour windows at three-hour spacing. The fallback still samples the entire
ordered data set and emits epoch-specific paired OMM/OCM records. A nonterminal
file that also fails the four-hour pass remains a fail-closed OD error.

## Transaction Semantics

The OD node's deterministic FlatSQL transaction identity accepts either:

1. the normal ordered `omm`, `ocm` stream pair; or
2. exactly one `ocm` stream explicitly marked as a terminal-reentry result.

An arbitrary missing OMM remains invalid. A terminal-reentry completion reports
one affected record and a terminal-reentry completion message. Configuration
continues to declare both canonical tables because the flow can process normal
and terminal sources in the same run.

## Bounds and Failure Semantics

- Classification uses only the already parsed complete source and no host or
  CelesTrak access.
- Terminal classification requires at least three finite, strictly ordered,
  uniformly sampled full states.
- The complete terminal trajectory must fit existing transient and output
  bounds.
- An irregular terminal trajectory fails closed because the canonical compact
  OCM representation reconstructs epochs from one `STATE_STEP_SIZE`.
- The host remains application-blind, no raw ephemeris is persisted, and no Go
  or JavaScript control plane implements this policy.

## Verification

Tests must prove:

- a complete synthetic terminal trajectory emits one OCM, zero OMMs, every
  transformed state, no covariance, and no OD block;
- the real hash-pinned terminal files for NORAD 46144 and 47587 complete through
  the OCM-only path;
- normal sources remain paired and byte-deterministic;
- a nonterminal high-RMS source cannot use the terminal bypass;
- the known high-drag corpus succeeds through the four-hour fallback;
- canonical and aligned routing produce identical OCM bytes and transaction
  identities; and
- the same signed artifact produces the same terminal OCM in the browser
  harness and WasmEdge.
