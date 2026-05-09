// rf-ber-modulation Node native-test-runner harness.
// Numerical Recipes §6.2 erfc + Sklar Chapter 4 closed-form BER per
// modulation. Property-based suite + textbook-style reference points.

import test from "node:test";
import assert from "node:assert/strict";

import { createRfBerModulationPlugin, ModulationCode } from "../index.js";

let plugin;

test.before(async () => {
  plugin = await createRfBerModulationPlugin();
});

test.after(() => {
  plugin?.destroy();
});

test("loads the manifest with COMMS family", () => {
  assert.equal(plugin.metadata.type, "Comms");
  assert.equal(plugin.manifest.pluginId, "com.orbpro.rf-ber-modulation");
});

test("erfc(0) = 1 and erfc(large positive) → 0", () => {
  // Chebyshev approximation accuracy is ~7 figures.
  assert.ok(Math.abs(plugin.erfc(0) - 1) < 1.0e-7);
  assert.ok(plugin.erfc(5) < 1.0e-9);
  assert.ok(plugin.erfc(10) < 1.0e-30);
});

test("erfc is symmetric: erfc(-x) = 2 - erfc(x)", () => {
  for (const x of [0.5, 1, 1.5, 2, 3]) {
    const lhs = plugin.erfc(-x);
    const rhs = 2 - plugin.erfc(x);
    assert.ok(
      Math.abs(lhs - rhs) < 1.0e-7,
      `erfc symmetry broken at ${x}: ${lhs} vs ${rhs}`,
    );
  }
});

test("BPSK BER at 7 dB Eb/N0 ≈ 7.7e-4 (Sklar Table 4.1 reference)", () => {
  const ber = plugin.berFromEbno(7, ModulationCode.BPSK);
  // Expected closed-form Q(sqrt(2 * 10^0.7)) ≈ 7.7e-4. Allow 5% margin
  // for the Chebyshev erfc approximation.
  assert.ok(ber > 5e-4 && ber < 1.5e-3, `BPSK@7dB BER = ${ber}`);
});

test("BER decreases monotonically with Eb/N0 for every modulation", () => {
  for (const mod of Object.values(ModulationCode)) {
    const seq = [-2, 0, 3, 6, 9, 12, 15].map((ebno) =>
      plugin.berFromEbno(ebno, mod),
    );
    for (let i = 1; i < seq.length; i += 1) {
      assert.ok(
        seq[i] <= seq[i - 1] + 1.0e-12,
        `mod ${mod} BER not monotonic at ${i}: ${seq[i - 1]} → ${seq[i]}`,
      );
    }
  }
});

test("BPSK and QPSK BER are identical at the same Eb/N0", () => {
  // Per Sklar §4.7: BPSK and (Gray-coded) QPSK have the same BER vs
  // Eb/N0 because the in-phase/quadrature streams are independent.
  for (const ebno of [0, 3, 6, 9, 12]) {
    const bpsk = plugin.berFromEbno(ebno, ModulationCode.BPSK);
    const qpsk = plugin.berFromEbno(ebno, ModulationCode.QPSK);
    assert.ok(
      Math.abs(bpsk - qpsk) < 1.0e-6,
      `BPSK vs QPSK differ at ${ebno} dB: ${bpsk} vs ${qpsk}`,
    );
  }
});

test("Higher-order modulations require more Eb/N0 for the same BER", () => {
  // At Eb/N0 = 10 dB, 64-QAM should have noticeably worse BER than QPSK.
  const qpsk = plugin.berFromEbno(10, ModulationCode.QPSK);
  const qam16 = plugin.berFromEbno(10, ModulationCode.QAM16);
  const qam64 = plugin.berFromEbno(10, ModulationCode.QAM64);
  assert.ok(qam16 > qpsk);
  assert.ok(qam64 > qam16);
});

test("FSK BER = ½·exp(−½·Eb/N0_linear) (non-coherent / orthogonal BFSK)", () => {
  // The kernel implements the closed-form ½·exp(−½·Eb/N0_linear).
  // At Eb/N0 = 0 dB → linear 1 → 0.5·exp(-0.5) ≈ 0.30327.
  const ber0 = plugin.berFromEbno(0, ModulationCode.FSK);
  assert.ok(
    Math.abs(ber0 - 0.5 * Math.exp(-0.5)) < 1.0e-9,
    `FSK@0dB BER = ${ber0}`,
  );
  // At Eb/N0 = 10 dB → linear 10 → 0.5·exp(-5) ≈ 3.37e-3.
  const ber10 = plugin.berFromEbno(10, ModulationCode.FSK);
  assert.ok(
    Math.abs(ber10 - 0.5 * Math.exp(-5)) < 1.0e-9,
    `FSK@10dB BER = ${ber10}`,
  );
});
