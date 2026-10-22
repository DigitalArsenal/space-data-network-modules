import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
export async function localNode(binary) {
 assert(binary&&path.isAbsolute(binary),'SDN_NODE_BINARY must name a native node binary');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'space-weather-node-'));
 const ports={};for(const n of ['tcp','ws','admin','kubo','gateway','publish'])ports[n]=await freePort();
 const base=`http://127.0.0.1:${ports.admin}`,rpc=`http://127.0.0.1:${ports.kubo}`;
 const configPath=path.join(dir,'config.json'),program='com.digitalarsenal.flows.space-weather';
 const config={mode:'full',network:{listen:[`/ip4/127.0.0.1/tcp/${ports.tcp}`,`/ip4/127.0.0.1/tcp/${ports.ws}/ws`],bootstrap:[],enable_relay:false,max_connections:16},
 storage:{path:path.join(dir,'data'),max_size:'1GiB'},setup:{data_path:path.join(dir,'data')},
 admin:{enabled:true,listen_addr:`127.0.0.1:${ports.admin}`,require_auth:true,dev_auto_admin:true,tls_enabled:false,ipfs_api_url:rpc,ipfs_gateway_url:`http://127.0.0.1:${ports.gateway}`},
 // Public BIP32 test-vector-1 xpub; authorizes only this isolated loopback test node.
 users:[{xpub:'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8',trust_level:'admin',name:'space-weather acceptance'}],
 peers:{enable_dht:false,enable_mdns:false,trusted_peers:[]},asset_pins:{enabled:false,kubo_repo_path:path.join(dir,'kubo')},
 publishing:{enabled:true,allowed_schemas:['SPW','SPW.fbs'],local_publish_addr:`127.0.0.1:${ports.publish}`,retention:{keep_series:2},auto_publish:[{schema:'SPW.fbs',provider_id:'space-weather',source_name:'gfz-noaa',min_interval:'1s',settle:'1s',max_shard_bytes:1048576}]},
 ingest:{enabled:false,spacetrack_enabled:false,udl_enabled:false},flows:{enabled:true,storage_path:path.join(dir,'flows'),first_fire_when_due:true,services:[],mounts:[]},update:{enabled:false}};
 await fs.mkdir(path.join(dir,'kubo'));await fs.writeFile(configPath,JSON.stringify(config,null,2));
 let child;
 const cache=path.join(os.tmpdir(),'modules-space-weather-source-20261022-aot');
 await fs.mkdir(cache,{recursive:true}); // Content-addressed artifacts only; no owner node data.
 if(process.platform==='darwin'){await fs.mkdir(path.join(dir,'Library'));await fs.symlink(cache,path.join(dir,'Library/Caches'),'dir');}
 const env={...process.env,HOME:dir,XDG_CACHE_HOME:cache,GOMAXPROCS:'2',GOMEMLIMIT:'2GiB'};
 async function stop(){if(!child||child.exitCode!==null||child.signalCode!==null)return;const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');let timer;await Promise.race([exited,new Promise(r=>{timer=setTimeout(r,15000);})]);clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
 async function start(){await fs.writeFile(configPath,JSON.stringify(config,null,2));const log=await fs.open(path.join(dir,'sdn.log'),'a');child=spawn(binary,['daemon','--allow-multi-daemon','--config',configPath],{cwd:dir,env,stdio:['ignore',log.fd,log.fd]});await log.close();let error;child.on('error',e=>error=e);
 const deadline=Date.now()+180000;while(Date.now()<deadline){if(error)throw error;assert(child.exitCode===null,'Node exited before ready; see '+dir+'/sdn.log');try{const r=await fetch(base+'/api/v1/ready',{signal:AbortSignal.timeout(2000)});if(r.ok){const info=await(await fetch(base+'/api/node/info')).json();assert(info.peer_id);return info;}}catch{}await new Promise(r=>setTimeout(r,500));}throw new Error('No node readiness: '+dir);}
 return {dir,ports,base,rpc,config,configPath,env,program,start,stop};
}
