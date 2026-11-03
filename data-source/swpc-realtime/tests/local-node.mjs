import {localNode as base} from '../../space-weather/tests/local-node.mjs';
export async function localNode(binary){
 const node=await base(binary);
 // An empty bootstrap list invokes the node's built-in public defaults even
 // with DHT disabled. A closed loopback endpoint prevents that fallback.
 node.config.network.bootstrap=['/ip4/127.0.0.1/tcp/1/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN'];
 return node;
}
