// ONE E2E: resident WASM exports against the independent TEST-ONLY CSPICE /
// sunpy oracle. This file only loads bytes and transports arrays; all case
// geometry, reference calculations, and numerical comparisons are in Python.
// No browser process or network is used.
//
// SSB_PYTHON=<python with spiceypy and sunpy> SSB_KERNELS_DIR=<NAIF files>
//   node --test tests/body_coordinates.e2e.test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBrowserModuleHarness } from "space-data-module-sdk/host/browser-module";

const here = path.dirname(fileURLToPath(import.meta.url));
const kernelNames = [
  "naif0012.tls", "pck00011.tpc", "gm_de440.tpc", "moon_de440_250416.tf",
  "moon_pa_de440_200625.bpc", "de440s.bsp", "bennu_v17.tpc", "ryugu_v10.tpc",
];

test("body coordinate systems and surface grids match CSPICE and sunpy on the same kernels", { timeout: 180000 }, async () => {
  assert.ok(process.env.SSB_KERNELS_DIR, "SSB_KERNELS_DIR is required; this E2E never silently skips");
  const files = kernelNames.map((name) => path.join(process.env.SSB_KERNELS_DIR, name));
  for (const file of files) assert.ok(fs.existsSync(file), `required kernel missing: ${file}`);
  const scratch = fs.mkdtempSync(path.join(here, ".body-coordinate-oracle-"));
  for (const directory of ["sunpy", "downloads", "matplotlib", "config", "cache"]) {
    fs.mkdirSync(path.join(scratch, directory));
  }
  const oracle = spawn(process.env.SSB_PYTHON ?? "python3", ["-I", "-B", "-u", path.join(here, "body_coordinates_oracle.py")], {
    cwd: path.join(here, ".."), stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SUNPY_CONFIGDIR: path.join(scratch, "sunpy"),
      SUNPY_DOWNLOADDIR: path.join(scratch, "downloads"), MPLCONFIGDIR: path.join(scratch, "matplotlib"),
      XDG_CONFIG_HOME: path.join(scratch, "config"), XDG_CACHE_HOME: path.join(scratch, "cache") },
  });
  console.log(`E2E PID ${process.pid}; isolated oracle child PID ${oracle.pid}`);
  let stderr = "";
  oracle.stderr.setEncoding("utf8");
  oracle.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    oracle.once("error", reject);
    oracle.once("close", (code, signal) => resolve({ code, signal }));
  });
  const lines = readline.createInterface({ input: oracle.stdout })[Symbol.asyncIterator]();
  const readOracle = async () => {
    const line = await lines.next();
    assert.ok(!line.done, `oracle ended before replying: ${stderr}`);
    return JSON.parse(line.value);
  };
  let harness;
  try {
    oracle.stdin.write(`${JSON.stringify({ kernels: files })}\n`);
    const plan = await readOracle();
    assert.equal(plan.kind, "plan");
    harness = await createBrowserModuleHarness({
      wasmSource: fs.readFileSync(path.join(here, "..", "dist", "isomorphic", "module.wasm")),
      surface: "direct",
    });
    const x = harness.instance.exports;
    const mem = () => (harness.memory ?? x.memory).buffer;
    for (const name of ["ssb_body_coordinates", "ssb_body_surface_points", "ssb_body_coordinate_info"]) {
      assert.equal(typeof x[name], "function", `missing WASM export ${name}`);
    }
    const allocations = [];
    const alloc = (bytes) => {
      const ptr = x.plugin_alloc(bytes);
      assert.ok(ptr, `allocation failed: ${bytes} bytes`);
      allocations.push([ptr, bytes]);
      return ptr;
    };
    for (const file of files) {
      const bytes = fs.readFileSync(file);
      const ptr = x.plugin_alloc(bytes.length);
      assert.ok(ptr, `kernel allocation failed: ${path.basename(file)}`);
      let status;
      try {
        new Uint8Array(mem(), ptr, bytes.length).set(bytes);
        status = x.ssb_load_kernel(ptr, bytes.length);
      } finally {
        x.plugin_free(ptr, bytes.length);
      }
      assert.ok(status >= 0, `${path.basename(file)} refused by ssb_load_kernel (${status}); the full CSPICE oracle was not weakened`);
      console.log(`loaded ${path.basename(file)} (${bytes.length} bytes, status ${status})`);
    }
    const input = alloc(200 * 3 * 8), output = alloc(200 * 3 * 8), info = alloc(3 * 8);
    const idPtr = alloc(4), statusPtr = alloc(4), orientation = alloc(10 * 8);
    const responses = [];
    try {
      for (const batch of plan.batches) {
        new Float64Array(mem(), input, batch.xyz.length).set(batch.xyz);
        const coordinateStatus = x.ssb_body_coordinates(batch.id, batch.system, batch.et, input, batch.count, output);
        const coordinates = Array.from(new Float64Array(mem(), output, batch.count * 3));
        const coordinateAliasStatus = x.ssb_body_coordinates(batch.id, batch.system, batch.et, input, batch.count, input);
        const coordinateAlias = Array.from(new Float64Array(mem(), input, batch.count * 3));
        new Float64Array(mem(), input, batch.lonlat.length).set(batch.lonlat);
        const surfaceBatchStatus = x.ssb_body_surface_points(batch.id, batch.system, batch.et, input, batch.count, output);
        const surfaceBatch = Array.from(new Float64Array(mem(), output, batch.count * 2));
        const surfaceStatuses = [], surface = [], surfaceAliasStatuses = [], surfaceAlias = [];
        // A rejected intersection must not prevent the other requested points
        // from being measured. Each rejected point remains an oracle failure.
        for (let point = 0; point < batch.count; point += 1) {
          const values = batch.lonlat.slice(point * 2, point * 2 + 2);
          new Float64Array(mem(), input, 2).set(values);
          new Float64Array(mem(), output, 2).fill(0);
          surfaceStatuses.push(x.ssb_body_surface_points(batch.id, batch.system, batch.et, input, 1, output));
          surface.push(...new Float64Array(mem(), output, 2));
          const aliasStatus = x.ssb_body_surface_points(batch.id, batch.system, batch.et, input, 1, input);
          surfaceAliasStatuses.push(aliasStatus);
          surfaceAlias.push(...new Float64Array(mem(), input, 2));
        }
        const infoStatus = x.ssb_body_coordinate_info(batch.id, batch.system, batch.et, info);
        responses.push({ coordinateStatus, coordinates, surfaceStatuses, surface, infoStatus,
          coordinateAliasStatus, coordinateAlias, surfaceAliasStatuses, surfaceAlias, surfaceBatchStatus, surfaceBatch,
          info: Array.from(new Float64Array(mem(), info, 3)) });
      }
      const probes = plan.probes.map((probe) => {
        new Float64Array(mem(), input, 3).set(probe.xyz);
        const coordinateStatus = x.ssb_body_coordinates(probe.id, probe.system, probe.et, input, 1, output);
        const coordinates = Array.from(new Float64Array(mem(), output, 3));
        new Float64Array(mem(), input, 2).set(probe.lonlat);
        const surfaceStatus = x.ssb_body_surface_points(probe.id, probe.system, probe.et, input, 1, output);
        const infoStatus = x.ssb_body_coordinate_info(probe.id, probe.system, probe.et, info);
        return { coordinateStatus, coordinates, surfaceStatus, infoStatus,
          info: Array.from(new Float64Array(mem(), info, 3)) };
      });
      const rotations = plan.rotations.map((probe) => {
        new Int32Array(mem(), idPtr, 1)[0] = probe.id;
        const failed = x.ssb_orientations(probe.et, idPtr, 1, orientation, statusPtr);
        return { failed, status: new Int32Array(mem(), statusPtr, 1)[0],
          values: Array.from(new Float64Array(mem(), orientation, 10)) };
      });
      oracle.stdin.end(`${JSON.stringify({ responses, probes, rotations })}\n`);
      const report = await readOracle();
      for (const line of report.lines) console.log(line);
      const exit = await closed;
      assert.equal(exit.code, 0, `${report.failures.join("\n")}\n${stderr}`);
      assert.equal(report.failureCount, 0, report.failures.join("\n"));
    } finally {
      for (const [ptr, bytes] of allocations.reverse()) x.plugin_free(ptr, bytes);
    }
  } finally {
    await harness?.destroy();
    if (oracle.pid && oracle.exitCode === null && oracle.signalCode === null) {
      // Terminate only the exact child this test owns, including on assertion failure.
      process.kill(oracle.pid, "SIGKILL");
    }
    const exit = await closed;
    console.log(`oracle child PID ${oracle.pid} reaped (exit ${exit.code}, signal ${exit.signal ?? "none"})`);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
