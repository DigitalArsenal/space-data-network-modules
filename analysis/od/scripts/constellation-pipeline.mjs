// Constellation pipeline (loop packet P1.1 / owner directive 2026-07-14):
// download a provider's FULL public ephemeris set, fit every object with the OD
// module in a parallel worker pool, OPTIONALLY publish each fitted $OMM to a
// serving SDN node as it lands, compare each fitted OMM against (a) the same-day
// CelesTrak SupGP RMS and (b) Space-Track GP elements, and emit a per-stage
// timed report.
//
// Efficiency model (owner: "create an entire new set from all sources in less
// than 1 hour"): download and fit OVERLAP — files feed the fit pool as they
// land (reused-from-disk files feed immediately), and fitted OMMs feed the
// publish pool as they complete. Download uses the built-in global `fetch`
// (undici) at high concurrency; measured plateau ~280 MB/s at ~256-way on this
// link (a raw node:https Agent is NOT used — it does not follow the api.starlink
// CDN redirect and is far slower). Rolling MB/s is logged every 5s.
//
// Network scope: ONLY the provider's public ephemeris service is fetched here
// (bounded concurrency, resumable). CelesTrak + Space-Track inputs are
// pre-captured CSV paths. Publishing targets a node the operator points us at
// (--publish-url), typically an SSH tunnel to the serving node's API port.
//
//   node scripts/constellation-pipeline.mjs \
//     --provider starlink|iss|glonass|cpf|intelsat|celestrak-supgp|gps|oneweb \
//     --workdir <dir> \
//     [--celestrak-csv <sup-gp.csv>] [--spacetrack-csv <gp.csv>] \
//     [--download-concurrency 256] [--fit-workers 20] [--limit N] \
//     [--publish] [--publish-url http://127.0.0.1:15001] \
//     [--publish-batch 100] [--publish-concurrency 4] \
//     [--cpf-targets lageos1,lageos2] [--arc-hours 24] \
//     [--relay-host root@celestrak.eth] [--tokens ses,planet,...]
//
// Lane kinds: manifest (starlink), single (iss), prepare (glonass/cpf/intelsat:
// live upstream -> position-only KVN OEM -> fit), republish (celestrak-supgp:
// the 7 NON-INDEPENDENT CelesTrak SupGP tokens, policy-gated relay fetch, no
// fit / no RMS claim of ours), blocked (gps/oneweb: honest skip taxonomy).
//
// Must be run with cwd = analysis/od (the isomorphic harness resolves the
// space-data-module-sdk from process.cwd()).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const PROVIDERS = {
  starlink: {
    registryKey: "spacex-starlink", // SDN provider registry key -> SourceTags.SourceName/ProviderID
    source: "SpaceX-E", // ORIGINATOR / provenance name
    dataSource: "SpaceX-E", // OD-module fit option
    kind: "manifest",
    manifestUrl: "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt",
    fileUrl: (name) => `https://api.starlink.com/public-files/ephemerides/${name}`,
    inputFormat: "meme",
    noradFromFilename: (name) => Number.parseInt(name.split("_")[1], 10),
    objectFromFilename: (name) => name.split("_")[2] ?? "",
    objectNameFromFilename: (name) => name.split("_")[2] ?? "",
    objectIdFromFilename: () => "", // SpaceX filenames carry no COSPAR — honest empty
  },
  // ISS: a single public CCSDS OEM (NASA). Fit the whole file -> one $OMM.
  iss: {
    registryKey: "iss",
    source: "NASA-ISS",
    dataSource: "ISS-E",
    kind: "single",
    fileName: "ISS.OEM_J2K_EPH.txt",
    fileUrl: () => "https://nasa-public-data.s3.amazonaws.com/iss-coords/current/ISS_OEM/ISS.OEM_J2K_EPH.txt",
    inputFormat: "oem",
    norad: 25544,
    objectName: "ISS (ZARYA)",
    objectId: "1998-067A",
    noradFromFilename: () => 25544,
    objectFromFilename: () => "ISS (ZARYA)",
    objectNameFromFilename: () => "ISS (ZARYA)",
    objectIdFromFilename: () => "1998-067A",
  },
  // GLONASS: IAC precise SP3-d rapid product (anonymous FTP) -> position-only
  // KVN OEM per satellite slot (R01..R26) -> fit. Frame/time come from the SP3
  // header (IGS20/ECEF, GPS time); the OD side owns ECEF->TEME + GPS->UTC
  // (A2.4-prereq chain, see tests/data/supgp-reference/glonass/PROVENANCE.md).
  // The SP3 carries ONLY slot ids — no NORAD/COSPAR. No authoritative GLONASS
  // slot->NORAD registry is available (OWNER-ASSIST), so IDs stay honest-empty.
  glonass: {
    registryKey: "glonass",
    source: "IAC",
    dataSource: "GLONASS-RE",
    kind: "prepare",
    prepare: "glonass",
    inputFormat: "oem",
    noradFromFilename: () => 0,
    objectFromFilename: (name) => name.replace(/\.oem\.kvn$/, ""),
    objectNameFromFilename: (name) => name.replace(/\.oem\.kvn$/, ""),
    objectIdFromFilename: () => "",
  },
  // CPF: ILRS CPF v2 predictions (EDC/DGFI-TUM anonymous HTTPS) -> position-only
  // KVN OEM per laser target -> fit. CPF '10' records are ITRF/ECEF metres, UTC
  // (MJD + sec-of-day); the H2 header carries the REAL NORAD (parsed, never
  // fabricated). PREDICTION source — CelesTrak's CPF SupGP derives from the same
  // CPF predictions, so any parity there is prediction-vs-prediction.
  cpf: {
    registryKey: "cpf",
    source: "ILRS",
    dataSource: "CPF",
    kind: "prepare",
    prepare: "cpf",
    inputFormat: "oem",
    noradFromFilename: () => 0,
    objectFromFilename: (name) => name.replace(/\.oem\.kvn$/, ""),
    objectNameFromFilename: (name) => name.replace(/\.oem\.kvn$/, ""),
    objectIdFromFilename: () => "",
  },
  // Intelsat: MyIntelsat public ECF ephemeris (unauthenticated) -> position-only
  // KVN OEM per satellite -> fit. ECF = ECEF metres, UTC; no velocity, no
  // NORAD/COSPAR in the source. External registry (owner-assist, A2.4 NORAD-KEY
  // CORRECTION): IS-21 = NORAD 38749 / COSPAR 2012-045A (NOT the draft's 38098).
  intelsat: {
    registryKey: "intelsat",
    source: "Intelsat",
    dataSource: "Intelsat-11P",
    kind: "prepare",
    prepare: "intelsat",
    inputFormat: "oem",
    noradFromFilename: () => 0,
    objectFromFilename: (name) => name.replace(/\.oem\.kvn$/, ""),
    objectNameFromFilename: (name) => name.replace(/\.oem\.kvn$/, ""),
    objectIdFromFilename: () => "",
  },
  // CelesTrak SupGP republish lanes (App 2 A2.9): the 7 NON-INDEPENDENT tokens.
  // These are CELESTRAK-FITTED mean elements — NOT our OD and NOT operator-raw.
  // Republish-only: no fit, no RMS claim of ours. Records carry the honest
  // NON-INDEPENDENT labeling mirrored from data-source/celestrak-supgp (COMMENT
  // prose + CelesTrak's own RMS/DATA_SOURCE preserved). Fetched ONCE per token
  // via the host relay UNDER THE CELESTRAK FETCH POLICY (3h ledger, 2.5s serial).
  "celestrak-supgp": {
    kind: "republish",
    tokens: [
      { token: "SES-E", key: "ses" },
      { token: "Planet", key: "planet" },
      { token: "Iridium", key: "iridium" },
      { token: "Telesat", key: "telesat" },
      { token: "Kuiper-E", key: "kuiper" },
      { token: "AST", key: "ast-spacemobile" },
      { token: "CSS-E", key: "css" },
    ],
  },
  // BLOCKED lanes (honest skip taxonomy — the board renders these reasons).
  gps: {
    kind: "blocked",
    registryKey: "gps",
    skipReason:
      "BLOCKED AT SOURCE: a GPS almanac (NAVCEN SEM/YUMA) is a set of GPS-LNAV mean Keplerian ELEMENTS, " +
      "not a state-vector ephemeris — there is nothing to fit (A2.2c-2 forbids fabricating an ephemeris " +
      "by propagating the almanac). Element-space parity vs CelesTrak GPS-A is also not independent and " +
      "needs a GPS-BROADCAST->SGP4 theory reconciliation + PRN->NORAD cross-reference (OWNER-ASSIST). " +
      "UNBLOCK LEAD: CelesTrak's GPS-E (state-vector) + IGS precise ephemeris + PRN->NORAD.",
  },
  oneweb: {
    kind: "blocked",
    registryKey: "oneweb",
    skipReason:
      "BLOCKED ON DECODE: OneWeb's operator feed is LTEF, a proprietary 17-column fixed-point encoding " +
      "with no public column spec (A2.2c-1); SMA/eccentricity/frame are not decodable, so no raw state " +
      "vectors can be fit. Element parity vs CelesTrak OneWeb-E would be non-independent anyway (their " +
      "SupGP derives from the same LTEF). OWNER-ASSIST: obtain OneWeb's LTEF spec.",
  },
};

