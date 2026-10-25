# SGP4XP conformance tail (amendment 7 input)

Side B: modules main 848de581 (dist 9d8dec4c16c3), the SPEC of amendments 1-6. Conformance E2E
(`test/conformance.e2e.mjs`, corpus seed 20261023: 10,200 SGP4XP sets, 8 times each over 7 days) against side A's
oracle (USSF Sgp4Prop 9.9, black box): 80,974 samples, outputs SHA-256
72dcf60050464606b1aaddb63ed121f965845a957d05adcb4c4f06ccc8a7bedc. No sample is open. Before this run, 699 samples of
199 sets were open (worst 623 m, HEO 4780). Every one of them has a named cause, and the module's outputs are
unchanged.

| Regime | Decay-accepted | Shadow-accepted | Split-accepted | Open samples |
| --- | --: | --: | --: | --: |
| LEO | 63 | 60 | 4 | 0 |
| SSO | 0 | 62 | 0 | 0 |
| MEO | 0 | 196 | 0 | 0 |
| GEO | 0 | 518 | 0 | 0 |
| HEO | 7 | 103 | 0 | 0 |
| VDS | 0 | 131 | 0 | 0 |

## Causes

1. **The envelope ran on cached nodes (690 of the 699 samples). This was a defect in the E2E, and it is ours.** The
   two shadow-envelope runs (every rounding-limited decision a sunlit arc, then every one wholly sunlit) set
   `sdnap_shadow_policy` on the store that had just answered the nominal run. That run's checkpoints and window were
   still there, so each envelope run started from nodes that policy 0 had taken. Its decisions reached only the
   steps after the last cached checkpoint: for HEO 8806 the envelope had width 0 at every sample, where the node at
   5226 min decides the 87 m. Each policy now runs on freshly initialized sets, as amendment 6 states ("the setting
   holds for every rate evaluation, nodes and stages included"). That change alone leaves 9 samples open (LEO 4,
   MEO 4, HEO 1; worst 7.1 m).
2. **Decisions in mixed directions (5 samples: HEO 346, MEO 2264, 5204 and 6752).** Amendment 6 says both outcomes of
   each rounding-limited decision conform. The two-way envelope takes them all one way, then all the other way.
   Where the reference takes some one way and some the other, it lies outside the box of the two runs, yet within
   their spread of the module's answer (1.35 m within 12.1 m, 2.13 within 35.9, 3.17 within 43.0, and 7.1 and 5.6
   within 37.5 and 25.9). The E2E accepts a sample whose difference is within that spread.
3. **The reference's two builds disagree (4 samples: LEO 4746, worst 2.11 m).** One y4 stage at 3131.8 min has a
   candidate with n < 0 whose |S| in the module is 1.70e-11. That is above SPEC 4's 1e-12 test and above band (a)'s
   upper limit of 1e-11. The module takes the orbit as wholly sunlit there, and so does the reference's 9.1.1.0
   build: it is within 1 mm of the module at every sample. 9.9 takes a sunlit arc. The decision rests on the
   arithmetic of a near-double root of the quartic. The two candidates near nu = pi/2, 1.5707924 and 1.5708003, are
   7.9e-6 apart. The E2E accepts a sample that the other build reproduces within 1 m. **Amendment 7 input:** band (a)
   stops at 1e-11, and 9.9 takes a decision at 1.70e-11 that 9.1.1.0 does not take.

## Evidence: the decisions that reproduce 9.9

A diagnostics build of the same sources (scratch, never committed) dumps the module's integration nodes. It flips
chosen SPEC 4 decisions (arc to wholly sunlit, or sunlit to an arc with boundaries up to |S| 1e-10) at given
evaluation times. A greedy search starts at the first node where the module and 9.9's native elements (black box)
differ by more than 1e-11. It tries the decisions of the step into that node: the previous node's rates, then the
k2 and k4 stages, singly and in pairs. It keeps the flip that carries the agreement furthest, then repeats. |S| is
the module's smallest and second-smallest candidate with n < 0 at that evaluation. A negative sign means the
module takes an arc there.

| Set | Regime | Before (m) | Flips (min: evaluation, module \|S\|) | 9.9 reproduced (1e-11) |
| --- | --- | --: | --- | --- |
| 4780 | HEO | 623 | 1788.7: k2, -2.00e-13 / 3.02e-13 | through node 30 (all) |
| 8806 | HEO | 87.0 | 5226.2: node rates, -4.06e-13 / 5.60e-13 | through 7 days |
| 2364 | LEO | 12.7 | 3107.0: k2, 8.31e-13 / 2.17e-12 | through 7 days |
| 8766 | LEO | 5.20 | 5064.7: k2, 6.66e-16 / 1.10e-12 | through 7 days |
| 346 | HEO | 1.35 | 2500.0: node rates, -2.13e-13 / 9.42e-13 | through 7 days |
| 5204 | MEO | 2.13 | 4901.0: node rates, -5.33e-15 / 3.07e-13; 5360.4: k2, 2.31e-14 / 2.15e-12 | through 7 days |
| 6752 | MEO | 3.17 | 7934.3: k2, 1.10e-12 / 1.14e-12; 8412.3: node rates, -2.77e-13 / 2.79e-13; 9009.7: k4, -1.69e-13 / 1.72e-13 | through 7 days |
| 2264 | MEO | 7.15 | 15 decisions at 8 steps, \|S\| 1.2e-13 to 2.2e-12 (a grazing orbit) | through 7 days |
| 4746 | LEO | 2.11 | 3131.8: k4, 0 / 1.70e-11 | through node 60 (all) |

Other open sets traced the same way: SSO 7381 (k2 at 2151.9 min, a root near nu = pi where arccos magnifies the last
bits: candidates at 3.1415767 and 3.1416086, |S| 7.0e-14 and 2.6e-5), HEO 6622 (k2 of the first step, second |S|
1.07e-12) and MEO 5636 (node at 3986.3 min, 1.54e-12 / 1.55e-12). Each one is a flip of a decision at the rounding
limit.
