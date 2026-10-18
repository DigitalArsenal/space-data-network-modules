// A local provider node (an sdn binary from sdn main at or after 90e522de0,
// which stores STR 1.254 and SKT), the Gaia flow signed by the node's own key
// and installed as a service, and the node's resident memory sampled by its
// PID while it runs (the stack's star-catalog verify recipe).
import {spawn, spawnSync, execFileSync} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const PROGRAM = 'com.digitalarsenal.flows.gaia-octree-ingest';
const SCHEMAS = ['SKT', 'SKT.fbs', 'STR', 'STR.fbs', 'DPM', 'DPM.fbs'];
export const LANES = ['angular-g13.5', 'octree-g13.5'].map((source_name) => ({schema: 'SKT.fbs', provider_id: 'gaia-dr3', source_name,
  min_interval: '24h', max_shard_bytes: 16777216}));

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const {port} = server.address(); server.close(() => resolve(port)); });
});
export async function waitFor(what, probe, timeoutMs, child, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const value = await probe(); if (value) return value; } catch { /* not yet */ }
    if (child && child.exitCode !== null) throw new Error(`${what}: the process exited (${child.exitCode})`);
    if (Date.now() > deadline) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export async function createProviderNode({binary, stackRoot, packageDir}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaia-octree-node-'));
  const port = {tcp: await freePort(), ws: await freePort(), admin: await freePort(), lane: await freePort(), kubo: await freePort(), gateway: await freePort()};
  const configPath = path.join(dir, 'config.json');
  fs.mkdirSync(path.join(dir, 'kubo'), {recursive: true});
  fs.writeFileSync(configPath, JSON.stringify({
    mode: 'full',
    network: {listen: [`/ip4/127.0.0.1/tcp/${port.tcp}`, `/ip4/127.0.0.1/tcp/${port.ws}/ws`], bootstrap: [], max_connections: 128, enable_relay: false, dht_server: false},
    storage: {path: path.join(dir, 'data'), max_size: '64GiB'},
    setup: {data_path: dir},
    admin: {enabled: true, listen_addr: `127.0.0.1:${port.admin}`, require_auth: true, dev_auto_admin: true, tls_enabled: false,
      ipfs_api_url: `http://127.0.0.1:${port.kubo}`, ipfs_gateway_url: `http://127.0.0.1:${port.gateway}`},
    // dev_auto_admin admits loopback requests as the first Admin user: the BIP32
    // spec's test-vector-1 master xpub, a public identifier only.
    users: [{xpub: 'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8', trust_level: 'admin', name: 'gaia E2E operator'}],
    asset_pins: {enabled: false, kubo_repo_path: path.join(dir, 'kubo')},
    peers: {enable_dht: false, enable_mdns: false, trusted_peers: []},
    schemas: {validate: true, strict: false},
    publishing: {enabled: true, allowed_schemas: SCHEMAS, local_publish_addr: `127.0.0.1:${port.lane}`, max_record_bytes: 16 * 1024 * 1024, auto_publish: LANES},
    ingest: {enabled: false, spacetrack_enabled: false, udl_enabled: false},
    flows: {enabled: true, storage_path: path.join(dir, 'flows'), services: [], mounts: [], first_fire_when_due: true},
    update: {enabled: false},
  }, null, 1));
  const admin = `http://127.0.0.1:${port.admin}`;
  const rss = {peakKiB: 0, samples: 0};
  let child, sampler, peerId;

  async function start() {
    const log = fs.openSync(path.join(dir, 'sdn.log'), 'a');
    // GODEBUG madvdontneed=1: Go returns freed heap with MADV_DONTNEED, as it does by default on Linux
    // (host-01), so the sampled RSS is what the node holds, not pages macOS has yet to reclaim.
    child = spawn(binary, ['daemon', '--allow-multi-daemon', '--config', configPath], {cwd: dir, stdio: ['ignore', log, log],
      env: {...process.env, GODEBUG: [process.env.GODEBUG, 'madvdontneed=1'].filter(Boolean).join(',')}});
    const info = await waitFor('node ready', async () => (await fetch(`${admin}/api/node/info`)).ok && (await fetch(`${admin}/api/node/info`)).json(), 180_000, child);
    await waitFor('node IPFS', async () => (await fetch(`http://127.0.0.1:${port.kubo}/api/v0/id`, {method: 'POST'})).ok, 120_000, child);
    peerId = info.peer_id;
    // The node's resident set, by its own PID (ps reports KiB).
    sampler = setInterval(() => {
      try {
        const kib = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], {encoding: 'utf8'}).trim());
        if (kib > rss.peakKiB) rss.peakKiB = kib;
        rss.samples += 1;
      } catch { /* exited */ }
    }, 2000);
    return {peerId, ws: `/ip4/127.0.0.1/tcp/${port.ws}/ws/p2p/${peerId}`};
  }
  // macOS: the kernel's own peak physical footprint of the node (vmmap), beside the sampled RSS.
  function footprintPeak() {
    if (process.platform !== 'darwin' || !child || child.exitCode !== null) return null;
    try { return execFileSync('vmmap', ['--summary', String(child.pid)], {encoding: 'utf8'}).match(/Physical footprint \(peak\):\s*(\S+)/)?.[1] ?? null; } catch { return null; }
  }
  async function stop() {
    clearInterval(sampler);
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 90_000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  // Sign with the node's key, approve the capabilities, install as a service with `config`; restart after.
  async function install(config) {
    const runtime = path.join(packageDir, 'dist/flow/runtime');
    const signed = path.join(dir, 'signed-flow');
    const sign = spawnSync(process.execPath, [path.join(stackRoot, 'deployment/solar-system-provider-node/sign-flow.mjs'), packageDir, runtime, signed, admin, peerId], {encoding: 'utf8'});
    if (sign.status !== 0) throw new Error(`sign-flow: ${`${sign.stdout}${sign.stderr}`.trim().split('\n').slice(-6).join(' | ')}`);
    const receipt = JSON.parse(sign.stdout.trim().split('\n').pop());
    const artifact = JSON.parse(fs.readFileSync(path.join(signed, 'artifact.json'), 'utf8'));
    for (const capability of artifact.capabilities) {
      const approved = await fetch(`${admin}/api/modules/capabilities/approve`, {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({module_hash: receipt.portableSha256, capability, plugin_id: PROGRAM, signer_pubkey_hex: receipt.publicKey, note: 'gaia E2E'})});
      if (!approved.ok) throw new Error(`approve ${capability}: HTTP ${approved.status} ${(await approved.text()).slice(0, 200)}`);
    }
    await stop();
    fs.cpSync(signed, path.join(dir, 'flows', PROGRAM), {recursive: true});
    const yaml = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    // 32768 pages (2 GiB) is the runtime's own declared maximum.
    yaml.flows.services = [{flow: PROGRAM, memory_pages: 32768, config, intervals: {monthly: '720h'}, retrieval_interval: '719h', release_after_run: true}];
    fs.writeFileSync(configPath, JSON.stringify(yaml, null, 1));
    // The flow's AOT artifact (the release prewarm step): a node loads it at start and never compiles one itself.
    const prewarm = spawnSync(binary, ['prewarm-aot', '--config', configPath], {cwd: dir, encoding: 'utf8', timeout: 900_000});
    const named = `${prewarm.stdout}${prewarm.stderr}`.split('\n').find((l) => l.includes(`flow ${PROGRAM}`));
    if (prewarm.status !== 0 || !named) throw new Error(`prewarm-aot: ${`${prewarm.stdout}${prewarm.stderr}`.trim().split('\n').slice(-4).join(' | ')}`);
    return artifact.capabilities;
  }
  const log = () => fs.readFileSync(path.join(dir, 'sdn.log'), 'utf8');
  const remove = () => fs.rmSync(dir, {recursive: true, force: true});
  return {dir, start, stop, install, log, remove, rss, footprintPeak, get peerId() { return peerId; }, get child() { return child; }};
}
