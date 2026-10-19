// The high-resolution body imagery flow, for a provider node's flow builder (build.mjs composes and compiles it):
// timer -> this cycle (plugin.getConfig) -> the tile pyramid made from the source mosaic and filed through
// storage.ingest_with_source (PNM.fbs usgs-astrogeology/mars-themis-day-ir) -> egress. One module; it reaches the
// network through the node's http.request and the node's IPFS through ipfs.add.
export const TILES_PLUGIN = 'com.digitalarsenal.data-source.body-imagery-tiles';
export const TILES_PROGRAM = 'com.digitalarsenal.flows.mars-themis-imagery-ingest';

export function tilesFlow({node, edge, packageDir}) {
  const source = TILES_PLUGIN;
  return {
    flow: {
      programId: TILES_PROGRAM, name: 'Mars THEMIS Day IR imagery (USGS Astrogeology)', version: '0.1.0', engineLinkage: 'bridge',
      description: 'Mars imagery from the USGS Astrogeology THEMIS Day IR global mosaic 100 m v12 (NASA/JPL/ASU, public domain) as a 256 px JPEG tile pyramid to level 9 (81.4 m/px), planetocentric, read once by HTTP range, packs of 16 tiles added to the node\'s IPFS and filed as $PNM (provider usgs-astrogeology, source mars-themis-day-ir); the configured SDN auto-publisher signs and announces the lane. Disabled cycles emit status only.',
      nodes: [node('prepare', source, 'prepare_scheduled'), node('retrieve', source, 'retrieve_tiles'), node('egress', 'sdn.flow.egress', 'emit', 'sink')],
      edges: [edge('prepare', 'cycle', 'retrieve', 'cycle'), edge('prepare', 'status', 'egress', 'result'), edge('retrieve', 'report', 'egress', 'result')],
      triggers: [{triggerId: 'yearly', kind: 'timer', source: 'host-cron', defaultIntervalMs: 365 * 86400000,
        description: 'One cycle per year; the mosaic is a fixed release, so a cycle makes the same files under the same CIDs.'}],
      triggerBindings: [{triggerId: 'yearly', targetNodeId: 'prepare', targetPortId: 'tick', backpressurePolicy: 'queue', queueDepth: 1}],
      requiredPlugins: [source],
    },
    deps: {[source]: packageDir},
  };
}
