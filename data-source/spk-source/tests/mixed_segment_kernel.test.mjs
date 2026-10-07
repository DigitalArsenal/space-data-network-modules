// A kernel that MIXES segment types, through the SHIPPED ephemeris propagator,
// on every runtime: real headless Chrome, native WasmEdge and, when the Docker
// daemon is up, the pinned container WasmEdge.
//
// The regression this pins: `ephem::load_container` met a type-2 Chebyshev
// segment, which the SPK reader evaluates at explicit epochs but cannot
// materialise as state rows, and refused the WHOLE kernel with BAD_INPUT — so
// one coefficient segment hid every readable segment beside it. The propagator
// serves rows, so a Chebyshev segment is skipped exactly as an unknown segment
// type is, and a kernel with nothing readable is still refused, as
// UNSUPPORTED_FORMAT, never accepted empty.
//
// Known answers come from the official NAIF toolkit, not from this module:
// both kernels were WRITTEN by CSPICE N0067 and the reference state is CSPICE's
// own spkpvn on the readable segment (fixtures/make_mixed_kernels.py,
// fixtures/spk_mixed_reference.json).
//
// JS orchestrates and decodes only. Every number is computed inside the guest;
// each lane prints the 64 raw bytes of each OrbProStateVector as hex, and the
// lanes must agree byte for byte before any value is read.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { toLoadableWasmBytes } from "space-data-module-sdk/bundle";
import {
  EphemerisFormat,
  ErrorCode,
  ORBPRO_STATE_VECTOR,
  ReferenceFrame,
  StateFlags,
} from "space-data-module-sdk/generated/propagator-abi";
import {
  loadWasmEdgePin,
  resolveChromeBinary,
  resolveWasmEdgeRunnerBuildPlan,
} from "space-data-module-sdk/testing";

const execFile = promisify(execFileCallback);
const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");
const wasmPath = path.join(packageRoot, "dist", "isomorphic", "module.wasm");
const fixturesDir = path.join(packageRoot, "fixtures");
const hostSource = path.join(here, "wasmedge_abi_host.c");
const sdkWasiShim = path.join(packageRoot, "node_modules", "space-data-module-sdk", "src",
  "host", "wasiShim.js");

const POSITION_BOUND_M = 1e-6;
const VELOCITY_BOUND_M_S = 1e-6;

const MIXED = "spk_mixed_t2_t13.bsp";
const CHEBYSHEV_ONLY = "spk_chebyshev_only.bsp";
const reference = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, "spk_mixed_reference.json"), "utf8"),
);

