// =============================================================================
// A2.8b — synthetic Aerospace-IVV-shaped fixture generator
// =============================================================================
//
// Emits a SMALL, clearly-labeled SYNTHETIC stand-in for the real Aerospace IVV
// dataset (AerospaceIVVDataset_20251009a), which is CC0 but ~21.74 GB and gated
// behind a Google account / OSC contact (OWNER-ASSIST — see
// docs/aerospace-ivv-acquisition.md). The synthetic fixture is NOT real CSieve
// data. Its "answer key" is computed ANALYTICALLY in closed form from
// straight-line relative motion (exact TCA, miss distance, relative speed), so
// the parity gate has a genuinely INDEPENDENT reference to check the module's
// screen_catalog TCA/miss-distance refinement machinery against.
//
// Straight-line motion is Hermite-exact, so the module should reproduce the
// analytic answer to sub-mm for realistic (>~30 m) misses. It validates the
// screening/refinement CODE PATH end-to-end; it does NOT validate orbital
// dynamics (that is the real dataset's job, run via the documented one-command
// step once the tarball is obtained).
//
// Output: tests/fixtures/aerospace-synthetic/
//   ocm/<norad>.ocm                       CCSDS-OCM-KVN track files
//   answer_key_spherical.csv              CSieve-schema answer key (analytic)
//   README.md                             provenance + labeling
//
// Run: node scripts/generate-aerospace-synthetic-fixture.mjs
// Deterministic: same inputs -> byte-identical output.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(PACKAGE_ROOT, "tests", "fixtures", "aerospace-synthetic");
const OCM_DIR = path.join(OUT_DIR, "ocm");

// Window matches the real IVV screening window start so the OD-age gate and
// window-boundary logic exercise the same constants.
const T0_ISO = "2025-01-01T12:00:00.000Z";
const T0_MS = Date.parse(T0_ISO);
const OD_EPOCH_ISO = "2024-12-30T12:00:00.000Z"; // < 14 days before window start
const HALF_WINDOW_SEC = 300;
const STEP_SEC = 10; // linear motion is exact at any density; keep files small
const MS_PER_DAY = 86400000;
const JULIAN_UNIX_EPOCH = 2440587.5;

