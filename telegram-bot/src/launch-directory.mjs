import {PublicKey} from '@solana/web3.js';
import * as sdk from '@meteora-ag/cp-amm-sdk';
import {XMR20_MINT,XMR20_PRESET} from '../vendor/shared/meteora/preset.js';
const need=(v,c)=>{if(!v)throw Error(c);};
const key=v=>{try{return typeof v==='string'&&new PublicKey(v).toBase58()===v;}catch{return false;}};
export const LAUNCH_DIRECTORY_URL='https://api.xmr20.org/api/xmr20/tokens';
export function listedLaunch(data,mint){
  need(key(mint)&&mint!==XMR20_MINT,'TRADE_TOKEN_ADDRESS');
  need(data?.schema==='xmr20-launches-v1'&&data.moneroNetwork==='mainnet'&&data.solanaNetwork==='mainnet-beta'&&Array.isArray(data.tokens)&&data.tokens.length<=10000,'TRADE_DIRECTORY');
  const matches=data.tokens.filter(r=>r?.mint===mint);
  need(matches.length===1,'TRADE_LAUNCH_REQUIRED');const r=matches[0];
  need(r.venue===XMR20_PRESET.venue&&r.presetId===XMR20_PRESET.id&&r.network==='mainnet-beta'&&r.moneroNetwork==='mainnet'&&!r.hidden&&!r.halted&&!r.cancelledAt&&r.solanaFinalized===true&&r.proofVerified===true&&r.confirmations>=10&&r.bridgeReady===true&&r.state==='Launched','TRADE_LAUNCH_REQUIRED');
  need(/^[a-f0-9-]{36}$/.test(r.id)&&/^[a-f0-9]{64}$/.test(r.moneroTxid)&&key(r.owner)&&key(r.pool),'TRADE_LAUNCH_REQUIRED');
  need(sdk.deriveCustomizablePoolAddress(new PublicKey(mint),new PublicKey(XMR20_MINT)).toBase58()===r.pool,'TRADE_POOL');
  return {id:r.id,mint:r.mint,pool:r.pool,owner:r.owner};
}
// Public discovery establishes platform membership. Trading separately verifies
// the canonical pool, its creator, mints and balances through the configured RPC.
export async function lookupLaunch(mint,{fetcher=fetch}={}){
  let data;
  try{
    const r=await fetcher(LAUNCH_DIRECTORY_URL,{method:'GET',redirect:'error',cache:'no-store',headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)});
    need(r.ok,'TRADE_DIRECTORY');let bytes=0;const chunks=[];
    for await(const chunk of r.body){bytes+=chunk.length;need(bytes<=5000000,'TRADE_DIRECTORY');chunks.push(Buffer.from(chunk));}
    data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{throw Error('TRADE_DIRECTORY');}
  return listedLaunch(data,mint);
}
export function validateTradePool(pool,launch,mint){
  need(pool?.tokenAMint?.toBase58()===mint&&pool?.tokenBMint?.toBase58()===XMR20_MINT&&pool?.creator?.toBase58()===launch.owner&&pool.collectFeeMode===sdk.CollectFeeMode.OnlyB,'TRADE_POOL');
  return pool;
}
