// The weekly flow: a timer tick plans the roster's GETs, the host executes them, build_infrastructure reads the responses, and the two lanes
// (sites: $SIT, sensors: $SNR) are stored and published.
export function spaceInfrastructureFlow({ node, edge, http, storage, packageDir }) {
  const source = "com.digitalarsenal.data-source.space-infrastructure";
  const nodes = [
    node("plan", source, "plan_sources"), node("fetch", http, "request"), node("build", source, "build_infrastructure"),
    node("ingest_sites", storage, "ingest"), node("ingest_sensors", storage, "ingest"),
    node("egress", "sdn.flow.egress", "emit", "sink"),
  ];
  const edges = [
    edge("plan", "request", "fetch", "request"), edge("fetch", "response", "build", "response"),
    edge("build", "site_records", "ingest_sites", "sit_records"), edge("build", "site_meta", "ingest_sites", "meta"),
    edge("build", "sensor_records", "ingest_sensors", "snr_records"), edge("build", "sensor_meta", "ingest_sensors", "meta"),
    edge("ingest_sites", "result", "egress", "result"), edge("ingest_sensors", "result", "egress", "result"),
    edge("build", "notice", "egress", "result"),
  ];
  return {
    flow: {
      programId: "com.digitalarsenal.flows.space-infrastructure-ingest",
      name: "Space-surveillance and missile-warning sensor sites ($SIT, $SNR)", version: "0.1.0", engineLinkage: "bridge",
      description: "Typed TimerTick, HTTP and ingest contracts read the Wikidata entities, Wikipedia articles and OpenStreetMap elements of the roster into $SIT sites and the $SNR sensors at them, each position cross-checked between sources and each value quoted from its source with its retrieval time and license. Two lanes: sites and sensors.",
      nodes, edges,
      triggers: [{ triggerId: "weekly", kind: "timer", source: "host-cron", defaultIntervalMs: 604800000,
        description: "Refresh the catalog weekly: the sites change slowly; a changed record is a changed hash in the lane metadata." }],
      triggerBindings: [{ triggerId: "weekly", targetNodeId: "plan", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 }],
      requiredPlugins: [source, http, storage],
    },
    deps: { [source]: packageDir },
  };
}
