// The Moon terrain retrieval flow, composed by the stack's
// deployment/solar-system-provider-node/build-flow.mjs (moon-terrain), like body-imagery's and naif-kernels' flows:
// timer -> the durable $IRM mark (flatsql-query) -> lola_plan (one unit: a LOLA product's PDS3 label and three
// whole-line ranges of its image, the tiles' $DTT body plan) -> four http requests -> terrain-source:tile (quantized
// mesh on the 1737.4 km sphere, oct normals, the 32 KiB ceiling) -> terrain-source:pack (root.dtts / 4x4 block files)
// -> ipfs.add (host adapter, one $PNM per file) -> announce_files ($PNM records + IngestRequest, provider nasa-lola,
// source moon-terrain) -> attributed storage -> publish_request (the mark advances from the verified store result) ->
// storage-write (the mark) and egress. Every frame between nodes is a FlatBuffer.
import path from "node:path";

export function moonTerrainFlow({
  node,
  edge,
  http,
  storage,
  packageDir,
  query = "com.digitalarsenal.hostcap.flatsql-query",
  write = "com.digitalarsenal.hostcap.storage-write",
}) {
  const ingest = "com.digitalarsenal.data-source.terrain-ingest", source = "com.digitalarsenal.data-source.terrain-source";
  const adapter = "com.digitalarsenal.data-source.terrain-ingest-host";
  const nodes = [
    node("mark_q", ingest, "mark_query"), node("mark_read", query, "query"), node("plan", ingest, "lola_plan"),
    ...[0, 1, 2, 3].map((k) => node(`http_dem_${k}`, http, "request")),
    node("tile", source, "tile"), node("pack", source, "pack"), node("publish", adapter, "publish_files"),
    node("announce", ingest, "announce_files"), node("ingest", storage, "ingest"),
    node("mark", ingest, "publish_request"), node("mark_write", write, "write_record"),
    node("egress", "sdn.flow.egress", "emit", "sink"),
  ];
  const edges = [
    edge("mark_q", "query", "mark_read", "query"), edge("mark_read", "records", "plan", "mark"),
    edge("mark_read", "status", "egress", "result"),
    ...[0, 1, 2, 3].flatMap((k) => [edge("plan", `dem_${k}`, `http_dem_${k}`, "request"), edge(`http_dem_${k}`, "response", "tile", "dem")]),
    edge("plan", "plan", "tile", "plan"), edge("plan", "options", "tile", "options"),
    edge("tile", "records", "pack", "records"), edge("plan", "pack", "pack", "options"), edge("tile", "report", "egress", "result"),
    edge("pack", "file", "publish", "file"), edge("pack", "names", "publish", "names"),
    edge("publish", "added", "announce", "added"), edge("plan", "job", "announce", "job"),
    edge("announce", "records", "ingest", "records"), edge("announce", "meta", "ingest", "meta"),
    edge("ingest", "result", "mark", "result"), edge("announce", "meta", "mark", "meta"), edge("plan", "job", "mark", "job"),
    edge("mark", "mark", "mark_write", "record"), edge("mark", "mark", "egress", "result"),
    edge("mark_write", "result", "egress", "result"), edge("ingest", "result", "egress", "result"),
  ];
  return {
    flow: {
      programId: "com.digitalarsenal.flows.moon-terrain-ingest", name: "Moon terrain (NASA LRO LOLA)", version: "0.1.0", engineLinkage: "bridge",
      description: "The Moon's terrain from the NASA LRO LOLA gridded products in the PDS Geosciences Node (public domain), one unit per tick: lola_plan resumes the walk from the durable $IRM mark and asks for the product's PDS3 label and three whole-line byte ranges of its image (If-Match on the product's ETag, so a reprocessed product stops the run); terrain-source decodes them in WASM into quantized-mesh tiles on the 1737.4 km reference sphere (GEOGRAPHIC_TWO_ROOT_BODY, oct-encoded normals, no water mask, 32 KiB per tile) and packs them into root.dtts and 4x4 block files (size-prefixed $DTT streams); the host adapter adds each file to the node's IPFS and announce_files publishes one $PNM per file (provider nasa-lola, source moon-terrain), which the console resolves through SOLAR_SYSTEM_LANES.terrain and fetches by CID; publish_request advances the mark only from the verified store result. Levels 0-3 from LDEM_4, 4-5 from LDEM_16, 6-7 from LDEM_64, 8-10 from the polar products over the latitude caps in lola_caps. The configured SDN auto-publisher signs and announces each batch.",
      nodes, edges,
      triggers: [{ triggerId: "moon-terrain-unit", kind: "timer", source: "host-cron", defaultIntervalMs: 60000,
        description: "One unit of the walk per tick (about 200 units for the whole Moon); a drained walk is a clean no-op until lola_caps or the edition changes." }],
      triggerBindings: [
        { triggerId: "moon-terrain-unit", targetNodeId: "mark_q", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 },
        { triggerId: "moon-terrain-unit", targetNodeId: "plan", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 },
      ],
      requiredPlugins: [ingest, source, adapter, http, query, storage, write],
    },
    deps: { [ingest]: packageDir, [source]: path.join(packageDir, "..", "terrain-source"), [adapter]: path.join(packageDir, "host-adapter") },
  };
}
