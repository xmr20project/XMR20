import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,SystemProgram,SystemInstruction} from '@solana/web3.js';
import {swapOrderStore,solLamports} from '../src/website-native-swap.js';

const memory=()=>{const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,String(v)),raw:m};};
const owner=Keypair.generate().publicKey.toBase58(),other=Keypair.generate().publicKey.toBase58();
const order=(n,extra={})=>({requestId:String(n).padStart(8,'0')+'-0000-4000-8000-000000000000',direction:'sol-xmr',amount:'0.5',...extra});

test('saved exchanges are per Solana wallet and survive reloads; malformed records are ignored',()=>{
 const storage=memory(),store=swapOrderStore(owner,{storage});
 store.save(order(1));store.save(order(1,{id:'cn-1',status:'waiting'}));store.save(order(2,{direction:'xmr-sol',amount:'0.25'}));
 assert.deepEqual(store.load().map(r=>[r.requestId.slice(0,8),r.id??null]),[['00000001','cn-1'],['00000002',null]]);
 assert.deepEqual(swapOrderStore(owner,{storage}).load().length,2);
 assert.deepEqual(swapOrderStore(other,{storage}).load(),[]);
 storage.setItem('xmr20-native-swaps-v1:'+owner,JSON.stringify([order(3),{requestId:'x'},{...order(4),direction:'btc-xmr'},null]));
 assert.deepEqual(store.load().map(r=>r.requestId.slice(0,8)),['00000003']);
 storage.setItem('xmr20-native-swaps-v1:'+owner,'{not json');assert.deepEqual(store.load(),[]);
 assert.throws(()=>store.save({...order(5),amount:'1e3'}),/Invalid exchange record/);
 assert.throws(()=>swapOrderStore('not-a-wallet',{storage}),/Connect a Solana wallet/);
});

test('only completed exchanges are trimmed; an unfinished exchange is never dropped',()=>{
 const storage=memory(),store=swapOrderStore(owner,{storage});
 store.save(order(0,{status:'waiting'}));
 for(let i=1;i<=60;i++)store.save(order(i,{status:'finished'}));
 const rows=store.load();assert.equal(rows.length,50);assert.ok(rows.some(r=>r.requestId.startsWith('00000000')));
});

test('SOL deposit amounts convert to exact lamports',()=>{
 assert.equal(solLamports('1'),1000000000n);assert.equal(solLamports('0.000000001'),1n);assert.equal(solLamports('12.5'),12500000000n);
 for(const bad of ['0','0.0000000001','-1','1e9','',' 1','abc',undefined])assert.throws(()=>solLamports(bad),/Invalid SOL amount/);
});

test('a SOL payment pays exactly the deposit to the ChangeNOW address and checks fee and balance first',async t=>{
 const previous=new Map(['location','fetch'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 t.after(()=>{for(const [k,v] of previous)if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];});
 Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://wallet.invalid'}});
 let balance=2000000000;const calls=[];
 globalThis.fetch=async(url,options)=>{
  const body=JSON.parse(options.body);assert.equal(url,'https://wallet.invalid/api/wallet');assert.equal(body.action,'walletRpc');
  const {id,method}=body.rpc;calls.push(method);const ctx={context:{slot:1}};
  const result=method==='getLatestBlockhash'?{...ctx,value:{blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}}:
   method==='getFeeForMessage'?{...ctx,value:5000}:method==='getBalance'?{...ctx,value:balance}:null;
  return new Response(JSON.stringify({jsonrpc:'2.0',id,result}));
 };
 const {prepareSolTransfer}=await import('../src/wallet-sol-send.js');
 const deposit=Keypair.generate().publicKey.toBase58();
 const prepared=await prepareSolTransfer({owner,to:deposit,lamports:solLamports('1.5')});
 assert.equal(prepared.fee,5000n);assert.deepEqual(calls,['getLatestBlockhash','getFeeForMessage','getBalance']);
 assert.equal(prepared.tx.instructions.length,1);assert.ok(prepared.tx.instructions[0].programId.equals(SystemProgram.programId));
 const transfer=SystemInstruction.decodeTransfer(prepared.tx.instructions[0]);
 assert.equal(transfer.fromPubkey.toBase58(),owner);assert.equal(transfer.toPubkey.toBase58(),deposit);assert.equal(BigInt(transfer.lamports),1500000000n);
 balance=1500004999;await assert.rejects(prepareSolTransfer({owner,to:deposit,lamports:1500000000n}),/Not enough SOL/);
 await assert.rejects(prepareSolTransfer({owner,to:owner,lamports:1n}),/Choose another Solana wallet/);
 await assert.rejects(prepareSolTransfer({owner,to:deposit,lamports:0n}),/Invalid SOL amount/);
});

test('a Solana token send keeps its blockhash, so the reviewed transaction can be signed',async t=>{
 const previous=new Map(['location','fetch'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
 t.after(()=>{for(const [k,v] of previous)if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];});
 Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'https://wallet.invalid'}});
 const {PublicKey}=await import('@solana/web3.js');const {TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync}=await import('@solana/spl-token');
 const mint=Keypair.generate().publicKey,sender=new PublicKey(owner),blockhash=Keypair.generate().publicKey.toBase58();
 const source=getAssociatedTokenAddressSync(mint,sender,false,TOKEN_PROGRAM_ID).toBase58();
 const mintData=Buffer.alloc(82);mintData[44]=6;mintData[45]=1;
 const holding=Buffer.alloc(165);mint.toBuffer().copy(holding,0);sender.toBuffer().copy(holding,32);holding.writeBigUInt64LE(5000000n,64);holding[108]=1;
 const account=data=>({data:[data.toString('base64'),'base64'],executable:false,lamports:1,owner:TOKEN_PROGRAM_ID.toBase58(),rentEpoch:0,space:data.length});
 globalThis.fetch=async(_url,options)=>{
  const {id,method,params}=JSON.parse(options.body).rpc,ctx={context:{slot:1}};
  const result=method==='getAccountInfo'?{...ctx,value:params[0]===mint.toBase58()?account(mintData):params[0]===source?account(holding):null}:
   method==='getLatestBlockhash'?{...ctx,value:{blockhash,lastValidBlockHeight:100}}:null;
  return new Response(JSON.stringify({jsonrpc:'2.0',id,result}));
 };
 const {prepareSolanaTokenSend}=await import('../src/wallet-sol-send.js');
 const prepared=await prepareSolanaTokenSend({row:{mint:mint.toBase58()},owner,to:other,amount:'1.5'});
 assert.equal(prepared.tx.recentBlockhash,blockhash);assert.ok(prepared.tx.serializeMessage().length>0);
});
