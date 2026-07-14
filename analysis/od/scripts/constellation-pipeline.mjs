// Constellation pipeline (loop packet P1.1): download a provider's FULL
// public ephemeris set, fit every object with the OD module in a parallel
// worker pool, compare each fitted OMM against (a) the same-day CelesTrak
// SupGP RMS and (b) Space-Track GP elements, and emit a per-stage timed
// report. Standards-honest: fits come from the real module .wasm via the
// same isomorphic harness the SDN nodes use; skips use the A2.3 taxonomy.
//
// Network scope: ONLY the provider's public ephemeris service is fetched
// here (bounded concurrency, resumable). CelesTrak + Space-Track inputs are
// pre-captured CSV paths (their fetch policies live with the capture step).
//
//   node scripts/constellation-pipeline.mjs \
//     --provider starlink --workdir <dir> \
//     --celestrak-csv <sup-gp.csv> [--spacetrack-csv <gp.csv>] \
//     [--download-concurrency 16] [--fit-workers 20] [--limit N]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WASM_PATH = new URL("../dist/isomorphic/module.wasm", import.meta.url);

const PROVIDERS = {
  starlink: {
    source: "SpaceX-E",
    manifestUrl: "https://api.starlink.com/public-files/ephemerides/MANIFEST.txt",
    fileUrl: (name) => `https://api.starlink.com/public-files/ephemerides/${name}`,
    inputFormat: "meme",
    noradFromFilename: (name) => Number.parseInt(name.split("_")[1], 10),
    objectFromFilename: (name) => name.split("_")[2] ?? "",
  },
};

// ---------------------------------------------------------------- worker
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
          {
            portId: "options",
            payload: new TextEncoder().encode(JSON.stringify({ inputFormat, dataSource })),
          },
        ],
      });
      const bytes = assertSuccessfulResponse(response, { outputPortId: "result" });
      const fit = JSON.parse(new TextDecoder().decode(bytes));
      parentPort.postMessage({
        kind: "fit",
        file: msg.file,
        ms: performance.now() - started,
        fit: {
          RMS: fit.RMS,
          EPOCH: fit.EPOCH,
          MEAN_MOTION: fit.MEAN_MOTION,
          ECCENTRICITY: fit.ECCENTRICITY,
          INCLINATION: fit.INCLINATION,
          RA_OF_ASC_NODE: fit.RA_OF_ASC_NODE,
          ARG_OF_PERICENTER: fit.ARG_OF_PERICENTER,
          MEAN_ANOMALY: fit.MEAN_ANOMALY,
          BSTAR: fit.BSTAR,
          CONVERGED: fit.CONVERGED ?? fit.USER_DEFINED_CONVERGED,
        },
      });
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

