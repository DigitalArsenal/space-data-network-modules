// The body imagery retrieval flow, composed by
// deployment/solar-system-provider-node/build-flow.mjs (imagery):
// timer -> host config -> the first MiB of every source -> directory arrays
// -> image data in whole strips or tile rows (at most three 48 MiB ranges per
// stage) -> tile packs and textures -> ipfs.add (host adapter) -> receipt ->
// one $PNM per file -> attributed storage (provider usgs-astrogeology, source
// body-imagery).
import path from "node:path";

// Stages after plan_imagery: the directories, then about 4.3 GB of mosaics at
// up to 144 MiB per stage (measured: 91 ranges of 48 MiB over 21 bodies), with
// room to spare. A run that finishes early keeps the chain with a one-byte range.
export const IMAGERY_STAGES = 40;

export function imageryFlow({ node, edge, http, storage, packageDir }) {
  const source = "com.digitalarsenal.data-source.body-imagery", adapter = source + "-host";
  const nodes = [node("prepare", adapter, "prepare_scheduled"), node("plan", source, "plan_imagery"), node("fetch0", http, "request")];
  const edges = [edge("prepare", "config", "plan", "config"), edge("prepare", "status", "egress", "result"),
    edge("plan", "request", "fetch0", "request"), edge("plan", "state", "advance1", "state"), edge("fetch0", "response", "advance1", "response")];
  for (let s = 1; s <= IMAGERY_STAGES; s++) {
    nodes.push(node(`advance${s}`, source, "advance_imagery"), node(`fetch${s}`, http, "request"));
    const to = s < IMAGERY_STAGES ? `advance${s + 1}` : "build";
    edges.push(edge(`advance${s}`, "request", `fetch${s}`, "request"), edge(`advance${s}`, "state", to, "state"),
      edge(`fetch${s}`, "response", to, "response"));
  }
  nodes.push(node("build", source, "build_imagery"), node("publish", adapter, "publish_files"), node("receipt", adapter, "receipt_scheduled"),
    node("announce", source, "announce_imagery"), node("ingest", storage, "ingest"), node("egress", "sdn.flow.egress", "emit", "sink"));
  edges.push(edge("build", "file", "publish", "file"), edge("build", "job", "receipt", "job"),
    edge("publish", "added", "announce", "added"), edge("receipt", "job", "announce", "job"), edge("receipt", "receipt", "announce", "receipt"),
    edge("announce", "records", "ingest", "records"), edge("announce", "meta", "ingest", "meta"), edge("announce", "report", "egress", "result"),
    edge("ingest", "result", "egress", "result"));
  return {
    flow: {
      programId: "com.digitalarsenal.flows.body-imagery-ingest", name: "Planet and moon imagery (USGS Astrogeology, NASA)", version: "0.1.0", engineLinkage: "bridge",
      description: "Planet, moon and asteroid imagery for the console's bodies from public-domain NASA mission global mosaics (USGS Astrogeology, NASA SVS, NASA/JPL Photojournal), monthly: each GeoTIFF is read by HTTP range (never held whole), decoded and area-averaged in WASM into a planetodetic grid on the body's PCK ellipsoid, cut into a JPEG tile pack and a whole-body texture, added to the node's IPFS and announced as one $PNM per file (provider usgs-astrogeology, source body-imagery); the configured SDN auto-publisher signs and announces the batch. Disabled cycles emit status only.",
      nodes, edges,
      triggers: [{ triggerId: "monthly", kind: "timer", source: "host-cron", defaultIntervalMs: 30 * 86400000,
        description: "One imagery retrieval per month (the mosaics change rarely; an unchanged run republishes the same files under the same CIDs)." }],
      triggerBindings: [{ triggerId: "monthly", targetNodeId: "prepare", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 }],
      requiredPlugins: [adapter, source, http, storage],
    },
    deps: { [source]: packageDir, [adapter]: path.join(packageDir, "host-adapter") },
  };
}
