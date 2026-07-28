/*
 * Runs the CCSDS 124.0-B-1 reference vector suite through the SAME
 * codec-cli.wasm bytes in every available runtime lane and byte-diffs the
 * results against each other AND against the ESA reference output.
 *
 * Lanes:
 *   node-wasi  — Node's WASI preview1 over the V8 engine (the JS-engine lane;
 *                the SDK browser harness runs this same artifact shape)
 *   wasmedge-docker — the pinned parity image from
 *                src/testing/wasmedgePin.json (WasmEdge 0.16.4)
 *   wasmedge-native — a local wasmedge binary, when present
 *
 * A lane that is unavailable is REPORTED, never silently skipped.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { buildLaneDriver, LANE_DRIVER_WASM } from "./build-probe.mjs";

const execFileAsync = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = path.resolve(here, "..", "..");
const CLI_WASM = LANE_DRIVER_WASM;

async function readPin() {
  // The pin is read from the SDK, never copied here: host and container
  // WasmEdge versions bump together or the drift is itself a defect.
  const pinPath = path.resolve(
    packageRoot,
    "..", "..", "..", "..",
    "ancillary-packages", "space-data-module-sdk",
    "src", "testing", "wasmedgePin.json",
  );
  return JSON.parse(await fs.readFile(pinPath, "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export const VECTORS = [
  { name: "simple", input: "simple.bin", expected: "simple.bin.pkt" },
  { name: "hiro", input: "hiro.bin", expected: "hiro.bin.pkt" },
  { name: "housekeeping", input: "housekeeping.bin", expected: "housekeeping.bin.pkt" },
  { name: "edge-cases", input: "edge-cases.bin", expected: "edge-cases.bin.pkt" },
  { name: "venus-express", input: "venus-express.ccsds", expected: "venus-express.ccsds.pkt" },
];

async function loadSuite(vectorRoot) {
  const out = [];
  for (const v of VECTORS) {
    const meta = JSON.parse(
      await fs.readFile(
        path.join(vectorRoot, "test-vectors", "expected-output", `${v.name}-metadata.json`),
        "utf8",
      ),
    );
    const p = meta.compression.parameters;
    const packetBytes = meta.compression.packet_length;
    const inputBytes = await fs.readFile(
      path.join(vectorRoot, "test-vectors", "input", v.input),
    );
    out.push({
      ...v,
      packetBytes,
      robustness: p.robustness,
      pt: p.pt, ft: p.ft, rt: p.rt,
      packetCount: inputBytes.length / packetBytes,
      inputBytes,
      expectedBytes: await fs.readFile(
        path.join(vectorRoot, "test-vectors", "expected-output", v.expected),
      ),
    });
  }
  return out;
}

/* ---------------- lanes ---------------- */

async function runNodeWasi(workDir, argv) {
  const { WASI } = await import("node:wasi");
  const wasi = new WASI({
    version: "preview1",
    args: ["codec-cli.wasm", ...argv],
    env: {},
    preopens: { "/work": workDir },
    returnOnExit: true,
  });
  const bytes = await fs.readFile(CLI_WASM);
  const module = await WebAssembly.compile(bytes);
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  const code = wasi.start(instance);
  return code ?? 0;
}

async function runWasmEdgeDocker(workDir, argv, pin) {
  const image = `${pin.dockerImageRepository}:${pin.wasmedgeVersion}`;
  const { stdout } = await execFileAsync("docker", [
    "run", "--rm",
    "-v", `${workDir}:/work`,
    "-w", "/work",
    image,
    "--enable-threads",
    "--dir", "/work:/work",
    "codec-cli.wasm",
    ...argv,
  ]);
  return stdout;
}

async function runWasmEdgeNative(workDir, argv, binary) {
  const { stdout } = await execFileAsync(binary, [
    "--enable-threads",
    "--dir", "/work:" + workDir,
    CLI_WASM,
    ...argv,
  ]);
  return stdout;
}

async function verifyPinnedVersion(pin, nativeBinary) {
  const results = {};
  try {
    const { stdout } = await execFileAsync("docker", [
      "run", "--rm", "--entrypoint", "wasmedge",
      `${pin.dockerImageRepository}:${pin.wasmedgeVersion}`, "--version",
    ]);
    results.docker = stdout.trim();
  } catch (error) {
    results.docker = `UNAVAILABLE (${error.message.split("\n")[0]})`;
  }
  if (nativeBinary) {
    try {
      const { stdout } = await execFileAsync(nativeBinary, ["--version"]);
      results.native = stdout.trim();
    } catch (error) {
      results.native = `UNAVAILABLE (${error.message.split("\n")[0]})`;
    }
  } else {
    results.native = "UNAVAILABLE (no wasmedge on PATH; set SDM_WASMEDGE_BINARY)";
  }
  return results;
}

/* ---------------- driver ---------------- */

