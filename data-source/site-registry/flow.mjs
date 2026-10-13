// The site-registry flow, composed by the provider deployment (stack
// deployment/site-registry-provider-node/build-flow.mjs), the same shape as
// data-source/gibs/flow.mjs:
// timer -> host config -> plan -> [http -> stage] x 8 -> finish -> attributed
// storage of both lanes (SIT.fbs and GNP.fbs, provider sdn-site-registry) ->
// egress (the run report and both ingest results).
import path from "node:path";

// Must equal the stage chain in src/driver.hpp.
export const STAGES = ["entities_a", "entities_b", "entities_c", "parties", "articles_a", "articles_b", "articles_c", "finish"];
export const PROGRAM_ID = "com.digitalarsenal.flows.site-registry-ingest";

export function siteRegistryFlow({ node, edge, http, storage, packageDir }) {
  const source = "com.digitalarsenal.data-source.site-registry", adapter = source + "-host";
  const nodes = [node("prepare", adapter, "prepare_scheduled"), node("plan", source, "plan")];
  const edges = [edge("prepare", "config", "plan", "config"), edge("prepare", "status", "egress", "result")];
  let previous = "plan";
  STAGES.forEach((stage, i) => {
    const fetch = `fetch${i}`;
    nodes.push(node(fetch, http, "request"), node(stage, source, stage));
    edges.push(edge(previous, "request", fetch, "request"), edge(previous, "state", stage, "state"), edge(fetch, "response", stage, "response"));
    previous = stage;
  });
  nodes.push(node("ingest_sites", storage, "ingest"), node("ingest_places", storage, "ingest"), node("egress", "sdn.flow.egress", "emit", "sink"));
  edges.push(edge("finish", "sites", "ingest_sites", "records"), edge("finish", "sites_meta", "ingest_sites", "meta"),
    edge("finish", "places", "ingest_places", "records"), edge("finish", "places_meta", "ingest_places", "meta"),
    edge("finish", "report", "egress", "result"), edge("ingest_sites", "result", "egress", "result"), edge("ingest_places", "result", "egress", "result"));
  return {
    flow: {
      programId: PROGRAM_ID, name: "SDN site registry", version: "0.1.0", engineLinkage: "bridge",
      description: "Every site the SpaceAware console shows, once a week: Wikidata class membership and items, operators, owners and regulators, the Global Energy Monitor nuclear tracker, the Research Organization Registry dump and the Wikipedia infoboxes of the nuclear, storage and chemical sites, reconciled in WASM into $SIT 1.1.0 records with a cited lifecycle, description, references, parties and quantities, and a $GNP search projection; stored with attribution (provider sdn-site-registry, sources sites and site-places) for the configured SDN auto-publisher. Disabled cycles emit status only.",
      nodes, edges,
      triggers: [{ triggerId: "weekly", kind: "timer", source: "host-cron", defaultIntervalMs: 168 * 3600000,
        description: "One registry run a week (about 230 requests: Wikidata, Wikipedia, GEM, Zenodo/ROR)." }],
      triggerBindings: [{ triggerId: "weekly", targetNodeId: "prepare", targetPortId: "tick", backpressurePolicy: "queue", queueDepth: 1 }],
      requiredPlugins: [adapter, source, http, storage],
    },
    deps: { [source]: packageDir, [adapter]: path.join(packageDir, "host-adapter") },
  };
}
