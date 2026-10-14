// The free services' answers, in each provider's own JSON format (mempool/Esplora address stats, Ethereum and Solana
// JSON-RPC, Blockscout v2 token balances, Coinbase spot, CoinGecko simple price, DEX Screener tokens v1), served by a
// fetch stand-in the SDK's browser host calls for the module's http.request hostcalls. Every request is logged.
export const BTC = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
export const ETH = '0x00000000219ab540356cBB839Cbe05303d7705Fa';
export const SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
export const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCaDpTJ8hT1L4NV9iUQ';
export const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// broken: names of services that fail ('mempool', 'blockstream', 'eth-rpc', 'coinbase', 'blockscout', 'dexscreener').
export function providers({ broken = [] } = {}) {
  const log = [];
  const down = (name) => broken.includes(name);
  async function fetch(url, init = {}) {
    url = String(url);
    const body = init.body ? JSON.parse(new TextDecoder().decode(init.body instanceof Uint8Array ? init.body : new TextEncoder().encode(String(init.body)))) : null;
    log.push({ url, method: init.method, rpc: body?.method, headers: init.headers });
    if (url.startsWith('https://mempool.space/api/address/')) return down('mempool') ? json({}, 503) : json({ address: BTC, chain_stats: { funded_txo_sum: 250000000, spent_txo_sum: 25000000, tx_count: 4 } });
    if (url.startsWith('https://blockstream.info/api/address/')) return down('blockstream') ? json({}, 503) : json({ address: BTC, chain_stats: { funded_txo_sum: 250000000, spent_txo_sum: 25000000 } });
    if (url === 'https://ethereum-rpc.publicnode.com' || url === 'https://eth.llamarpc.com') {
      if (down('eth-rpc')) return json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'unavailable' } });
      if (body.method === 'eth_getBalance') return json({ jsonrpc: '2.0', id: 1, result: '0x1bc16d674ec80000' }); // 2 ETH
    }
    if (url === 'https://api.mainnet-beta.solana.com' || url === 'https://solana-rpc.publicnode.com') {
      if (body.method === 'getBalance') return json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 300000000 }, value: 1500000000 } }); // 1.5 SOL
      if (body.method === 'getTokenAccountsByOwner') {
        const legacy = body.params[1].programId.startsWith('Tokenkeg');
        const account = (mint, amount, decimals) => ({ pubkey: 'x', account: { data: { parsed: { info: { owner: SOL, mint,
          tokenAmount: { amount, decimals, uiAmountString: String(Number(amount) / 10 ** decimals) } } } } } });
        return json({ jsonrpc: '2.0', id: 1, result: { context: { slot: 300000000 }, value: legacy ? [account(BONK, '100000000', 5), account(BONK, '50000000', 5), account(JUP, '0', 6)] : [account(JUP, '2500000', 6)] } });
      }
    }
    if (url.startsWith('https://api.coinbase.com/v2/prices/')) {
      if (down('coinbase')) return json({}, 500);
      const prices = { BTC: '60000', ETH: '3000.5', SOL: '150' };
      return json({ data: { amount: prices[url.split('/prices/')[1].split('-')[0]], currency: 'USD' } });
    }
    if (url.startsWith('https://api.coingecko.com/')) return json({ bitcoin: { usd: 59000 }, ethereum: { usd: 2900 }, solana: { usd: 140 } });
    if (url === `https://eth.blockscout.com/api/v2/addresses/${ETH}/token-balances`) {
      if (down('blockscout')) return json({}, 502);
      return json([
        { token: { type: 'ERC-20', decimals: '6', symbol: 'USDC', address_hash: USDC, exchange_rate: '1.0' }, value: '1250000000' },
        { token: { type: 'ERC-20', decimals: '18', symbol: 'ZERO', address_hash: '0x1111111111111111111111111111111111111111', exchange_rate: null }, value: '0' },
        ...(down('unpriced-token') ? [{ token: { type: 'ERC-20', decimals: '18', symbol: '', address_hash: '0x2222222222222222222222222222222222222222', exchange_rate: null }, value: '3000000000000000000' }] : []),
        { token: { type: 'ERC-721', decimals: null, symbol: 'NFT', address_hash: '0x3333333333333333333333333333333333333333' }, value: '1' },
      ]);
    }
    if (url.startsWith('https://api.dexscreener.com/tokens/v1/solana/')) {
      if (down('dexscreener')) return json({}, 500);
      return json([
        { chainId: 'solana', baseToken: { address: BONK, symbol: 'Bonk' }, priceUsd: '0.00002', liquidity: { usd: 1000 } },
        { chainId: 'solana', baseToken: { address: BONK, symbol: 'BONK' }, priceUsd: '0.00003', liquidity: { usd: 500000 } },
        { chainId: 'solana', baseToken: { address: JUP, symbol: 'JUP' }, priceUsd: '0.8', liquidity: { usd: 90000 } },
      ]);
    }
    return json({ error: 'not found' }, 404);
  }
  return { fetch, log };
}
