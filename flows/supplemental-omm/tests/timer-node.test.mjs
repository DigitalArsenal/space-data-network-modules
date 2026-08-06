import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  extractPublicationRecordCollection,
  verifyModuleArtifact,
} from "../../../node_modules/space-data-module-sdk/src/index.js";
import { createBrowserModuleHarness } from "../../../node_modules/space-data-module-sdk/src/testing/index.js";
import {
  ByteBuffer,
} from "../../../../spacedatastandards.org/node_modules/flatbuffers/js/flatbuffers.js";
import { FSB } from "../../../../spacedatastandards.org/lib/js/FSB/FSB.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const timerRoot = path.join(packageRoot, "nodes/timer");
const manifestPath = path.join(timerRoot, "plugin-manifest.json");
const artifactPath = path.join(timerRoot, "dist/isomorphic/module.wasm");
const publisherPath = path.join(timerRoot, "publisher.json");
const standardsRoot = path.resolve(packageRoot, "../../../spacedatastandards.org");
const flatcPath = path.resolve(packageRoot, "../../../flatbuffers/build/flatc");
const hourMs = 3_600_000;
const initialWakeupDelayMs = 30_000;
const fsoIdentity = {
  schemaName: "FSO.fbs",
  fileIdentifier: "$FSO",
  schemaVersion: "1.164.0",
  schemaHash: "7698d54cba61bbb638104d37211cc2dbb15e446aefcfedfb4a66d0c46c70b90f",
  rootTypeName: "FSO",
};

const emptyFso = new Uint8Array([
  12, 0, 0, 0,
  36, 70, 83, 79,
  4, 0, 4, 0,
  4, 0, 0, 0,
]);

function wakeupInput(wireFormat = "flatbuffer") {
  const aligned = wireFormat === "aligned-binary";
  return {
    portId: "wakeup",
    wireFormat,
    typeRef: {
      ...fsoIdentity,
      schemaHash: [...Buffer.from(fsoIdentity.schemaHash, "hex")],
      wireFormat,
      ...(aligned ? { byteLength: 361_648, requiredAlignment: 8 } : {}),
    },
    payload: aligned ? new Uint8Array(361_648) : emptyFso,
  };
}

function productionCanonicalWakeupInput() {
  const input = wakeupInput();
  return {
    ...input,
    payload: new Uint8Array(0),
    typeRef: {
      ...input.typeRef,
      fixedStringLength: 0,
      byteLength: 361_648,
      requiredAlignment: 8,
    },
  };
}

function tickBytes(output) {
  if (output.wireFormat === "aligned-binary") {
    const view = new DataView(
      output.payload.buffer,
      output.payload.byteOffset,
      output.payload.byteLength,
    );
    const length = view.getUint32(124, true);
    return output.payload.slice(128, 128 + length);
  }
  const envelope = FSB.getRootAsFSB(
    new ByteBuffer(new Uint8Array(output.payload)),
  );
  return new Uint8Array(envelope.dataArray() ?? []);
}

function decodeTick(output) {
  const bytes = tickBytes(output);
  assert.equal(bytes.byteLength, 36, "timer tick payload has the fixed policy shape");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    nowMs: Number(view.getBigUint64(0, true)),
    scheduledMs: Number(view.getBigUint64(8, true)),
    nextMs: Number(view.getBigUint64(16, true)),
    sequence: Number(view.getBigUint64(24, true)),
    missedCount: view.getUint32(32, true),
  };
}

