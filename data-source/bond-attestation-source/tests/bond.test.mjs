// End to end on the built artifact: a WHA request in, the WHA attestation out, the module's http.request and
// clock.now hostcalls served by the SDK browser host (worker harness, sync hostcall bridge) whose fetch answers in
// each provider's own format (fixtures/providers.mjs). Expected values come from the fixture balances and quotes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateArtifactWithStandards } from 'space-data-module-sdk/compliance';
import { createBrowserHost } from 'space-data-module-sdk/host/browser';
import { inspectModule } from 'space-data-module-sdk/host/isomorphic';
import { createWorkerModuleHarness } from 'space-data-module-sdk/testing';
import { BONK, BTC, ETH, JUP, SOL, USDC, providers } from './fixtures/providers.mjs';
import { STANDARDS_ROOT, loadStandard } from './sds_bindings.mjs';

const manifest = JSON.parse(readFileSync(new URL('../plugin-manifest.json', import.meta.url), 'utf8'));
const wasmPath = fileURLToPath(new URL('../dist/isomorphic/module.wasm', import.meta.url));
const { WHA, WHAT, WHAAccountT, whaAssetKind, flatbuffers } = await loadStandard('WHA');
const WHA_TYPE = { schemaName: 'WHA.fbs', fileIdentifier: '$WHA', rootTypeName: 'WHA', wireFormat: 'flatbuffer' };
const CHAIN = { BTC: 'bip122:000000000019d6689c085ae165831e93', ETH: 'eip155:1', SOL: 'solana:5eykt4UsFv8P8NJdTREpY1vzQKqZKvdp' };

// A request is a WHA with only ACCOUNTS (each from an $ACT ExternalLink: ACCOUNT_ID names it).
function requestFrame(accounts) {
  const t = new WHAT();
  t.ACCOUNTS = accounts.map(([chain, address, id = null]) => Object.assign(new WHAAccountT(), { CHAIN_ID: CHAIN[chain] ?? chain, ADDRESS: address, ACCOUNT_ID: id }));
  const b = new flatbuffers.Builder(256);
  b.finish(t.pack(b), '$WHA');
  return { portId: 'request', payload: b.asUint8Array(), typeRef: WHA_TYPE };
}
async function attest(t, accounts, options = {}) {
  const { fetch, log } = providers(options);
  const host = createBrowserHost({ capabilities: ['http', 'clock'], fetch });
  const harness = await createWorkerModuleHarness({ wasmSource: readFileSync(wasmPath), host, harnessOptions: { manifest, surface: 'direct' } });
  t.after(() => harness.destroy());
  const before = Date.now();
  const response = await harness.invoke({ methodId: 'attest', inputs: [options.frame ?? requestFrame(accounts)] });
  return { response, log, before, after: Date.now() };
}
function decode(response) {
  assert.equal(response.statusCode, 0, `${response.errorCode}: ${response.errorMessage}`);
  const [frame] = response.outputs.filter((f) => f.portId === 'attestation');
  const bytes = new Uint8Array(frame.payload);
  const bb = new flatbuffers.ByteBuffer(bytes);
  assert.ok(WHA.bufferHasIdentifier(bb));
  return WHA.getRootAsWHA(bb).unpack();
}
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);

test('the artifact passes SDK validation and imports only WASI and the sync hostcall bridge', async () => {
  const report = await validateArtifactWithStandards({ manifest, wasmPath, standardsRoot: STANDARDS_ROOT });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  const inspection = await inspectModule(readFileSync(wasmPath));
  assert.deepEqual([...new Set(inspection.imports.map((e) => e.module))].sort(), ['space_data_module_host', 'wasi_snapshot_preview1']);
});

