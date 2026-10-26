// CUSTODY ADAPTER, Solana RPC flavour (devnet / mainnet-beta): the SAME interface as custody-litesvm.mjs over @solana/web3.js.
// STATUS: written against the compiled program's instruction and receipt formats (bridge-sdk.mjs) and the finalized-read
// discipline of the earlier adapters; NOT EXECUTED AGAINST ANY NETWORK in this candidate (devnet faucet unavailable, mainnet
// refused). Treat as untested until a devnet rehearsal runs it. Operator keypair: a 0600 JSON keypair file whose path comes from
// the configuration; its bytes are loaded once and never logged. Reads use commitment 'finalized' with a monotonic slot floor.
import {readFileSync,statSync} from 'node:fs';
import {Connection,Keypair,PublicKey,Transaction,sendAndConfirmTransaction} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID as TOKEN,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {bridgeInstruction,decodeBridgeReceipt,decodePolicy} from '../../../proof-of-concepts/joint-escrow-wallet/core-monero-send/bridge-sdk.mjs';
const need=(c,m)=>{if(!c)throw Error(m);};
export function loadOperatorKeypair(path){const st=statSync(path);need((st.mode&0o077)===0,'Operator keypair file must not be group/world readable: '+path);const arr=JSON.parse(readFileSync(path,'utf8'));need(Array.isArray(arr)&&arr.length===64,'Operator keypair file must hold a 64-byte secret key array');return Keypair.fromSecretKey(Uint8Array.from(arr));}
// config: {rpcUrl, network:'devnet'|'mainnet-beta', program, mint, verifier, policy, manifest (custody policy id hex), feeBps, decimals, operatorKeypairPath}
export function createRpcCustody(cfg){
 need(['devnet','mainnet-beta'].includes(cfg.network),'custody.network must be devnet or mainnet-beta');
 const connection=new Connection(cfg.rpcUrl,{commitment:'finalized'});
 const operator=cfg.operatorKeypairPath?loadOperatorKeypair(cfg.operatorKeypairPath):null;
 if(operator)need(operator.publicKey.toBase58()===cfg.verifier,'Operator keypair does not match the configured verifier');
 const program=new PublicKey(cfg.program),mint=new PublicKey(cfg.mint),policy=new PublicKey(cfg.policy),verifier=new PublicKey(cfg.verifier);
 const base={network:cfg.network,program:cfg.program,mint:cfg.mint,verifier:cfg.verifier,abi:3,binding:cfg.binding||'00'.repeat(32)};
 const options={manifest:cfg.manifest,signers:[cfg.verifier],mode:'operator-verified-v1'};
 const feeBps=Number(cfg.feeBps||0);const tax=n=>(BigInt(n)*BigInt(feeBps)+9999n)/10000n;const net=n=>BigInt(n)-tax(n);
 let floor=0;const ctx=c=>{need(Number.isSafeInteger(c?.slot)&&c.slot>=floor,'Finalized context moved backwards');floor=Math.max(floor,c.slot);};
 async function readPolicy(){const r=await connection.getAccountInfoAndContext(policy,{commitment:'finalized',minContextSlot:floor});ctx(r.context);need(r.value?.owner?.equals(program),'Policy account owner differs');const row=decodePolicy(r.value.data);need(row.mint===cfg.mint&&row.verifier===cfg.verifier&&row.manifest===cfg.manifest,'Immutable operator policy differs from the configuration');return row;}
 return {
  kind:'rpc',network:cfg.network,mint:cfg.mint,feeBps,decimals:Number(cfg.decimals||6),tax,net,readPolicy,
  depositPrepare(owner,gross,nonce,binding){const ix=bridgeInstruction({...base,owner},options,{kind:'deposit',amount:String(gross),fee:tax(gross).toString(),nonce,binding});return {instruction:ix.instruction,receipt:ix.receipt.toBase58(),program:cfg.program,mint:cfg.mint,fee:tax(gross).toString(),net:net(gross).toString(),note:'The holder adds a recent blockhash, signs and sends this instruction itself; the service only observes the finalized receipt.'};},
  async depositSubmit(signedBase64){const sig=await connection.sendRawTransaction(Buffer.from(signedBase64,'base64'),{skipPreflight:false});await connection.confirmTransaction(sig,'finalized');return {signature:sig};},
  // Finalized deposit receipts: program accounts of receipt size whose tag is 10 and whose `to` is this policy.
  async receipts(){const r=await connection.getProgramAccounts(program,{commitment:'finalized',filters:[{dataSize:185},{memcmp:{offset:0,bytes:'B'}},{memcmp:{offset:33,bytes:policy.toBase58()}}]});const out=[];for(const a of r){try{const row=decodeBridgeReceipt(a.account.data);if(row.kind===10)out.push({...row,address:a.pubkey.toBase58()});}catch{}}return out;},
  async redeem(destination,amount,nonce){need(operator,'No operator keypair configured: payouts disabled');const dest=new PublicKey(destination);const ata=getAssociatedTokenAddressSync(mint,dest,false,TOKEN);
   const ix=bridgeInstruction({...base,owner:cfg.verifier,verifier:cfg.verifier},options,{kind:'redeem',amount:String(amount),fee:tax(amount).toString(),nonce,destination,signers:[cfg.verifier]});
   const tx=new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(verifier,ata,dest,mint,TOKEN),ix.instruction);tx.feePayer=verifier;
   const signature=await sendAndConfirmTransaction(connection,tx,[operator],{commitment:'finalized'});const receipt=await this.redemptionReceipt(nonce);return {ok:Boolean(receipt),receipt,signature,logs:[]};},
  async redemptionReceipt(nonce){const addr=PublicKey.findProgramAddressSync([Buffer.from('monero-redemption-v1'),policy.toBuffer(),Buffer.from(nonce,'hex')],program)[0];const r=await connection.getAccountInfoAndContext(addr,{commitment:'finalized',minContextSlot:floor});ctx(r.context);if(!r.value)return null;need(r.value.owner.equals(program),'Receipt owner differs');return decodeBridgeReceipt(r.value.data);},
  async reserve(){const pool=PublicKey.findProgramAddressSync([Buffer.from('joint-v3-pool'),mint.toBuffer(),verifier.toBuffer()],program)[0];const vault=getAssociatedTokenAddressSync(mint,pool,true,TOKEN);const b=await connection.getTokenAccountBalance(vault,'finalized');return String(b.value.amount);},
  async state(){return {reserve:await this.reserve(),network:cfg.network};},
  async tokenBalance(ata){const b=await connection.getTokenAccountBalance(new PublicKey(ata),'finalized');return String(b.value.amount);},
 };
}
