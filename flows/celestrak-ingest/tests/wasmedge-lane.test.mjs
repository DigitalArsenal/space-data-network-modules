/*
 * THE WASMEDGE LANE — required, never skipped.
 *
 * flow.test.mjs runs these artifacts in the JS flow host. On 2026-07-29 that
 * suite was 9/9 GREEN on bundles that, under the node's real WasmEdge host,
 * executed ONE node and went inert: the compiled router refused every OPAQUE
 * byte edge, and the tick frame the Go host writes (alignment left at 0) was
 * refused outright while the browser host's (alignment defaulted to 1) was
 * admitted. Same module.wasm, two runtimes, opposite outcomes — and the only
 * evidence anyone had was a green suite in the runtime that happened to work.
 *
 * So this lane exists, and it FAILS rather than skips. A flow is verified when
 * the artifact that will be deployed has been drained by the runtime that will
 * deploy it; anything less is a guess with a checkmark next to it.
 *
 * It drives the sdn-server WasmEdge integration test
 * (internal/flowrt/celestrak_ingest_flow_test.go) against THIS dist directory,
 * which is the production embedding: WasmEdge through the Go host, the real
 * http + storage_ingest capability handlers, a real FlatSQL store.
 *
 *   SDN_SERVER_REPO   path to space-data-network      (default: ../../../space-data-network)
 *   WASMEDGE_DIR      pinned WasmEdge header/lib tree (required; see wasmedgePin.json)
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "..", "dist");
const SDN_REPO = path.resolve(
  process.env.SDN_SERVER_REPO ?? path.join(HERE, "..", "..", "..", "..", "space-data-network"),
);

function missingPrerequisite() {
  if (!fs.existsSync(path.join(DIST, "gp", "runtime.wasm"))) {
    return `no built bundles at ${DIST} — run \`npm run build\` first`;
  }
  if (!fs.existsSync(path.join(SDN_REPO, "scripts", "go-with-wasmedge.sh"))) {
    return (
      `space-data-network not found at ${SDN_REPO}. ` +
      "Set SDN_SERVER_REPO to the node repo that embeds WasmEdge."
    );
  }
  const wasmedgeDir = process.env.WASMEDGE_DIR;
  if (!wasmedgeDir || !fs.existsSync(path.join(wasmedgeDir, "include", "wasmedge", "wasmedge.h"))) {
    return (
      "WASMEDGE_DIR is unset or does not contain include/wasmedge/wasmedge.h. " +
      "The lane needs the PINNED WasmEdge (space-data-module-sdk src/testing/wasmedgePin.json); " +
      "host and container pins bump together."
    );
  }
  return null;
}

test("the SAME artifacts drain under the node's real WasmEdge host", () => {
  const blocked = missingPrerequisite();
  assert.equal(
    blocked,
    null,
    `WASMEDGE LANE CANNOT RUN: ${blocked}\n` +
      "This is a FAILURE, not a skip. A flow suite that only ever ran in the JS host " +
      "has already shipped a bundle that executed one node and stopped under WasmEdge.",
  );

  const output = execFileSync(
    "bash",
    [
      path.join(SDN_REPO, "scripts", "go-with-wasmedge.sh"),
      "test",
      "./internal/flowrt/",
      "-run",
      "TestCelesTrak",
      "-count=1",
      "-timeout",
      "900s",
      "-v",
    ],
    {
      cwd: SDN_REPO,
      encoding: "utf8",
      env: { ...process.env, SDN_CELESTRAK_INGEST_FLOW_DIST: DIST },
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  // The Go runner reports "ok" on success; assert on the individual cases too,
  // because a run that SKIPS every case also exits zero.
  const passed = [...output.matchAll(/^--- PASS: (\S+)/gm)].map((match) => match[1]);
  const skipped = [...output.matchAll(/^--- SKIP: (\S+)/gm)].map((match) => match[1]);
  assert.deepEqual(skipped, [], `WasmEdge lane skipped cases: ${skipped.join(", ")}`);
  assert.ok(
    passed.includes("TestCelesTrakGPIngestFlowRetrievesOMM"),
    `the GP ingest lane must run and pass under WasmEdge; saw: ${passed.join(", ") || "nothing"}`,
  );
  assert.ok(
    passed.includes("TestCelesTrakSatcatIngestFlowRetrievesCAT"),
    `the satcat ingest lane must run and pass under WasmEdge; saw: ${passed.join(", ")}`,
  );
});