export async function runAllLanes({ vectorRoot, quiet = false } = {}) {
  // Build from source rather than trusting a stale artifact: the parity claim
  // is about THESE vendored bytes under THESE flags.
  await buildLaneDriver({ quiet: true });
  const pin = await readPin();
  const nativeBinary = process.env.SDM_WASMEDGE_BINARY ?? null;
  const versions = await verifyPinnedVersion(pin, nativeBinary);
  const suite = await loadSuite(vectorRoot);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "p124-lanes-"));
  await fs.copyFile(CLI_WASM, path.join(workDir, "codec-cli.wasm"));

  const lanes = [
    { id: "node-wasi", available: true },
    { id: "wasmedge-docker", available: !versions.docker.startsWith("UNAVAILABLE") },
    { id: "wasmedge-native", available: !versions.native.startsWith("UNAVAILABLE") },
  ];

  const results = [];
  for (const vector of suite) {
    await fs.writeFile(path.join(workDir, vector.input), vector.inputBytes);
    const row = { vector: vector.name, packets: vector.packetCount, lanes: {} };

    for (const lane of lanes) {
      if (!lane.available) { row.lanes[lane.id] = { status: "lane-unavailable" }; continue; }

      const cName = `${vector.name}.${lane.id}.pkt`;
      const dName = `${vector.name}.${lane.id}.raw`;
      const compressArgv = [
        "compress", `/work/${vector.input}`, `/work/${cName}`,
        String(vector.packetBytes), String(vector.robustness),
        String(vector.pt), String(vector.ft), String(vector.rt),
      ];
      const decompressArgv = [
        "decompress", `/work/${cName}`, `/work/${dName}`,
        String(vector.packetBytes), String(vector.robustness),
        String(vector.packetCount),
      ];

      try {
        if (lane.id === "node-wasi") {
          await runNodeWasi(workDir, compressArgv);
          await runNodeWasi(workDir, decompressArgv);
        } else if (lane.id === "wasmedge-docker") {
          await runWasmEdgeDocker(workDir, compressArgv, pin);
          await runWasmEdgeDocker(workDir, decompressArgv, pin);
        } else {
          await runWasmEdgeNative(workDir, compressArgv, nativeBinary);
          await runWasmEdgeNative(workDir, decompressArgv, nativeBinary);
        }
        const compressed = await fs.readFile(path.join(workDir, cName));
        const decompressed = await fs.readFile(path.join(workDir, dName));
        row.lanes[lane.id] = {
          status: "ok",
          compressedSha: sha256(compressed),
          compressedLen: compressed.length,
          decompressedSha: sha256(decompressed),
          matchesReference: compressed.equals(vector.expectedBytes),
          roundTripExact: decompressed.equals(vector.inputBytes),
        };
      } catch (error) {
        row.lanes[lane.id] = { status: "error", error: String(error.message).split("\n")[0] };
      }
    }

    row.referenceSha = sha256(vector.expectedBytes);
    const okLanes = Object.entries(row.lanes).filter(([, r]) => r.status === "ok");
    row.crossLaneIdentical =
      okLanes.length > 0 &&
      new Set(okLanes.map(([, r]) => r.compressedSha)).size === 1 &&
      new Set(okLanes.map(([, r]) => r.decompressedSha)).size === 1;
    results.push(row);
  }

  if (!quiet) {
    console.log(`\nWasmEdge pin: ${pin.wasmedgeVersion}`);
    console.log(`  docker lane: ${versions.docker}`);
    console.log(`  native lane: ${versions.native}`);
    console.log(`\nartifact: ${CLI_WASM} (sha256 ${sha256(await fs.readFile(CLI_WASM))})\n`);
    for (const row of results) {
      console.log(`${row.vector} (${row.packets} packets)`);
      for (const [laneId, r] of Object.entries(row.lanes)) {
        if (r.status !== "ok") { console.log(`  ${laneId.padEnd(16)} ${r.status}${r.error ? ": " + r.error : ""}`); continue; }
        console.log(
          `  ${laneId.padEnd(16)} compress=${r.matchesReference ? "REFERENCE-IDENTICAL" : "DIVERGES"}` +
          ` roundtrip=${r.roundTripExact ? "EXACT" : "FAIL"} sha=${r.compressedSha.slice(0, 16)}`,
        );
      }
      console.log(`  cross-lane: ${row.crossLaneIdentical ? "BYTE-IDENTICAL" : "DIVERGENT"}\n`);
    }
  }

  await fs.rm(workDir, { recursive: true, force: true });
  return { pin, versions, results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const vectorRoot = process.env.CCSDS124_VECTORS;
  if (!vectorRoot) {
    console.error("CCSDS124_VECTORS must point at a github.com/tanagraspace/ccsds124 checkout.");
    process.exit(2);
  }
  const { results } = await runAllLanes({ vectorRoot });
  const bad = results.filter(
    (r) => !r.crossLaneIdentical ||
      Object.values(r.lanes).some((l) => l.status === "ok" && (!l.matchesReference || !l.roundTripExact)),
  );
  console.log(bad.length === 0
    ? "ALL VECTORS: every available lane byte-identical to the ESA reference and to each other."
    : `DIVERGENCE in ${bad.length} vector(s): ${bad.map((b) => b.vector).join(", ")}`);
  process.exit(bad.length === 0 ? 0 : 1);
}
