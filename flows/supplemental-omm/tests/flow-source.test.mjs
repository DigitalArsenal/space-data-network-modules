import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const programId = "org.sdn.flows.od-supplemental-omm";
const providers = [
  ["starlink", "com.orbpro.spacex-starlink-source"],
  ["glonass", "com.orbpro.glonass-source"],
  ["intelsat", "com.orbpro.intelsat-source"],
  ["cpf", "com.orbpro.cpf-source"],
  ["iss", "com.orbpro.iss-source"],
];
const independentNodes = [
  ["timer", "org.sdn.flows.supplemental-omm.timer", "on_wakeup"],
  ...providers.map(([key, pluginId]) => [`provider-${key}`, pluginId, "emit"]),
  ["od", "org.sdn.flows.supplemental-omm.od", "fit"],
  ["store", "com.digitalarsenal.flatsql.store", "append_records"],
  ["publication", "org.sdn.flows.supplemental-omm.publication", "publish_records"],
  ["status", "org.sdn.flows.supplemental-omm.status", "record_event"],
];

function requireFile(relativePath) {
  const absolutePath = path.join(packageRoot, relativePath);
  assert.ok(fs.existsSync(absolutePath), `missing ${relativePath}`);
  return absolutePath;
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(requireFile(relativePath), "utf8"));
}

function edgeKey(edge) {
  return `${edge.fromNodeId}.${edge.fromPortId}->${edge.toNodeId}.${edge.toPortId}`;
}

test("the authored flow is an explicit ten-node isomorphic composition", () => {
  const flow = readJson("flow.json");
  assert.equal(flow.programId, programId);
  assert.deepEqual(
    flow.nodes.map(({ nodeId, pluginId, methodId }) => [nodeId, pluginId, methodId]),
    independentNodes,
  );
  assert.ok(flow.nodes.every((node) => node.dispatchModel === "isomorphic"));
  assert.ok(
    flow.nodes.every(
      (node) =>
        typeof node.artifact?.path === "string" &&
        typeof node.artifact?.publisher === "string" &&
        /^[0-9a-f]{64}$/.test(node.artifact?.sha256 ?? ""),
    ),
  );
  assert.deepEqual(flow.requiredPlugins, independentNodes.map(([, pluginId]) => pluginId));
  assert.doesNotMatch(
    JSON.stringify(flow),
    /storage_engine_link|engineLinkage|linkedStore|host-cron|flatsql[-_]link[-_]shim/i,
  );
});

test("timer, native provider, OD, FlatSQL, publication, and status lanes are explicit", () => {
  const flow = readJson("flow.json");
  const actual = new Set(flow.edges.map(edgeKey));
  for (const [provider] of providers) {
    assert.ok(actual.has(`timer.tick->provider-${provider}.config`));
    assert.ok(actual.has(`provider-${provider}.oem->od.${provider}`));
    assert.ok(actual.has(`provider-${provider}.oem->status.provider-${provider}`));
  }
  assert.ok(actual.has("od.control->store.control"));
  for (const record of ["omm", "ocm", "obd"]) {
    assert.ok(actual.has(`od.${record}->store.records`));
    assert.ok(actual.has(`od.${record}->publication.records`));
  }
  assert.ok(actual.has("store.status->status.store"));
  assert.ok(
    flow.edges.every(
      (edge) =>
        !(edge.fromNodeId.startsWith("provider-") && edge.toNodeId === "store"),
    ),
    "provider-native ephemeris bytes remain transient",
  );
  assert.deepEqual(flow.triggers.map(({ kind, source }) => [kind, source]), [
    ["manual", "generic-lifecycle"],
  ]);
  assert.deepEqual(flow.triggerBindings, [
    {
      triggerId: "startup",
      targetNodeId: "timer",
      targetPortId: "wakeup",
      backpressurePolicy: "queue",
      queueDepth: 1,
    },
  ]);
});

test("every child dependency resolves to an independently packaged module", () => {
  const flow = readJson("flow.json");
  const deps = readJson("deps.json");
  assert.deepEqual(
    Object.keys(deps).sort(),
    independentNodes.map(([, pluginId]) => pluginId).sort(),
  );
  for (const node of flow.nodes) {
    const dependencyRoot = path.resolve(packageRoot, deps[node.pluginId]);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dependencyRoot, "plugin-manifest.json"), "utf8"),
    );
    assert.equal(manifest.pluginId, node.pluginId);
    assert.ok(fs.existsSync(path.resolve(packageRoot, node.artifact.path)));
    assert.ok(fs.existsSync(path.resolve(packageRoot, node.artifact.publisher)));
    assert.doesNotMatch(deps[node.pluginId], /guest-link|hostcap/);
  }
});

test("native responses are reassembled and parsed only inside the OD WASM node", () => {
  const source = fs.readFileSync(requireFile("nodes/od/src/node.cpp"), "utf8");
  for (const marker of [
    "parse_starlink_meme",
    "parse_glonass_sp3",
    "parse_intelsat_ecf",
    "parse_cpf",
    "parse_iss_oem",
    "CHUNK_SEQUENCE",
    "TOTAL_BYTES",
    "additional_epochs",
    "CONFIGURE_INDEX",
  ]) {
    assert.match(source, new RegExp(marker));
  }
  assert.doesNotMatch(source, /128\s*\*\s*1024|131072|celestrak/i);
});

test("the bundle owns one self-contained APP status board", () => {
  const app = readJson("app/app.json");
  const ui = fs.readFileSync(requireFile("app/ui/index.html"), "utf8");
  assert.equal(app.id, "supplemental-omm");
  assert.deepEqual(
    app.modules.map(({ id, pluginId, version, role }) => ({ id, pluginId, version, role })),
    [{ id: "supplemental-omm", pluginId: programId, version: "1.0.0", role: "primary" }],
  );
  for (const [provider] of providers) {
    assert.match(ui, new RegExp(`data-provider=["']${provider}["']`));
  }
  assert.match(ui, /\/sdn\/v1\/artifacts\/__MODULE_CONTENT_HASH__/);
  assert.match(ui, /\/runtime\/nodes\//);
  assert.doesNotMatch(ui, /\/api\/v1\/stats|https?:\/\/|celestrak/i);
  assert.ok(app.dataflow.length > 0);
  for (const route of app.dataflow) {
    assert.equal(
      route.sdsSchema,
      "FSB",
      `${route.name} carries the signed node's outer FSB envelope`,
    );
  }
  assert.equal(
    app.data.find((entry) => entry.id === "runtime-status")?.sdsType,
    "DSS",
    "the application data identity remains the inner DSS record",
  );
});

test("Supplemental source and packaging contain no Go control plane", () => {
  const pkg = readJson("package.json");
  assert.equal(pkg["sdn-module"], "./dist/isomorphic/module.wasm");
  assert.match(pkg.scripts.check, /space-data-module\.js flow check/);
  assert.match(pkg.scripts.build, /space-data-module\.js flow compile/);
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /\bgo\b|\.go\b/i);

  const stack = [packageRoot];
  const goFiles = [];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(candidate);
      else if (entry.name.endsWith(".go")) goFiles.push(path.relative(packageRoot, candidate));
    }
  }
  assert.deepEqual(goFiles, []);
});
