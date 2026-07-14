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
//     --provider starlink --workdir <dir> \
//     --celestrak-csv <sup-gp.csv> [--spacetrack-csv <gp.csv>] \
//     [--download-concurrency 96] [--fit-workers 20] [--limit N] \
//     [--publish] [--publish-url http://127.0.0.1:15001] \
//     [--publish-batch 100] [--publish-concurrency 4] [--emit-ocm]
//
// OCM lane (owner directive 2026-07-14): with --emit-ocm, each fitted object
// also yields an SDS $OCM (Orbit Comprehensive Message) published alongside its
// $OMM. The OCM carries the fitted mean-element state, OD metadata, and a
// PERTURBATIONS block whose FIELD SELECTION follows the US Space Force VCM
// taxonomy (VCM used as a REFERENCE SPEC only — no VCM record is read or
// produced; all values are our own SGP4 fit-theory context, honest N/A where the
// theory does not define a field). See scripts/lib/ocm-record.mjs.
//
// Must be run with cwd = analysis/od (the isomorphic harness resolves the
// space-data-module-sdk from process.cwd()).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { loadOcmBindings, buildOcmFrame } from "./lib/ocm-record.mjs";

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
};

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
  const downloadConcurrency = Number.parseInt(args["download-concurrency"] ?? "256", 10);
  const fitWorkers = Number.parseInt(args["fit-workers"] ?? "20", 10);
  const limit = args.limit ? Number.parseInt(args.limit, 10) : Infinity;
  const doPublish = args.publish === "true" || args.publish === "" || args.publish === true;
  const publishUrl = (args["publish-url"] ?? "http://127.0.0.1:15001").replace(/\/$/, "");
  const publishBatch = Number.parseInt(args["publish-batch"] ?? "100", 10);
  const publishConcurrency = Number.parseInt(args["publish-concurrency"] ?? "4", 10);
  const publishTimeoutMs = Number.parseInt(args["publish-timeout-ms"] ?? "30000", 10);
  // OCM lane is opt-in so existing OMM-only runs are byte-for-byte unchanged.
  const emitOcm = args["emit-ocm"] === "true" || args["emit-ocm"] === "" || args["emit-ocm"] === true;

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
  const sourceUrl = provider.kind === "single" ? provider.fileUrl() : provider.manifestUrl;
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
  let ocmBindings = null;
  if (doPublish) {
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
    // OCM bindings share the same require anchors (same node_modules copy).
    if (emitOcm) ocmBindings = await loadOcmBindings(anchors);
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
  {
    const t0 = performance.now();
    if (provider.kind === "single") {
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
  // Per-schema publish tallies (OMM always; OCM only when --emit-ocm). Each: how
  // many records the node acked (cid), POST count, first/last POST wall clock,
  // and up to 10 sampled errors.
  const ommStats = { published: 0, posts: 0, firstAt: 0, lastAt: 0, errors: [] };
  const ocmStats = { published: 0, posts: 0, firstAt: 0, lastAt: 0, errors: [] };

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
  const meta = (file) => ({
    norad: provider.noradFromFilename(file),
    objectName: provider.objectNameFromFilename(file),
    objectId: provider.objectIdFromFilename(file),
    source: provider.source,
  });
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
    // bad batch can't stall the whole publish stage. Parameterised by schema +
    // its stats sink so the OMM and OCM lanes share one hardened poster.
    const postBatch = async (frames, schema, st) => {
      const total = frames.reduce((s, f) => s + f.length, 0);
      const body = Buffer.allocUnsafe(total);
      let off = 0;
      for (const f of frames) { body.set(f, off); off += f.length; }
      // Schema segment MUST be the full schema name ("OMM.fbs"/"OCM.fbs") — the
      // server validator rejects the short form ("unknown schema: OMM").
      const url = `${publishUrl}/api/v1/data/publish/batch/${schema}${publishQuery}`;
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
            if (st.errors.length < 10) st.errors.push(`batch ${res.status}: ${(await res.text()).slice(0, 120)}`);
            return;
          }
          const json = await res.json().catch(() => ({}));
          const rows = Array.isArray(json.results) ? json.results : [];
          st.published += rows.filter((r) => r && r.cid).length;
          // Batch returns HTTP 201 even when individual records fail — surface
          // the first per-record error so the run is honest about them.
          const firstErr = rows.find((r) => r && r.error);
          if (firstErr && st.errors.length < 10) st.errors.push(`record: ${String(firstErr.error).slice(0, 120)}`);
          if (!st.firstAt) st.firstAt = performance.now();
          st.lastAt = performance.now();
          st.posts += 1;
          return;
        } catch (e) {
          if (attempt === 1 && st.errors.length < 10) st.errors.push(`post: ${String(e?.message ?? e).slice(0, 120)}`);
        }
      }
    };
    async function publisher() {
      let ommFrames = [];
      let ocmFrames = [];
      const flush = async () => {
        if (ommFrames.length) { await postBatch(ommFrames, "OMM.fbs", ommStats); ommFrames = []; }
        if (ocmFrames.length) { await postBatch(ocmFrames, "OCM.fbs", ocmStats); ocmFrames = []; }
      };
      for (;;) {
        const item = await publishChannel.pull();
        if (item === null) break;
        try { ommFrames.push(buildOmmFrame(item.fit, item.meta)); }
        catch (e) { if (ommStats.errors.length < 10) ommStats.errors.push(`build: ${String(e?.message ?? e).slice(0, 120)}`); continue; }
        // OCM is 1:1 with OMM. An OCM build failure is isolated (recorded, OMM
        // still ships) so it can never regress the OMM lane or its gate.
        if (emitOcm) {
          try {
            ocmFrames.push(buildOcmFrame({ fit: item.fit, meta: item.meta, batchId, creationDate, sourceUrl, bindings: ocmBindings }));
          } catch (e) {
            if (ocmStats.errors.length < 10) ocmStats.errors.push(`build: ${String(e?.message ?? e).slice(0, 120)}`);
          }
        }
        if (ommFrames.length >= publishBatch) await flush();
      }
      await flush();
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
      // stats rows key the schema as `schema` ("OMM.fbs"/"OCM.fbs"); tolerate the
      // legacy schema_name/short-name forms too.
      const schemaCount = (name) => {
        const row = (j.schemas || []).find((s) => (s.schema || s.schema_name || s.schemaName) === name);
        return row ? row.count : null;
      };
      const batchCount = (name) => {
        const row = (j.sources || []).find(
          (s) => s.batch_id === batchId && (s.schema === name || s.schema === name.replace(".fbs", "")),
        );
        return row ? row.count : 0;
      };
      return {
        totalOmm: schemaCount("OMM.fbs") ?? (j.total_records ?? null),
        batchOmm: batchCount("OMM.fbs"),
        totalOcm: schemaCount("OCM.fbs"),
        batchOcm: batchCount("OCM.fbs"),
      };
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
      ? ` | node OMM ${stats.totalOmm} src[batch] ${stats.batchOmm}` +
        (emitOcm ? ` | node OCM ${stats.totalOcm ?? 0} src[batch] ${stats.batchOcm}` : "")
      : "";
    console.log(
      `[+${done}s] dl ${mbps.toFixed(1)} MB/s (rolling) | got ${downloaded} reuse ${reused} fail ${failed.length} ` +
      `| fitQ ${fitChannel.size} fitted ${results.length} skip ${skips.length} ` +
      `| pubQ ${publishChannel.size} pub OMM ${ommStats.published}${emitOcm ? ` OCM ${ocmStats.published}` : ""}${nodeStr}`,
    );
  }, 5000);

  // -------------------------------- await ----------------------------------
  await runDownload;
  await runFit;
  await runPublish;
  clearInterval(heartbeat);

  const fitWall = fitFirstAt ? (fitLastAt - fitFirstAt) / 1000 : 0;
  const publishWall = ommStats.firstAt ? (ommStats.lastAt - ommStats.firstAt) / 1000 : 0;
  const ocmWall = ocmStats.firstAt ? (ocmStats.lastAt - ocmStats.firstAt) / 1000 : 0;
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
      schema: "OMM.fbs",
      wallClockSeconds: +publishWall.toFixed(2),
      published: ommStats.published, posts: ommStats.posts, batchSize: publishBatch, concurrency: publishConcurrency,
      recordsPerSecond: +(ommStats.published / Math.max(0.001, publishWall)).toFixed(1),
      errors: ommStats.errors.slice(0, 10), publishUrl,
    };
    if (emitOcm) {
      metrics.stages.publishOcm = {
        schema: "OCM.fbs",
        wallClockSeconds: +ocmWall.toFixed(2),
        published: ocmStats.published, posts: ocmStats.posts, batchSize: publishBatch, concurrency: publishConcurrency,
        recordsPerSecond: +(ocmStats.published / Math.max(0.001, ocmWall)).toFixed(1),
        errors: ocmStats.errors.slice(0, 10), publishUrl,
      };
    }
  }
  metrics.stages.total = { wallClockSeconds: +totalWall.toFixed(2), overlapped: true };
  for (const [name, s] of Object.entries(metrics.stages)) {
    if (name === "manifest") continue;
    console.log(`[stage ${name}] ${s.wallClockSeconds}s ${JSON.stringify(s)}`);
  }

  // ----------------- COMPARE vs CelesTrak SupGP + Space-Track --------------
  const t0 = performance.now();
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
    const norad = provider.noradFromFilename(r.file);
    const ours = Number.parseFloat(r.fit.RMS);
    const ct = celestrak.get(norad);
    const st = spacetrack.get(norad);
    if (ct && Number.isFinite(ct.rms)) { comparedCt += 1; if (ours < ct.rms) beat += 1; }
    if (st) comparedSt += 1;
    return {
      norad, object: provider.objectFromFilename(r.file),
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
    published: doPublish ? ommStats.published : null,
    publishedOcm: doPublish && emitOcm ? ocmStats.published : null,
    beatCelestrak: `${beat}/${comparedCt}`,
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
