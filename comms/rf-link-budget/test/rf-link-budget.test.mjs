// rf-link-budget Node native-test-runner harness.
//
// Friis + kTB + Shannon orchestrator. The Eb/N0 = SNR + 10·log10(B/Rb)
// fix from Sklar Eq. 4.27 is exercised explicitly in the dedicated
// test below.

import test from "node:test";
import assert from "node:assert/strict";

import { createRfLinkBudgetPlugin, LinkFlags } from "../index.js";

let plugin;

test.before(async () => {
  plugin = await createRfLinkBudgetPlugin();
});

test.after(() => {
  plugin?.destroy();
});

test("loads the manifest with COMMS family", () => {
  assert.equal(plugin.metadata.type, "Comms");
  assert.equal(plugin.manifest.pluginId, "com.orbpro.rf-link-budget");
});

test("EIRP = 10·log10(P_W) + G_t − L_t", () => {
  // 1 W, 12 dBi gain, 1 dB feeder loss → EIRP = 0 + 12 − 1 = 11 dBW.
  assert.equal(plugin.eirpDbw(1, 12, 1), 11);
  // 100 W, 20 dBi, 0 dB → 20 + 20 = 40 dBW.
  assert.ok(Math.abs(plugin.eirpDbw(100, 20, 0) - 40) < 1.0e-12);
});

test("kTB noise power matches the −174 dBm/Hz reference floor", () => {
  // At T = 290 K, B = 1 Hz, NF = 0: noise = 10·log10(k·T) ≈ -204 dBW
  // → -174 dBm. Convert: 1 dBW = 30 dBm, so -204 dBW = -174 dBm. ✓
  const n = plugin.noisePowerDbw(290, 1, 0);
  assert.ok(Math.abs(n - -204.0) < 0.1, `kTB(290K, 1Hz) = ${n} dBW`);

  // Bandwidth dependence: doubling B adds 3.01 dB.
  const n1 = plugin.noisePowerDbw(290, 1.0e6, 0);
  const n2 = plugin.noisePowerDbw(290, 2.0e6, 0);
  assert.ok(Math.abs(n2 - n1 - 10 * Math.log10(2)) < 1.0e-9);
});

test("Eb/N0 = SNR when B = R_b (legacy fallback identity)", () => {
  const ebno = plugin.ebnoDb(15, 1.0e6, 1.0e6);
  assert.ok(Math.abs(ebno - 15) < 1.0e-12);
});

test("Eb/N0 fix: Eb/N0 = SNR + 10·log10(B/R_b)  (Sklar Eq. 4.27)", () => {
  // B = 2 Mhz, R_b = 1 Mbps → Eb/N0 = SNR + 3.01 dB.
  const ebno = plugin.ebnoDb(10, 2.0e6, 1.0e6);
  assert.ok(Math.abs(ebno - (10 + 10 * Math.log10(2))) < 1.0e-9);

  // B = 1 MHz, R_b = 4 Mbps → Eb/N0 = SNR − 6.02 dB.
  const ebno2 = plugin.ebnoDb(10, 1.0e6, 4.0e6);
  assert.ok(Math.abs(ebno2 - (10 + 10 * Math.log10(0.25))) < 1.0e-9);
});

test("Eb/N0 falls back to SNR for non-positive symbol rate (legacy guard)", () => {
  assert.equal(plugin.ebnoDb(15, 1.0e6, 0), 15);
  assert.equal(plugin.ebnoDb(15, 1.0e6, -100), 15);
});

test("Shannon channel capacity matches log2(1+SNR_linear)·B", () => {
  // SNR = 10 dB → linear 10 → C = B·log2(11) ≈ B·3.4594.
  const B = 1.0e6;
  const C = plugin.capacityBps(B, 10);
  const expected = B * Math.log2(11);
  assert.ok(Math.abs(C - expected) / expected < 1.0e-9);
});

test("free-space path loss self-contained reference vs Friis closed-form", () => {
  // 1 km @ 1 GHz → 92.44778322188337 dB (the FSPL constant).
  const fsl = plugin.freeSpaceLossDb(1000, 1.0e9);
  assert.ok(Math.abs(fsl - 92.44778322188337) < 1.0e-9);
});

test("compute() produces a finite link budget with LINK_UP flag set", () => {
  const result = plugin.compute({
    rangeM: 1000,
    frequencyHz: 1.0e9,
    txPowerW: 10,
    txGainDbi: 12,
    txLineLossDb: 1,
    rxGainDbi: 3,
    rxLineLossDb: 2,
    rxNoiseFigureDb: 3,
    systemTempK: 290,
    bandwidthHz: 1.0e6,
    symbolRateHz: 1.0e6, // legacy: B = R_b → Eb/N0 = SNR
    requiredLinkMarginDb: 10,
  });
  for (const key of [
    "eirpDbw",
    "freeSpaceLossDb",
    "totalPathLossDb",
    "receivedPowerDbw",
    "noisePowerDbw",
    "snrDb",
    "ebnoDb",
    "capacityBps",
    "linkMarginDb",
  ]) {
    assert.ok(Number.isFinite(result[key]), `${key} not finite: ${result[key]}`);
  }
  assert.ok(result.snrDb > 0);
  assert.ok((result.flags & LinkFlags.LINK_UP) !== 0);
  // legacy Eb/N0 = SNR identity when B = Rb
  assert.ok(Math.abs(result.ebnoDb - result.snrDb) < 1.0e-12);
});

test("compute() applies Eb/N0 fix when symbol rate ≠ bandwidth", () => {
  const result = plugin.compute({
    rangeM: 1000,
    frequencyHz: 1.0e9,
    txPowerW: 10,
    txGainDbi: 12,
    txLineLossDb: 1,
    rxGainDbi: 3,
    rxLineLossDb: 2,
    rxNoiseFigureDb: 3,
    systemTempK: 290,
    bandwidthHz: 2.0e6,
    symbolRateHz: 1.0e6,
    requiredLinkMarginDb: 10,
  });
  // Eb/N0 should exceed SNR by 10·log10(2/1) ≈ 3.01 dB.
  const expected = result.snrDb + 10 * Math.log10(2);
  assert.ok(Math.abs(result.ebnoDb - expected) < 1.0e-9);
});