// ------------------------------------------------- provider prepare helpers
// (main thread only; workers never call these)
const pExecFile = promisify(execFile);

// KVN OEM writer — mirrors the checked-in A2.4 derived-fixture format
// (tests/data/supgp-reference/{glonass,cpf,intelsat}/*.kvn): values verbatim
// from the source (metres->km only where noted), frame/time as DECLARED by the
// source, position-only data lines, and a COMMENT block recording derivation.
function writeKvnOem(dest, { objectName, objectId, refFrame, timeSystem, originator, comments, points }) {
  const lines = [];
  lines.push("CCSDS_OEM_VERS = 2.0");
  for (const c of comments) lines.push(`COMMENT ${c}`);
  lines.push(`CREATION_DATE = ${points[0].epoch}`);
  lines.push(`ORIGINATOR = ${originator}`);
  lines.push("META_START");
  lines.push(`OBJECT_NAME = ${objectName}`);
  lines.push(`OBJECT_ID = ${objectId ?? ""}`);
  lines.push("CENTER_NAME = EARTH");
  lines.push(`REF_FRAME = ${refFrame}`);
  lines.push(`TIME_SYSTEM = ${timeSystem}`);
  lines.push(`START_TIME = ${points[0].epoch}`);
  lines.push(`STOP_TIME = ${points[points.length - 1].epoch}`);
  lines.push("META_STOP");
  for (const p of points) lines.push(`${p.epoch} ${p.x} ${p.y} ${p.z}`);
  fs.writeFileSync(dest, `${lines.join("\n")}\n`);
}

const isoStamp = (y, mo, d, h, mi, s) => {
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(Math.floor(s))}.${pad(ms, 3)}`;
};

// GLONASS: discover the latest IAC rapid GLONASS-only SP3-d (.sp3.glo) over
// anonymous FTP (curl — Node fetch has no FTP), download once (cache), and
// emit one position-only KVN OEM per satellite slot with >=3 good epochs.
async function prepareGlonass(filesDir, cacheDir) {
  const dayMs = 86400000;
  let sp3Path = null;
  let sp3Name = null;
  let dayDir = null;
  for (let back = 0; back < 6 && !sp3Path; back += 1) {
    const d = new Date(Date.now() - back * dayMs);
    const doy = Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / dayMs);
    dayDir = `${String(d.getUTCFullYear()).slice(2)}${String(doy).padStart(3, "0")}`;
    const listUrl = `ftp://ftp.glonass-iac.ru/MCC/PRODUCTS/${dayDir}/rapid/`;
    try {
      const { stdout } = await pExecFile("curl", ["-s", "-m", "40", listUrl]);
      const m = stdout.match(/Sta\d+\.sp3\.glo/);
      if (!m) continue;
      sp3Name = m[0];
      const cached = path.join(cacheDir, `${dayDir}_${sp3Name}`);
      if (!fs.existsSync(cached) || fs.statSync(cached).size === 0) {
        await pExecFile("curl", ["-s", "-m", "120", "-o", cached, `${listUrl}${sp3Name}`]);
      }
      if (fs.statSync(cached).size > 0) sp3Path = cached;
    } catch { /* try previous day */ }
  }
  if (!sp3Path) throw new Error("glonass: no IAC rapid .sp3.glo found in the last 6 days");

  const text = fs.readFileSync(sp3Path, "utf8");
  const lines = text.split(/\r?\n/);
  const frame = (lines[0].match(/\b(IGS\d+\w*|IGb\d+\w*|ITRF\w*)\b/) ?? [null, "IGS20"])[1];
  const timeLine = lines.find((l) => l.startsWith("%c")) ?? "";
  const timeSystem = (timeLine.match(/^%c\s+\S+\s+\S+\s+(\w+)/) ?? [null, "GPS"])[1];
  let epoch = null;
  const perSat = new Map();
  for (const line of lines) {
    if (line.startsWith("* ")) {
      const f = line.slice(1).trim().split(/\s+/).map(Number);
      epoch = isoStamp(f[0], f[1], f[2], f[3], f[4], f[5]);
      continue;
    }
    if (epoch && /^P[A-Z]\d\d/.test(line)) {
      const sat = line.slice(1, 4);
      const f = line.slice(4).trim().split(/\s+/).map(Number);
      const [x, y, z] = f;
      // SP3 bad-value sentinel 999999.999999 (or all-zero) positions are skipped.
      if (![x, y, z].every(Number.isFinite)) continue;
      if (Math.abs(x) >= 999999 || Math.abs(y) >= 999999 || Math.abs(z) >= 999999) continue;
      if (x === 0 && y === 0 && z === 0) continue;
      if (!perSat.has(sat)) perSat.set(sat, []);
      perSat.get(sat).push({ epoch, x: x.toFixed(6), y: y.toFixed(6), z: z.toFixed(6) });
    }
  }
  const meta = new Map();
  const files = [];
  for (const [sat, points] of [...perSat.entries()].sort()) {
    if (points.length < 3) continue;
    const file = `${sat}.oem.kvn`;
    writeKvnOem(path.join(filesDir, file), {
      objectName: sat,
      objectId: "",
      refFrame: frame,
      timeSystem,
      originator: "IAC",
      comments: [
        "DERIVED live by the constellation pipeline (App 2 all-providers lane).",
        `Source: IAC GLONASS-only precise SP3-d rapid product ${sp3Name} (day ${dayDir}),`,
        "  upstream ftp://ftp.glonass-iac.ru/MCC/PRODUCTS/ — anonymous FTP.",
        `ECEF(${frame})/${timeSystem}-time, positions km, P-records copied verbatim.`,
        "SP3 carries only the slot id — NO NORAD/COSPAR (no authoritative slot->NORAD",
        "  registry, OWNER-ASSIST); identity left honest-empty, never fabricated.",
      ],
      points,
    });
    meta.set(file, { norad: 0, objectName: sat, objectId: "" });
    files.push(file);
  }
  return { files, meta, note: `sp3=${sp3Name} day=${dayDir} frame=${frame} time=${timeSystem} sats=${files.length}` };
}

