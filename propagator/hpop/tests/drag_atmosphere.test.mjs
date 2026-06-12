/**
 * HPOP atmosphere + drag tests against PUBLISHED reference values only.
 *
 * Sources:
 * - NRLMSISE-00 canonical 17-case output table distributed with the
 *   reference C package (release 20041227, D. Brodowski port of
 *   Picone/Hedin/Drob), DOCUMENTATION file; also mirrored at
 *   https://github.com/magnific0/nrlmsise-00/blob/master/DOCUMENTATION
 * - US Standard Atmosphere 1976 (NOAA-S/T 76-1562), Table I.
 * - Thermosphere density magnitude at 400 km, moderate solar activity:
 *   ~1e-12 kg/m^3 order (e.g. Vallado, "Fundamentals of Astrodynamics and
 *   Applications" 4th ed., Sec. 8.6; Picone et al. 2002). Bounds used here
 *   are deliberately generous: 1e-13..1e-11 kg/m^3.
 * - ISS-like orbital decay: average ~2 km/month at moderate activity
 *   (NASA ISS trajectory data summaries; Vallado Sec. 8.6 drag discussion),
 *   i.e. ~70 m/day. We assert a generous 5..500 m/day window.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  STANDALONE_RUNTIME_KINDS,
  createStandaloneHarnessOrSkip,
  invokeJsonRequest,
} from "../../../tests/lib/isomorphicHarness.mjs";

const ISOMORPHIC_WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const MU_EARTH = 398600.4418; // km^3/s^2

function assertRelClose(actual, expected, relTol, label) {
  const relErr = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(
    relErr <= relTol,
    `${label}: expected ${actual} within rel ${relTol} of ${expected} (got rel ${relErr})`,
  );
}

function magnitude3([x, y, z]) {
  return Math.sqrt(x * x + y * y + z * z);
}

function semiMajorAxisKm(positionKm, velocityKmS) {
  const r = magnitude3(positionKm);
  const v = magnitude3(velocityKmS);
  return 1 / (2 / r - (v * v) / MU_EARTH);
}

for (const runtimeKind of STANDALONE_RUNTIME_KINDS) {
  test(`NRLMSISE-00 canonical test vectors reproduce on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, ISOMORPHIC_WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // Canonical case 1 (package DOCUMENTATION output table): doy=172,
    // sec=29000 s UT, alt=400 km, lat=60, lon=-70, lst=16 h, F107A=150,
    // F107=150, ap=4. Published gtd7 outputs:
    //   TINF = 1250.54 K, TG = 1241.42 K, RHO = 4.075e-15 g/cm^3,
    //   HE = 6.665e+05, O = 1.139e+08, N2 = 1.998e+07 [1/cm^3].
    const case1 = await invokeJsonRequest(harness, {
      operation: "atmosphere",
      params: {
        model: "NRLMSISE00",
        dayOfYear: 172,
        secondOfDay: 29000,
        altitudeKm: 400,
        latitudeDeg: 60,
        longitudeDeg: -70,
        localSolarTimeHours: 16,
        f107a: 150,
        f107: 150,
        ap: 4,
      },
    });
    assert.equal(case1.variant, "gtd7");
    assertRelClose(case1.exosphericTemperatureK, 1250.54, 1e-3, "case1 TINF");
    assertRelClose(case1.temperatureK, 1241.42, 1e-3, "case1 TG");
    assertRelClose(case1.densityGCm3, 4.075e-15, 1e-3, "case1 RHO");
    assertRelClose(case1.numberDensitiesCm3.He, 6.665e5, 1e-3, "case1 He");
    assertRelClose(case1.numberDensitiesCm3.O, 1.139e8, 1e-3, "case1 O");
    assertRelClose(case1.numberDensitiesCm3.N2, 1.998e7, 1e-3, "case1 N2");

    // Canonical case 11: alt=0 km (other inputs as case 1).
    // Published: TG = 281.46 K, RHO = 1.261e-03 g/cm^3.
    const case11 = await invokeJsonRequest(harness, {
      operation: "atmosphere",
      params: {
        model: "NRLMSISE00",
        dayOfYear: 172,
        secondOfDay: 29000,
        altitudeKm: 0,
        latitudeDeg: 60,
        longitudeDeg: -70,
        localSolarTimeHours: 16,
        f107a: 150,
        f107: 150,
        ap: 4,
      },
    });
    assertRelClose(case11.temperatureK, 281.46, 1e-3, "case11 TG");
    assertRelClose(case11.densityGCm3, 1.261e-3, 1e-3, "case11 RHO");
  });

  test(`US76 path returns published Table I values on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, ISOMORPHIC_WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // US Standard Atmosphere 1976 (NOAA-S/T 76-1562) Table I:
    //   Z = 0 km:  T = 288.150 K, rho = 1.2250 kg/m^3
    //   Z = 10 km GEOMETRIC: T = 223.252 K, rho = 0.41351 kg/m^3
    const sea = await invokeJsonRequest(harness, {
      operation: "atmosphere",
      params: { model: "USSA1976", altitudeKm: 0 },
    });
    assertRelClose(sea.temperatureK, 288.15, 1e-3, "sea level T");
    assertRelClose(sea.densityKgM3, 1.225, 1e-3, "sea level rho");

    const tenKm = await invokeJsonRequest(harness, {
      operation: "atmosphere",
      params: { model: "USSA1976", altitudeKm: 10 },
    });
    assertRelClose(tenKm.temperatureK, 223.252, 1e-3, "10 km T (geopotential-corrected)");
    assertRelClose(tenKm.densityKgM3, 0.41351, 1e-3, "10 km rho");
  });

  test(`NRLMSISE-00 density at 400 km stays in published bounds on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, ISOMORPHIC_WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // Moderate activity (F107 = F107A = 150, ap = 4): thermospheric density
    // at 400 km is of order 1e-12 kg/m^3 (Picone et al. 2002; Vallado 4th
    // ed. Sec. 8.6). Generous published bounds: 1e-13 .. 1e-11 kg/m^3.
    const result = await invokeJsonRequest(harness, {
      operation: "atmosphere",
      params: {
        model: "NRLMSISE00",
        includeAnomalousOxygen: true, // drag-effective density (gtd7d)
        dayOfYear: 80,
        secondOfDay: 43200,
        altitudeKm: 400,
        latitudeDeg: 0,
        longitudeDeg: 0,
        f107a: 150,
        f107: 150,
        ap: 4,
      },
    });
    assert.ok(
      result.densityKgM3 > 1e-13 && result.densityKgM3 < 1e-11,
      `density at 400 km out of published bounds: ${result.densityKgM3} kg/m^3`,
    );
  });

  test(`drag-enabled propagation decays an ISS-like orbit plausibly on ${runtimeKind}`, async (t) => {
    const harness = await createStandaloneHarnessOrSkip(runtimeKind, ISOMORPHIC_WASM_PATH, t);
    if (!harness) {
      return;
    }
    t.after(async () => {
      await harness.destroy();
    });

    // ISS-like circular orbit: a = 6778 km (~400 km altitude), i = 51.6 deg.
    // ISS ballistic properties: m ~ 420 000 kg, A ~ 1500 m^2, Cd ~ 2.2.
    // Published decay at moderate activity averages ~2 km/month ~ 70 m/day
    // (NASA ISS trajectory summaries). Generous assertion: SMA strictly
    // decreases, by 5..500 m over one day.
    const aInitKm = 6778.0;
    const inc = (51.6 * Math.PI) / 180;
    const vCirc = Math.sqrt(MU_EARTH / aInitKm);
    const epochJD = 2451545.0;
    const position = [aInitKm, 0, 0];
    const velocity = [0, vCirc * Math.cos(inc), vCirc * Math.sin(inc)];

    const dayResult = await invokeJsonRequest(harness, {
      operation: "propagate",
      params: {
        epochJD,
        targetJD: epochJD + 1.0,
        position,
        velocity,
        integrator: {
          method: "RK4",
          initialStep: 60,
          maxSteps: 200000,
        },
        forces: {
          pointMass: true,
          j2: false,
          j3: false,
          j4: false,
          thirdBody: false,
          srp: false,
          drag: true,
          massKg: 420000,
          areaM2: 1500,
          cd: 2.2,
        },
        weather: { F107: 150, F107a: 150, Ap: 15 },
      },
    });

    const aFinalKm = semiMajorAxisKm(dayResult.position, dayResult.velocity);

    // Baseline: identical propagation without drag. Fixed-step RK4 at 60 s
    // has a measurable truncation drift in SMA over a day (~tens of meters);
    // differencing the drag and no-drag runs cancels that shared truncation
    // error so the decay below is attributable to drag alone.
    const noDragResult = await invokeJsonRequest(harness, {
      operation: "propagate",
      params: {
        epochJD,
        targetJD: epochJD + 1.0,
        position,
        velocity,
        integrator: {
          method: "RK4",
          initialStep: 60,
          maxSteps: 200000,
        },
        forces: {
          pointMass: true,
          j2: false,
          j3: false,
          j4: false,
          thirdBody: false,
          srp: false,
          drag: false,
        },
      },
    });
    const aNoDragKm = semiMajorAxisKm(noDragResult.position, noDragResult.velocity);

    // Sanity bound on the integrator itself: fixed-step RK4 at 60 s must not
    // drift the two-body SMA by more than 100 m/day (measured ~27 m/day) —
    // small compared with the published ~70 m/day drag signal.
    assert.ok(
      Math.abs(aNoDragKm - aInitKm) * 1000.0 < 100,
      `no-drag SMA drifted ${(aNoDragKm - aInitKm) * 1000} m — integrator energy error too large`,
    );

    const decayMeters = (aNoDragKm - aFinalKm) * 1000.0;
    assert.ok(decayMeters > 0, `drag must shrink the orbit (decay = ${decayMeters} m/day)`);
    assert.ok(
      decayMeters > 5 && decayMeters < 500,
      `ISS-like drag-attributable decay out of plausible published window: ${decayMeters} m/day ` +
        "(published average ~70 m/day at moderate activity)",
    );
  });
}