function hexToDouble(hex) {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

// The same script on every lane, in this order. The last successful init is
// the one the propagate calls read.
const PROBE_JD_HEX = reference.probe.julian_date_hex;
const OPS = [
  `init:${CHEBYSHEV_ONLY}:${EphemerisFormat.AUTO}`,
  `init:${CHEBYSHEV_ONLY}:${EphemerisFormat.SPK_DAF}`,
  `init:${MIXED}:${EphemerisFormat.SPK_DAF}`,
  `init:${MIXED}:${EphemerisFormat.AUTO}`,
  `prop:${PROBE_JD_HEX}:0`,
  `prop:${PROBE_JD_HEX}:1`,
];

function dockerUp() {
  return execFile("docker", ["info"], { timeout: 30000 }).then(() => true, () => false);
}

async function nativeWasmEdgeLane(dir, guest) {
  const plan = resolveWasmEdgeRunnerBuildPlan({ outputPath: path.join(dir, "host") });
  const binary = path.join(dir, "wasmedge_abi_host");
  await execFile(process.env.CC ?? "cc", [
    hostSource, "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
    `-I${plan.wasmedgeIncludeDir}`, `-L${plan.wasmedgeLibDir}`, "-lwasmedge",
    `-Wl,-rpath,${plan.wasmedgeLibDir}`, "-o", binary,
  ]);
  const { stdout } = await execFile(binary, [guest, fixturesDir, ...OPS]);
  return stdout.trimEnd().split("\n");
}

async function dockerWasmEdgeLane(dir, guest) {
  const { dockerRunnerImage } = loadWasmEdgePin();
  // The pinned parity image carries the WasmEdge release library, its headers
  // and gcc. Compile and run in one network-less container; never pull/build.
  await execFile("docker", ["image", "inspect", dockerRunnerImage], { timeout: 30000 });
  const script =
    'gcc "$0" -std=c11 -O2 -Wall -Wextra -Werror -I/opt/wasmedge/include ' +
    "-L/opt/wasmedge/lib64 -L/opt/wasmedge/lib -lwasmedge " +
    "-Wl,-rpath,/opt/wasmedge/lib64 -Wl,-rpath,/opt/wasmedge/lib -o /tmp/wasmedge_abi_host " +
    '&& exec /tmp/wasmedge_abi_host "$@"';
  const { stdout } = await execFile("docker", [
    "run", "--rm", "--network", "none",
    "-v", `${here}:${here}:ro`, "-v", `${fixturesDir}:${fixturesDir}:ro`, "-v", `${dir}:${dir}:ro`,
    "--entrypoint", "/bin/sh", dockerRunnerImage, "-c", script,
    hostSource, guest, fixturesDir, ...OPS,
  ], { timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trimEnd().split("\n");
}

// Served to the page as a module; it imports the SDK's own browser WASI shim
// and drives the direct exports the way the engine does.
const BROWSER_RUNNER = `
import { createBrowserWasiShim } from "/wasi-shim.js";
const post = (body) => fetch("/done", { method: "POST", body: JSON.stringify(body) });
try {
  const ops = await (await fetch("/ops")).json();
  const wasi = createBrowserWasiShim({ args: ["module"] });
  const { instance } = await WebAssembly.instantiate(
    await (await fetch("/module.wasm")).arrayBuffer(), wasi.imports);
  wasi.setMemory(instance.exports.memory);
  const e = instance.exports;
  e.__wasm_call_ctors();
  const lines = ["browser " + navigator.userAgent];
  for (const op of ops) {
    const [kind, a, b] = op.split(":");
    if (kind === "init") {
      const data = new Uint8Array(await (await fetch("/fixtures/" + a)).arrayBuffer());
      const p = e.plugin_alloc(data.length);
      new Uint8Array(e.memory.buffer).set(data, p);
      const rc = e.plugin_init_ephemeris(p, data.length, Number(b));
      e.plugin_free(p, data.length);
      lines.push(["init", a, b, rc, e.plugin_entity_count()].join(" "));
    } else if (kind === "prop") {
      const bits = new DataView(new ArrayBuffer(8));
      bits.setBigUint64(0, BigInt("0x" + a));
      const p = e.plugin_alloc(64);
      const rc = e.plugin_propagate(bits.getFloat64(0), Number(b), p);
      const state = new Uint8Array(e.memory.buffer.slice(p, p + 64));
      e.plugin_free(p, 64);
      lines.push(["prop", b, rc, Array.from(state, (x) => x.toString(16).padStart(2, "0")).join("")].join(" "));
    }
  }
  await post({ lines });
} catch (error) {
  await post({ fatal: String(error && error.stack || error) });
}
`;

async function browserLane(guestBytes) {
  const chrome = await resolveChromeBinary();
  let settle;
  const done = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const routes = new Map([
    ["/", ["text/html", '<!doctype html><script type="module" src="/runner.js"></script>']],
    ["/runner.js", ["text/javascript", BROWSER_RUNNER]],
    ["/wasi-shim.js", ["text/javascript", fs.readFileSync(sdkWasiShim)]],
    ["/module.wasm", ["application/wasm", Buffer.from(guestBytes)]],
    ["/ops", ["application/json", JSON.stringify(OPS)]],
    ...[MIXED, CHEBYSHEV_ONLY].map((name) =>
      [`/fixtures/${name}`, ["application/octet-stream", fs.readFileSync(path.join(fixturesDir, name))]]),
  ]);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/done") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        response.end("ok");
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body.fatal) settle.reject(new Error(`browser lane: ${body.fatal}`));
        else settle.resolve(body.lines);
      });
      return;
    }
    const route = routes.get(url.pathname);
    response.writeHead(route ? 200 : 404, { "Content-Type": route?.[0] ?? "text/plain" });
    response.end(route?.[1] ?? "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "spk-mixed-chrome-"));
  const child = spawn(chrome, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--disable-sync",
    `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}/`,
  ], { stdio: "ignore" });
  child.on("exit", (code, signal) =>
    settle.reject(new Error(`browser lane: Chrome exited early (${code ?? signal})`)));
  const timer = setTimeout(() => settle.reject(new Error("browser lane timed out")), 60000);
  try {
    return await done;
  } finally {
    clearTimeout(timer);
    child.removeAllListeners("exit");
    const exited = child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    server.close();
    // Chrome's helpers can still be flushing the profile for a moment after
    // the browser process is gone.
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

function parse(lines) {
  const [runtime, ...rest] = lines;
  const inits = [];
  const props = [];
  for (const line of rest) {
    const [kind, ...f] = line.split(" ");
    if (kind === "init") {
      inits.push({ file: f[0], format: Number(f[1]), rc: Number(f[2]), count: Number(f[3]) });
    } else if (kind === "prop") {
      props.push({ index: Number(f[0]), rc: Number(f[1]), bytes: Buffer.from(f[2], "hex") });
    } else {
      assert.fail(`unexpected lane output: ${line}`);
    }
  }
  return { runtime, inits, props };
}

function readState(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { offsets } = ORBPRO_STATE_VECTOR;
  return {
    epoch: view.getFloat64(offsets.epoch, true),
    position: [0, 1, 2].map((i) => view.getFloat64(offsets.position + 8 * i, true)),
    velocity: [0, 1, 2].map((i) => view.getFloat64(offsets.velocity + 8 * i, true)),
    frame: view.getUint8(offsets.reference_frame),
    flags: view.getUint32(offsets.flags, true),
  };
}

test("a kernel mixing Chebyshev and Hermite segments, on every runtime", async (t) => {
  for (const name of [MIXED, CHEBYSHEV_ONLY]) {
    const bytes = fs.readFileSync(path.join(fixturesDir, name));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      reference.kernels[name].sha256,
      `${name} is not the kernel CSPICE wrote`,
    );
  }
  assert.deepEqual(
    reference.kernels[MIXED].segments.map((s) => s.type), [2, 13],
    "the mixed kernel is one Chebyshev segment followed by one Hermite segment",
  );
  assert.deepEqual(reference.kernels[CHEBYSHEV_ONLY].segments.map((s) => s.type), [2, 3]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spk-mixed-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const guestBytes = toLoadableWasmBytes(new Uint8Array(fs.readFileSync(wasmPath)));
  const guest = path.join(dir, "module.wasm");
  fs.writeFileSync(guest, guestBytes);

  const pin = loadWasmEdgePin();
  const lanes = { browser: parse(await browserLane(guestBytes)) };
  lanes.wasmedge = parse(await nativeWasmEdgeLane(dir, guest));
  assert.equal(lanes.wasmedge.runtime, `wasmedge ${pin.wasmedgeVersion}`);
  if (await dockerUp()) {
    lanes["docker-wasmedge"] = parse(await dockerWasmEdgeLane(dir, guest));
    assert.equal(lanes["docker-wasmedge"].runtime, `wasmedge ${pin.wasmedgeVersion}`);
  } else {
    t.diagnostic("Docker daemon is down: the container WasmEdge lane did not run");
  }
  for (const [lane, result] of Object.entries(lanes)) {
    t.diagnostic(`${lane}: ${result.runtime}`);
  }

  const [first, ...others] = Object.entries(lanes);
  for (const [lane, result] of others) {
    assert.deepEqual(result.inits, first[1].inits, `${lane} and ${first[0]} disagree on init`);
    assert.deepEqual(
      result.props.map((p) => [p.index, p.rc, p.bytes.toString("hex")]),
      first[1].props.map((p) => [p.index, p.rc, p.bytes.toString("hex")]),
      `${lane} and ${first[0]} disagree on a state vector`,
    );
  }

  for (const [lane, { inits, props }] of Object.entries(lanes)) {
    await t.test(`${lane}: a kernel with no readable segment is UNSUPPORTED_FORMAT`, () => {
      // Type 2 and type 3 store coefficients, not states. Accepting the kernel
      // with zero entities would be a load that answers nothing.
      for (const format of [EphemerisFormat.AUTO, EphemerisFormat.SPK_DAF]) {
        const init = inits.find((i) => i.file === CHEBYSHEV_ONLY && i.format === format);
        assert.equal(init.rc, ErrorCode.UNSUPPORTED_FORMAT, `format ${format}`);
        assert.equal(init.count, 0, `format ${format}`);
      }
    });

    await t.test(`${lane}: the mixed kernel loads its one readable segment`, () => {
      // Two segments in the file; the type-2 one is skipped, so exactly one
      // entity — and asking for a second is BAD_ENTITY_INDEX, not a state.
      for (const format of [EphemerisFormat.AUTO, EphemerisFormat.SPK_DAF]) {
        const init = inits.find((i) => i.file === MIXED && i.format === format);
        assert.equal(init.rc, 1, `format ${format}`);
        assert.equal(init.count, 1, `format ${format}`);
      }
      assert.equal(props[1].index, 1);
      assert.equal(props[1].rc, ErrorCode.BAD_ENTITY_INDEX);
    });

    await t.test(`${lane}: the readable segment's state is CSPICE's`, () => {
      assert.equal(props[0].index, 0);
      assert.equal(props[0].rc, ErrorCode.OK);
      const state = readState(props[0].bytes);
      const { probe } = reference;
      assert.equal(state.epoch, hexToDouble(probe.julian_date_hex));
      assert.equal(state.frame, ReferenceFrame.J2000);
      assert.equal(state.flags, StateFlags.VALID);
      const expected = probe.state_hex.map(hexToDouble);
      const dr = Math.hypot(...state.position.map((v, i) => v - 1000 * expected[i]));
      const dv = Math.hypot(...state.velocity.map((v, i) => v - 1000 * expected[3 + i]));
      t.diagnostic(`${lane}: |dr| = ${dr.toExponential(3)} m, |dv| = ${dv.toExponential(3)} m/s vs CSPICE spkpvn`);
      assert.ok(dr <= POSITION_BOUND_M, `position is ${dr} m from CSPICE`);
      assert.ok(dv <= VELOCITY_BOUND_M_S, `velocity is ${dv} m/s from CSPICE`);
    });
  }
});