function readJson(filePath, description) {
  assert.ok(fs.existsSync(filePath), `${description} is missing: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertPair(port, location) {
  assert.equal(port?.acceptedTypeSets?.length, 1, `${location} needs one type set`);
  const types = port.acceptedTypeSets[0]?.allowedTypes ?? [];
  assert.equal(types.length, 2, `${location} needs exactly two representations`);
  const canonical = types.find(
    (type) => (type.wireFormat ?? "flatbuffer") === "flatbuffer",
  );
  const aligned = types.find((type) => type.wireFormat === "aligned-binary");
  assert.ok(canonical, `${location} needs canonical FlatBuffer`);
  assert.ok(aligned, `${location} needs aligned-binary`);
  for (const property of [
    "schemaName",
    "fileIdentifier",
    "schemaVersion",
    "schemaHash",
    "rootTypeName",
  ]) {
    assert.deepEqual(
      aligned[property] ?? null,
      canonical[property] ?? null,
      `${location} ${property} identity differs`,
    );
  }
  assert.equal(
    Number.isSafeInteger(aligned.byteLength) && aligned.byteLength > 0,
    true,
    `${location} needs a generated aligned byteLength`,
  );
  assert.equal(
    Number.isSafeInteger(aligned.requiredAlignment) &&
      aligned.requiredAlignment > 0,
    true,
    `${location} needs a generated aligned requiredAlignment`,
  );
}

test("timer policy is an explicit isomorphic node with only generic clock/timer authority", () => {
  const manifest = readJson(manifestPath, "timer manifest");
  assert.equal(manifest.pluginId, "org.sdn.flows.supplemental-omm.timer");
  assert.deepEqual([...(manifest.runtimeTargets ?? [])].sort(), ["browser", "wasmedge"]);
  assert.deepEqual([...(manifest.capabilities ?? [])].sort(), ["clock", "timers"]);
  assert.deepEqual(manifest.invokeSurfaces, ["direct"]);

  const manifestText = JSON.stringify(manifest);
  for (const forbidden of [
    /host-cron/i,
    /schedule_cron/i,
    /schedule\.parse/i,
    /schedule\.matches/i,
    /schedule\.next/i,
    /storage_engine_link/i,
    /wakeup\.request/i,
  ]) {
    assert.doesNotMatch(manifestText, forbidden);
  }
  const timerInterface = (manifest.externalInterfaces ?? []).find(
    (candidate) => candidate.capability === "timers",
  );
  assert.deepEqual(timerInterface?.properties?.hostOps, [
    "timers.arm",
    "timers.cancel",
  ]);

  const method = (manifest.methods ?? []).find(
    (candidate) => candidate.methodId === "on_wakeup",
  );
  assert.ok(method, "timer must expose on_wakeup");
  const wakeup = (method.inputPorts ?? []).find((port) => port.portId === "wakeup");
  const tick = (method.outputPorts ?? []).find((port) => port.portId === "tick");
  assert.ok(wakeup, "timer must consume a typed generic wakeup frame");
  assert.ok(tick, "timer must emit a typed tick frame");
  assertPair(wakeup, "on_wakeup.wakeup");
  assertPair(tick, "on_wakeup.tick");
});

test("the canonical timer boundary schema can generate its aligned representation", () => {
  const manifest = readJson(manifestPath, "timer manifest");
  const type = manifest.methods[0].outputPorts[0].acceptedTypeSets[0].allowedTypes.find(
    (candidate) => (candidate.wireFormat ?? "flatbuffer") === "flatbuffer",
  );
  const schemaCode = type.schemaName.replace(/\.fbs$/, "");
  const schemaPath = path.join(standardsRoot, `schema/${schemaCode}/main.fbs`);
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "supplemental-timer-aligned-"));
  const result = spawnSync(
    flatcPath,
    ["--no-warnings", "--cpp", "--aligned", "-o", outputRoot, schemaPath],
    { encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `canonical SDS ${schemaCode} cannot generate an aligned layout:\n${result.stderr}`,
  );
  const generated = fs.readFileSync(path.join(outputRoot, "main_aligned.h"), "utf8");
  assert.match(generated, new RegExp(`constexpr\\s+size_t\\s+${schemaCode}_SIZE\\s*=`));
  assert.match(generated, new RegExp(`constexpr\\s+size_t\\s+${schemaCode}_ALIGN\\s*=`));
});

test("timer node artifact is independently bundle-signed", async () => {
  assert.ok(fs.existsSync(artifactPath), `timer artifact is missing: ${artifactPath}`);
  const publisher = readJson(publisherPath, "timer publisher record");
  assert.match(publisher.publicKeyHex ?? "", /^[0-9a-f]{64}$/);
  const verified = await verifyModuleArtifact(fs.readFileSync(artifactPath), {
    trustedPublicKeys: [publisher.publicKeyHex],
    requireSignature: true,
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.signed, true);
  assert.equal(verified.signatureScope, "bundle");
});

test("timer bootstraps installation before its first generic wakeup", async (t) => {
  const manifest = readJson(manifestPath, "timer manifest");
  const signed = new Uint8Array(fs.readFileSync(artifactPath));
  const portable = extractPublicationRecordCollection(signed)?.payloadBytes ?? signed;
  let nowMs = 1_800_001_234_567;
  const arms = [];
  const harness = await createBrowserModuleHarness({
    wasmSource: portable,
    manifest,
    surface: "direct",
    hostcallDispatch(operation, params) {
      if (operation === "clock.now") return nowMs;
      if (operation === "timers.arm") {
        arms.push({ ...params });
        return { accepted: true };
      }
      throw new Error(`timer called forbidden host operation ${operation}`);
    },
  });
  t.after(() => harness.destroy());

  const bootstrap = await harness.invoke({
    methodId: "on_wakeup",
    inputs: [wakeupInput()],
  });
  assert.equal(bootstrap.statusCode, 0, bootstrap.errorMessage);
  assert.equal(
    bootstrap.outputs.length,
    0,
    "a lifecycle-only startup must commit the APP before starting the catalog run",
  );
  assert.equal(arms.length, 1);
  assert.equal(arms[0].at_unix_ms, nowMs + initialWakeupDelayMs);
  assert.equal(arms[0].token, "supplemental-omm-hourly");

  nowMs += initialWakeupDelayMs;
  const firstWakeup = await harness.invoke({
    methodId: "on_wakeup",
    inputs: [wakeupInput()],
  });
  assert.equal(firstWakeup.statusCode, 0, firstWakeup.errorMessage);
  assert.equal(firstWakeup.outputs.length, 1);
  const nextDue = (Math.floor(nowMs / hourMs) + 1) * hourMs;
  assert.deepEqual(decodeTick(firstWakeup.outputs[0]), {
    nowMs,
    scheduledMs: nowMs,
    nextMs: nextDue,
    sequence: 1,
    missedCount: 0,
  });
});

test("timer accepts a canonical production wakeup carrying paired aligned-layout hints", async (t) => {
  const manifest = readJson(manifestPath, "timer manifest");
  const signed = new Uint8Array(fs.readFileSync(artifactPath));
  const portable = extractPublicationRecordCollection(signed)?.payloadBytes ?? signed;
  let nowMs = 1_800_001_234_567;
  const harness = await createBrowserModuleHarness({
    wasmSource: portable,
    manifest,
    surface: "direct",
    hostcallDispatch(operation) {
      if (operation === "clock.now") return nowMs;
      if (operation === "timers.arm") return { accepted: true };
      throw new Error(`timer called forbidden host operation ${operation}`);
    },
  });
  t.after(() => harness.destroy());

  const bootstrap = await harness.invoke({
    methodId: "on_wakeup",
    inputs: [productionCanonicalWakeupInput()],
  });
  assert.equal(bootstrap.statusCode, 0, bootstrap.errorMessage);
  assert.equal(bootstrap.outputs.length, 0);

  nowMs += initialWakeupDelayMs;
  const response = await harness.invoke({
    methodId: "on_wakeup",
    inputs: [productionCanonicalWakeupInput()],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].portId, "tick");
  assert.equal(response.outputs[0].wireFormat, "flatbuffer");
});

test("timer owns hourly UTC policy and arms only a generic timer token", async (t) => {
  const manifest = readJson(manifestPath, "timer manifest");
  assert.ok(fs.existsSync(artifactPath), `timer artifact is missing: ${artifactPath}`);
  const signed = new Uint8Array(fs.readFileSync(artifactPath));
  const portable = extractPublicationRecordCollection(signed)?.payloadBytes ?? signed;
  const calls = [];
  let nowMs = 1_800_001_234_567;
  const harness = await createBrowserModuleHarness({
    wasmSource: portable,
    manifest,
    surface: "direct",
    hostcallDispatch(operation, params) {
      calls.push({ operation, params });
      if (operation === "clock.now") return nowMs;
      if (operation === "timers.arm") return { accepted: true };
      throw new Error(`timer called forbidden host operation ${operation}`);
    },
  });
  t.after(() => harness.destroy());

  // The direct browser harness needs an in-envelope arena to materialize
  // direct-surface outputs. A generic wakeup may omit the body in production;
  // this empty canonical FSO supplies that arena without moving policy to the
  // harness or host.
  const bootstrap = await harness.invoke({
    methodId: "on_wakeup",
    inputs: [wakeupInput()],
  });
  assert.equal(bootstrap.statusCode, 0, bootstrap.errorMessage);
  assert.equal(bootstrap.outputs.length, 0);
  assert.equal(calls[1].params.at_unix_ms, nowMs + initialWakeupDelayMs);

  calls.length = 0;
  nowMs += initialWakeupDelayMs;
  const expectedNextMs = (Math.floor(nowMs / hourMs) + 1) * hourMs;
  const response = await harness.invoke({
    methodId: "on_wakeup",
    inputs: [wakeupInput()],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(
    response.outputs.length,
    1,
    "the first generic wakeup after installation emits exactly one tick",
  );
  assert.equal(response.outputs[0].portId, "tick");
  assert.equal(response.outputs[0].wireFormat, "flatbuffer");
  assert.equal(response.outputs[0].typeRef?.schemaName, "FSB.fbs");
  assert.equal(response.outputs[0].typeRef?.fileIdentifier, "$FSB");
  assert.equal(
    new TextDecoder().decode(response.outputs[0].payload.subarray(4, 8)),
    "$FSB",
  );
  assert.deepEqual(
    calls.map(({ operation }) => operation),
    ["clock.now", "timers.arm"],
  );
  assert.equal(calls[1].params.at_unix_ms, expectedNextMs);
  assert.equal(calls[1].params.token, "supplemental-omm-hourly");
});

test("timer coalesces late wakeups, ignores early wakeups, and re-establishes policy after restart", async (t) => {
  const manifest = readJson(manifestPath, "timer manifest");
  const signed = new Uint8Array(fs.readFileSync(artifactPath));
  const portable = extractPublicationRecordCollection(signed)?.payloadBytes ?? signed;
  let nowMs = 1_800_001_234_567;
  const arms = [];
  const makeHarness = () => createBrowserModuleHarness({
    wasmSource: portable,
    manifest,
    surface: "direct",
    hostcallDispatch(operation, params) {
      if (operation === "clock.now") return nowMs;
      if (operation === "timers.arm") {
        arms.push({ ...params });
        return { accepted: true };
      }
      throw new Error(`timer called forbidden host operation ${operation}`);
    },
  });

  const firstHarness = await makeHarness();
  t.after(() => firstHarness.destroy());
  const bootstrap = await firstHarness.invoke({
    methodId: "on_wakeup",
    inputs: [wakeupInput()],
  });
  assert.equal(bootstrap.statusCode, 0, bootstrap.errorMessage);
  assert.equal(bootstrap.outputs.length, 0);

  nowMs += initialWakeupDelayMs;
  const first = await firstHarness.invoke({
    methodId: "on_wakeup",
    inputs: [wakeupInput()],
  });
  assert.equal(first.statusCode, 0, first.errorMessage);
  assert.equal(first.outputs.length, 1);
  const firstTick = decodeTick(first.outputs[0]);
  const firstDue = (Math.floor(nowMs / hourMs) + 1) * hourMs;
  assert.deepEqual(firstTick, {
    nowMs,
    scheduledMs: nowMs,
    nextMs: firstDue,
    sequence: 1,
    missedCount: 0,
  });

  nowMs = firstDue - 1;
  const early = await firstHarness.invoke({
    methodId: "on_wakeup",
    inputs: [wakeupInput()],
  });
  assert.equal(early.statusCode, 0, early.errorMessage);
  assert.equal(early.outputs.length, 0, "an early generic wakeup emits no tick");
  assert.equal(arms.at(-1).at_unix_ms, firstDue, "early wakeup re-arms the same due instant");

  nowMs = firstDue + 2 * hourMs + 12_345;
  const late = await firstHarness.invoke({
    methodId: "on_wakeup",
    inputs: [wakeupInput()],
  });
  assert.equal(late.statusCode, 0, late.errorMessage);
  assert.equal(late.outputs.length, 1, "one late wakeup coalesces into one tick");
  const nextDue = (Math.floor(nowMs / hourMs) + 1) * hourMs;
  assert.deepEqual(decodeTick(late.outputs[0]), {
    nowMs,
    scheduledMs: firstDue,
    nextMs: nextDue,
    sequence: 2,
    missedCount: 2,
  });

  const restartedHarness = await makeHarness();
  t.after(() => restartedHarness.destroy());
  const restartBootstrap = await restartedHarness.invoke({
    methodId: "on_wakeup",
    inputs: [wakeupInput()],
  });
  assert.equal(restartBootstrap.statusCode, 0, restartBootstrap.errorMessage);
  assert.equal(restartBootstrap.outputs.length, 0);

  nowMs += initialWakeupDelayMs;
  const restarted = await restartedHarness.invoke({
    methodId: "on_wakeup",
    inputs: [wakeupInput()],
  });
  assert.equal(restarted.statusCode, 0, restarted.errorMessage);
  assert.equal(restarted.outputs.length, 1, "fresh signed instance re-establishes policy after bootstrap");
  const restartedNextDue = (Math.floor(nowMs / hourMs) + 1) * hourMs;
  assert.deepEqual(decodeTick(restarted.outputs[0]), {
    nowMs,
    scheduledMs: nowMs,
    nextMs: restartedNextDue,
    sequence: 1,
    missedCount: 0,
  });
  assert.ok(arms.every((arm) => arm.token === "supplemental-omm-hourly"));
});

test("timer emits the declared aligned FSB when the incoming generic wakeup is aligned", async (t) => {
  const manifest = readJson(manifestPath, "timer manifest");
  const signed = new Uint8Array(fs.readFileSync(artifactPath));
  const portable = extractPublicationRecordCollection(signed)?.payloadBytes ?? signed;
  let nowMs = 1_800_001_234_567;
  const harness = await createBrowserModuleHarness({
    wasmSource: portable,
    manifest,
    surface: "direct",
    hostcallDispatch(operation) {
      if (operation === "clock.now") return nowMs;
      if (operation === "timers.arm") return { accepted: true };
      throw new Error(`timer called forbidden host operation ${operation}`);
    },
  });
  t.after(() => harness.destroy());

  const bootstrap = await harness.invoke({
    methodId: "on_wakeup",
    inputs: [wakeupInput("aligned-binary")],
  });
  assert.equal(bootstrap.statusCode, 0, bootstrap.errorMessage);
  assert.equal(bootstrap.outputs.length, 0);

  nowMs += initialWakeupDelayMs;
  const response = await harness.invoke({
    methodId: "on_wakeup",
    inputs: [wakeupInput("aligned-binary")],
  });
  assert.equal(response.statusCode, 0, response.errorMessage);
  assert.equal(response.outputs.length, 1);
  assert.equal(response.outputs[0].wireFormat, "aligned-binary");
  assert.equal(response.outputs[0].payload.byteLength, 1_048_744);
  assert.equal(response.outputs[0].typeRef?.fileIdentifier, "$FSB");
  assert.equal(response.outputs[0].typeRef?.requiredAlignment, 8);
  assert.equal(decodeTick(response.outputs[0]).nowMs, nowMs);
});
