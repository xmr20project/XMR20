import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey,SystemProgram,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {MintLayout,AccountLayout,TransferFeeConfigLayout,ExtensionType,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import * as sdk from '@meteora-ag/cp-amm-sdk';
import {listedLaunch,lookupLaunch,validateTradePool,LAUNCH_DIRECTORY_URL} from '../src/launch-directory.mjs';
import {TradePilot} from '../src/trade-pilot.mjs';
import {PilotEngine} from '../src/pilot-engine.mjs';
import {XMR20_MINT,XMR20_PRESET} from '../vendor/shared/meteora/preset.js';
const key=()=>Keypair.generate().publicKey;
function fixture(){const mint=key(),creator=key(),pool=sdk.deriveCustomizablePoolAddress(mint,new PublicKey(XMR20_MINT));const row={id:'00000000-0000-0000-0000-000000000001',mint:mint.toBase58(),owner:creator.toBase58(),pool:pool.toBase58(),venue:XMR20_PRESET.venue,presetId:XMR20_PRESET.id,network:'mainnet-beta',moneroNetwork:'mainnet',state:'Launched',solanaFinalized:true,proofVerified:true,bridgeReady:true,confirmations:10,moneroTxid:'a'.repeat(64)};return {mint,creator,pool,row,data:{schema:'xmr20-launches-v1',moneroNetwork:'mainnet',solanaNetwork:'mainnet-beta',tokens:[row]}};}
test('directory accepts another creator and rejects unverified, hidden, ambiguous or mismatched launches',()=>{
 const f=fixture();assert.equal(listedLaunch(f.data,f.row.mint).owner,f.row.owner);
 for(const change of [{venue:'other'},{presetId:'other'},{proofVerified:false},{solanaFinalized:false},{bridgeReady:false},{confirmations:9},{state:'Inscribing'},{hidden:true},{halted:true},{cancelledAt:1},{network:'devnet'},{pool:key().toBase58()}]){
  assert.throws(()=>listedLaunch({...f.data,tokens:[{...f.row,...change}]},f.row.mint));
 }
 assert.throws(()=>listedLaunch({...f.data,tokens:[f.row,f.row]},f.row.mint));assert.throws(()=>listedLaunch(f.data,key().toBase58()));
 const p={tokenAMint:f.mint,tokenBMint:new PublicKey(XMR20_MINT),creator:f.creator,collectFeeMode:sdk.CollectFeeMode.OnlyB};
 assert.equal(validateTradePool(p,f.row,f.row.mint),p);
 assert.throws(()=>validateTradePool({...p,creator:key()},f.row,f.row.mint),/POOL/);
});
test('directory fetch is fixed, bounded and redacts provider failures',async()=>{
 const f=fixture();const r=await lookupLaunch(f.row.mint,{fetcher:async(url,options)=>{assert.equal(url,LAUNCH_DIRECTORY_URL);assert.equal(options.redirect,'error');return new Response(JSON.stringify(f.data));}});assert.equal(r.pool,f.row.pool);
 await assert.rejects(lookupLaunch(f.row.mint,{fetcher:async()=>{throw Error('private provider response');}}),/^Error: TRADE_DIRECTORY$/);
 await assert.rejects(lookupLaunch(f.row.mint,{fetcher:async()=>new Response('x'.repeat(5000001))}),/DIRECTORY/);
});
function mintInfo(quote){
 const data=Buffer.alloc(quote?278:82);MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1000000000000000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},data);
 if(quote){data[165]=1;data.writeUInt16LE(ExtensionType.TransferFeeConfig,166);data.writeUInt16LE(108,168);const fee={epoch:0n,maximumFee:18446744073709551615n,transferFeeBasisPoints:150};TransferFeeConfigLayout.encode({transferFeeConfigAuthority:PublicKey.default,withdrawWithheldAuthority:PublicKey.default,withheldAmount:0n,olderTransferFee:fee,newerTransferFee:fee},data.subarray(170));}
 return {owner:TOKEN_2022_PROGRAM_ID,data};
}
test('buy and sell reach reviewed transactions for a foreign creator without any owned launches',async()=>{
 for(const side of ['buy','sell']){
  const f=fixture(),owner=key(),input=side==='buy'?new PublicKey(XMR20_MINT):f.mint,source=getAssociatedTokenAddressSync(input,owner,false,TOKEN_2022_PROGRAM_ID);
  const vault={state:{},transaction(fn){fn(this.state);}};let lookupCount=0,swap;
  const poolState={tokenAMint:f.mint,tokenBMint:new PublicKey(XMR20_MINT),creator:f.creator,collectFeeMode:sdk.CollectFeeMode.OnlyB,tokenAVault:key(),tokenBVault:key()};
  const account=Buffer.alloc(165);AccountLayout.encode({mint:input,owner,amount:1000000000n,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},account);
  const connection={getAccountInfo:async address=>address.equals(f.pool)?{owner:sdk.CP_AMM_PROGRAM_ID}:address.equals(SYSVAR_CLOCK_PUBKEY)?{data:Buffer.alloc(40)}:address.equals(source)?{owner:TOKEN_2022_PROGRAM_ID,data:account}:null,getMultipleAccountsInfo:async()=>[mintInfo(false),mintInfo(true)],getEpochInfo:async()=>({epoch:1}),getLatestBlockhash:async()=>({blockhash:key().toBase58(),lastValidBlockHeight:100}),getFeeForMessage:async()=>({value:11000}),getBalance:async()=>1000000000,simulateTransaction:async()=>({value:{err:null,accounts:[{lamports:999980000}]}})};
  const trader=new TradePilot({vault,owner:owner.toBase58(),connection,lookup:async mint=>{lookupCount++;return listedLaunch(f.data,mint);}});
  trader.cp={fetchPoolState:async()=>poolState,getQuote2:args=>{assert.equal(args.inputTokenMint.toBase58(),input.toBase58());return {minimumAmountOut:123n,priceImpact:{abs:()=>({lte:()=>true})}};},swap2:async args=>{swap=args;return {instructions:[SystemProgram.transfer({fromPubkey:owner,toPubkey:owner,lamports:0})]};}};
  const result=await trader.prepare({side,mint:f.row.mint,amountRaw:'1000000'});
  assert.equal(result.state,'review');assert.equal(result.launchCreator,f.row.owner);assert.notEqual(result.launchCreator,result.owner);assert.equal(result.launchId,f.row.id);assert.equal(lookupCount,1);assert.equal(swap.payer.toBase58(),owner.toBase58());assert.equal(vault.state.launches,undefined);
 }
});
test('both button replies ask for any XMR20 launch CA',async()=>{
 const vault={state:{},transaction(fn){fn(this.state);}},e=new PilotEngine({vault,ownerId:1,wallet:key().toBase58(),trading:{}});
 for(const command of ['/buy','/sell'])assert.equal((await e.command(command)).text,'Enter the CA (token address) of any XMR20 launch.');
});
