// The weekly flow: a timer tick plans the roster's GETs, the host executes them, build_sensors reads the responses, and the two
// lanes (space: satellite payloads, ground: ground sensors) are stored and published as $SNR streams.
export function sensorDefinitionsFlow({ node, edge, http, storage, packageDir }) {
  const source = "com.digitalarsenal.data-source.sensor-definitions";
  const nodes = [
    node("plan", source, "plan_sources"), node("fetch", http, "request"), node("build", source, "build_sensors"),
    node("ingest_space", storage, "ingest"), node("ingest_ground", storage, "ingest"),
    node("egress", "sdn.flow.egress", "emit", "sink"),
  ];
  const edges = [
    edge("plan", "request", "fetch", "request"), edge("fetch", "response", "build", "response"),
    edge("build", "space_records", "ingest_space", "snr_records"), edge("build", "space_meta", "ingest_space", "meta"),
    edge("build", "ground_records", "ingest_ground", "snr_records"), edge("build", "ground_meta", "ingest_ground", "meta"),
    edge("ingest_space", "result", "egress", "result"), edge("ingest_ground", "result", "egress", "result"),
    edge("build", "notice", "egress", "result"),
  ];
  return {
    flow: {
      programId: "com.digitalarsenal.flows.sensor-definitions-ingest",
      name: "Real-world sensor definitions ($SNR)", version: "0.1.1", engineLinkage: "bridge",
      description: "Typed TimerTick, HTTP and ingest contracts read the WMO OSCAR/Space instrument channel tables and satellite listings, the locally stored CelesTrak CAT identities and the ground-sensor pages of the roster into $SNR sensor definitions, one record per sensor on a platform, each value with its source, retrieval time, method and license. Two lanes: space (satellite payloads joined by NORAD_CAT_ID) and ground (sensors at a $SIT site).",
      nodes, edges,
      triggers: [{ triggerId: "weekly", kind: "timer", source: "host-cron", defaultIntervalMs: 604800000,
        description: "Refresh the sensor definitions weekly: OSCAR and the pages change slowly." }],
      triggerBindings: [{ triggerId: "weekly", targetNodeId: "plan", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 }],
      requiredPlugins: [source, http, storage],
    },
    deps: { [source]: packageDir },
  };
}
