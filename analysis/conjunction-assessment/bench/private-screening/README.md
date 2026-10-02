# Private screening benchmark

This benchmark runs the arithmetic of the private screening protocol on
Microsoft SEAL 4.1.1 (BFV, n = 8192, three 60-bit plaintext moduli). The
protocol is described, with results, in
[docs/private-screening.md](../../docs/private-screening.md).

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release   # fetches SEAL 4.1.1
cmake --build build -j
build/private_screening_bench --days 1 --step 1 --pairs 8
build/private_screening_bench --days 3 --step 10 --pairs 8
```

It prints JSON with:
- costs per object-day for the requester and per pair-day for the
  responder;
- ciphertext sizes and the remaining noise budget;
- the per-step sign check against the plaintext distance (`signMismatches`
  must be 0; the exit code is 1 otherwise);
- the designed encounters' alert steps;
- the multiplicative mask's leakage (`maskLeakage`).

The trajectories are synthetic circular orbits, and the costs do not depend
on them. This is a native C++ measurement of SEAL. A screening module would
run the same operations in WebAssembly.

`exposure.mjs <run.json>` counts, from an all-vs-all screen's output, the
conjunctions between large constellations and outside objects. These are the
alerts private screening must deliver.
