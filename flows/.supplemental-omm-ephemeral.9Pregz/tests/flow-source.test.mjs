import assert from "node:assert/strict";
import crypto from "node:crypto";
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
    if (provider === "starlink") {
      assert.ok(
        actual.has(
          "provider-starlink.progress->status.provider-starlink-progress",
        ),
      );
      assert.ok(
        !actual.has("provider-starlink.oem->status.provider-starlink"),
        "Starlink OEM data must feed OD only",
      );
      assert.ok(
        !actual.has("provider-starlink.progress->od.starlink"),
        "Starlink progress must feed status only",
      );
    } else {
      assert.ok(actual.has(`provider-${provider}.oem->status.provider-${provider}`));
    }
  }
  const starlink = flow.nodes.find((node) => node.nodeId === "provider-starlink");
  const starlinkManifest = readJson(
    "nodes/providers/starlink/plugin-manifest.json",
  );
  assert.deepEqual(
    [...(starlink?.capabilities ?? [])].sort(),
    [...(starlinkManifest.capabilities ?? [])].sort(),
    "the flow grants exactly the signed Starlink node's declared capabilities",
  );
  assert.deepEqual(
    flow.edges
      .filter((edge) => edge.fromNodeId === "provider-starlink")
      .map(
        (edge) =>
          `${edge.fromPortId}->${edge.toNodeId}.${edge.toPortId}`,
      )
      .sort(),
    ["oem->od.starlink", "progress->status.provider-starlink-progress"],
    "Starlink has exactly one data edge to OD and one progress edge to status",
  );
  assert.ok(actual.has("od.control->store.control"));
  assert.ok(actual.has("od.status->status.od"));
  for (const record of ["omm", "ocm"]) {
    assert.ok(actual.has(`od.${record}->store.records`));
    assert.ok(actual.has(`od.${record}->publication.records`));
  }
  assert.ok(
    [...actual].every((edge) => !/(?:^|\.)obd(?:\.|->|$)/i.test(edge)),
    "OBD is not a Supplemental OMM graph lane",
  );
  assert.ok(actual.has("store.status->status.store"));
  assert.ok(
    flow.runtimeNodeRoutes.some(
      (route) =>
        route.key === "od.dss" &&
        route.nodeId === "status" &&
        route.portId === "od.dss",
    ),
  );
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

test("FlatSQL success feeds the signed Starlink cursor through one bounded cycle", () => {
  const flow = readJson("flow.json");
  const actual = new Set(flow.edges.map(edgeKey));
  assert.equal(flow.allowCycles, true);
  assert.ok(
    actual.has("store.status->provider-starlink.ack"),
    "the durable FlatSQL status must reach the WASM node that owns the cursor",
  );

  const cycleNodeIds = new Set(["provider-starlink", "od", "store"]);
  const cycleEdges = flow.edges.filter(
    (edge) =>
      cycleNodeIds.has(edge.fromNodeId) && cycleNodeIds.has(edge.toNodeId),
  );
  assert.deepEqual(
    new Set(cycleEdges.map(edgeKey)),
    new Set([
      "provider-starlink.oem->od.starlink",
      "od.control->store.control",
      "od.omm->store.records",
      "od.ocm->store.records",
      "store.status->provider-starlink.ack",
    ]),
  );
  const expectedQueueDepth = new Map([
    ["starlink-native-to-od", 256],
    ["od-control-to-store", 64],
    ["od-omm-to-store", 64],
    ["od-ocm-to-store", 64],
    ["store-status-to-starlink-ack", 64],
  ]);
  for (const edge of cycleEdges) {
    assert.equal(
      edge.backpressurePolicy,
      "queue",
      `${edge.edgeId} cannot drop a source transaction or its only acknowledgement`,
    );
    assert.equal(
      edge.queueDepth,
      expectedQueueDepth.get(edge.edgeId),
      `${edge.edgeId} must match its signed producer frame bound`,
    );
  }
  const starlinkMethod = readJson(
    "nodes/providers/starlink/plugin-manifest.json",
  ).methods
    .find(({ methodId }) => methodId === "emit");
  const starlinkInput = starlinkMethod?.inputPorts.find(
    ({ portId }) => portId === "ack",
  );
  const starlinkOutput = starlinkMethod?.outputPorts.find(
    ({ portId }) => portId === "oem",
  );
  assert.ok(starlinkInput, "Starlink must declare the FlatSQL acknowledgement input");
  assert.equal(starlinkInput.maxStreams, 64);
  assert.equal(starlinkOutput?.maxStreams, 256);
  assert.equal(starlinkMethod?.maxBatch, 64);
  const allowedTypes = starlinkInput.acceptedTypeSets?.[0]?.allowedTypes ?? [];
  assert.equal(allowedTypes.length, 2);
  assert.ok(allowedTypes.every(({ schemaName }) => schemaName === "FSO.fbs"));
  assert.deepEqual(
    new Set(allowedTypes.map(({ wireFormat }) => wireFormat)),
    new Set(["flatbuffer", "aligned-binary"]),
  );
});

test("OBD is absent from the executable Supplemental application surface", () => {
  const executableFiles = [
    "flow.json",
    "app/app.json",
    "app/ui/index.html",
    "nodes/od/src/node.cpp",
    "nodes/od/manifest.mjs",
    "nodes/od/build.mjs",
    "nodes/od/README.md",
    "nodes/od/vendor/od_batch_fit.hpp",
    "nodes/od/plugin-manifest.json",
    "nodes/od/dist/isomorphic/module.wasm",
    "nodes/flatsql/README.md",
  ];
  for (const relativePath of executableFiles) {
    const source = fs
      .readFileSync(requireFile(relativePath))
      .toString(relativePath.endsWith(".wasm") ? "latin1" : "utf8");
    assert.doesNotMatch(
      source,
      /\bOBD\b|\$OBD|\bobd\b/i,
      `${relativePath} still exposes OBD`,
    );
  }
});

test("every child dependency resolves to an independently packaged module", () => {
  const flow = readJson("flow.json");
  const deps = readJson("deps.json");
  assert.equal(
    deps["com.digitalarsenal.flatsql.store"],
    "./nodes/flatsql",
    "Supplemental OMM must instantiate its independently packaged local FlatSQL node",
  );
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
    const artifactPath = path.resolve(packageRoot, node.artifact.path);
    assert.ok(fs.existsSync(artifactPath));
    assert.equal(
      crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex"),
      node.artifact.sha256,
      `${node.nodeId} graph binding must match its exact signed child bytes`,
    );
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
  assert.deepEqual(
    [...ui.matchAll(/<tr\s+data-provider=["']([^"']+)["']/g)].map((match) => match[1]),
    providers.map(([provider]) => provider),
    "the status board renders exactly the original five provider rows",
  );
  assert.doesNotMatch(ui, /data-provider=["']od["']|Orbit determination/i);
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
  assert.ok(
    app.dataflow.some(
      (route) =>
        route.name === "od-runtime-status" &&
        route.locator.endsWith("/runtime/nodes/od.dss"),
    ),
    "the APP must expose the signed OD status-node route",
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
