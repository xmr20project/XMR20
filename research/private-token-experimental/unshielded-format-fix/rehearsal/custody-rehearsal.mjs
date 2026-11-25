// CUSTODY REHEARSAL for the RPC custody adapter (bridge-service bridge/custody-rpc.mjs) against a REAL Solana validator.
// Default: a local solana-test-validator started by this script (offline, disposable ledger, deleted afterwards). With
// --url <devnet rpc> --payer <keypair.json> it runs the same steps on devnet (needs faucet SOL on the payer).
// Steps: deploy the compiled xmr20_joint_escrow program (solana CLI) · create a Token-2022 mint with a 1.5% transfer fee ·
// mint tokens to a throwaway holder · initialize the OPERATOR-VERIFIED custody policy (operator = owner = verifier) ·
// holder deposit through the adapter's depositPrepare/depositSubmit · adapter receipts() sees the finalized receipt ·
// adapter redeem() pays a redemption to the holder · redemptionReceipt() and reserve() agree. Throwaway keys only.
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {mkdir,rm,writeFile,readFile,chmod} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {Connection,Keypair,PublicKey,Transaction,sendAndConfirmTransaction,SystemProgram} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID as TOKEN,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createMintToInstruction} from '@solana/spl-token';
import {createRpcCustody} from '../../bridge-service-unshielded-20261026/bridge/custody-rpc.mjs';
import {initializePolicy,bridgePolicy} from '../../../proof-of-concepts/joint-escrow-wallet/core-monero-send/bridge-sdk.mjs';
const dir=fileURLToPath(new URL('../',import.meta.url));const ROOT=path.resolve(dir,'../..');
const argv=process.argv.slice(2);const flag=k=>{const i=argv.indexOf('--'+k);return i<0?null:argv[i+1];};
const SOLANA_BIN=path.join(os.homedir(),'.local/share/solana/install/active_release/bin');
const PROGRAM_SO=ROOT+'/proof-of-concepts/joint-escrow-wallet/core-monero-send/target/sbpf-solana-solana/release/xmr20_joint_escrow.so';
const run=(cmd,args,opts={})=>new Promise((res,rej)=>execFile(cmd,args,{maxBuffer:1<<22,...opts},(e,so,se)=>e?rej(Error((se||'')+(e.message||''))):res(so)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const work=dir+'rehearsal/run-'+Date.now();await mkdir(work,{recursive:true});
const evidence={execution:null,steps:[]};const step=(name,x={})=>{evidence.steps.push({at:new Date().toISOString(),name,...x});console.error(JSON.stringify({step:name,...x}).slice(0,300));};
let validator=null,url=flag('url'),payer;
try{
 if(url){const arr=JSON.parse(await readFile(flag('payer'),'utf8'));payer=Keypair.fromSecretKey(Uint8Array.from(arr));evidence.execution='REMOTE validator '+url+' (throwaway payer)';}
 else{// local disposable validator
  payer=Keypair.generate();await writeFile(work+'/payer.json',JSON.stringify([...payer.secretKey]));await chmod(work+'/payer.json',0o600);
  const port=8899+Math.floor(Math.random()*100);const faucet=port+1000;url=`http://127.0.0.1:${port}`;
  validator=spawn(SOLANA_BIN+'/solana-test-validator',['--ledger',work+'/ledger','--rpc-port',String(port),'--faucet-port',String(faucet),'--bind-address','127.0.0.1','--mint',payer.publicKey.toBase58(),'--reset','--quiet','--ticks-per-slot','8','--limit-ledger-size','10000',
   // mirror mainnet-beta/devnet (checked 26 Oct 2026): SIMD-0500 (disable deployment of SBPF v0/v1) is INACTIVE there; the test
   // validator activates it by default, which refuses the v0 artefact that every LiteSVM test exercised
   '--deactivate-feature','B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g'],{stdio:['ignore','ignore','ignore']});
  let ok=false;for(let i=0;i<120;i++){try{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getHealth'})});if((await r.json()).result==='ok'){ok=true;break;}}catch{}await sleep(500);}
  assert.ok(ok,'local validator did not start');evidence.execution='LOCAL solana-test-validator (disposable ledger, offline)';step('validator up',{url});}
 const connection=new Connection(url,{commitment:'confirmed'});
 const payerFile=url.startsWith('http://127.')?work+'/payer.json':flag('payer');
 const bal=await connection.getBalance(payer.publicKey);assert.ok(bal>2e9,'payer needs > 2 SOL (has '+bal/1e9+')');
 // 1. deploy the program with the CLI (upgradeable loader), payer as upgrade authority
 const programKey=Keypair.generate();await writeFile(work+'/program.json',JSON.stringify([...programKey.secretKey]));await chmod(work+'/program.json',0o600);
 await run(SOLANA_BIN+'/solana',['program','deploy',PROGRAM_SO,'--program-id',work+'/program.json','--keypair',payerFile,'--url',url,'--commitment','confirmed','--use-rpc'],{timeout:600000});
 const program=programKey.publicKey.toBase58();
 // wait until the deployed program is executable at FINALIZED commitment (the deploy returns at 'confirmed')
 let exec=false;for(let i=0;i<60&&!exec;i++){const ai=await connection.getAccountInfo(programKey.publicKey,'finalized');exec=Boolean(ai?.executable);if(!exec)await sleep(500);}assert.ok(exec,'program not executable at finalized commitment');step('program deployed',{program});
 // 2. Token-2022 mint with a 1.5% transfer fee (as the XMR20 mints have), 6 decimals; payer is mint authority
 const mintOut=await run(SOLANA_BIN+'/spl-token',['create-token','--program-2022','--decimals','6','--transfer-fee-basis-points','150','--transfer-fee-maximum-fee','1000000000','--fee-payer',payerFile,'--mint-authority',payerFile,'--url',url,'--output','json']);
 const mint=JSON.parse(mintOut).commandOutput.address;step('mint created',{mint});
 const holder=Keypair.generate();const operator=payer;// operator = owner = verifier of the custody policy (operator-verified-v1)
 await sendAndConfirmTransaction(connection,new Transaction().add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:holder.publicKey,lamports:500_000_000})),[payer]);
 const holderAta=getAssociatedTokenAddressSync(new PublicKey(mint),holder.publicKey,false,TOKEN);
 await sendAndConfirmTransaction(connection,new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey,holderAta,holder.publicKey,new PublicKey(mint),TOKEN),createMintToInstruction(new PublicKey(mint),holderAta,payer.publicKey,1_000_000_000n,[],TOKEN)),[payer]);
 step('holder funded',{holder:holder.publicKey.toBase58(),tokens:'1000.000000'});
 // the custody program accepts only a FINISHED mint (no mint authority, no freeze authority, decimals 6, supply > 0, only the
 // transfer-fee/metadata extensions) — as the real XMR20 mints are
 await run(SOLANA_BIN+'/spl-token',['authorize',mint,'mint','--disable','--authority',payerFile,'--fee-payer',payerFile,'--url',url]);step('mint authority revoked (finished mint)');
 // 3. custody policy (operator-verified): identity manifest = sha256 of a policy document, as the service will do on mainnet
 const manifest=randomBytes(32).toString('hex');const cfg={network:'mainnet-beta',program,mint,verifier:operator.publicKey.toBase58(),owner:operator.publicKey.toBase58(),abi:3,binding:'00'.repeat(32)};const options={manifest,signers:[cfg.verifier],mode:'operator-verified-v1'};
 const a=bridgePolicy(cfg,options);const init=initializePolicy(cfg,options);
 // the pool vault (ATA of the pool PDA) must exist before the policy is initialised; the operator pays for it
 // transactions confirmed at 'confirmed' are not yet visible to a FINALIZED preflight; wait for finality of the mint and holder
 // accounts before the policy steps (the adapter reads everything at finalized commitment by design)
 const untilFinalized=async(key,label)=>{for(let i=0;i<120;i++){if(await connection.getAccountInfo(new PublicKey(key),'finalized'))return;await sleep(500);}throw Error(label+' not finalized in time');};
 await untilFinalized(mint,'mint');await untilFinalized(holderAta.toBase58(),'holder ATA');step('mint and holder finalized');
 const vaultIx=createAssociatedTokenAccountIdempotentInstruction(operator.publicKey,a.vault,a.pool,new PublicKey(mint),TOKEN);
 await sendAndConfirmTransaction(connection,new Transaction().add(vaultIx),[operator],{commitment:'finalized'});await untilFinalized(a.vault.toBase58(),'vault');
 await sendAndConfirmTransaction(connection,new Transaction().add(init.instruction??init),[operator],{commitment:'finalized'});step('policy initialized',{policy:a.policy.toBase58(),pool:a.pool.toBase58(),vault:a.vault.toBase58()});
 // 4. the adapter under test
 await writeFile(work+'/operator.json',JSON.stringify([...operator.secretKey]));await chmod(work+'/operator.json',0o600);
 const custody=createRpcCustody({network:'local-validator',rpcUrl:url,program,mint,verifier:cfg.verifier,policy:a.policy.toBase58(),manifest,feeBps:150,decimals:6,operatorKeypairPath:work+'/operator.json'});
 const policyRow=await custody.readPolicy();step('adapter read the policy',{mint:policyRow.mint===mint});
 assert.equal(await custody.reserve(),'0');
 // 5. holder deposit through the adapter: prepare -> holder signs -> submit -> finalized receipt
 const nonce=randomBytes(32).toString('hex'),binding=randomBytes(32).toString('hex');const gross=100_000_000n;
 const prep=custody.depositPrepare(holder.publicKey.toBase58(),gross,nonce,binding);
 const tx=new Transaction({recentBlockhash:(await connection.getLatestBlockhash('finalized')).blockhash,feePayer:holder.publicKey}).add(prep.instruction);tx.sign(holder);
 const sub=await custody.depositSubmit(tx.serialize().toString('base64'));step('deposit submitted',{signature:sub.signature});
 let receipts=[];for(let i=0;i<30&&!receipts.length;i++){receipts=await custody.receipts();if(!receipts.length)await sleep(1000);}
 assert.equal(receipts.length,1,'adapter sees the finalized deposit receipt');assert.equal(receipts[0].nonce,nonce);assert.equal(receipts[0].binding,binding);
 const net=BigInt(receipts[0].net);assert.equal(net,custody.net(gross));step('receipt observed',{net:String(net),fee:String(gross-net)});
 assert.equal(await custody.reserve(),String(net),'vault holds the net deposit');
 // 6. redemption through the adapter (operator signs), exactly once
 const redeemNonce=randomBytes(32).toString('hex');const amount=40_000_000n;
 const r=await custody.redeem(holder.publicKey.toBase58(),amount,redeemNonce);assert.equal(r.ok,true);assert.ok(r.receipt);step('redeemed',{signature:r.signature,amount:String(amount)});
 const again=await custody.redemptionReceipt(redeemNonce);assert.ok(again&&again.nonce===redeemNonce,'redemption receipt readable');
 await assert.rejects(custody.redeem(holder.publicKey.toBase58(),amount,redeemNonce),/already|in use|custom program error|failed/i,'second redemption with the same nonce refused by the program');
 const reserveAfter=BigInt(await custody.reserve());assert.equal(reserveAfter,net-amount,'reserve decreased by the paid amount');
 const holderBal=BigInt(await custody.tokenBalance(holderAta.toBase58()));step('balances',{reserve:String(reserveAfter),holder:String(holderBal)});
 evidence.ok=true;evidence.program=program;evidence.mint=mint;evidence.policy=a.policy.toBase58();evidence.deposit={gross:String(gross),net:String(net)};evidence.redeem={amount:String(amount),reserveAfter:String(reserveAfter)};
}catch(e){evidence.ok=false;evidence.error=String(e.stack||e).slice(0,1500);console.error('REHEARSAL FAILURE: '+e.message);}
finally{if(validator){validator.kill();await new Promise(r=>validator.once('exit',r));}
 await mkdir(dir+'runs',{recursive:true});await writeFile(dir+'runs/custody-rehearsal-'+(evidence.execution?.startsWith('LOCAL')?'local':'remote')+'.json',JSON.stringify(evidence,null,1));
 await rm(work+'/ledger',{recursive:true,force:true});if(!flag('keep'))await rm(work,{recursive:true,force:true});
 console.log(JSON.stringify({ok:evidence.ok,execution:evidence.execution,steps:evidence.steps.length,error:evidence.error?.slice(0,200)}));process.exit(evidence.ok?0:1);}
