// The NAIF kernel retrieval flow, composed by
// deployment/solar-system-provider-node/build-flow.mjs (kernels):
// timer -> host config -> file records -> summary/name records -> segment
// directories (+ middle summaries) -> directories found late + text kernels ->
// record windows -> decade shards -> ipfs.add (host adapter) -> receipt ->
// one $PNM per file -> attributed storage (provider naif, source ssb-kernels).
import path from "node:path";

export function kernelsFlow({ node, edge, http, storage, packageDir }) {
  const source = "com.digitalarsenal.data-source.naif-kernels", adapter = source + "-host";
  const stages = [1, 2, 3, 4];
  const nodes = [node("prepare", adapter, "prepare_scheduled"), node("plan", source, "plan_kernels"), node("fetch0", http, "request")];
  const edges = [edge("prepare", "config", "plan", "config"), edge("prepare", "status", "egress", "result"),
    edge("plan", "request", "fetch0", "request"), edge("plan", "state", "advance1", "state"), edge("fetch0", "response", "advance1", "response")];
  for (const s of stages) {
    nodes.push(node(`advance${s}`, source, "advance"), node(`fetch${s}`, http, "request"));
    const to = s < 4 ? `advance${s + 1}` : "build";
    edges.push(edge(`advance${s}`, "request", `fetch${s}`, "request"), edge(`advance${s}`, "state", to, "state"),
      edge(`fetch${s}`, "response", to, "response"), edge(`advance${s}`, "status", "egress", "result"));
  }
  nodes.push(node("build", source, "build_kernels"), node("publish", adapter, "publish_files"), node("receipt", adapter, "receipt_scheduled"),
    node("announce", source, "announce_kernels"), node("ingest", storage, "ingest"), node("egress", "sdn.flow.egress", "emit", "sink"));
  edges.push(edge("build", "file", "publish", "file"), edge("build", "job", "receipt", "job"),
    edge("publish", "added", "announce", "added"), edge("receipt", "job", "announce", "job"), edge("receipt", "receipt", "announce", "receipt"),
    edge("announce", "records", "ingest", "records"), edge("announce", "meta", "ingest", "meta"), edge("announce", "report", "egress", "result"),
    edge("ingest", "result", "egress", "result"));
  return {
    flow: {
      programId: "com.digitalarsenal.flows.naif-kernels-ingest", name: "Solar-system ephemerides and orientation (NAIF)", version: "0.1.0", engineLinkage: "bridge",
      description: "Planetary, satellite and small-body ephemerides and the lunar orientation from NASA/JPL NAIF and SSD, weekly: DAF file records, summaries, segment directories and Chebyshev record windows are read by HTTP range (no source kernel is downloaded whole), cut into decade shards in WASM with the source records unchanged, added to the node's IPFS, and announced as one $PNM per file (provider naif, source ssb-kernels); the configured SDN auto-publisher signs and announces the batch. When every source answers 304 to its validator the cycle ends unchanged. Disabled cycles emit status only.",
      nodes, edges,
      triggers: [{ triggerId: "weekly", kind: "timer", source: "host-cron", defaultIntervalMs: 7 * 86400000,
        description: "One kernel retrieval per week; unchanged sources answer 304 on the first stage and nothing else is fetched." }],
      triggerBindings: [{ triggerId: "weekly", targetNodeId: "prepare", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 }],
      requiredPlugins: [adapter, source, http, storage],
    },
    deps: { [source]: packageDir, [adapter]: path.join(packageDir, "host-adapter") },
  };
}
