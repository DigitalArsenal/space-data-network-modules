# CelesTrak fetch policy (owner directive 2026-07-13)

These rules bind EVERY script in this directory that touches celestrak.org,
whether direct or via Tor. They exist to keep us a good citizen of a free
service this program depends on.

## Why Tor exists here at all

The Tor path is **firewall/erroneous-block recovery only**. This project has
been the victim of upstream blocks that were not caused by our request
behavior (e.g. shared-egress collateral blocks; coordinator sessions have
seen `ECONNREFUSED` from clean environments). Circuit rotation restores
*reachability*. It is **NOT** a mechanism to evade rate limiting, and every
rule below applies identically with or without Tor.

## Hard rules

1. **Serial requests only, ≥ 2.5 s apart** (~24/min). No parallel fetching.
   Rate flags on the scripts are floors-enforced: values below 2500 ms are
   raised to 2500 ms.
2. **Three-hour rule: never request the same data (same URL/query key) more
   than once in any 3-hour period.** Enforced by a persistent ledger
   (`tests/data/.celestrak-fetch-ledger`) recording successful fetches;
   keys fetched successfully within the last 10 800 s are skipped even if
   the output file was deleted. Existing output files are never re-fetched.
3. **429/503 means slow down, not rotate-and-hammer:** back off 60 s before
   any retry; at most ONE retry per key per run; the retry counts toward
   the halt threshold.
4. **Halt on sustained failure:** abort the entire run after 30 consecutive
   failed requests. A run that keeps failing is a signal to stop and
   investigate, not to rotate through it.
5. CelesTrak's own published constraints stand on top of these: SOCRATES
   regenerates ~3x/day (the 3-hour rule matches its refresh cadence);
   >50 HTTP errors in 2 h risks an automatic IP block; M2M clients must
   halt on any non-200.

## Shared enforcement helpers

- Shell: `lib/celestrak-fetch-policy.sh` (`policy_*` functions)
- Node: `lib/celestrakFetchPolicy.mjs` (`FetchPolicy` class)

New fetch scripts MUST use these helpers and cite this document in their
header comment.