test('BTC, ETH and SOL wallets attest: every holding priced, every chain complete, the total the sum', async (t) => {
  const { response, log, before, after } = await attest(t, [['BTC', BTC, 'act-btc'], ['ETH', ETH], ['SOL', SOL]]);
  const w = decode(response);
  assert.equal(w.ATTESTED, true);
  assert.deepEqual(w.ERRORS, []);
  assert.equal(w.PURPOSE, 'security-bond');
  assert.equal(w.CURRENCY, 'USD');
  assert.equal(w.ATTESTER_ID, 'org.spacedatanetwork.bond-attestation');
  assert.ok(Number(w.AS_OF_MS) >= before && Number(w.AS_OF_MS) <= after, 'AS_OF_MS from the clock hostcall');
  assert.deepEqual(w.ACCOUNTS.map((a) => [a.CHAIN_NAME, a.CHAIN_ID, a.ADDRESS, a.ACCOUNT_ID]),
    [['BTC', CHAIN.BTC, BTC, 'act-btc'], ['ETH', CHAIN.ETH, ETH, null], ['SOL', CHAIN.SOL, SOL, null]]);
  const h = Object.fromEntries(w.HOLDINGS.map((x) => [`${x.CHAIN_NAME}:${x.SYMBOL}`, x]));
  assert.deepEqual(Object.keys(h), ['BTC:BTC', 'ETH:ETH', 'ETH:USDC', 'SOL:SOL', 'SOL:BONK', 'SOL:JUP'], 'native first, zero balances and NFTs left out');
  near(h['BTC:BTC'].AMOUNT, 2.25, 'BTC'); assert.equal(h['BTC:BTC'].AMOUNT_BASE_UNITS, '225000000'); assert.equal(h['BTC:BTC'].DECIMALS, 8);
  near(h['BTC:BTC'].VALUE, 135000, 'BTC value'); assert.equal(h['BTC:BTC'].PRICE_SOURCE, 'coinbase'); assert.equal(h['BTC:BTC'].BALANCE_SOURCE, 'mempool.space');
  assert.equal(h['BTC:BTC'].ASSET_KIND, whaAssetKind.Native);
  near(h['ETH:ETH'].AMOUNT, 2, 'ETH'); assert.equal(h['ETH:ETH'].AMOUNT_BASE_UNITS, '2000000000000000000'); near(h['ETH:ETH'].VALUE, 6001, 'ETH value');
  assert.equal(h['ETH:ETH'].BALANCE_SOURCE, 'ethereum-rpc.publicnode.com');
  assert.equal(h['ETH:USDC'].CONTRACT, USDC); assert.equal(h['ETH:USDC'].ASSET_KIND, whaAssetKind.FungibleToken); assert.equal(h['ETH:USDC'].DECIMALS, 6);
  near(h['ETH:USDC'].AMOUNT, 1250, 'USDC'); assert.equal(h['ETH:USDC'].AMOUNT_BASE_UNITS, '1250000000'); near(h['ETH:USDC'].VALUE, 1250, 'USDC value');
  near(h['SOL:SOL'].VALUE, 225, 'SOL value'); assert.equal(h['SOL:SOL'].AMOUNT_BASE_UNITS, '1500000000');
  assert.equal(h['SOL:BONK'].CONTRACT, BONK); near(h['SOL:BONK'].AMOUNT, 1500, 'BONK summed over two accounts'); assert.equal(h['SOL:BONK'].AMOUNT_BASE_UNITS, '150000000');
  near(h['SOL:BONK'].PRICE, 0.00003, 'the most liquid pair prices it'); assert.equal(h['SOL:BONK'].PRICE_SOURCE, 'dexscreener');
  assert.equal(h['SOL:JUP'].CONTRACT, JUP); near(h['SOL:JUP'].VALUE, 2, 'JUP value'); assert.equal(h['SOL:JUP'].DECIMALS, 6);
  assert.ok(w.HOLDINGS.every((x) => x.VALUED));
  const c = Object.fromEntries(w.CHAINS.map((x) => [x.CHAIN_NAME, x]));
  assert.deepEqual(w.CHAINS.map((x) => [x.CHAIN_NAME, x.TOKEN_COUNT, x.COMPLETE, x.COMMITMENT, x.ERROR]),
    [['BTC', 1, true, 'confirmed', null], ['ETH', 2, true, 'latest', null], ['SOL', 3, true, 'finalized', null]]);
  near(c.ETH.VALUE, 7251, 'ETH chain'); near(c.SOL.VALUE, 227.045, 'SOL chain');
  near(w.TOTAL_VALUE, 135000 + 7251 + 227.045, 'total');
  assert.ok(log.every((r) => r.headers?.['If-Modified-Since'] === 'Thu, 01 Jan 1970 00:00:00 GMT'), 'a full snapshot asked every time');
  assert.ok(log.filter((r) => r.method === 'POST').every((r) => r.headers['Content-Type'] === 'application/json'));
});