function isoAt(offsetSec) {
  return new Date(T0_MS + offsetSec * 1000).toISOString();
}
function jdAt(offsetSec) {
  return (T0_MS + offsetSec * 1000) / MS_PER_DAY + JULIAN_UNIX_EPOCH;
}
function norm(v) {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

// Each object: linear motion p(t) = center + vel*(t - T0). For a pair, missVec
// is perpendicular to relVel so the closest approach is exactly at T0.
// [independent-parity] analytic answer: tca=T0, miss=|missVec|, relSpd=|relVel|.
const PAIRS = [
  {
    id: "P1-NLRV", stratum: "NLRV",
    a: { norad: 90001, name: "SYN-NLRV-A1", center: [7000, 0, 0], vel: [0, 5.5, 0] },
    b: { norad: 90002, name: "SYN-NLRV-B1", center: [7000, 0, 0.25], vel: [0, -5.5, 0] },
  },
  {
    id: "P2-NLRV", stratum: "NLRV",
    a: { norad: 90003, name: "SYN-NLRV-A2", center: [0, 7000, 0], vel: [7.5, 0, 0] },
    b: { norad: 90004, name: "SYN-NLRV-B2", center: [0, 7000, 1.5], vel: [-7.5, 0, 0] },
  },
  {
    id: "P3-LRV", stratum: "LRV",
    a: { norad: 90005, name: "SYN-LRV-A3", center: [0, 0, 7000], vel: [0.015, 0, 0] },
    b: { norad: 90006, name: "SYN-LRV-B3", center: [0, 0.4, 7000], vel: [-0.015, 0, 0] },
  },
  {
    id: "P4-VLRV", stratum: "VLRV",
    a: { norad: 90007, name: "SYN-VLRV-A4", center: [-7000, 0, 0], vel: [0, 0.0025, 0] },
    b: { norad: 90008, name: "SYN-VLRV-B4", center: [-7000, 0, 0.8], vel: [0, -0.0025, 0] },
  },
  {
    // CONTROL: 15 km miss > 10 km spherical threshold -> must NOT be reported.
    // Exercises event-set PRECISION (the screener excludes beyond-threshold pairs).
    id: "P5-CONTROL-NOEVENT", stratum: "CONTROL", control: true,
    a: { norad: 90009, name: "SYN-CTRL-A5", center: [0, -7000, 0], vel: [0.01, 0, 0] },
    b: { norad: 90010, name: "SYN-CTRL-B5", center: [0, -7000, 15], vel: [-0.01, 0, 0] },
  },
];

function ocmText(obj) {
  const lines = [];
  lines.push("CCSDS_OCM_VERS = 3.0");
  lines.push("COMMENT SYNTHETIC A2.8b fixture — NOT real Aerospace CSieve data.");
  lines.push("COMMENT Straight-line motion; analytic closed-form answer key.");
  lines.push(`CREATION_DATE = ${T0_ISO}`);
  lines.push("ORIGINATOR = A2.8b-synthetic-generator");
  lines.push("META_START");
  lines.push(`OBJECT_NAME = ${obj.name}`);
  lines.push(`OBJECT_DESIGNATOR = ${obj.norad}`);
  lines.push(`INTERNATIONAL_DESIGNATOR = 2025-SYN${obj.norad}`);
  lines.push(`EPOCH_TZERO = ${T0_ISO}`);
  lines.push("TIME_SYSTEM = UTC");
  lines.push(`START_TIME = ${isoAt(-HALF_WINDOW_SEC)}`);
  lines.push(`STOP_TIME = ${isoAt(HALF_WINDOW_SEC)}`);
  lines.push("META_STOP");
  lines.push("TRAJ_START");
  lines.push("TRAJ_REF_FRAME = ICRF");
  lines.push("TRAJ_TYPE = CARTPV");
  lines.push(`USEABLE_START_TIME = ${isoAt(-HALF_WINDOW_SEC)}`);
  lines.push(`USEABLE_STOP_TIME = ${isoAt(HALF_WINDOW_SEC)}`);
  lines.push("TRAJ_UNITS = [km, km, km, km/s, km/s, km/s]");
  for (let t = -HALF_WINDOW_SEC; t <= HALF_WINDOW_SEC; t += STEP_SEC) {
    const x = obj.center[0] + obj.vel[0] * t;
    const y = obj.center[1] + obj.vel[1] * t;
    const z = obj.center[2] + obj.vel[2] * t;
    lines.push(
      `${isoAt(t)} ${x.toFixed(9)} ${y.toFixed(9)} ${z.toFixed(9)} ` +
        `${obj.vel[0].toFixed(9)} ${obj.vel[1].toFixed(9)} ${obj.vel[2].toFixed(9)}`,
    );
  }
  lines.push("TRAJ_STOP");
  lines.push("OD_START");
  lines.push(`OD_EPOCH = ${OD_EPOCH_ISO}`);
  lines.push("OD_STOP");
  return lines.join("\n") + "\n";
}

function analyticEvent(pair) {
  const relVel = [
    pair.a.vel[0] - pair.b.vel[0],
    pair.a.vel[1] - pair.b.vel[1],
    pair.a.vel[2] - pair.b.vel[2],
  ];
  const missVec = [
    pair.b.center[0] - pair.a.center[0],
    pair.b.center[1] - pair.a.center[1],
    pair.b.center[2] - pair.a.center[2],
  ];
  // sanity: missVec must be perpendicular to relVel so TCA == T0.
  const dot = relVec3(missVec, relVel);
  if (Math.abs(dot) > 1e-9) {
    throw new Error(`${pair.id}: missVec not perpendicular to relVel (dot=${dot}).`);
  }
  return {
    obj1: Math.min(pair.a.norad, pair.b.norad),
    obj2: Math.max(pair.a.norad, pair.b.norad),
    tcaJd: jdAt(0),
    tcaIso: T0_ISO,
    missKm: norm(missVec),
    relSpeedKms: norm(relVel),
    stratum: pair.stratum,
  };
}
function relVec3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OCM_DIR, { recursive: true });

  const objects = [];
  for (const pair of PAIRS) {
    objects.push(pair.a, pair.b);
  }
  for (const obj of objects) {
    fs.writeFileSync(path.join(OCM_DIR, `${obj.norad}.ocm`), ocmText(obj), "utf8");
  }

  const events = PAIRS.filter((p) => !p.control).map(analyticEvent);
  const header = [
    "run_id", "conj_id", "obj1", "met_criteria1", "obj2", "met_criteria2",
    "min_range", "Vrel", "prob", "dilution", "mdistance", "epoch", "jdate",
    "obj1_filename", "obj2_filename", "stratum",
  ];
  const rows = [header.join(",")];
  let conjId = 1;
  for (const e of events) {
    rows.push([
      "SYNTHETIC-A2.8b", conjId++, e.obj1, 1, e.obj2, 1,
      e.missKm.toFixed(9), e.relSpeedKms.toFixed(9),
      "NULL", 0, "NULL", e.tcaIso, e.tcaJd.toFixed(9),
      `${e.obj1}.ocm`, `${e.obj2}.ocm`, e.stratum,
    ].join(","));
  }
  fs.writeFileSync(
    path.join(OUT_DIR, "answer_key_spherical.csv"),
    rows.join("\n") + "\n",
    "utf8",
  );

  const readme = `# SYNTHETIC Aerospace-IVV-shaped parity fixture (A2.8b)

**THIS IS NOT REAL AEROSPACE / CSieve DATA.** It is a small, deterministic,
analytically-answered stand-in generated by
\`scripts/generate-aerospace-synthetic-fixture.mjs\`, used ONLY when the real
Aerospace IVV dataset (\`AerospaceIVVDataset_20251009a\`, CC0 but ~21.74 GB,
Google-account/OSC-gated) is not present locally. See
\`docs/aerospace-ivv-acquisition.md\` to obtain the real dataset (OWNER-ASSIST)
and run the same harness against the genuine CSieve answer key.

## What it is
- \`ocm/<norad>.ocm\` — ${objects.length} CCSDS-OCM-KVN ephemeris files, each a
  straight-line (constant-velocity) trajectory over
  [T0-${HALF_WINDOW_SEC}s, T0+${HALF_WINDOW_SEC}s], T0=${T0_ISO}, ${STEP_SEC}s step.
- \`answer_key_spherical.csv\` — CSieve-schema answer key computed in CLOSED FORM
  (each pair's miss vector is perpendicular to its relative velocity, so the
  closest approach is exactly at T0; miss=|missVec|, Vrel=|relVel|). This is an
  INDEPENDENT reference, not the module's own output.

## Coverage
${events
  .map(
    (e) =>
      `- ${e.obj1}-${e.obj2} [${e.stratum}] miss=${(e.missKm * 1000).toFixed(1)}m Vrel=${e.relSpeedKms} km/s`,
  )
  .join("\n")}
- 90009-90010 [CONTROL] miss=15000m > 10km spherical threshold — must NOT be
  reported (event-set precision check).

## What it validates / does not
- VALIDATES: screen_catalog track ingestion, all-vs-all screening, TCA
  refinement, miss-distance geometry, event-set recall/precision, rel-vel
  stratification — end to end, in CI, with no network and no WasmEdge.
- Does NOT validate orbital dynamics or Pc numerics — that is the real dataset's
  role. Pc here is NULL (not gated; the User's Guide excludes Pc from CS
  validation regardless).
`;
  fs.writeFileSync(path.join(OUT_DIR, "README.md"), readme, "utf8");

  process.stdout.write(
    `Wrote ${objects.length} OCM files + answer key (${events.length} events) to ${OUT_DIR}\n`,
  );
}

main();
