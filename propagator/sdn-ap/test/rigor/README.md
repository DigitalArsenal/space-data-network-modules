# SDN-AP rigor suite

The questions T.S. Kelso, David Vallado and Felix Hoots would put to SDN-AP, as E2E checks (owner 2026-10-25: "write
a series of rigor tests like you are TS Kelso or Dave Vallado or Felix Hoots to make sure every edit, every idea we
are using passes muster"). Each check answers one question with one specific outcome and prints the question, its
source and the evidence it found. The paper and site claim tracing is in the sdn-ap repository, `rigor/claims.mjs`.

    node test/rigor/run.mjs --tier fast        # the gauntlet tier (propagator/sdn-ap, foundation/sgp4-str3 changes)
    node test/rigor/run.mjs --tier full        # nightly: every check
    node test/rigor/run.mjs --only <id>[,<id>]

- Each check runs in its own process under a time cap (90 s fast, 900 s full): a module that never returns is a FAIL
  with that evidence.
- `known-failures.json` lists failures already filed as graph tasks. They print KNOWN-FAIL with the task and do not
  vote; a listed check that passes fails until its entry is removed, so the list only shrinks.
- The reference checks run the US Space Force Sgp4Prop 9.9 library as a black box through the SGP4-XP harness
  (`SDN_AP_ORACLE_ROOT`, or `GAUNTLET_STACK_ROOT`/`SDN_STACK_ROOT` naming the stack whose closed-modules checkout holds
  `packages/sgp4-xp-oracle`). Clean room: published inputs and outputs are data; no reference source code is read.
- JS orchestrates and computes test statistics only; every state comes from the module or the reference.

## Checks

| Reviewer | Check | Tier | Question | Source |
| --- | --- | --- | --- | --- |
| Hoots | `hoots-225-min-boundary` | fast | Is the SGP4/SDP4 switch at 225 min of the recovered n''o, where the reference switches (41 mean motions across it)? | STR#3 sec. 6, 10; AIAA 2006-6753 sec. II; paper 1.1 |
| Hoots | `hoots-singular-geometry` | fast | At e = 0, e at the 1e-4 rule, i = 0 and 180 deg and the critical inclinations, the reference's states and refusals? | STR#3 sec. 6; AIAA 2006-6753 VI.A, App. D |
| Hoots | `hoots-singular-geometry-sdnap` | fast | Does SDNAP stay finite at the same geometries (never a NaN reported good)? | paper 1.3, 2.1; SPEC 1.5 |
| Hoots | `hoots-low-perigee` | fast | Below 220, 156 and 98 km of perigee and under the surface, the reference's states and the same decay refusals? | STR#3 sec. 6; AIAA 2006-6753 VI.A, App. D |
| Hoots | `hoots-resonance-classes` | fast | Synchronous, 12-hour, 16 h and 8 h classes and the DPINIT band edges match the reference over a week? | STR#3 sec. 10; USSF SGP4-XP; paper 1.2, 3.5 |
| Hoots | `hoots-lyddane-node-quadrant` | fast | Below 0.2 rad of inclination, with the node near 0, 180 and 360 deg, the node in the reference's quadrant? | AIAA 2006-6753 VI.C; paper 1.1 |
| Hoots | `hoots-mean-element-recovery` | fast | Does the integrated mean state at epoch give back the set, and the inverse map of its a the set's mean motion? | paper 2.1, 2.4; SPEC 1.1, 1.5 |
| Vallado | `vallado-aiaa-2006-6753-verification` | fast | The 33 verification sets against their published outputs (1 mm, 1e-5 m/s) and their published error stops? | AIAA 2006-6753 App. D: SGP4-VER.TLE, tcppver.out (`data/`) |
| Vallado | `vallado-teme-to-gcrf` | fast | TEME to GCRF as the published AIAA 2006-6753 example (1 cm); the distance to pyerfa's GMST06 TEME (report only)? | AIAA 2006-6753 sec. V; analysis/epoch-state/tests/vallado-verification.json |
| Vallado | `vallado-time-arguments` | fast | A UTC Julian date the same instant as minutes from epoch, every theory, across the 2016 leap second? | AIAA 2006-6753 II.F; IERS Bulletin C 52 |
| Vallado | `vallado-wgs72-constants` | fast | SGP4 constants WGS-72 as AIAA 2006-6753 Table 2? | AIAA 2006-6753 VI.B; src/constants.inc |
| Vallado | `vallado-path-independence` | fast | The same bytes fresh and after 10 days forward and back (forward-backward closure)? | AIAA 2006-6753 VI.D; paper 1.1, 2.2 |
| Vallado | `vallado-energy-without-drag` | fast | SGP4XP mean a constant over 30 days without drag or radiation pressure (SDNAP reported: its tesseral terms are not conservative in the inertial frame)? | Brouwer 1959, Kozai 1959; paper 2.1, 3.2, 3.4 |
| Vallado | `vallado-step-convergence` | full | Do the shallow-resonance terms converge as the step shrinks? | paper 2.2, 3.4 |
| Vallado | `vallado-thread-determinism` | fast | The same bytes at 0 and 4 threads, every theory? | paper 12.2 |
| Vallado | `vallado-wasmedge-parity` | full | Native WasmEdge gives the browser host's bytes (`test/wasmedge-parity.mjs`)? | paper 12.2 |
| Vallado | `vallado-covariance-realism-bound` | fast | Is a realism acceptance band stated, and is every held-out cell inside it? | SPEC 12; test/results/covariance-realism-*.json |
| Kelso | `kelso-catalog-scale` | full | The whole public GP catalog with no refusal the reference does not make; 300 random sets within 1 m over a day? | the host's newest public GP snapshot (statistics only); paper 12.1 |
| Kelso | `kelso-malformed-sets-refused` | fast | Malformed sets (e >= 1, e < 0, n <= 0, NaN drag or n, i outside [0, 180]) refused, every theory? | AIAA 2006-6753 App. D; CCSDS 502.0-B-3 |
| Kelso | `kelso-identity-carried` | fast | Does the output \$OEM carry the set's catalog number (alpha-5 range included), designator and name? | CCSDS 502.0-B-3; Space-Track alpha-5 |
| All three | sdn-ap `rigor/claims.mjs` claims-traced | sdn-ap gate | Is every figure of the paper's checked sections a committed result at a named commit, equal at printed precision? | whitepaper/sdn-ap.md; rigor/claims.json |
| Kelso | sdn-ap `rigor/claims.mjs` frozen-plan-first | sdn-ap gate | Was the frozen plan registered before every result it covers? | orbit-accuracy-experiments PLAN.md and results history |

## Data

`data/aiaa-2006-6753.json` holds the 33 sets of SGP4-VER.TLE and the 667 states of tcppver.out (Vallado, Crawford,
Hujsak, Kelso 2006; free use with citation, NOTICE.md), with the SHA-256 of both inputs; `data/build-aiaa.mjs`
rebuilds it from the two published files.
