// A body's terrain retrieval flow, composed by the stack's deployment/solar-system-provider-node/build-flow.mjs
// (flow-moon.mjs, flow-mars.mjs), like body-imagery's and naif-kernels' flows:
// timer -> the durable $IRM mark (flatsql-query) -> body_plan (one unit: per file of the unit's PDS product, its PDS3
// label and whole-line ranges of its image, the tiles' $DTT body plan; config body names the body's table) -> the
// http requests -> terrain-source:tile (quantized mesh on the body's reference sphere, oct normals, the 32 KiB
// ceiling) -> terrain-source:pack (root.dtts / 4x4 block files) -> ipfs.add (host adapter, one $PNM per file) ->
// announce_files ($PNM records + IngestRequest under the body's provider and source) -> attributed storage ->
// publish_request (the mark advances from the verified store result) -> storage-write (the mark) and egress. Every
// frame between nodes is a FlatBuffer.
import path from "node:path";

export function bodyTerrainFlow({
  node,
  edge,
  http,
  storage,
  packageDir,
  query = "com.digitalarsenal.hostcap.flatsql-query",
  write = "com.digitalarsenal.hostcap.storage-write",
}, { programId, name, description, triggerId, triggerDescription, requests }) {
  const dem = Array.from({ length: requests }, (_, k) => k);
  const ingest = "com.digitalarsenal.data-source.terrain-ingest", source = "com.digitalarsenal.data-source.terrain-source";
  const adapter = "com.digitalarsenal.data-source.terrain-ingest-host";
  const nodes = [
    node("mark_q", ingest, "mark_query"), node("mark_read", query, "query"), node("plan", ingest, "body_plan"),
    ...dem.map((k) => node(`http_dem_${k}`, http, "request")),
    node("tile", source, "tile"), node("pack", source, "pack"), node("publish", adapter, "publish_files"),
    node("announce", ingest, "announce_files"), node("ingest", storage, "ingest"),
    node("mark", ingest, "publish_request"), node("mark_write", write, "write_record"),
    node("egress", "sdn.flow.egress", "emit", "sink"),
  ];
  const edges = [
    edge("mark_q", "query", "mark_read", "query"), edge("mark_read", "records", "plan", "mark"),
    edge("mark_read", "status", "egress", "result"),
    ...dem.flatMap((k) => [edge("plan", `dem_${k}`, `http_dem_${k}`, "request"), edge(`http_dem_${k}`, "response", "tile", "dem")]),
    edge("plan", "plan", "tile", "plan"), edge("plan", "options", "tile", "options"),
    edge("tile", "records", "pack", "records"), edge("plan", "pack", "pack", "options"), edge("tile", "report", "egress", "result"),
    edge("pack", "file", "publish", "file"), edge("pack", "names", "publish", "names"),
    edge("publish", "added", "announce", "added"), edge("plan", "job", "announce", "job"),
    edge("announce", "records", "ingest", "pnm_records"), edge("announce", "meta", "ingest", "meta"),
    edge("ingest", "result", "mark", "result"), edge("announce", "meta", "mark", "meta"), edge("plan", "job", "mark", "job"),
    edge("mark", "mark", "mark_write", "record"), edge("mark", "mark", "egress", "result"),
    edge("mark_write", "result", "egress", "result"), edge("ingest", "result", "egress", "result"),
  ];
  return {
    flow: {
      programId, name, version: "0.1.0", engineLinkage: "bridge", description,
      nodes, edges,
      triggers: [{ triggerId, kind: "timer", source: "host-cron", defaultIntervalMs: 60000, description: triggerDescription }],
      triggerBindings: [
        { triggerId, targetNodeId: "mark_q", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 },
        { triggerId, targetNodeId: "plan", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 },
      ],
      requiredPlugins: [ingest, source, adapter, http, query, storage, write],
    },
    deps: { [ingest]: packageDir, [source]: path.join(packageDir, "..", "terrain-source"), [adapter]: path.join(packageDir, "host-adapter") },
  };
}
