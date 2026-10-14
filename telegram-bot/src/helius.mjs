// Read-only adapter. No signing, sendTransaction, account mutation or secret logging.
const READS = new Set(['getBalance','getLatestBlockhash','getSignatureStatuses','getTokenAccountsByOwner','getAccountInfo','getBlockHeight','getPriorityFeeEstimate']);
export class HeliusRead {
  #url;
  constructor(apiKey, {fetcher = fetch} = {}) {
    if (typeof apiKey !== 'string' || !/^[a-zA-Z0-9_-]{10,200}$/.test(apiKey)) throw Error('Helius API key required.');
    this.#url = 'https://mainnet.helius-rpc.com/?api-key=' + encodeURIComponent(apiKey); this.fetcher = fetcher;
  }
  async request(method, params) {
    if (!READS.has(method)) throw Error('RPC method not permitted in the prototype.');
    try {
      const response = await this.fetcher(this.#url, {method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(4000),body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
      const body = await response.json();
      if (!response.ok || body.error || body.id !== 1 || !Object.hasOwn(body,'result')) throw Error();
      return body.result;
    } catch { throw Error('Helius read unavailable. Retry later; no transaction was sent.'); }
  }
  balance(owner) { return this.request('getBalance',[owner,{commitment:'finalized'}]); }
  signatures(signatures) { return this.request('getSignatureStatuses',[signatures,{searchTransactionHistory:true}]); }
}
export const deliveryPlan = Object.freeze({
  rpc: 'Helius mainnet',
  sender: 'https://sender.helius-rpc.com/fast?swqos_only=true',
  reuse: 'website/web/server/quick-network.mjs:sendQuickBytes',
  enabled: false,
  policy: 'Exact simulated and validated bytes; preserve signature on ambiguous delivery. Never automatically sign a replacement.'
});
