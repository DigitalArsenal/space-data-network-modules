// rf-atmospheric-gaseous — ITU-R P.676-13 Annex 1 §1 line-by-line
// specific-attenuation fixture suite.
//
// Expected values generated with the ITU-Rpy reference implementation
// (itur 0.4.0, `_ITU676_12_.gamma0_exact` / `gammaw_exact`; the Annex 1
// spectroscopic line tables are identical between P.676-12 and P.676-13).
// Strict P.676 pressure semantics: the pressure argument is the DRY-air
// partial pressure (p_dry = P_total - e, with e = rho * T / 216.7).
//
// Fixtures are authoritative; tolerance is 0.5 % relative.

import test from "node:test";
import assert from "node:assert/strict";

import { createRfAtmosphericGaseousPlugin } from "../index.js";

let plugin;

test.before(async () => {
  plugin = await createRfAtmosphericGaseousPlugin();
});

test.after(() => {
  plugin?.destroy();
});

const REL_TOL = 5.0e-3; // 0.5 % relative

function assertRelClose(actual, expected, label) {
  assert.ok(Number.isFinite(actual), `${label}: non-finite value ${actual}`);
  if (expected === 0) {
    assert.equal(actual, 0, `${label}: expected exact 0, got ${actual}`);
    return;
  }
  const rel = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(
    rel < REL_TOL,
    `${label}: got ${actual}, expected ${expected} (rel err ${rel})`,
  );
}

// Each condition: { pDry [hPa], rho [g/m^3], T [K], rows: [f_GHz, gamma0, gammaw] }.
// gamma0/gammaw generated with p = DRY-air pressure (strict P.676).
const CONDITIONS = [
  {
    name: "standard (P_total=1013.25 hPa, 15 °C, rho=7.5 g/m³)",
    pDry: 1003.2771112136594,
    rho: 7.5,
    T: 288.15,
    rows: [
      [1.0, 5.310287930885314e-3, 5.048583627356524e-5],
      [10.0, 8.064582959602093e-3, 5.925341970066754e-3],
      [22.235, 1.303368210984186e-2, 1.80311001397246e-1],
      [30.0, 2.10315997386669e-2, 7.18259912999082e-2],
      [60.0, 1.45020932741754e1, 1.53590700134872e-1],
      [94.0, 3.380809447903821e-2, 3.706357014958254e-1],
      [118.75, 1.333530902232281, 6.100509903337547e-1],
      [183.0, 1.248514260220296e-2, 2.78968004500148e1],
    ],
  },
  {
    name: "dry (P_total=1013.25 hPa, 15 °C, rho=0)",
    pDry: 1013.25,
    rho: 0.0,
    T: 288.15,
    rows: [
      [1.0, 5.363067657858832e-3, 0.0],
      [10.0, 8.144046821421721e-3, 0.0],
      [22.235, 1.315772957441256e-2, 0.0],
      [30.0, 2.122467199546449e-2, 0.0],
      [60.0, 1.465114969995837e1, 0.0],
      [94.0, 3.403562394051574e-2, 0.0],
      [118.75, 1.348182560938002, 0.0],
      [183.0, 1.265647887120355e-2, 0.0],
    ],
  },
  {
    name: "high humidity (P_total=1013.25 hPa, 30 °C, rho=25 g/m³)",
    pDry: 978.2765343793262,
    rho: 25.0,
    T: 303.15,
    rows: [
      [1.0, 4.583279818005226e-3, 1.884171266419093e-4],
      [10.0, 6.819592906499162e-3, 2.184551511364813e-2],
      [22.235, 1.099807995976626e-2, 5.746456969147585e-1],
      [30.0, 1.771838108187128e-2, 2.592691482181668e-1],
      [60.0, 1.250000580994132e1, 5.81453670246676e-1],
      [94.0, 2.741860314929385e-2, 1.40305192661493],
      [118.75, 1.159810626229228, 2.302485201482565],
      [183.0, 9.738684553469504e-3, 8.185392767240728e1],
    ],
  },
];

