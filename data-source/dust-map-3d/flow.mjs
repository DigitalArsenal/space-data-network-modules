// The 3D dust map retrieval flow, for a provider node's flow builder:
// timer -> host config -> FITS headers -> STD header -> radial tables and the
// inner sphere -> ten stages of 48 MEAN shells -> the last 36 shells and the
// rows -> storage ingest (provider edenhofer2024, source local-dust-1250pc).
// The receipt (clock + producer) comes from the host adapter at cycle start.
import path from "node:path";

export function dustMapFlow({ node, edge, http, storage, packageDir }) {
  const source = "com.digitalarsenal.data-source.dust-map-3d", adapter = source + "-host";
  const lastAdvance = 13;  // advance_dust stages 1..13; build_dust takes stage 14
  const nodes = [node("prepare", adapter, "prepare_scheduled"), node("plan", source, "plan_dust"), node("fetch1", http, "request"),
    node("receipt", adapter, "receipt_scheduled")];
  const edges = [edge("prepare", "config", "plan", "config"), edge("prepare", "config", "receipt", "config"),
    edge("prepare", "status", "egress", "result"), edge("plan", "request", "fetch1", "request"), edge("plan", "state", "advance1", "state"),
    edge("fetch1", "response", "advance1", "response")];
  for (let s = 1; s <= lastAdvance; ++s) {
    const to = s < lastAdvance ? `advance${s + 1}` : "build";
    nodes.push(node(`advance${s}`, source, "advance_dust"), node(`fetch${s + 1}`, http, "request"));
    edges.push(edge(`advance${s}`, "request", `fetch${s + 1}`, "request"), edge(`advance${s}`, "state", to, "state"),
      edge(`fetch${s + 1}`, "response", to, "response"), edge(`advance${s}`, "status", "egress", "result"));
  }
  nodes.push(node("build", source, "build_dust"), node("ingest", storage, "ingest"), node("egress", "sdn.flow.egress", "emit", "sink"));
  edges.push(edge("receipt", "receipt", "build", "receipt"), edge("build", "records", "ingest", "records"),
    edge("build", "meta", "ingest", "meta"), edge("build", "report", "egress", "result"), edge("ingest", "result", "egress", "result"));
  return {
    flow: {
      programId: "com.digitalarsenal.flows.dust-map-3d-ingest", name: "Local 3D interstellar dust (Edenhofer et al. 2024)", version: "0.1.0", engineLinkage: "bridge",
      description: "The posterior mean of the Edenhofer et al. (2024) local 3D dust map (Zenodo 10658339, CC BY 4.0), monthly: FITS headers, the radial tables and 516 HEALPix shells are read by HTTP range (1.63 GB; the file is never downloaded whole), resampled in WASM to 20 pc heliocentric voxels, and stored as 61 $PCE rows (provider edenhofer2024, source local-dust-1250pc) that the configured SDN auto-publisher signs and announces. When the header range answers 304 the cycle ends unchanged. Disabled cycles emit status only.",
      nodes, edges,
      triggers: [{ triggerId: "monthly", kind: "timer", source: "host-cron", defaultIntervalMs: 30 * 86400000,
        description: "One retrieval per month; the published v1.0.2 map is static, so an unchanged source ends at the first stage." }],
      triggerBindings: [{ triggerId: "monthly", targetNodeId: "prepare", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 }],
      requiredPlugins: [adapter, source, http, storage],
    },
    deps: { [source]: packageDir, [adapter]: path.join(packageDir, "host-adapter") },
  };
}