// CPF: for each ILRS target, list the EDC anonymous-HTTPS archive, pick the
// latest v2 prediction, and convert its '10' position records (ITRF/ECEF,
// metres, MJD+sec UTC) to a KVN OEM. NORAD comes from the CPF H2 header
// (real, parsed — never fabricated). Arc trimmed to the first N hours.
async function prepareCpf(filesDir, cacheDir, { targets, arcHours }) {
  const year = new Date().getUTCFullYear();
  const meta = new Map();
  const files = [];
  const notes = [];
  for (const target of targets) {
    const base = `https://edc.dgfi.tum.de/pub/slr/cpf_predicts_v2/${year}/${target}/`;
    let listing;
    try {
      listing = await (await fetch(base, { signal: AbortSignal.timeout(30000) })).text();
    } catch (e) {
      notes.push(`${target}: listing failed (${String(e?.message ?? e).slice(0, 60)})`);
      continue;
    }
    const names = [...new Set(listing.match(new RegExp(`${target}_cpf_\\d{6}_\\d+\\.[a-z]+`, "g")) ?? [])].sort();
    const name = names.at(-1);
    if (!name) { notes.push(`${target}: no CPF files in listing`); continue; }
    const cached = path.join(cacheDir, name);
    if (!fs.existsSync(cached) || fs.statSync(cached).size === 0) {
      const res = await fetch(`${base}${name}`, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) { notes.push(`${target}: fetch ${res.status}`); continue; }
      fs.writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
    }
    const lines = fs.readFileSync(cached, "utf8").split(/\r?\n/);
    const h1 = (lines.find((l) => l.startsWith("H1")) ?? "").trim().split(/\s+/);
    const h2 = (lines.find((l) => l.startsWith("H2")) ?? "").trim().split(/\s+/);
    const objectName = h1[10] ?? target;
    const agency = h1[3] ?? "";
    const norad = Number.parseInt(h2[3] ?? "0", 10) || 0;
    const frameCode = Number.parseInt(h2[19] ?? "0", 10);
    if (frameCode !== 0) { notes.push(`${target}: CPF frame code ${frameCode} != 0 (not ECEF) — skipped`); continue; }
    const points = [];
    let firstMs = null;
    for (const line of lines) {
      if (!line.startsWith("10 ")) continue;
      const f = line.trim().split(/\s+/);
      const mjd = Number.parseInt(f[2], 10);
      const sec = Number.parseFloat(f[3]);
      const ms = (mjd - 40587) * 86400000 + sec * 1000;
      if (firstMs === null) firstMs = ms;
      if (ms - firstMs > arcHours * 3600000) break;
      const iso = new Date(ms).toISOString().replace("Z", "");
      points.push({
        epoch: iso.length === 19 ? `${iso}.000` : iso,
        x: (Number.parseFloat(f[5]) / 1000).toFixed(6),
        y: (Number.parseFloat(f[6]) / 1000).toFixed(6),
        z: (Number.parseFloat(f[7]) / 1000).toFixed(6),
      });
    }
    if (points.length < 3) { notes.push(`${target}: <3 position records`); continue; }
    const file = `${objectName}.oem.kvn`;
    writeKvnOem(path.join(filesDir, file), {
      objectName,
      objectId: "",
      refFrame: "ITRF",
      timeSystem: "UTC",
      originator: `ILRS/${agency}`,
      comments: [
        "DERIVED live by the constellation pipeline (App 2 all-providers lane).",
        `Source: ILRS CPF v2 PREDICTION ${name} (EDC/DGFI-TUM anonymous HTTPS,`,
        `  https://edc.dgfi.tum.de/pub/slr/cpf_predicts_v2/${year}/${target}/).`,
        "CPF '10' records ITRF/ECEF UTC; metres->km only; epoch = MJD+sec-of-day.",
        `Arc trimmed to first ${arcHours}h (${points.length} pts). NORAD ${norad} from CPF H2 (real).`,
        "PREDICTION source: CelesTrak CPF SupGP derives from the same ILRS CPF",
        "  predictions — any parity is prediction-vs-prediction, NOT independent.",
      ],
      points,
    });
    meta.set(file, { norad, objectName, objectId: "" });
    files.push(file);
    notes.push(`${target}: ${name} norad=${norad} pts=${points.length}`);
  }
  return { files, meta, note: notes.join("; ") };
}

