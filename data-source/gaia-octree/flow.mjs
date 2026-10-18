// The Gaia retrieval flow, for a provider node's flow builder (build.mjs
// composes and compiles it): timer -> this cycle (plugin.getConfig) -> both
// layers made from ESA's Gaia archive and filed through
// storage.ingest_with_source (SKT.fbs gaia-dr3/angular-g13.5 and
// gaia-dr3/octree-g13.5) -> egress. One module; it reaches the network
// through the node's http.request.
export const GAIA_PLUGIN = 'com.digitalarsenal.data-source.gaia-octree';
export const GAIA_PROGRAM = 'com.digitalarsenal.flows.gaia-octree-ingest';

export function gaiaFlow({node, edge, packageDir}) {
  const source = GAIA_PLUGIN;
  return {
    flow: {
      programId: GAIA_PROGRAM, name: 'Gaia DR3 (angular layer and 3D octree)', version: '0.1.0', engineLinkage: 'bridge',
      description: 'Gaia DR3 to G 13.5 with Bailer-Jones et al. 2021 distances and Hipparcos 2007 for the brightest and Gaia-missing stars, as two $SKT layers (provider gaia-dr3): angular-g13.5, HEALPix order-4 tiles of $STR rows, and octree-g13.5, a magnitude-sorted heliocentric octree of the stars with distances good to 50%. Tile payloads are added to the node\'s IPFS; the configured SDN auto-publisher signs and announces the index records. Disabled cycles emit status only.',
      nodes: [node('prepare', source, 'prepare_scheduled'), node('retrieve', source, 'retrieve_gaia'), node('egress', 'sdn.flow.egress', 'emit', 'sink')],
      edges: [edge('prepare', 'cycle', 'retrieve', 'cycle'), edge('prepare', 'status', 'egress', 'result'), edge('retrieve', 'report', 'egress', 'result')],
      triggers: [{triggerId: 'monthly', kind: 'timer', source: 'host-cron', defaultIntervalMs: 30 * 86400000,
        description: 'One cycle per 30 days; Gaia DR3 is a fixed release, so a cycle files the same stars again.'}],
      triggerBindings: [{triggerId: 'monthly', targetNodeId: 'prepare', targetPortId: 'tick', backpressurePolicy: 'queue', queueDepth: 1}],
      requiredPlugins: [source],
    },
    deps: {[source]: packageDir},
  };
}