for (const cond of CONDITIONS) {
  test(`P.676 gamma0 matches ITU-Rpy fixtures — ${cond.name}`, () => {
    for (const [f, gamma0] of cond.rows) {
      const actual = plugin.gaseousGamma0P676DbPerKm(
        f,
        cond.pDry,
        cond.rho,
        cond.T,
      );
      assertRelClose(actual, gamma0, `gamma0 @ ${f} GHz`);
    }
  });

  test(`P.676 gammaw matches ITU-Rpy fixtures — ${cond.name}`, () => {
    for (const [f, , gammaw] of cond.rows) {
      const actual = plugin.gaseousGammawP676DbPerKm(
        f,
        cond.pDry,
        cond.rho,
        cond.T,
      );
      assertRelClose(actual, gammaw, `gammaw @ ${f} GHz`);
    }
  });

  test(`P.676 total equals gamma0 + gammaw — ${cond.name}`, () => {
    for (const [f, gamma0, gammaw] of cond.rows) {
      const total = plugin.gaseousSpecificAttenuationP676DbPerKm(
        f,
        cond.pDry,
        cond.rho,
        cond.T,
      );
      assertRelClose(total, gamma0 + gammaw, `total @ ${f} GHz`);
      const sum =
        plugin.gaseousGamma0P676DbPerKm(f, cond.pDry, cond.rho, cond.T) +
        plugin.gaseousGammawP676DbPerKm(f, cond.pDry, cond.rho, cond.T);
      assert.ok(
        Math.abs(total - sum) <= 1.0e-12 * Math.max(1, Math.abs(sum)),
        `total != gamma0+gammaw @ ${f} GHz: ${total} vs ${sum}`,
      );
    }
  });
}

test("P.676 published sanity anchors (60 GHz O2 peak, 22.235 GHz H2O line, 118.75 GHz O2 line)", () => {
  const { pDry, rho, T } = CONDITIONS[0];
  const g60 = plugin.gaseousGamma0P676DbPerKm(60, pDry, rho, T);
  assert.ok(g60 > 14 && g60 < 16, `60 GHz oxygen peak out of range: ${g60}`);
  const g22 = plugin.gaseousGammawP676DbPerKm(22.235, pDry, rho, T);
  assert.ok(g22 > 0.15 && g22 < 0.22, `22.235 GHz water line out of range: ${g22}`);
  const g118 = plugin.gaseousGamma0P676DbPerKm(118.75, pDry, rho, T);
  assert.ok(g118 > 1.2 && g118 < 1.5, `118.75 GHz oxygen line out of range: ${g118}`);
});

test("P.676 exports reject invalid inputs by returning 0.0", () => {
  const args = [1003.28, 7.5, 288.15];
  assert.equal(plugin.gaseousGamma0P676DbPerKm(Number.NaN, ...args.slice(0, 3)), 0);
  assert.equal(plugin.gaseousGammawP676DbPerKm(10, Number.NaN, 7.5, 288.15), 0);
  assert.equal(
    plugin.gaseousSpecificAttenuationP676DbPerKm(10, 1003.28, Number.NaN, 288.15),
    0,
  );
  assert.equal(
    plugin.gaseousSpecificAttenuationP676DbPerKm(10, 1003.28, 7.5, Number.NaN),
    0,
  );
  assert.equal(plugin.gaseousSpecificAttenuationP676DbPerKm(-1, 1003.28, 7.5, 288.15), 0);
  assert.equal(plugin.gaseousSpecificAttenuationP676DbPerKm(10, -1, 7.5, 288.15), 0);
  assert.equal(plugin.gaseousSpecificAttenuationP676DbPerKm(10, 1003.28, -1, 288.15), 0);
  assert.equal(plugin.gaseousSpecificAttenuationP676DbPerKm(10, 1003.28, 7.5, 0), 0);
});

test("legacy ABI still present alongside P.676 exports", () => {
  // Additive change: the pre-existing simplified exports keep working.
  assert.ok(plugin.oxygenSpecificAttenuationDbPerKm(10, 15) > 0);
  assert.ok(plugin.waterVaporSpecificAttenuationDbPerKm(22, 15, 50) > 0);
  assert.ok(plugin.atmosphericAbsorptionDb(10, 5, 15, 50) > 0);
  assert.ok(plugin.saturationVaporPressureHpa(0) > 6);
});