// Intelsat: fetch the public MyIntelsat listing (unauthenticated HTML), pick
// the newest ECF (category 'e') file per satellite, convert (ECEF metres UTC ->
// km) to KVN OEM. The ECF carries NO NORAD/COSPAR; the ONLY owner-assisted
// registry entry is IS-21 = 38749 / 2012-045A (A2.4 NORAD-KEY CORRECTION —
// CelesTrak's own SupGP disproved the draft's 38098). Others stay honest-empty.
const INTELSAT_NORAD_REGISTRY = { "IS-21": { norad: 38749, objectId: "2012-045A" } };
async function prepareIntelsat(filesDir, cacheDir, { limit, arcHours, fetchConcurrency }) {
  const listingUrl = "https://my.intelsat.com/ephemeris/public";
  const listing = await (await fetch(listingUrl, { signal: AbortSignal.timeout(30000) })).text();
  const all = [...new Set(listing.match(/<option value="([^"]+)"/g) ?? [])]
    .map((m) => m.slice(15, -1));
  // category 'e' = ECF state-vector table (c/m/w/x are not state ephemerides).
  const ecf = all.filter((n) => n.split("_")[2] === "e");
  const newestBySat = new Map();
  for (const n of ecf) {
    const parts = n.split("_");
    const sat = parts[4] ?? n;
    const stamp = `${parts[5] ?? ""}${parts[6] ?? ""}`;
    const cur = newestBySat.get(sat);
    if (!cur || stamp > cur.stamp) newestBySat.set(sat, { name: n, stamp });
  }
  const picks = [...newestBySat.entries()].sort().slice(0, limit).map(([sat, v]) => ({ sat, name: v.name }));
  const meta = new Map();
  const files = [];
  const notes = [];
  const queue = [...picks];
  async function worker() {
    for (;;) {
      const pick = queue.shift();
      if (!pick) return;
      try {
        const cached = path.join(cacheDir, `${pick.name}.txt`);
        if (!fs.existsSync(cached) || fs.statSync(cached).size === 0) {
          const res = await fetch(`https://my.intelsat.com/Resource/Ephemeris/${pick.name}.txt`, {
            signal: AbortSignal.timeout(45000),
          });
          if (!res.ok) { notes.push(`${pick.sat}: fetch ${res.status}`); continue; }
          fs.writeFileSync(cached, Buffer.from(await res.arrayBuffer()));
        }
        const text = fs.readFileSync(cached, "utf8");
        const nameMatch = text.match(/ECF Ephemeris for Intelsat\s+(\S+)/i);
        const objectName = (nameMatch?.[1] ?? pick.sat).toUpperCase();
        const points = [];
        let firstMs = null;
        for (const line of text.split(/\r?\n/)) {
          const m = line.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/);
          if (!m) continue;
          const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], Math.floor(+m[6]), Math.round((+m[6] % 1) * 1000));
          if (firstMs === null) firstMs = ms;
          if (ms - firstMs > arcHours * 3600000) break;
          const iso = new Date(ms).toISOString().replace("Z", "");
          points.push({
            epoch: iso.length === 19 ? `${iso}.000` : iso,
            x: (Number.parseFloat(m[7]) / 1000).toFixed(6),
            y: (Number.parseFloat(m[8]) / 1000).toFixed(6),
            z: (Number.parseFloat(m[9]) / 1000).toFixed(6),
          });
        }
        if (points.length < 3) { notes.push(`${pick.sat}: <3 rows`); continue; }
        const reg = INTELSAT_NORAD_REGISTRY[objectName] ?? { norad: 0, objectId: "" };
        const file = `${objectName}.oem.kvn`;
        writeKvnOem(path.join(filesDir, file), {
          objectName,
          objectId: reg.objectId,
          refFrame: "ECEF",
          timeSystem: "UTC",
          originator: "Intelsat",
          comments: [
            "DERIVED live by the constellation pipeline (App 2 all-providers lane).",
            `Source: MyIntelsat public ECF ephemeris ${pick.name}.txt (unauthenticated,`,
            "  https://my.intelsat.com/Resource/Ephemeris/). ECEF, UTC, metres->km only.",
            `Arc trimmed to first ${arcHours}h (${points.length} pts). Position-only; velocity never fabricated.`,
            reg.norad
              ? `Identity: owner-assist registry ${objectName} -> NORAD ${reg.norad} / ${reg.objectId} (A2.4 correction).`
              : "Identity: the ECF carries NO NORAD/COSPAR and no registry entry exists — honest-empty.",
            "NON-INDEPENDENT vs CelesTrak Intelsat-11P SupGP (same public feed).",
          ],
          points,
        });
        meta.set(file, { norad: reg.norad, objectName, objectId: reg.objectId });
        files.push(file);
      } catch (e) {
        notes.push(`${pick.sat}: ${String(e?.message ?? e).slice(0, 60)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: fetchConcurrency }, worker));
  return { files, meta, note: `listing=${ecf.length} ecf entries, ${newestBySat.size} sats, prepared ${files.length}; ${notes.slice(0, 6).join("; ")}` };
}

const PREPARERS = { glonass: prepareGlonass, cpf: prepareCpf, intelsat: prepareIntelsat };

// ---------------------------------------------------------------- fit worker
if (!isMainThread) {
  const { assertSuccessfulResponse, createStandaloneHarnessOrSkip } = await import(
    "../../../tests/lib/isomorphicHarness.mjs"
  );
  const harness = await createStandaloneHarnessOrSkip("browser", WASM_PATH);
  if (!harness) {
    parentPort.postMessage({ kind: "fatal", error: "no standalone runtime available" });
    process.exit(1);
  }
  const { inputFormat, dataSource } = workerData;
  const optionBytes = new TextEncoder().encode(JSON.stringify({ inputFormat, dataSource }));
  parentPort.on("message", async (msg) => {
    if (msg.kind === "close") {
      await harness.close?.();
      process.exit(0);
    }
    const started = performance.now();
    try {
      const payload = fs.readFileSync(msg.filePath);
      const response = await harness.invoke({
        methodId: "fit",
        inputs: [
          { portId: "meme", payload },
          { portId: "options", payload: optionBytes },
        ],
      });
      const bytes = assertSuccessfulResponse(response, { outputPortId: "result" });
      const fit = JSON.parse(new TextDecoder().decode(bytes));
      parentPort.postMessage({ kind: "fit", file: msg.file, ms: performance.now() - started, fit });
    } catch (error) {
      parentPort.postMessage({
        kind: "skip",
        file: msg.file,
        ms: performance.now() - started,
        reason: String(error?.message ?? error).slice(0, 300),
      });
    }
  });
  parentPort.postMessage({ kind: "ready" });
}

// ---------------------------------------------------------------- main
if (isMainThread) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a, i, all) => {
      if (!a.startsWith("--")) return null;
      const key = a.slice(2);
      const next = all[i + 1];
      // boolean flags (no value or followed by another --flag)
      if (next === undefined || next.startsWith("--")) return [key, "true"];
      return [key, next];
    }).filter(Boolean),
  );
  const providerName = args.provider ?? "starlink";
  const provider = PROVIDERS[providerName];
  if (!provider) throw new Error(`unknown provider ${providerName}`);
  const workdir = path.resolve(args.workdir ?? path.join(os.tmpdir(), "constellation-pipeline"));
  const filesDir = path.join(workdir, providerName, "files");
  fs.mkdirSync(filesDir, { recursive: true });

  // ---- BLOCKED lanes: honest skip taxonomy (gps / oneweb). The lane runs,
  // states WHY nothing is fitted or published, and writes a report the board
  // can render. Never fabricates an ephemeris to un-block itself.
  if (provider.kind === "blocked") {
    const report = {
      provider: providerName,
      registryKey: provider.registryKey ?? providerName,
      startedAt: new Date().toISOString(),
      blocked: true,
      skipReason: provider.skipReason,
      totals: { fitted: 0, published: 0 },
    };
    report.finishedAt = report.startedAt;
    fs.writeFileSync(path.join(workdir, providerName, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[lane blocked] provider=${providerName} — ${provider.skipReason}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }
  const downloadConcurrency = Number.parseInt(args["download-concurrency"] ?? "256", 10);
  const fitWorkers = Number.parseInt(args["fit-workers"] ?? "20", 10);
  const limit = args.limit ? Number.parseInt(args.limit, 10) : Infinity;
  const doPublish = args.publish === "true" || args.publish === "" || args.publish === true;
  const publishUrl = (args["publish-url"] ?? "http://127.0.0.1:15001").replace(/\/$/, "");
  const publishBatch = Number.parseInt(args["publish-batch"] ?? "100", 10);
  const publishConcurrency = Number.parseInt(args["publish-concurrency"] ?? "4", 10);
  const publishTimeoutMs = Number.parseInt(args["publish-timeout-ms"] ?? "30000", 10);

  const startedAt = new Date().toISOString();
  const registryKey = provider.registryKey ?? providerName;
  // Run/batch id = sha256(provider + startedAt). "provider" is the canonical
  // SDN provider registry key (spacex-starlink / iss), matching the SourceName
  // the App 2 board groups lanes by. Groups every OMM fitted in this pass.
  const batchId = crypto.createHash("sha256").update(`${registryKey}${startedAt}`).digest("hex");
  const creationDate = startedAt.replace(/\.\d+Z$/, "Z");

  // Provenance the publish endpoint SHOULD persist as SourceTags so the
  // records show up in GET /api/v1/stats sources[] (App 2 board). See the
  // gap note in the module README: today POST /publish stores records via
  // Store(...,nil) and does NOT write these; we forward them as query params
  // (schema-path parsing ignores the query string) so the surface is correct
  // the moment the handler routes source_name/provider_id/batch_id to
  // StoreWithSourceTags. Never a validation bypass — same validate + quota path.
  // source_url = the provider's upstream (manifest for multi-file, the OEM URL
  // for single-file). SDN persists these query params as SourceTags (publish
  // patch 6180f39f) so the App 2 board's /api/v1/stats sources[] counts rise.
  const sourceUrl =
    provider.kind === "single" ? provider.fileUrl()
    : provider.kind === "prepare" ? ({
        glonass: "ftp://ftp.glonass-iac.ru/MCC/PRODUCTS/",
        cpf: "https://edc.dgfi.tum.de/pub/slr/cpf_predicts_v2/",
        intelsat: "https://my.intelsat.com/ephemeris/public",
      }[provider.prepare] ?? "")
    : provider.kind === "republish" ? "https://celestrak.org/NORAD/elements/supplemental/sup-gp.php"
    : provider.manifestUrl;
  const publishQuery =
    `?source_name=${encodeURIComponent(registryKey)}` +
    `&provider_id=${encodeURIComponent(registryKey)}` +
    `&batch_id=${encodeURIComponent(batchId)}` +
    `&source_url=${encodeURIComponent(sourceUrl)}`;

  const metrics = { provider: providerName, registryKey, startedAt, batchId, stages: {} };
  const pipelineStart = performance.now();

  // --- resolve the generated $OMM FlatBuffer builder (only if publishing) ----
  let OMM = null;
  let flatbuffers = null;
  if (doPublish || provider.kind === "republish") {
    const anchors = [
      path.join(__dirname, "../../../propagator/sgp4/package.json"),
      path.join(__dirname, "../../../propagator/hpop/package.json"),
      path.join(__dirname, "../node_modules/space-data-module-sdk/package.json"),
    ];
    let fbPath;
    let ommPath;
    for (const a of anchors) {
      try {
        const r = createRequire(a);
        fbPath = r.resolve("flatbuffers");
        ommPath = r.resolve("spacedatastandards.org/lib/js/OMM/OMM.js");
        break;
      } catch { /* next anchor */ }
    }
    if (!fbPath || !ommPath) throw new Error("cannot resolve flatbuffers + spacedatastandards.org for --publish");
    flatbuffers = await import(pathToFileURL(fbPath));
    ({ OMM } = await import(pathToFileURL(ommPath)));
  }

  const epochUnixSeconds = (iso) => {
    const t = Date.parse(iso.endsWith("Z") ? iso : `${iso}Z`);
    return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
  };

  // Build a size-prefixed $OMM FlatBuffer from a fit result + provider meta.
  // The module returns placeholder identity (NORAD 99999) — the REAL NORAD /
  // object name come from the provider (SpaceX filename / ISS constant), never
  // fabricated. Provenance (source, batch id, fit RMS, convergence) rides in
  // the CCSDS COMMENT + ORIGINATOR, mirroring the fit-pipeline module.
  const buildOmmFrame = (fit, meta) => {
    const b = new flatbuffers.Builder(512);
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number.parseFloat(v));
    const rms = Number.parseFloat(fit.RMS);
    const comment =
      `SDN OD-fitted supplemental GP (App 2). ` +
      `SOURCE_NAME=${meta.source} DATA_SOURCE=${fit.DATA_SOURCE ?? meta.source} ` +
      `BATCH_ID=${batchId} FIT_RMS_KM=${Number.isFinite(rms) ? rms.toFixed(6) : "NA"} ` +
      `ITERATIONS=${fit.ITERATIONS ?? ""} CONVERGED=${fit.CONVERGED ?? ""}`;
    const nameOff = b.createString(meta.objectName || "");
    const objIdOff = meta.objectId ? b.createString(meta.objectId) : 0;
    const centerOff = b.createString("EARTH");
    const originatorOff = b.createString(meta.source);
    const creationOff = b.createString(creationDate);
    const commentOff = b.createString(comment);
    const epochOff = b.createString(fit.EPOCH ?? "");
    const classOff = fit.CLASSIFICATION_TYPE ? b.createString(String(fit.CLASSIFICATION_TYPE)) : 0;
    const designatorOff = meta.objectName ? b.createString(meta.objectName) : 0;
    OMM.startOMM(b);
    OMM.addCreationDate(b, creationOff);
    OMM.addOriginator(b, originatorOff);
    if (nameOff) OMM.addObjectName(b, nameOff);
    if (objIdOff) OMM.addObjectId(b, objIdOff);
    OMM.addCenterName(b, centerOff);
    OMM.addComment(b, commentOff);
    OMM.addEpoch(b, epochOff);
    OMM.addMeanMotion(b, num(fit.MEAN_MOTION));
    OMM.addEccentricity(b, num(fit.ECCENTRICITY));
    OMM.addInclination(b, num(fit.INCLINATION));
    OMM.addRaOfAscNode(b, num(fit.RA_OF_ASC_NODE));
    OMM.addArgOfPericenter(b, num(fit.ARG_OF_PERICENTER));
    OMM.addMeanAnomaly(b, num(fit.MEAN_ANOMALY));
    if (Number.isFinite(num(fit.MEAN_MOTION_DOT))) OMM.addMeanMotionDot(b, num(fit.MEAN_MOTION_DOT));
    if (Number.isFinite(num(fit.MEAN_MOTION_DDOT))) OMM.addMeanMotionDdot(b, num(fit.MEAN_MOTION_DDOT));
    if (Number.isFinite(num(fit.BSTAR))) OMM.addBstar(b, num(fit.BSTAR));
    if (Number.isFinite(num(fit.EPHEMERIS_TYPE))) OMM.addEphemerisType(b, num(fit.EPHEMERIS_TYPE));
    if (classOff) OMM.addClassificationType(b, classOff);
    OMM.addNoradCatId(b, meta.norad >>> 0);
    if (Number.isFinite(num(fit.ELEMENT_SET_NO))) OMM.addElementSetNo(b, num(fit.ELEMENT_SET_NO) >>> 0);
    if (Number.isFinite(num(fit.REV_AT_EPOCH))) OMM.addRevAtEpoch(b, num(fit.REV_AT_EPOCH));
    OMM.addUserDefinedEpochTimestamp(b, epochUnixSeconds(fit.EPOCH ?? ""));
    if (designatorOff) OMM.addUserDefinedObjectDesignator(b, designatorOff);
    const off = OMM.endOMM(b);
    OMM.finishSizePrefixedOMMBuffer(b, off);
    return b.asUint8Array().slice();
  };

  // RFC4180-ish line splitter: honours double-quoted fields (Space-Track's GP
  // CSV quotes EVERY value, and COMMENT/TLE fields can contain commas), so a
  // naive split(",") both misaligns columns and leaves quotes on values
  // (parseInt('"44235"') -> NaN). CelesTrak's unquoted CSV parses identically.
  const splitCsvLine = (line) => {
    const out = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      if (q) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i += 1; } else q = false; }
        else cur += c;
      } else if (c === '"') { q = true; }
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };

  // ---------------- CELESTRAK SUPGP REPUBLISH LANES (App 2 A2.9) ------------
  // The 7 NON-INDEPENDENT tokens: fetch each sup-gp CSV ONCE through the host
  // relay UNDER THE CELESTRAK FETCH POLICY (sourced bash helpers: 3h same-key
  // ledger window, >=2.5s serial spacing, success recorded), convert every row
  // to an $OMM re-publication tagged per provider key, with the honest labels
  // mirrored from data-source/celestrak-supgp (NON-INDEPENDENT prose COMMENT +
  // CelesTrak's own RMS/DATA_SOURCE preserved). NO fit, NO RMS claim of ours.
  if (provider.kind === "republish") {
    const relayHost = args["relay-host"] ?? "root@celestrak.eth";
    const policySh = path.resolve(__dirname, "../../conjunction-assessment/scripts/lib/celestrak-fetch-policy.sh");
    const policyLedger = path.resolve(__dirname, "../../conjunction-assessment/tests/data/.celestrak-fetch-ledger");
    if (!fs.existsSync(policySh)) throw new Error(`fetch policy helpers missing: ${policySh}`);
    const tokenFilter = args.tokens ? new Set(args.tokens.split(",")) : null;

    const buildRepublishFrame = (row, laneKey, laneBatchId) => {
      const b = new flatbuffers.Builder(768);
      const num = (v) => Number.parseFloat(v);
      const comment = [
        "CelesTrak Supplemental GP (SupGP) OMM re-published by SDN — App 2 A2.9.",
        "NON-INDEPENDENT: these are CelesTrak-FITTED SGP4 mean elements, NOT an SDN OD solution and NOT the operator's raw ephemeris.",
        "data_source=CelesTrak SupGP; must never count as our OD; never outranks Space-Track GP in synthesis.",
        `SOURCE_NAME=${laneKey} CELESTRAK_DATA_SOURCE=${row.DATA_SOURCE ?? ""} CELESTRAK_RMS=${row.RMS ?? ""} BATCH_ID=${laneBatchId}`,
      ].join(" | ");
      // NO CREATION_DATE: it would vary per run and break the deterministic
      // batch's CID idempotency (retries must re-derive identical records).
      const nameOff = row.OBJECT_NAME ? b.createString(row.OBJECT_NAME) : 0;
      const objIdOff = row.OBJECT_ID ? b.createString(row.OBJECT_ID) : 0;
      const centerOff = b.createString("EARTH");
      const originatorOff = b.createString("CelesTrak");
      const commentOff = b.createString(comment);
      const epochOff = b.createString(row.EPOCH ?? "");
      const classOff = row.CLASSIFICATION_TYPE ? b.createString(String(row.CLASSIFICATION_TYPE)) : 0;
      OMM.startOMM(b);
      OMM.addOriginator(b, originatorOff);
      if (nameOff) OMM.addObjectName(b, nameOff);
      if (objIdOff) OMM.addObjectId(b, objIdOff);
      OMM.addCenterName(b, centerOff);
      OMM.addComment(b, commentOff);
      OMM.addEpoch(b, epochOff);
      OMM.addMeanMotion(b, num(row.MEAN_MOTION));
      OMM.addEccentricity(b, num(row.ECCENTRICITY));
      OMM.addInclination(b, num(row.INCLINATION));
      OMM.addRaOfAscNode(b, num(row.RA_OF_ASC_NODE));
      OMM.addArgOfPericenter(b, num(row.ARG_OF_PERICENTER));
      OMM.addMeanAnomaly(b, num(row.MEAN_ANOMALY));
      if (Number.isFinite(num(row.MEAN_MOTION_DOT))) OMM.addMeanMotionDot(b, num(row.MEAN_MOTION_DOT));
      if (Number.isFinite(num(row.MEAN_MOTION_DDOT))) OMM.addMeanMotionDdot(b, num(row.MEAN_MOTION_DDOT));
      if (Number.isFinite(num(row.BSTAR))) OMM.addBstar(b, num(row.BSTAR));
      if (Number.isFinite(num(row.EPHEMERIS_TYPE))) OMM.addEphemerisType(b, num(row.EPHEMERIS_TYPE));
      if (classOff) OMM.addClassificationType(b, classOff);
      OMM.addNoradCatId(b, (Number.parseInt(row.NORAD_CAT_ID, 10) || 0) >>> 0);
      if (Number.isFinite(num(row.ELEMENT_SET_NO))) OMM.addElementSetNo(b, num(row.ELEMENT_SET_NO) >>> 0);
      if (Number.isFinite(num(row.REV_AT_EPOCH))) OMM.addRevAtEpoch(b, num(row.REV_AT_EPOCH));
      OMM.addUserDefinedEpochTimestamp(b, epochUnixSeconds(row.EPOCH ?? ""));
      const off = OMM.endOMM(b);
      OMM.finishSizePrefixedOMMBuffer(b, off);
      return b.asUint8Array().slice();
    };

    const lanes = [];
    for (const { token, key } of provider.tokens) {
      if (tokenFilter && !tokenFilter.has(key) && !tokenFilter.has(token)) continue;
      const lane = {
        token, key,
        batchId: null, // deterministic: sha256(key + sha256(csv bytes)) once the CSV is known
        csvPath: path.join(filesDir, `celestrak_supgp_${token}.csv`),
        fetch: "pending", rows: 0, published: 0, posts: 0, errors: [],
      };
      // Policy-gated single fetch through the relay. bash sources the SAME
      // policy helpers the conjunction workers use; exit 3 = inside the 3h
      // window (reuse cache, never refetch); policy_sleep enforces >=2.5s
      // between successive queries; policy_record only on verified success.
      const url = `https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=${token}&FORMAT=CSV`;
      const script = [
        "set -e",
        `source "${policySh}"`,
        `policy_init "${policyLedger}"`,
        `KEY="sup-gp.php?SOURCE=${token}&FORMAT=CSV"`,
        `if ! policy_allowed "$KEY"; then echo POLICY_SKIP; exit 3; fi`,
        `ssh -o BatchMode=yes -o ConnectTimeout=15 ${relayHost} "curl -sS -m 60 '${url}'" > "${lane.csvPath}.tmp"`,
        `head -1 "${lane.csvPath}.tmp" | grep -q NORAD_CAT_ID`,
        `mv "${lane.csvPath}.tmp" "${lane.csvPath}"`,
        `policy_record "$KEY"`,
        "echo FETCH_OK",
        "policy_sleep",
      ].join("\n");
      try {
        const { stdout } = await pExecFile("bash", ["-c", script], { timeout: 120000 });
        lane.fetch = stdout.includes("FETCH_OK") ? "fetched" : "unknown";
      } catch (e) {
        if (e?.code === 3) {
          lane.fetch = fs.existsSync(lane.csvPath) ? "policy-window-cache" : "policy-window-no-cache";
        } else {
          lane.fetch = `failed: ${String(e?.message ?? e).slice(0, 120)}`;
        }
      }
      lanes.push(lane);
    }

    for (const lane of lanes) {
      if (!fs.existsSync(lane.csvPath)) {
        console.log(`[lane ${lane.key}] no CSV (${lane.fetch}) — skipped honestly`);
        continue;
      }
      // Deterministic batch id = sha256(key + sha256(csv bytes)) — mirrors the
      // fit-pipeline's input-set fingerprint: re-running over the SAME captured
      // CSV re-derives the identical batch (and identical record CIDs), so a
      // retry after publish timeouts is idempotent, never a duplicate lane.
      const csvBytes = fs.readFileSync(lane.csvPath);
      lane.batchId = crypto.createHash("sha256")
        .update(lane.key)
        .update(crypto.createHash("sha256").update(csvBytes).digest("hex"))
        .digest("hex");
      const lines = csvBytes.toString("utf8").split(/\r?\n/).filter((l) => l.trim());
      const header = splitCsvLine(lines[0]);
      const rows = lines.slice(1).map((l) => {
        const f = splitCsvLine(l);
        return Object.fromEntries(header.map((h, i) => [h, f[i]]));
      }).filter((r) => Number.parseFloat(r.MEAN_MOTION));
      lane.rows = rows.length;
      if (!doPublish) continue;
      const laneQuery =
        `?source_name=${encodeURIComponent(lane.key)}` +
        `&provider_id=${encodeURIComponent(lane.key)}` +
        `&batch_id=${encodeURIComponent(lane.batchId)}` +
        `&source_url=${encodeURIComponent(`https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?SOURCE=${lane.token}&FORMAT=CSV`)}`;
      for (let i = 0; i < rows.length; i += publishBatch) {
        const frames = rows.slice(i, i + publishBatch).map((r) => buildRepublishFrame(r, lane.key, lane.batchId));
        const total = frames.reduce((s, f) => s + f.length, 0);
        const body = Buffer.allocUnsafe(total);
        let off = 0;
        for (const f of frames) { body.set(f, off); off += f.length; }
        try {
          const res = await fetch(`${publishUrl}/api/v1/data/publish/batch/OMM.fbs${laneQuery}`, {
            method: "POST",
            headers: { "content-type": "application/x-flatbuffers" },
            body,
            signal: AbortSignal.timeout(publishTimeoutMs),
          });
          if (!res.ok) { lane.errors.push(`batch ${res.status}`); continue; }
          const json = await res.json().catch(() => ({}));
          lane.published += (json.results ?? []).filter((r) => r && r.cid).length;
          lane.posts += 1;
        } catch (e) {
          lane.errors.push(`post: ${String(e?.message ?? e).slice(0, 80)}`);
        }
      }
      console.log(`[lane ${lane.key}] fetch=${lane.fetch} rows=${lane.rows} published=${lane.published} batch=${lane.batchId.slice(0, 12)}…`);
    }

    const report = {
      provider: providerName, startedAt, finishedAt: new Date().toISOString(),
      republish: true,
      note: "NON-INDEPENDENT CelesTrak-fitted OMMs re-published per provider key — no SDN OD, no RMS claim of ours.",
      lanes: lanes.map(({ token, key, batchId: bid, fetch: f, rows, published, posts, errors }) =>
        ({ token, key, batchId: bid, fetch: f, rows, published, posts, errors: errors.slice(0, 5) })),
    };
    fs.writeFileSync(path.join(workdir, providerName, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  // ---- async channel: producer/consumer with backpressure-free handoff -----
  class Channel {
    constructor() { this.items = []; this.waiters = []; this.closed = false; }
    push(x) {
      if (this.closed) return;
      const w = this.waiters.shift();
      if (w) w(x); else this.items.push(x);
    }
    close() { this.closed = true; let w; while ((w = this.waiters.shift())) w(null); }
    pull() {
      if (this.items.length) return Promise.resolve(this.items.shift());
      if (this.closed) return Promise.resolve(null);
      return new Promise((res) => this.waiters.push(res));
    }
    get size() { return this.items.length; }
  }
  const fitChannel = new Channel();
  const publishChannel = new Channel();

  // ------------------------------- targets ---------------------------------
  // Manifest fetch-ledger (owner caching ruling 2026-07-14): don't refetch the
  // provider MANIFEST if the last completed fetch is <3h old — reuse the cached
  // copy. Per-file bytes are already cached by the skip-if-exists resume below.
  const MANIFEST_TTL_MS = Number.parseInt(args["manifest-ttl-ms"] ?? String(3 * 3600 * 1000), 10);
  const ledgerPath = path.join(workdir, providerName, "manifest-ledger.json");
  const manifestCachePath = path.join(workdir, providerName, "manifest.txt");
  let manifest;
  let manifestCached = false;
  const preparedMeta = new Map(); // file -> {norad, objectName, objectId} from prepare()
  {
    const t0 = performance.now();
    if (provider.kind === "prepare") {
      // Custom discover+convert lanes (glonass/cpf/intelsat): the preparer
      // fetches the live upstream, converts to position-only KVN OEM files in
      // filesDir (values verbatim, frames/time as declared), and returns real
      // per-object identity where the SOURCE carries it (never fabricated).
      const cacheDir = path.join(workdir, providerName, "upstream");
      fs.mkdirSync(cacheDir, { recursive: true });
      const prepared = await PREPARERS[provider.prepare](filesDir, cacheDir, {
        targets: (args["cpf-targets"] ?? "lageos1,lageos2").split(",").map((t) => t.trim()).filter(Boolean),
        arcHours: Number.parseInt(args["arc-hours"] ?? "24", 10),
        limit: Number.isFinite(limit) ? limit : Infinity,
        fetchConcurrency: 4,
      });
      manifest = prepared.files;
      for (const [k, v] of prepared.meta) preparedMeta.set(k, v);
      console.log(`[prepare ${provider.prepare}] ${prepared.note}`);
    } else if (provider.kind === "single") {
      manifest = [provider.fileName];
    } else {
      try {
        const led = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
        const age = Date.now() - Date.parse(led.fetchedAt);
        if (led.fetchedAt && Number.isFinite(age) && age < MANIFEST_TTL_MS && fs.existsSync(manifestCachePath)) {
          manifest = fs.readFileSync(manifestCachePath, "utf8").split(/\r?\n/).filter((l) => l.trim());
          manifestCached = true;
        }
      } catch { /* no/invalid ledger -> fetch */ }
      if (!manifestCached) {
        const res = await fetch(provider.manifestUrl);
        if (!res.ok) throw new Error(`manifest fetch ${res.status}`);
        const text = await res.text();
        manifest = text.split(/\r?\n/).filter((l) => l.trim());
        fs.writeFileSync(manifestCachePath, text);
        fs.writeFileSync(ledgerPath, JSON.stringify({ fetchedAt: new Date().toISOString(), files: manifest.length }));
      }
    }
    metrics.stages.manifest = {
      wallClockSeconds: +((performance.now() - t0) / 1000).toFixed(2),
      files: manifest.length, cached: manifestCached,
    };
    console.log(`[stage manifest] ${metrics.stages.manifest.wallClockSeconds}s files=${manifest.length} cached=${manifestCached}`);
  }
  const targets = manifest.slice(0, limit);

  // -------------------------- shared counters ------------------------------
  let downloaded = 0;
  let reused = 0;
  let downloadBytes = 0;
  const failed = [];
  const results = [];
  const skips = [];
  let fitFirstAt = 0;
  let fitLastAt = 0;
  let published = 0;
  let publishPosts = 0;
  let publishFirstAt = 0;
  let publishLastAt = 0;
  const publishErrors = [];

  // ------------------------------ DOWNLOAD ---------------------------------
  const downloadStart = performance.now();
  let downloadWall = 0;
  const runDownload = (async () => {
    const queue = [...targets];
    async function worker() {
      for (;;) {
        const name = queue.shift();
        if (!name) return;
        const dest = path.join(filesDir, name);
        try {
          const stat = fs.statSync(dest, { throwIfNoEntry: false });
          if (stat && stat.size > 0) {
            reused += 1;
            fitChannel.push(name); // reused files feed the fitters immediately
            continue;
          }
          if (!provider.fileUrl) throw new Error("prepared file missing on disk (no re-fetch URL)");
          const res = await fetch(provider.fileUrl(name));
          if (!res.ok) throw new Error(`http ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          fs.writeFileSync(dest, buf);
          downloadBytes += buf.length;
          downloaded += 1;
          fitChannel.push(name);
        } catch (error) {
          failed.push({ name, reason: String(error?.message ?? error).slice(0, 200) });
        }
      }
    }
    await Promise.all(Array.from({ length: downloadConcurrency }, worker));
    downloadWall = (performance.now() - downloadStart) / 1000;
    fitChannel.close(); // no more files will arrive
  })();

  // -------------------------------- FIT ------------------------------------
  // Identity: prepared lanes carry per-object identity from the SOURCE (CPF H2
  // NORAD, owner-assist registry for IS-21) via preparedMeta; filename parsers
  // are the fallback for manifest/single lanes. Never fabricated.
  const meta = (file) => {
    const prep = preparedMeta.get(file);
    if (prep) return { ...prep, source: provider.source };
    return {
      norad: provider.noradFromFilename(file),
      objectName: provider.objectNameFromFilename(file),
      objectId: provider.objectIdFromFilename(file),
      source: provider.source,
    };
  };
  const runFit = (async () => {
    const workers = Array.from({ length: fitWorkers }, () =>
      new Worker(__filename, { workerData: { inputFormat: provider.inputFormat, dataSource: provider.dataSource } }));
    const state = new Map(); // worker -> { ready:Promise, readyResolve, pending:resolver|null }
    for (const w of workers) {
      const st = { pending: null };
      st.ready = new Promise((res) => { st.readyResolve = res; });
      state.set(w, st);
      w.on("message", (msg) => {
        const s = state.get(w);
        if (msg.kind === "ready") { s.readyResolve(); return; }
        if (msg.kind === "fatal") { console.error("fit worker fatal:", msg.error); s.readyResolve(); return; }
        const p = s.pending; s.pending = null; if (p) p(msg);
      });
      w.on("error", (e) => console.error("fit worker error:", e));
    }
    const dispatch = (w, file, filePath) => new Promise((res) => {
      state.get(w).pending = res;
      if (!fitFirstAt) fitFirstAt = performance.now();
      w.postMessage({ file, filePath });
    });
    const drive = async (w) => {
      await state.get(w).ready;
      for (;;) {
        const file = await fitChannel.pull();
        if (file === null) { w.postMessage({ kind: "close" }); return; }
        const msg = await dispatch(w, file, path.join(filesDir, file));
        fitLastAt = performance.now();
        if (msg.kind === "fit") {
          results.push(msg);
          if (doPublish) publishChannel.push({ fit: msg.fit, meta: meta(msg.file) });
        } else {
          skips.push(msg);
        }
      }
    };
    await Promise.all(workers.map(drive));
    publishChannel.close();
  })();

  // ------------------------------ PUBLISH ----------------------------------
  const runPublish = (async () => {
    if (!doPublish) { publishChannel.close(); return; }
    // postBatch NEVER throws: a hung/failed POST is bounded by a request
    // timeout and retried once (a fresh connection recovers a keep-alive
    // socket the server dropped under load), then recorded as an error so one
    // bad batch can't stall the whole publish stage.
    const postBatch = async (frames) => {
      const total = frames.reduce((s, f) => s + f.length, 0);
      const body = Buffer.allocUnsafe(total);
      let off = 0;
      for (const f of frames) { body.set(f, off); off += f.length; }
      // Schema segment MUST be the full schema name "OMM.fbs" — the server
      // validator rejects the short "OMM" ("unknown schema: OMM").
      const url = `${publishUrl}/api/v1/data/publish/batch/OMM.fbs${publishQuery}`;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/x-flatbuffers",
              // Forward provenance as headers too (belt + suspenders for a
              // tag-aware handler that reads headers rather than query params).
              "x-sdn-source-name": registryKey,
              "x-sdn-provider-id": registryKey,
              "x-sdn-batch-id": batchId,
            },
            body,
            signal: AbortSignal.timeout(publishTimeoutMs),
          });
          if (!res.ok) {
            if (publishErrors.length < 10) publishErrors.push(`batch ${res.status}: ${(await res.text()).slice(0, 120)}`);
            return;
          }
          const json = await res.json().catch(() => ({}));
          const rows = Array.isArray(json.results) ? json.results : [];
          published += rows.filter((r) => r && r.cid).length;
          // Batch returns HTTP 201 even when individual records fail — surface
          // the first per-record error so the run is honest about them.
          const firstErr = rows.find((r) => r && r.error);
          if (firstErr && publishErrors.length < 10) publishErrors.push(`record: ${String(firstErr.error).slice(0, 120)}`);
          if (!publishFirstAt) publishFirstAt = performance.now();
          publishLastAt = performance.now();
          publishPosts += 1;
          return;
        } catch (e) {
          if (attempt === 1 && publishErrors.length < 10) publishErrors.push(`post: ${String(e?.message ?? e).slice(0, 120)}`);
        }
      }
    };
    async function publisher() {
      let frames = [];
      for (;;) {
        const item = await publishChannel.pull();
        if (item === null) break;
        try { frames.push(buildOmmFrame(item.fit, item.meta)); }
        catch (e) { if (publishErrors.length < 10) publishErrors.push(`build: ${String(e?.message ?? e).slice(0, 120)}`); continue; }
        if (frames.length >= publishBatch) { await postBatch(frames); frames = []; }
      }
      if (frames.length) await postBatch(frames);
    }
    await Promise.all(Array.from({ length: publishConcurrency }, publisher));
  })();

  // --------------------------- progress heartbeat --------------------------
  let lastBytes = 0;
  let lastTick = performance.now();
  // Poll the SAME anonymous surface the App 2 board reads: GET /api/v1/stats.
  // Returns [total OMM records on node, this-batch sources[] count]. The batch
  // count stays 0 until the publish handler persists SourceTags (see gap note).
  const pollNodeStats = async () => {
    try {
      const res = await fetch(`${publishUrl}/api/v1/stats`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      const j = await res.json();
      const schemaRow = (j.schemas || []).find((s) => (s.schema_name || s.schemaName) === "OMM.fbs");
      const totalOmm = schemaRow ? schemaRow.count : (j.total_records ?? null);
      const srcRow = (j.sources || []).find(
        (s) => s.batch_id === batchId && (s.schema === "OMM.fbs" || s.schema === "OMM"),
      );
      return { totalOmm, batchCount: srcRow ? srcRow.count : 0 };
    } catch { return null; }
  };
  const heartbeat = setInterval(async () => {
    const now = performance.now();
    const dt = (now - lastTick) / 1000;
    const mbps = ((downloadBytes - lastBytes) / 1e6) / Math.max(0.001, dt);
    lastBytes = downloadBytes; lastTick = now;
    const stats = doPublish ? await pollNodeStats() : null;
    const done = ((now - pipelineStart) / 1000).toFixed(0);
    const nodeStr = stats
      ? ` | node OMM ${stats.totalOmm} | stats.sources[batch] ${stats.batchCount}`
      : "";
    console.log(
      `[+${done}s] dl ${mbps.toFixed(1)} MB/s (rolling) | got ${downloaded} reuse ${reused} fail ${failed.length} ` +
      `| fitQ ${fitChannel.size} fitted ${results.length} skip ${skips.length} ` +
      `| pubQ ${publishChannel.size} published ${published}${nodeStr}`,
    );
  }, 5000);

  // -------------------------------- await ----------------------------------
  await runDownload;
  await runFit;
  await runPublish;
  clearInterval(heartbeat);

  const fitWall = fitFirstAt ? (fitLastAt - fitFirstAt) / 1000 : 0;
  const publishWall = publishFirstAt ? (publishLastAt - publishFirstAt) / 1000 : 0;
  const totalWall = (performance.now() - pipelineStart) / 1000;

  metrics.stages.download = {
    wallClockSeconds: +downloadWall.toFixed(2),
    downloaded, reusedFromDisk: reused, failed: failed.length,
    megabytes: +(downloadBytes / 1e6).toFixed(1),
    mbPerSecond: +((downloadBytes / 1e6) / Math.max(0.001, downloadWall)).toFixed(1),
    concurrency: downloadConcurrency,
  };
  metrics.stages.fit = {
    wallClockSeconds: +fitWall.toFixed(2),
    fitted: results.length, skipped: skips.length, workers: fitWorkers,
    satsPerSecond: +(results.length / Math.max(0.001, fitWall)).toFixed(1),
    meanFitMs: +(results.reduce((s, r) => s + r.ms, 0) / Math.max(1, results.length)).toFixed(1),
  };
  if (doPublish) {
    metrics.stages.publish = {
      wallClockSeconds: +publishWall.toFixed(2),
      published, posts: publishPosts, batchSize: publishBatch, concurrency: publishConcurrency,
      recordsPerSecond: +(published / Math.max(0.001, publishWall)).toFixed(1),
      errors: publishErrors.slice(0, 10), publishUrl,
    };
  }
  metrics.stages.total = { wallClockSeconds: +totalWall.toFixed(2), overlapped: true };
  for (const [name, s] of Object.entries(metrics.stages)) {
    if (name === "manifest") continue;
    console.log(`[stage ${name}] ${s.wallClockSeconds}s ${JSON.stringify(s)}`);
  }

  // ----------------- COMPARE vs CelesTrak SupGP + Space-Track --------------
  const t0 = performance.now();
  const parseCsv = (p) => {
    if (!p) return new Map();
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim());
    const header = splitCsvLine(lines[0]);
    const col = (n) => header.indexOf(n);
    const rows = new Map();
    for (const line of lines.slice(1)) {
      const f = splitCsvLine(line);
      const norad = Number.parseInt(f[col("NORAD_CAT_ID")], 10);
      if (!Number.isFinite(norad)) continue;
      rows.set(norad, {
        epoch: f[col("EPOCH")],
        meanMotion: Number.parseFloat(f[col("MEAN_MOTION")]),
        eccentricity: Number.parseFloat(f[col("ECCENTRICITY")]),
        inclination: Number.parseFloat(f[col("INCLINATION")]),
        raan: Number.parseFloat(f[col("RA_OF_ASC_NODE")]),
        rms: col("RMS") >= 0 ? Number.parseFloat(f[col("RMS")]) : NaN,
      });
    }
    return rows;
  };
  const celestrak = parseCsv(args["celestrak-csv"]);
  const spacetrack = parseCsv(args["spacetrack-csv"]);
  // Parse an epoch to ms, appending the Z only when absent (the module's fit
  // EPOCH already carries a trailing Z; Space-Track's does not).
  const epochMs = (e) => (e ? Date.parse(String(e).endsWith("Z") ? String(e) : `${e}Z`) : NaN);
  let beat = 0, comparedCt = 0, comparedSt = 0;
  const perSat = results.map((r) => {
    const m = meta(r.file);
    const norad = m.norad;
    const ours = Number.parseFloat(r.fit.RMS);
    const ct = celestrak.get(norad);
    const st = spacetrack.get(norad);
    if (ct && Number.isFinite(ct.rms)) { comparedCt += 1; if (ours < ct.rms) beat += 1; }
    if (st) comparedSt += 1;
    return {
      norad, object: m.objectName,
      ourRms: ours, ourEpoch: r.fit.EPOCH,
      celestrakRms: ct?.rms ?? null,
      beatCelestrak: ct && Number.isFinite(ct.rms) ? ours < ct.rms : null,
      spacetrack: st ? {
        epoch: st.epoch,
        deltaMeanMotion: +(Number.parseFloat(r.fit.MEAN_MOTION) - st.meanMotion).toFixed(6),
        deltaEccentricity: +(Number.parseFloat(r.fit.ECCENTRICITY) - st.eccentricity).toFixed(7),
        deltaInclinationDeg: +(Number.parseFloat(r.fit.INCLINATION) - st.inclination).toFixed(4),
        epochAgeHours: +((epochMs(r.fit.EPOCH) - epochMs(st.epoch)) / 3.6e6).toFixed(1),
      } : null,
    };
  });
  metrics.stages.compare = {
    wallClockSeconds: +((performance.now() - t0) / 1000).toFixed(2),
    celestrakMatched: comparedCt, beatCelestrak: beat,
    beatRate: comparedCt ? +(beat / comparedCt).toFixed(4) : null,
    spacetrackMatched: comparedSt,
  };
  console.log(`[stage compare] ${metrics.stages.compare.wallClockSeconds}s ${JSON.stringify(metrics.stages.compare)}`);

  // -------------------------------- REPORT ---------------------------------
  metrics.finishedAt = new Date().toISOString();
  metrics.totals = {
    manifestFiles: manifest.length, fitted: results.length, skipped: skips.length,
    published: doPublish ? published : null, beatCelestrak: `${beat}/${comparedCt}`,
  };
  const rmsSorted = perSat.map((s) => s.ourRms).filter(Number.isFinite).sort((a, b) => a - b);
  const pct = (p) => rmsSorted[Math.min(rmsSorted.length - 1, Math.floor((p / 100) * rmsSorted.length))];
  metrics.rmsKm = rmsSorted.length
    ? { p50: +pct(50).toFixed(3), p90: +pct(90).toFixed(3), p99: +pct(99).toFixed(3), max: +rmsSorted.at(-1).toFixed(3) }
    : null;
  const outDir = path.join(workdir, providerName);
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify({ metrics, skips: skips.slice(0, 200) }, null, 2)}\n`);
  fs.writeFileSync(
    path.join(outDir, "per-sat.csv"),
    ["NORAD,OBJECT,OUR_RMS_KM,CELESTRAK_RMS_KM,BEAT,ST_DELTA_MM,ST_EPOCH_AGE_H"]
      .concat(perSat.map((s) =>
        [s.norad, s.object, s.ourRms, s.celestrakRms ?? "", s.beatCelestrak ?? "",
          s.spacetrack?.deltaMeanMotion ?? "", s.spacetrack?.epochAgeHours ?? ""].join(",")))
      .join("\n") + "\n",
  );
  fs.writeFileSync(path.join(outDir, "per-sat.json"), `${JSON.stringify(perSat)}\n`);
  console.log(JSON.stringify(metrics, null, 2));
}
