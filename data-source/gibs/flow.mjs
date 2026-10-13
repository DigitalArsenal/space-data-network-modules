// The GIBS layer-catalog flow, composed by the provider deployment (the same
// shape as data-source/naif-kernels/flow.mjs):
// timer -> host config -> the three WMTS Capabilities documents -> parse and
// plan -> 30 batches of layer-metadata and DescribeDomains requests -> the
// merged Capabilities document -> ipfs.add (host adapter) -> receipt -> one
// $PNM -> attributed storage (provider nasa-gibs, source layer-catalog).
import path from "node:path";

// Must equal kBatches in src/gibs.cpp: plan_details asks for batch 0, advance
// for batches 1..BATCHES-1, build_catalog absorbs the last.
export const BATCHES = 30;

export function gibsCatalogFlow({ node, edge, http, storage, packageDir }) {
  const source = "com.digitalarsenal.data-source.gibs", adapter = source + "-host";
  const nodes = [node("prepare", adapter, "prepare_scheduled"), node("plan", source, "plan_capabilities"), node("caps", http, "request"),
    node("details", source, "plan_details"), node("fetch0", http, "request")];
  const edges = [edge("prepare", "config", "plan", "config"), edge("prepare", "status", "egress", "result"),
    edge("plan", "request", "caps", "request"), edge("plan", "state", "details", "state"), edge("caps", "response", "details", "response"),
    edge("details", "request", "fetch0", "request"), edge("details", "state", "advance1", "state"), edge("fetch0", "response", "advance1", "response")];
  for (let b = 1; b < BATCHES; b += 1) {
    const to = b < BATCHES - 1 ? `advance${b + 1}` : "build";
    nodes.push(node(`advance${b}`, source, "advance"), node(`fetch${b}`, http, "request"));
    edges.push(edge(`advance${b}`, "request", `fetch${b}`, "request"), edge(`advance${b}`, "state", to, "state"),
      edge(`fetch${b}`, "response", to, "response"));
  }
  nodes.push(node("build", source, "build_catalog"), node("publish", adapter, "publish_files"), node("receipt", adapter, "receipt_scheduled"),
    node("announce", source, "announce_catalog"), node("ingest", storage, "ingest"), node("egress", "sdn.flow.egress", "emit", "sink"));
  edges.push(edge("build", "file", "publish", "file"), edge("build", "job", "receipt", "job"),
    edge("publish", "added", "announce", "added"), edge("receipt", "job", "announce", "job"), edge("receipt", "receipt", "announce", "receipt"),
    edge("announce", "records", "ingest", "records"), edge("announce", "meta", "ingest", "meta"), edge("announce", "report", "egress", "result"),
    edge("ingest", "result", "egress", "result"));
  return {
    flow: {
      programId: "com.digitalarsenal.flows.gibs-layer-catalog-ingest", name: "NASA GIBS layer catalog", version: "0.1.0", engineLinkage: "bridge",
      description: "Every NASA GIBS visualization layer, twice a day: the EPSG:3857, EPSG:3413 and EPSG:3031 WMTS Capabilities documents, the GIBS layer metadata of every layer and the full time domain of every layer whose Capabilities time list is truncated, merged in WASM into one WMTS 1.0.0 Capabilities document, added to the node's IPFS and announced as one $PNM (provider nasa-gibs, source layer-catalog); the configured SDN auto-publisher signs and announces it. Disabled cycles emit status only.",
      nodes, edges,
      triggers: [{ triggerId: "twice-daily", kind: "timer", source: "host-cron", defaultIntervalMs: 12 * 3600000,
        description: "One catalog retrieval every twelve hours (about 1,400 small requests to GIBS per cycle)." }],
      triggerBindings: [{ triggerId: "twice-daily", targetNodeId: "prepare", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 }],
      requiredPlugins: [adapter, source, http, storage],
    },
    deps: { [source]: packageDir, [adapter]: path.join(packageDir, "host-adapter") },
  };
}
