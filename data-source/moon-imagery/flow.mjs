// The Moon imagery retrieval flow, composed by the stack's deployment/solar-system-provider-node/build-flow.mjs
// (moon-imagery): timer -> the durable $IRM mark (terrain-ingest mark_query, hostcap/flatsql-query) -> wac_plan (one
// unit: whole-row ranges of the LROC WAC mosaic, or the stored level-5 tiles for the coarse unit) -> four http
// requests / one flatsql query -> wac_tile (JPEG $DTT tiles packed into files; level 5 also as records to store) ->
// ipfs.add (terrain-ingest host adapter, one $PNM per file) -> announce_files ($PNM records + IngestRequest, provider
// usgs-astrogeology, source moon-lroc-wac) -> attributed storage -> publish_request (the mark advances from the
// verified store result) -> storage-write (the mark) and egress. Every frame between nodes is a FlatBuffer.
import path from "node:path";

export function moonImageryFlow({
  node,
  edge,
  http,
  storage,
  packageDir,
  query = "com.digitalarsenal.hostcap.flatsql-query",
  write = "com.digitalarsenal.hostcap.storage-write",
}) {
  const imagery = "com.digitalarsenal.data-source.moon-imagery", ingest = "com.digitalarsenal.data-source.terrain-ingest";
  const adapter = "com.digitalarsenal.data-source.terrain-ingest-host";
  const parts = [0, 1, 2, 3];
  const nodes = [
    node("mark_q", ingest, "mark_query"), node("mark_read", query, "query"), node("plan", imagery, "wac_plan"),
    ...parts.map((k) => node(`http_rows_${k}`, http, "request")), node("child_read", query, "query"),
    node("tile", imagery, "wac_tile"), node("publish", adapter, "publish_files"),
    node("announce", ingest, "announce_files"), node("ingest", storage, "ingest"), node("ingest_tiles", storage, "ingest"),
    node("mark", ingest, "publish_request"), node("mark_write", write, "write_record"),
    node("egress", "sdn.flow.egress", "emit", "sink"),
  ];
  const edges = [
    edge("mark_q", "query", "mark_read", "query"), edge("mark_read", "records", "plan", "mark"),
    edge("mark_read", "status", "egress", "result"),
    ...parts.flatMap((k) => [edge("plan", `rows_${k}`, `http_rows_${k}`, "request"), edge(`http_rows_${k}`, "response", "tile", `rows_${k}`)]),
    edge("plan", "children", "child_read", "query"), edge("child_read", "records", "tile", "children"),
    edge("child_read", "status", "egress", "result"),
    edge("plan", "unit", "tile", "unit"), edge("plan", "job", "tile", "job"),
    edge("tile", "file", "publish", "file"), edge("tile", "names", "publish", "names"),
    edge("publish", "added", "announce", "added"), edge("plan", "job", "announce", "job"),
    edge("announce", "records", "ingest", "pnm_records"), edge("announce", "meta", "ingest", "meta"),
    edge("tile", "records", "ingest_tiles", "dtt_records"), edge("tile", "meta", "ingest_tiles", "meta"),
    edge("ingest_tiles", "result", "egress", "result"),
    edge("ingest", "result", "mark", "result"), edge("announce", "meta", "mark", "meta"), edge("plan", "job", "mark", "job"),
    edge("mark", "mark", "mark_write", "record"), edge("mark", "mark", "egress", "result"),
    edge("mark_write", "result", "egress", "result"), edge("ingest", "result", "egress", "result"),
  ];
  return {
    flow: {
      programId: "com.digitalarsenal.flows.moon-imagery-ingest", name: "Moon imagery (LRO LROC WAC)", version: "0.1.0", engineLinkage: "bridge",
      description: "The Moon's imagery from the USGS Astrogeology LRO LROC WAC global mosaic (100 m/px, June 2013, public domain), one unit per tick: wac_plan resumes the walk from the durable $IRM mark and asks for one tile row of one level as whole-row byte ranges of the mosaic (If-Match on its ETag), or for the stored level-5 tiles; wac_tile area-averages the rows in WASM into 256 px JPEG tiles on the Moon's two-root geographic scheme, one $DTT record each (PAYLOAD_FORMAT CUSTOM, image/jpeg), packed into imagery/301/root.dtts and 16-tile row files; the host adapter adds each file to the node's IPFS and announce_files publishes one $PNM per file (provider usgs-astrogeology, source moon-lroc-wac), which the console resolves and fetches by CID; publish_request advances the mark only from the verified store result. Levels 5-8 from the mosaic's rows, 0-4 from the stored level-5 tiles. The configured SDN auto-publisher signs and announces each batch.",
      nodes, edges,
      triggers: [{ triggerId: "moon-imagery-unit", kind: "timer", source: "host-cron", defaultIntervalMs: 60000,
        description: "One unit of the walk per tick (481 units for the whole Moon); a drained walk is a clean no-op." }],
      triggerBindings: [
        { triggerId: "moon-imagery-unit", targetNodeId: "mark_q", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 },
        { triggerId: "moon-imagery-unit", targetNodeId: "plan", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 },
      ],
      requiredPlugins: [imagery, ingest, adapter, http, query, storage, write],
    },
    deps: {
      [imagery]: packageDir,
      [ingest]: path.join(packageDir, "..", "terrain-ingest"),
      [adapter]: path.join(packageDir, "..", "terrain-ingest", "host-adapter"),
    },
  };
}
