import {Connection,PublicKey,VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
const GENESIS='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const READS=new Set(['getGenesisHash','getBalance','getLatestBlockhash','getSignatureStatuses','getAccountInfo','getMultipleAccounts','getTokenAccountsByOwner','getTokenAccountBalance','getBlockHeight','getSlot','getEpochInfo','getMinimumBalanceForRentExemption','isBlockhashValid','getTransaction','getFeeForMessage','simulateTransaction','getProgramAccounts']);
export function createHelius(apiKey,{fetcher=fetch}={}) {
  if(typeof apiKey!=='string'||!/^[a-zA-Z0-9_-]{10,200}$/.test(apiKey))throw Error('HELIUS_SETTINGS');
  const endpoint='https://mainnet.helius-rpc.com/?api-key='+encodeURIComponent(apiKey);
  async function rpc(method,params) {
    try {
      const r=await fetcher(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10000)});
      const body=await r.json();if(!r.ok||body.error||body.id!==1||!Object.hasOwn(body,'result'))throw Error();return body.result;
    }catch{throw Error('HELIUS_UNAVAILABLE');}
  }
  // web3 receives no credential-bearing URL. Errors cannot include the key.
  const connection=new Connection('https://helius.invalid',{commitment:'confirmed',disableRetryOnRateLimit:true,fetch:async(_url,init)=>{
    const req=JSON.parse(init.body);if(!READS.has(req.method))throw Error('HELIUS_READ_ONLY');
    const result=await rpc(req.method,req.params);
    return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result}),{headers:{'Content-Type':'application/json'}});
  }});
  return Object.freeze({connection,
    async verify(){if(await connection.getGenesisHash()!==GENESIS)throw Error('WRONG_NETWORK');},
    async balance(owner){return BigInt(await connection.getBalance(new PublicKey(owner),'finalized'));},
    async signature(signature){return (await connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];},
    async sendExact(bytes,expectedSignature) {
      const tx=VersionedTransaction.deserialize(bytes);
      if(bytes.length>1232||bs58.encode(tx.signatures[0])!==expectedSignature||tx.signatures.some(s=>s.every(b=>b===0)))throw Error('DELIVERY_SIGNATURE');
      // Caller must have persisted and independently validated these exact bytes.
      const params=[Buffer.from(bytes).toString('base64'),{encoding:'base64',skipPreflight:true,maxRetries:0}];
      try{
        const r=await fetcher('https://sender.helius-rpc.com/fast?swqos_only=true',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(1500),body:JSON.stringify({jsonrpc:'2.0',id:1,method:'sendTransaction',params})});
        const b=await r.json();if(r.ok&&!b.error&&b.result===expectedSignature)return {signature:expectedSignature,route:'helius-sender'};
      }catch{}
      // Fallback reuses the same signature and bytes, even after a timeout.
      try{if(await rpc('sendTransaction',params)===expectedSignature)return {signature:expectedSignature,route:'helius-rpc'};}catch{}
      return {signature:expectedSignature,route:'unknown'};
    }
  });
}