test('fallbacks: blockstream when mempool is down, CoinGecko when Coinbase is down', async (t) => {
  const w = decode((await attest(t, [['BTC', BTC]], { broken: ['mempool', 'coinbase'] })).response);
  assert.equal(w.ATTESTED, true);
  const [btc] = w.HOLDINGS;
  assert.equal(btc.BALANCE_SOURCE, 'blockstream.info');
  assert.equal(btc.PRICE_SOURCE, 'coingecko');
  near(btc.VALUE, 2.25 * 59000, 'priced from CoinGecko');
});

test('a failed lookup or an unpriced holding is incomplete and named, never an invented balance', async (t) => {
  const w = decode((await attest(t, [['BTC', BTC], ['ETH', ETH], ['SOL', SOL]], { broken: ['eth-rpc', 'unpriced-token', 'dexscreener'] })).response);
  assert.equal(w.ATTESTED, false);
  assert.deepEqual(w.ERRORS, ['ETH: lookup incomplete', 'SOL: lookup incomplete']);
  assert.ok(!w.HOLDINGS.some((x) => x.CHAIN_NAME === 'ETH' && x.SYMBOL === 'ETH'), 'no ETH balance when no RPC answered');
  const unnamed = w.HOLDINGS.find((x) => x.CONTRACT === '0x2222222222222222222222222222222222222222');
  assert.equal(unnamed.SYMBOL, 'Token'); assert.equal(unnamed.VALUED, false); assert.equal(unnamed.VALUE, 0); near(unnamed.AMOUNT, 3, 'amount kept');
  const bonk = w.HOLDINGS.find((x) => x.CONTRACT === BONK);
  assert.equal(bonk.VALUED, false); assert.equal(bonk.SYMBOL, `${BONK.slice(0, 8)}…`);
  const c = Object.fromEntries(w.CHAINS.map((x) => [x.CHAIN_NAME, x]));
  assert.equal(c.BTC.COMPLETE, true);
  assert.equal(c.ETH.COMPLETE, false); assert.equal(c.ETH.ERROR, 'ETH: lookup incomplete'); near(c.ETH.VALUE, 1250, 'partial sum: USDC only');
  near(c.SOL.VALUE, 225, 'partial sum: SOL only');
  near(w.TOTAL_VALUE, 135000 + 1250 + 225, 'partial total');
});

test('a malformed address or an unknown chain is refused with nothing read; an empty address is skipped', async (t) => {
  for (const accounts of [[['BTC', BTC], ['ETH', '0x12/../']], [['cosmos:cosmoshub-4', 'cosmos1abc']]]) {
    const { response, log } = await attest(t, accounts);
    const w = decode(response);
    assert.equal(w.ATTESTED, false);
    assert.deepEqual(w.ERRORS, ['invalid request']);
    assert.deepEqual(w.HOLDINGS, []); assert.deepEqual(w.CHAINS, []);
    assert.equal(log.length, 0, 'no lookups');
  }
  const { response, log } = await attest(t, [['ETH', '']]);
  const w = decode(response);
  assert.deepEqual([w.ATTESTED, w.ERRORS, w.ACCOUNTS.length, log.length], [false, [], 0, 0]);
});

test('a frame that is not a WHA is refused', async (t) => {
  const { response } = await attest(t, [], { frame: { portId: 'request', payload: new TextEncoder().encode('{"btc":"x"}'), typeRef: WHA_TYPE } });
  assert.notEqual(response.statusCode, 0);
  assert.equal(response.errorCode, 'invalid-request-frame');
});

test('attests through native WasmEdge and the SDN HTTP host', { skip: !process.env.SDN_BOND_TEST_ROOT }, () => {
  const result = spawnSync('go', ['test', './cmd/spacedatanetwork', '-run', 'TestBondModuleFixtures', '-count=1'],
    { cwd: process.env.SDN_BOND_TEST_ROOT, encoding: 'utf8', env: { ...process.env, SDN_BOND_TEST_WASM: wasmPath } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
