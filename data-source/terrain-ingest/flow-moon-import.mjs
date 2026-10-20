// The Moon terrain IMPORT flow: the Moon walk's units encoded elsewhere by the same modules (terrain-ingest:body_plan,
// terrain-source:tile and pack; data-source/terrain-source/tools/body-encode.mjs) and published by this node as the
// walk publishes its own. Composed by the stack's deployment/solar-system-provider-node/build-flow.mjs:
// timer -> the import's durable $IRM mark (flatsql-query) -> import_plan (the walk's unit at the mark, never below
// import_from_unit: one GET per file from import_base_url, the files' names, the job) -> one http node (every GET,
// answered in order) -> import_files (each answer checked to be the file it names) -> ipfs.add (host adapter, one $PNM
// per file) -> announce_files ($PNM records + IngestRequest under nasa-lola / moon-terrain) -> attributed storage ->
// publish_request (the mark advances from the verified store result) -> storage-write (the mark) and egress. Every
// frame between nodes is a FlatBuffer.
import path from "node:path";

export function moonTerrainImportFlow({
  node,
  edge,
  http,
  storage,
  packageDir,
  query = "com.digitalarsenal.hostcap.flatsql-query",
  write = "com.digitalarsenal.hostcap.storage-write",
}) {
  const ingest = "com.digitalarsenal.data-source.terrain-ingest";
  const adapter = "com.digitalarsenal.data-source.terrain-ingest-host";
  const nodes = [
    node("mark_q", ingest, "mark_query"), node("mark_read", query, "query"), node("plan", ingest, "import_plan"),
    node("http_files", http, "request"), node("files", ingest, "import_files"), node("publish", adapter, "publish_files"),
    node("announce", ingest, "announce_files"), node("ingest", storage, "ingest"),
    node("mark", ingest, "publish_request"), node("mark_write", write, "write_record"),
    node("egress", "sdn.flow.egress", "emit", "sink"),
  ];
  const edges = [
    edge("mark_q", "query", "mark_read", "query"), edge("mark_read", "records", "plan", "mark"),
    edge("mark_read", "status", "egress", "result"),
    edge("plan", "files", "http_files", "request"), edge("http_files", "response", "files", "responses"),
    edge("plan", "names", "files", "names"),
    edge("files", "file", "publish", "file"), edge("files", "names", "publish", "names"),
    edge("publish", "added", "announce", "added"), edge("plan", "job", "announce", "job"),
    edge("announce", "records", "ingest", "pnm_records"), edge("announce", "meta", "ingest", "meta"),
    edge("ingest", "result", "mark", "result"), edge("announce", "meta", "mark", "meta"), edge("plan", "job", "mark", "job"),
    edge("mark", "mark", "mark_write", "record"), edge("mark", "mark", "egress", "result"),
    edge("mark_write", "result", "egress", "result"), edge("ingest", "result", "egress", "result"),
  ];
  const triggerId = "moon-terrain-import-unit";
  return {
    flow: {
      programId: "com.digitalarsenal.flows.moon-terrain-import",
      name: "Moon terrain import (NASA LRO LOLA, encoded elsewhere)",
      version: "0.1.0",
      engineLinkage: "bridge",
      description: "The Moon's terrain units the walk's own modules encoded on another machine, published by this node exactly as the walk publishes its own: import_plan plans the walk's unit (the same body, tileset, edition and caps) at the import's own durable $IRM mark, never below import_from_unit, and GETs its files (terrain/301/<L>/<X>_<Y>.dtts) from import_base_url, where they are staged; import_files checks each is the file it names; the host adapter adds each to the node's IPFS and announce_files publishes one $PNM per file (provider nasa-lola, source moon-terrain, BATCH_ID tileset@epoch#unit); publish_request advances the mark only from the verified store result. A file not staged yet stops the unit and the next tick asks again. The configured SDN auto-publisher signs and announces each batch.",
      nodes, edges,
      triggers: [{ triggerId, kind: "timer", source: "host-cron", defaultIntervalMs: 10000, description: "One import unit per tick (up to 32 staged files); a drained import is a clean no-op." }],
      triggerBindings: [
        { triggerId, targetNodeId: "mark_q", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 },
        { triggerId, targetNodeId: "plan", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 },
      ],
      requiredPlugins: [ingest, adapter, http, query, storage, write],
    },
    deps: { [ingest]: packageDir, [adapter]: path.join(packageDir, "host-adapter") },
  };
}