// ------------------------------------------------------------------ main
if (isMainThread) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean),
  );
  const provider = PROVIDERS[args.provider ?? "starlink"];
  if (!provider) throw new Error(`unknown provider ${args.provider}`);
  const workdir = path.resolve(args.workdir ?? path.join(os.tmpdir(), "constellation-pipeline"));
  const filesDir = path.join(workdir, args.provider ?? "starlink", "files");
  fs.mkdirSync(filesDir, { recursive: true });
  const downloadConcurrency = Number.parseInt(args["download-concurrency"] ?? "16", 10);
  const fitWorkers = Number.parseInt(args["fit-workers"] ?? "20", 10);
  const limit = args.limit ? Number.parseInt(args.limit, 10) : Infinity;

  const metrics = { provider: args.provider ?? "starlink", startedAt: new Date().toISOString(), stages: {} };
  const stageStart = () => performance.now();
  const stageEnd = (name, t0, extra) => {
    metrics.stages[name] = { wallClockSeconds: +((performance.now() - t0) / 1000).toFixed(2), ...extra };
    console.log(`[stage ${name}] ${metrics.stages[name].wallClockSeconds}s ${JSON.stringify(extra)}`);
  };

  // -- Stage 1: MANIFEST + DOWNLOAD (resumable, bounded concurrency).
  let t0 = stageStart();
  const manifestRes = await fetch(provider.manifestUrl);
  if (!manifestRes.ok) throw new Error(`manifest fetch ${manifestRes.status}`);
  const manifest = (await manifestRes.text()).split(/\r?\n/).filter((l) => l.trim());
  stageEnd("manifest", t0, { files: manifest.length });

  const targets = manifest.slice(0, limit);
  t0 = stageStart();
  let downloaded = 0;
  let reused = 0;
  let downloadBytes = 0;
  let failed = [];
  {
    const queue = [...targets];
    async function downloadWorker() {
      for (;;) {
        const name = queue.shift();
        if (!name) return;
        const dest = path.join(filesDir, name);
        try {
          const stat = fs.statSync(dest, { throwIfNoEntry: false });
          if (stat && stat.size > 0) {
            reused += 1;
            continue;
          }
          const res = await fetch(provider.fileUrl(name));
          if (!res.ok) throw new Error(`http ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          fs.writeFileSync(dest, buf);
          downloadBytes += buf.length;
          downloaded += 1;
        } catch (error) {
          failed.push({ name, reason: String(error?.message ?? error).slice(0, 200) });
        }
      }
    }
    await Promise.all(Array.from({ length: downloadConcurrency }, downloadWorker));
  }
  stageEnd("download", t0, {
    downloaded,
    reusedFromDisk: reused,
    failed: failed.length,
    megabytes: +(downloadBytes / 1e6).toFixed(1),
    mbPerSecond: +((downloadBytes / 1e6) / Math.max(0.001, (performance.now() - t0) / 1000)).toFixed(1),
    concurrency: downloadConcurrency,
  });

  // -- Stage 2: FIT (worker pool, one wasm harness per worker).
  t0 = stageStart();
  const files = fs.readdirSync(filesDir).filter((f) => targets.includes(f));
  const results = [];
  const skips = [];
  await new Promise((resolve, reject) => {
    const queue = [...files];
    let inFlight = 0;
    let readyWorkers = 0;
    const workers = Array.from({ length: fitWorkers }, () =>
      new Worker(__filename, {
        workerData: { inputFormat: provider.inputFormat, dataSource: provider.source },
      }));
    const feed = (worker) => {
      const file = queue.shift();
      if (file) {
        inFlight += 1;
        worker.postMessage({ file, filePath: path.join(filesDir, file) });
      } else if (inFlight === 0 && readyWorkers === workers.length) {
        for (const w of workers) w.postMessage({ kind: "close" });
        resolve();
      }
    };
    for (const worker of workers) {
      worker.on("message", (msg) => {
        if (msg.kind === "ready") {
          readyWorkers += 1;
          feed(worker);
          return;
        }
        if (msg.kind === "fatal") {
          reject(new Error(msg.error));
          return;
        }
        inFlight -= 1;
        if (msg.kind === "fit") results.push(msg);
        else skips.push(msg);
        if ((results.length + skips.length) % 1000 === 0) {
          console.log(`  fit progress: ${results.length + skips.length}/${files.length}`);
        }
        feed(worker);
      });
      worker.on("error", reject);
    }
  });
  const fitSeconds = (performance.now() - t0) / 1000;
  stageEnd("fit", t0, {
    fitted: results.length,
    skipped: skips.length,
    workers: fitWorkers,
    satsPerSecond: +(results.length / Math.max(0.001, fitSeconds)).toFixed(1),
    meanFitMs: +(results.reduce((s, r) => s + r.ms, 0) / Math.max(1, results.length)).toFixed(1),
  });

  // -- Stage 3: COMPARE vs CelesTrak SupGP RMS + Space-Track GP elements.
  t0 = stageStart();
  const parseCsv = (p) => {
    if (!p) return new Map();
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim());
    const header = lines[0].split(",");
    const col = (n) => header.indexOf(n);
    const rows = new Map();
    for (const line of lines.slice(1)) {
      const f = line.split(",");
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
  let beat = 0;
  let comparedCt = 0;
  let comparedSt = 0;
  const perSat = results.map((r) => {
    const norad = provider.noradFromFilename(r.file);
    const ours = Number.parseFloat(r.fit.RMS);
    const ct = celestrak.get(norad);
    const st = spacetrack.get(norad);
    if (ct && Number.isFinite(ct.rms)) {
      comparedCt += 1;
      if (ours < ct.rms) beat += 1;
    }
    if (st) comparedSt += 1;
    return {
      norad,
      object: provider.objectFromFilename(r.file),
      ourRms: ours,
      ourEpoch: r.fit.EPOCH,
      celestrakRms: ct?.rms ?? null,
      beatCelestrak: ct && Number.isFinite(ct.rms) ? ours < ct.rms : null,
      spacetrack: st
        ? {
            epoch: st.epoch,
            deltaMeanMotion: +(Number.parseFloat(r.fit.MEAN_MOTION) - st.meanMotion).toFixed(6),
            deltaEccentricity: +(Number.parseFloat(r.fit.ECCENTRICITY) - st.eccentricity).toFixed(7),
            deltaInclinationDeg: +(Number.parseFloat(r.fit.INCLINATION) - st.inclination).toFixed(4),
            epochAgeHours: +((Date.parse(`${r.fit.EPOCH}Z`) - Date.parse(`${st.epoch}Z`)) / 3.6e6).toFixed(1),
          }
        : null,
    };
  });
  stageEnd("compare", t0, {
    celestrakMatched: comparedCt,
    beatCelestrak: beat,
    beatRate: comparedCt ? +(beat / comparedCt).toFixed(4) : null,
    spacetrackMatched: comparedSt,
  });

  // -- Stage 4: REPORT.
  metrics.finishedAt = new Date().toISOString();
  metrics.totals = {
    manifestFiles: manifest.length,
    fitted: results.length,
    skipped: skips.length,
    beatCelestrak: `${beat}/${comparedCt}`,
  };
  const rmsSorted = perSat.map((s) => s.ourRms).filter(Number.isFinite).sort((a, b) => a - b);
  const pct = (p) => rmsSorted[Math.min(rmsSorted.length - 1, Math.floor((p / 100) * rmsSorted.length))];
  metrics.rmsKm = rmsSorted.length
    ? { p50: +pct(50).toFixed(3), p90: +pct(90).toFixed(3), p99: +pct(99).toFixed(3), max: +rmsSorted.at(-1).toFixed(3) }
    : null;
  const outDir = path.join(workdir, metrics.provider);
  fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify({ metrics, skips }, null, 2)}\n`);
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
