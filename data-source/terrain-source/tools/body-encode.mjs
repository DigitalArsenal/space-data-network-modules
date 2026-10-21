// A BODY'S TERRAIN UNITS, ENCODED HERE FOR ANOTHER NODE TO PUBLISH (the import: data-source/terrain-ingest
// import_plan / import_files, flow-moon-import.mjs). Each unit runs exactly the frames the walk runs - terrain-ingest
// body_plan at the unit's index, terrain-source tile over the PDS byte ranges it asks for (answered from local copies of
// the products, lola-frames.mjs localResponse), terrain-source pack - with the run clock of this machine (the tick
// becomes every tile's RETRIEVED_AT), and writes the unit's files under OUT by their published names
// (terrain/301/<L>/<X>_<Y>.dtts.gz). The files are byte-identical to the walk's own for the same unit and clock.
//
//   node body-encode.mjs --data DIR --out DIR --config FILE.json --from N --to M [--workers K]
//
// --config is the walk's flow config (tileset_id, dataset_epoch, caps, ...; body defaults to moon). Units whose files
// all exist under OUT are skipped, so a stopped run resumes; files are written to a temporary name and renamed. With
// --workers K the units are split over K processes (unit i goes to worker (i - from) mod K).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { localResponse } from "../lola-frames.mjs";
import { TYPE, STANDARDS_ROOT, flatbuffers } from "../typed-frames.mjs";
import { decodeHttpRequest, irmRecord, jobIdOf, markFrames, outputs, tickFrame } from "../../terrain-ingest/tests/typed.mjs";
import { createBodyLane, splitSized, dttOf } from "./body-lane.mjs";

const PNM_LIB = await import(new URL(`file://${STANDARDS_ROOT}/lib/js/PNM/main.js`).href);
const BODY_DEFAULTS = { moon: { datasetId: "nasa-lola-gdr", provider: "nasa-lola" }, mars: { datasetId: "nasa-mola-megdr", provider: "nasa-mola" } };

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  return out;
}

const opt = args(process.argv.slice(2));
for (const key of ["data", "out", "config", "from", "to"]) if (opt[key] === undefined) throw new Error(`--${key} is required`);
const from = Number(opt.from), to = Number(opt.to), workers = Number(opt.workers ?? 1);

if (workers > 1 && opt.worker === undefined) {
  // The parent: K workers over the same range, each taking every K-th unit.
  const self = fileURLToPath(import.meta.url);
  const codes = await Promise.all(Array.from({ length: workers }, (_, k) => new Promise((resolve) => {
    const child = spawn(process.execPath, [self, ...process.argv.slice(2), "--worker", String(k)], { stdio: "inherit" });
    child.on("close", resolve);
  })));
  process.exit(codes.some((c) => c !== 0) ? 1 : 0);
}

const worker = Number(opt.worker ?? 0);
const config = JSON.parse(fs.readFileSync(opt.config, "utf8"));
const body = BODY_DEFAULTS[config.body ?? "moon"];
const lane = await createBodyLane({ dataDir: opt.data, config });
const jobId = jobIdOf(config.dataset_id ?? body.datasetId, config.tileset_id, config.dataset_epoch);

async function plan(index, clockIso) {
  const inputs = [tickFrame(clockIso)];
  if (index > 0) inputs.push(...markFrames([irmRecord({ jobId, next: index, provider: body.provider })]));
  const out = outputs(await lane.ingest.invoke({ methodId: "body_plan", inputs }));
  if (!out.has("plan")) return null;
  return {
    plan: out.get("plan")[0],
    options: out.get("options")[0],
    pack: out.get("pack")[0],
    requests: Array.from({ length: 16 }, (_, k) => out.get(`dem_${k}`)?.[0]).filter(Boolean).map(decodeHttpRequest),
  };
}

/** The unit's file names, by terrain-source:pack's rule, from its plan headers (to skip a unit already encoded). */
function plannedNames(planBytes, prefix) {
  const names = new Set();
  for (const sized of splitSized(planBytes)) {
    const t = dttOf(sized.subarray(4));
    names.add(t.LEVEL() <= 2 ? `${prefix}/root.dtts.gz` : `${prefix}/${t.LEVEL()}/${t.X() >> 2}_${t.Y() >> 2}.dtts.gz`);
  }
  return [...names];
}

const prefix = config.path_prefix ?? "terrain/301";
let encoded = 0, skipped = 0, bytes = 0;
const started = Date.now();
for (let index = from + worker; index < to; index += workers) {
  const unit = await plan(index, new Date().toISOString());
  if (!unit) break;
  if (plannedNames(unit.plan, prefix).every((name) => fs.existsSync(path.join(opt.out, name)))) {
    skipped++;
    continue;
  }
  const tile = await lane.source.invoke({ methodId: "tile", inputs: [
    { portId: "plan", typeRef: TYPE.DTT, payload: Uint8Array.from(unit.plan) },
    { portId: "options", typeRef: TYPE.MCFG, payload: unit.options },
    ...unit.requests.map((r) => localResponse(opt.data, r)),
  ] });
  if (tile.statusCode !== 0) throw new Error(`unit ${index}: tile ${tile.errorCode}: ${tile.errorMessage}`);
  const records = tile.outputs.find((o) => o.portId === "records").payload;
  const packed = await lane.source.invoke({ methodId: "pack", inputs: [
    { portId: "records", typeRef: TYPE.DTT, payload: Uint8Array.from(records) },
    { portId: "options", typeRef: TYPE.MCFG, payload: unit.pack },
  ] });
  if (packed.statusCode !== 0) throw new Error(`unit ${index}: pack ${packed.errorCode}: ${packed.errorMessage}`);
  const names = splitSized(packed.outputs.find((o) => o.portId === "names").payload)
    .map((sized) => PNM_LIB.PNM.getSizePrefixedRootAsPNM(new flatbuffers.ByteBuffer(Uint8Array.from(sized))).FILE_NAME());
  const files = packed.outputs.filter((o) => o.portId === "file");
  if (names.length !== files.length) throw new Error(`unit ${index}: pack named ${names.length} files and wrote ${files.length}`);
  for (let k = 0; k < files.length; k++) {
    const target = path.join(opt.out, names[k]);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.part`, files[k].payload);
    fs.renameSync(`${target}.part`, target);
    bytes += files[k].payload.length;
  }
  encoded++;
  if (encoded % 10 === 0) {
    const rate = encoded / ((Date.now() - started) / 1000);
    console.log(`[worker ${worker}] unit ${index}: ${encoded} encoded, ${skipped} skipped, ${(bytes / 1e6).toFixed(1)} MB, ${rate.toFixed(3)} units/s`);
  }
}
lane.destroy();
console.log(`[worker ${worker}] done: ${encoded} units encoded, ${skipped} skipped, ${(bytes / 1e6).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(0)} s`);
