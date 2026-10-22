// Adapted from gaia-octree/tests/lib/provider-node.mjs. Uses the real native
// SDN daemon's in-process Kubo, isolated loopback ports, and lane-owned state.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

const freePort = () => new Promise((resolve,reject) => {
  const server = net.createServer();
  server.once('error',reject);
  server.listen(0,'127.0.0.1',()=>{const {port}=server.address(); server.close(()=>resolve(port));});
});

export async function createLocalNode(binary,workRoot) {
  assert.ok(binary && path.isAbsolute(binary),'SDN_NODE_BINARY must name an absolute native full-node binary path');
  assert.ok(workRoot && path.isAbsolute(workRoot),'SOLAR_NODE_WORK must name a durable lane-owned directory');
  await fs.mkdir(workRoot,{recursive:true});
  const resolved = await fs.realpath(workRoot);
  assert.ok(!/^\/(?:private\/)?tmp(?:\/|$)/.test(resolved),'Node state must not be under /tmp');
  const dir = await fs.mkdtemp(path.join(resolved,'solar-node-'));
  const ports = {};
  for (const name of ['tcp','ws','admin','kubo','gateway']) {
    do { ports[name] = await freePort(); } while (Object.values(ports).filter(p=>p===ports[name]).length>1);
  }
  const config = {
    mode:'full',network:{listen:[`/ip4/127.0.0.1/tcp/${ports.tcp}`,`/ip4/127.0.0.1/tcp/${ports.ws}/ws`],
      bootstrap:[],max_connections:16,enable_relay:false,dht_server:false},
    storage:{path:path.join(dir,'data'),max_size:'1GiB'},setup:{data_path:dir},
    admin:{enabled:true,listen_addr:`127.0.0.1:${ports.admin}`,require_auth:true,dev_auto_admin:true,tls_enabled:false,
      ipfs_api_url:`http://127.0.0.1:${ports.kubo}`,ipfs_gateway_url:`http://127.0.0.1:${ports.gateway}`},
    // Public BIP32 test-vector-1 xpub, as used by the Gaia test harness.
    users:[{xpub:'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8',
      trust_level:'admin',name:'solar source qualification'}],
    asset_pins:{enabled:false,kubo_repo_path:path.join(dir,'kubo')},
    peers:{enable_dht:false,enable_mdns:false,trusted_peers:[]},
    publishing:{enabled:false},ingest:{enabled:false,spacetrack_enabled:false,udl_enabled:false},
    flows:{enabled:false,storage_path:path.join(dir,'flows'),services:[],mounts:[]},update:{enabled:false},
  };
  await fs.mkdir(path.join(dir,'kubo'));
  const configPath = path.join(dir,'config.json');
  await fs.writeFile(configPath,JSON.stringify(config,null,2)+'\n');
  const log = await fs.open(path.join(dir,'sdn.log'),'a');
  const child = spawn(binary,['daemon','--allow-multi-daemon','--config',configPath],
    {cwd:dir,stdio:['ignore',log.fd,log.fd],env:{...process.env,GOMAXPROCS:'2',GOMEMLIMIT:'1GiB'}});
  let spawnError;
  child.on('error',e=>{spawnError=e;});
  const exited = new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
  await log.close();
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (spawnError || child.exitCode!==null || child.signalCode!==null) return;
    child.kill('SIGTERM');
    let timer;
    await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,15000);})]);
    clearTimeout(timer);
    if (child.exitCode===null && child.signalCode===null) {child.kill('SIGKILL');await exited;}
  }
  const onSignal = () => {void stop();};
  process.once('SIGINT',onSignal); process.once('SIGTERM',onSignal);
  const rpc = `http://127.0.0.1:${ports.kubo}`;
  async function start() {
    const deadline = Date.now()+60000;
    while (Date.now()<deadline) {
      if (spawnError) throw spawnError;
      assert.ok(child.exitCode===null && child.signalCode===null,'Native SDN daemon exited before readiness');
      try {
        const response = await fetch(`${rpc}/api/v0/id`,{method:'POST',signal:AbortSignal.timeout(1500)});
        if (response.ok) return (await response.json()).ID;
      } catch { /* startup still pending */ }
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error('Native SDN Kubo not ready within 60 seconds');
  }
  return {dir,rpc,start,child,async stop(){await stop();process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);}};
}
