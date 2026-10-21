const catalogs = ["lunar_orbit", "cislunar", "earth_moon_lagrange", "sun_earth_l1", "sun_earth_l2",
  "mercury_orbit", "venus_orbit", "mars_orbit", "jupiter_orbit", "saturn_orbit", "heliocentric"];

export function deepSpaceFlow({ node, edge: composeEdge, http, storage, packageDir }) {
  const edge = (from, fromPort, to, toPort) => {
    const e = composeEdge(from, fromPort, to, toPort);
    if (fromPort === "state") e.opaque = true;
    else delete e.opaque;
    return e;
  };
  const source = "com.digitalarsenal.data-source.deep-space-spacecraft";
  const nodes = [node("plan", source, "plan_horizons"), node("fetch0", http, "request")];
  const edges = [
    edge("plan", "request", "fetch0", "request"), edge("plan", "state", "advance1", "state"),
    edge("plan", "status", "egress", "result"), edge("fetch0", "response", "advance1", "response"),
  ];
  for (let stage = 1; stage <= 6; ++stage) {
    const advance = `advance${stage}`, fetch = `fetch${stage}`, next = stage < 6 ? `advance${stage + 1}` : "build";
    nodes.push(node(advance, source, "advance"), node(fetch, http, "request"));
    edges.push(edge(advance, "request", fetch, "request"), edge(advance, "status", "egress", "result"),
      edge(advance, "state", next, "state"), edge(fetch, "response", next, "response"));
  }
  nodes.push(node("build", source, "build_oem"));
  for (const id of [...catalogs, "catalogs"]) {
    const ingest = `ingest_${id}`;
    nodes.push(node(ingest, storage, "ingest"));
    edges.push(edge("build", `${id}_records`, ingest, id === "catalogs" ? "egp_records" : "oem_records"),
      edge("build", `${id}_meta`, ingest, "meta"), edge(ingest, "result", "egress", "result"));
  }
  nodes.push(node("egress", "sdn.flow.egress", "emit", "sink"));
  edges.push(edge("build", "notice", "egress", "result"));
  return {
    flow: {
      programId: "com.digitalarsenal.flows.deep-space-catalogs-ingest",
      name: "Beyond-Earth spacecraft catalogs (Horizons)", version: "0.2.0", engineLinkage: "bridge",
      description: "Typed TimerTick, HTTP and ingest contracts retrieve NASA/JPL Horizons ephemerides into eleven per-regime OEM catalogs and their EGP query groups. Source-owned provenance and current-batch metadata; disabled cycles emit a Skipped notice.",
      nodes, edges,
      triggers: [{ triggerId: "daily", kind: "timer", source: "host-cron", defaultIntervalMs: 86400000,
        description: "Refresh daily catalog windows and re-ingest the heliocentric archive." }],
      triggerBindings: [{ triggerId: "daily", targetNodeId: "plan", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 }],
      requiredPlugins: [source, http, storage],
    },
    deps: { [source]: packageDir },
  };
}
