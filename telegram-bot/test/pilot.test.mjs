import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createECDH} from 'node:crypto';
import {Keypair,TransactionMessage,VersionedTransaction,SystemProgram,SystemInstruction,PublicKey} from '@solana/web3.js';
import sharp from 'sharp';
import {Vault} from '../src/vault.mjs';
import {PilotEngine} from '../src/pilot-engine.mjs';
import {LaunchPilot,XMR20_PRESET} from '../src/launch-pilot.mjs';
import {tokenImage} from '../src/image.mjs';
import {createHelius} from '../src/helius-mainnet.mjs';
import {TurnkeyClient} from '../src/turnkey-client.mjs';
import {TradePilot} from '../src/trade-pilot.mjs';
import {createTurnkeySigner} from '../src/turnkey.mjs';
import {ExecutionJournal} from '../src/execution-journal.mjs';
import {pilotPreflight,readinessFailure} from '../src/pilot-preflight.mjs';
import bs58 from 'bs58';
import {assertNoNativeBigint} from '../src/dependency-guard.mjs';
import {pilotPolicy,matchesPilotPolicy,probePilotSigner} from '../src/pilot-policy.mjs';
const password='synthetic testing passphrase only';
function setup(t){const dir=mkdtempSync(join(tmpdir(),'xmr20-pilot-test-'));const vault=new Vault(join(dir,'test.vault'),password,{profile:'mainnet-pilot'});t.after(()=>{vault.close();rmSync(dir,{recursive:true,force:true});});return vault;}
const update=(id,text,owner=123)=>({update_id:id,message:{chat:{id:owner,type:'private'},from:{id:owner},text}});
const cb=(id,data)=>({update_id:id,callback_query:{id:String(id),from:{id:123},data,message:{chat:{id:123,type:'private'}}}});

test('mainnet engine is single owner; unknown/group updates cannot invoke providers',async t=>{
 const vault=setup(t),wallet=Keypair.generate().publicKey.toBase58();let calls=0;
 const engine=new PilotEngine({vault,ownerId:123,wallet,helius:{balance:async()=>{calls++;return 2n;}}});
 assert.equal(await engine.handle(update(1,'/wallet',456)),null);
 const group=update(2,'/wallet');group.message.chat.type='group';assert.equal(await engine.handle(group),null);assert.equal(calls,0);
 assert.match((await engine.handle(update(3,'/wallet'))).text,/finalized/);assert.equal(calls,1);
 await engine.handle(update(3,'/wallet'));assert.equal(calls,1);
});
test('mainnet launch has no Normal mode and image is mandatory before amount',async t=>{
 const vault=setup(t),wallet=Keypair.generate().publicKey.toBase58();
 const engine=new PilotEngine({vault,ownerId:123,wallet});
 assert.match((await engine.handle(update(1,'/start'))).text,/Launch and trade XMR20 tokens/);
 await engine.handle(update(2,'/launch'));await engine.handle(update(3,'Example'));await engine.handle(update(4,'EG'));
 assert.equal(vault.state.draft.stage,'image');assert.match((await engine.handle(update(5,'0'))).text,/image/);assert.equal(vault.state.draft.stage,'image');
 assert.match((await engine.handle(update(6,'/erase'))).text,/cannot be erased/);
});
test('welcome shows the assigned wallet without provider latency or creating a replacement',async t=>{
 const vault=setup(t),wallet=Keypair.generate().publicKey.toBase58();let network=0;
 const engine=new PilotEngine({vault,ownerId:123,wallet,helius:{balance:async()=>{network++;throw Error('offline');}}});
 const reply=await engine.handle(update(1,'/start'));
 assert.equal(reply.parse_mode,'HTML');
 assert.ok(reply.text.indexOf('Welcome to XMR20 bot.')<reply.text.indexOf('XMR20 · Mainnet'));
 assert.ok(reply.text.includes(`<code>${wallet}</code>`));
 assert.match(reply.text,/Later buys use XMR20/);
 assert.match(reply.text,/name, ticker and optional image/);
 assert.equal(network,0);
 assert.equal(reply.reply_markup.inline_keyboard[1][0].text,'🚀 Launch');
 assert.equal(await engine.handle(update(2,'/start',456)),null);
 assert.deepEqual(await engine.handle(update(1,'/start')),reply);
 assert.equal((await engine.handle(update(3,'/help'))).text,reply.text);
 assert.equal(vault.state.launches,undefined);
});
test('cancel revokes already displayed launch and trade approvals',async t=>{
 const vault=setup(t),wallet=Keypair.generate().publicKey.toBase58();vault.transaction(s=>{s.launches={one:{state:'review',expiresAt:12345},two:{state:'submitted'}};s.trades={one:{state:'review'}};});
 await new PilotEngine({vault,ownerId:123,wallet}).handle(update(1,'/cancel'));
 assert.equal(vault.state.launches.one.state,'draft');assert.equal(vault.state.launches.one.expiresAt,0);assert.equal(vault.state.launches.two.state,'submitted');assert.equal(vault.state.trades.one.state,'cancelled');
});
test('photo is normalized to bounded PNG with metadata removed',async()=>{
 const original=await sharp({create:{width:2000,height:1000,channels:3,background:'red'}}).jpeg().withMetadata().toBuffer();
 const result=Buffer.from(await tokenImage(original),'base64'),meta=await sharp(result).metadata();
 assert.equal(meta.format,'png');assert.ok(meta.width<=512&&result.length<=262144);assert.equal(meta.exif,undefined);
 await assert.rejects(()=>tokenImage(Buffer.from('<svg/>')),/IMAGE_INVALID/);
});
function launchFixture(t){
 const vault=setup(t),payer=Keypair.generate(),owner=payer.publicKey.toBase58(),blockhash=Keypair.generate().publicKey.toBase58();let calls=[],row,now=1000,signCount=0;
 const connection={getBalance:async()=>1000000000};
 const gateway={call:async(action,input)=>{calls.push({action,input});if(action==='meteoraAccount')return {launches:row?[structuredClone(row)]:[]};if(action==='meteoraMetadata'){const h='a'.repeat(64);return {metadataHash:h,metadataUri:'https://api.xmr20.org/mainnet/m/'+Buffer.from(h,'hex').toString('base64url')};}if(action==='meteoraReserve')return row={...input,owner,preset:XMR20_PRESET,state:'reserved',receipts:[]};if(action==='meteoraPrepare')return {owner,id:row.id,flow:row.flow,items:[{step:'mint'},{step:'pool'}],review:{estimatedSolDebitLamports:100000000,maximumSolDebitLamports:250000000}};if(action==='meteoraSubmit')return {...row,state:'submitted'};if(action==='meteoraStatus')return {...row,state:'submitted'};throw Error('Unexpected');}};
 const pilot=new LaunchPilot({vault,owner,gateway,connection,now:()=>now,review:async()=>{
   const d=Object.values(vault.state.launches)[0];return [['mintKey'],['creatorNftKey','platformNftKey']].map(fields=>new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:blockhash,instructions:fields.map(f=>SystemProgram.createAccount({fromPubkey:payer.publicKey,newAccountPubkey:Keypair.fromSecretKey(Uint8Array.from(d[f])).publicKey,lamports:1,space:0,programId:SystemProgram.programId}))}).compileToV0Message()));
 },signer:{signReviewed:async({transaction})=>{signCount++;const tx=VersionedTransaction.deserialize(transaction);tx.sign([payer]);return {transaction:tx.serialize()};}}});
 const id=pilot.create({name:'Example',symbol:'EG',initialSolLamports:'0',imageBase64:'syntheticPNG'});
 return {vault,pilot,id,calls,owner,get signs(){return signCount;},setNow:n=>{now=n;}};
}
test('XMR20 reserves saved identities, signs both and persists full batch before submit',async t=>{
 const f=launchFixture(t),review=await f.pilot.prepare(f.id);assert.equal(review.attempt,1);assert.equal(f.pilot.get(f.id).mode,'xmr20');
 const d=f.pilot.get(f.id);assert.equal(d.row.mint,d.mint);await f.pilot.approve(f.id,1);assert.equal(f.signs,2);
 const submitted=f.calls.find(c=>c.action==='meteoraSubmit');assert.equal(submitted.input.transactions.length,2);assert.deepEqual(submitted.input.transactions,f.pilot.get(f.id).bundle.map(b=>b.transaction));
 await assert.rejects(()=>f.pilot.approve(f.id,1),/EXPIRED/);assert.equal(f.signs,2);
});
test('expired review and interrupted partial signing cannot create another approval',async t=>{
 const f=launchFixture(t);await f.pilot.prepare(f.id);f.setNow(46000);await assert.rejects(()=>f.pilot.approve(f.id,1),/EXPIRED/);assert.equal(f.signs,0);
 f.setNow(1000);let n=0;const orig=f.pilot.signer.signReviewed;f.pilot.signer.signReviewed=async x=>{if(++n===2)throw Error('private-provider-details');return orig(x);};
 await assert.rejects(()=>f.pilot.approve(f.id,1),/LAUNCH_RECONCILE/);assert.equal(f.pilot.get(f.id).bundle.length,1);assert.equal(f.pilot.get(f.id).state,'attention');
 assert.equal(f.calls.filter(c=>c.action==='meteoraSubmit').length,0);await assert.rejects(()=>f.pilot.prepare(f.id),/RECOVERY_REQUIRED/);await assert.rejects(()=>f.pilot.recover(f.id),/PARTIAL_APPROVAL/);
 await f.pilot.status(f.id);assert.equal(f.pilot.get(f.id).state,'attention');await assert.rejects(()=>f.pilot.prepare(f.id),/RECOVERY_REQUIRED/);
 await assert.rejects(()=>f.pilot.recover(f.id),/PARTIAL_APPROVAL/);
});
test('status cannot clear an unknown first signing request with no local signature',async t=>{
 const f=launchFixture(t);await f.pilot.prepare(f.id);f.pilot.signer.signReviewed=async()=>{throw Error('unknown');};
 await assert.rejects(()=>f.pilot.approve(f.id,1),/RECONCILE/);assert.equal(f.pilot.get(f.id).bundle.length,0);
 await f.pilot.status(f.id);assert.equal(f.pilot.get(f.id).state,'attention');await assert.rejects(()=>f.pilot.prepare(f.id),/RECOVERY_REQUIRED/);
});
test('resume keeps the same signing operations and does not re-sign completed first transaction',async t=>{
 const f=launchFixture(t),records=new Map();await f.pilot.prepare(f.id);let failPool=true;
 f.pilot.journal={get:id=>records.get(id)};
 const original=f.pilot.signer.signReviewed;
 f.pilot.signer.signReviewed=async args=>{
  if(failPool&&args.operationId.endsWith(':pool'))throw Error('before pool request');
  const result=await original(args);records.set(args.operationId,{state:'signed',address:args.address,messageSha256:args.messageSha256,request:{parameters:{unsignedTransaction:Buffer.from(args.transaction).toString('hex')}},receipt:{signedTransactionHex:Buffer.from(result.transaction).toString('hex')}});return result;
 };
 await assert.rejects(()=>f.pilot.approve(f.id,1),/RECONCILE/);assert.equal(f.signs,1);
 const review=await f.pilot.resume(f.id);assert.equal(review.attempt,2);failPool=false;await f.pilot.approve(f.id,2);
 assert.equal(f.signs,2);assert.equal(records.size,2);assert.ok([...records.keys()].every(k=>k.includes(':1:')));assert.equal(f.pilot.get(f.id).bundle.length,2);
});
test('gateway permits only XMR20 actions, replaces owner and uses backend flat payload',()=>{
 const file=new URL('../scripts/launch_gateway.py',import.meta.url).pathname;
 const script=`import runpy\nm=runpy.run_path(${JSON.stringify(file)})\nv=m['validate']\nassert v({'action':'meteoraAccount','data':{}},'owner')=={'action':'meteoraAccount','owner':'owner'}\nfor req in [{'action':'reserve','data':{}},{'action':'meteoraAccount','data':{'owner':'someone'}},{'action':'meteoraReserve','data':{'flow':'normal'}}]:\n try:v(req,'owner');raise AssertionError()\n except ValueError:pass\n`;
 const r=spawnSync('python3',['-c',script],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});
test('Helius connection hides credentials and rejects provider broadcast on read connection',async()=>{
 const api=createHelius('synthetic_api_key_12345',{fetcher:async(url,init)=>{assert.ok(url.startsWith('https://mainnet.helius-rpc.com/'));const req=JSON.parse(init.body);return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:req.method==='getGenesisHash'?'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d':{context:{slot:1},value:123}}));}});
 await api.verify();assert.equal(await api.balance(Keypair.generate().publicKey.toBase58()),123n);assert.equal(api.connection.rpcEndpoint,'https://helius.invalid');
 await assert.rejects(()=>api.connection.sendRawTransaction(Buffer.from('bad')),/HELIUS_READ_ONLY/);
});
test('Turnkey mainnet client has no permission mutation or raw signing API',async()=>{
 const client=new TurnkeyClient({organizationId:'00000000-0000-0000-0000-000000000000',apiPublicKey:'02'+'a'.repeat(64),apiPrivateKey:'b'.repeat(64),fetcher:()=>{throw Error('secret');}});
 assert.throws(()=>client.query('create_policy'),/TURNKEY_QUERY/);assert.throws(()=>client.query('get_activity',{organizationId:'different'}),/TURNKEY_QUERY/);
 assert.throws(()=>client.signTransaction({type:'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'}),/TURNKEY_SIGN_REQUEST/);
});
test('Turnkey list operations use the documented HTTP routes and preserve signed request bodies',async()=>{
 const org='00000000-0000-0000-0000-000000000001',calls=[];
 const key=createECDH('prime256v1');key.setPrivateKey(Buffer.from('b'.repeat(64),'hex'));
 const client=new TurnkeyClient({organizationId:org,apiPublicKey:key.getPublicKey('hex','compressed'),apiPrivateKey:'b'.repeat(64),fetcher:async(url,init)=>{calls.push({url,init});return new Response('{}');}});
 const routes={get_wallets:'list_wallets',get_wallet_accounts:'list_wallet_accounts',get_policies:'list_policies',get_activities:'list_activities',get_activity:'get_activity',whoami:'whoami',get_user:'get_user',get_organization_configs:'get_organization_configs'};
 for(const [method,route] of Object.entries(routes)){
  const args=method==='get_user'?'public-user-id':method==='get_wallet_accounts'?{walletId:'public-wallet-id'}:{};
  await client.query(method,args);
  const c=calls.at(-1);assert.equal(c.url,'https://api.turnkey.com/public/v1/query/'+route);
  assert.equal(c.init.redirect,'error');assert.equal(c.init.method,'POST');
  assert.deepEqual(JSON.parse(c.init.body),{...(typeof args==='string'?{userId:args}:args),organizationId:org});
  assert.ok(Object.keys(c.init.headers).some(k=>k.toLowerCase().includes('stamp')));
 }
});
test('Turnkey HTTP failures distinguish endpoint, permission and network errors without response text',async()=>{
 const key=createECDH('prime256v1');key.setPrivateKey(Buffer.from('b'.repeat(64),'hex'));
 const options={organizationId:'00000000-0000-0000-0000-000000000001',apiPublicKey:key.getPublicKey('hex','compressed'),apiPrivateKey:'b'.repeat(64)};
 for(const [status,code] of [[401,'TURNKEY_AUTH'],[403,'TURNKEY_ACCESS'],[404,'TURNKEY_ENDPOINT'],[429,'TURNKEY_RATE_LIMIT'],[500,'TURNKEY_REQUEST']]){
  const client=new TurnkeyClient({...options,fetcher:async()=>({ok:false,status,json:()=>{throw Error('body must not be read');}})});
  await assert.rejects(()=>client.query('get_wallets'),e=>e.code===code&&e.message===code);
  assert.equal(readinessFailure('wallet-list',{code}).code,code);
 }
 const client=new TurnkeyClient({...options,fetcher:async()=>{throw Error('synthetic secret URL');}});
 await assert.rejects(()=>client.query('get_wallets'),e=>e.code==='TURNKEY_CONNECTION'&&!e.message.includes('secret'));
});
test('fixed-recipient withdrawal persists before Sender and refuses duplicate approval',async t=>{
 const vault=setup(t),pair=Keypair.generate(),owner=pair.publicKey.toBase58(),recipient=Keypair.generate().publicKey.toBase58(),blockhash=Keypair.generate().publicKey.toBase58();let sends=0,signs=0;
 const journalDir=mkdtempSync(join(tmpdir(),'xmr20-journal-test-'));const journal=new ExecutionJournal(join(journalDir,'journal.vault'),password);t.after(()=>{journal.close();rmSync(journalDir,{recursive:true,force:true});});
 const signer=createTurnkeySigner({organizationId:'synthetic-org',journal,now:()=>1000,client:{signTransaction:async request=>{signs++;const tx=VersionedTransaction.deserialize(Buffer.from(request.parameters.unsignedTransaction,'hex'));tx.sign([pair]);return {activity:{id:'synthetic-activity',organizationId:'synthetic-org',type:request.type,status:'ACTIVITY_STATUS_COMPLETED',result:{signTransactionResult:{signedTransaction:Buffer.from(tx.serialize()).toString('hex')}}}};}}});
 const connection={getLatestBlockhash:async()=>({blockhash,lastValidBlockHeight:100}),getFeeForMessage:async()=>({value:11000}),getBalance:async()=>1000000000,simulateTransaction:async()=>({value:{err:null,accounts:[{lamports:899980000}]}}),isBlockhashValid:async()=>({value:true})};
 const trader=new TradePilot({vault,owner,withdrawalAddress:recipient,connection,signer,journal,now:()=>1000,helius:{sendExact:async(bytes,signature)=>{sends++;const d=Object.values(vault.state.trades)[0];assert.equal(d.state,'submitted');assert.equal(d.signedTransaction,Buffer.from(bytes).toString('base64'));assert.equal(journal.get('trade:'+d.id).state,'signed');return {signature,route:'helius-sender'};}}});
 const d=await trader.prepare({side:'withdraw',amountRaw:'100000000'});assert.equal(d.withdrawalAddress,recipient);await trader.approve(d.id);assert.equal(sends,1);assert.equal(signs,1);
 await assert.rejects(()=>trader.approve(d.id),/EXPIRED/);assert.equal(sends,1);assert.equal(signs,1);
 await assert.rejects(()=>trader.prepare({side:'withdraw',amountRaw:'250000001'}),/LIMIT/);
});
test('Helius Sender ambiguity falls back with identical bytes and signature',async()=>{
 const pair=Keypair.generate(),tx=new VersionedTransaction(new TransactionMessage({payerKey:pair.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[SystemProgram.transfer({fromPubkey:pair.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1})]}).compileToV0Message());tx.sign([pair]);const sig=bs58.encode(tx.signatures[0]),calls=[];
 const helius=createHelius('synthetic_helius_key_123',{fetcher:async(url,init)=>{const body=JSON.parse(init.body);calls.push({url,body});if(url.includes('sender.'))throw Error('synthetic ambiguity');return new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:sig}));}});
 const result=await helius.sendExact(tx.serialize(),sig);assert.equal(result.route,'helius-rpc');assert.equal(calls.length,2);assert.deepEqual(calls[0].body.params,calls[1].body.params);
 await assert.rejects(()=>helius.sendExact(tx.serialize(),'wrong'),/SIGNATURE/);assert.equal(calls.length,2);
});
test('readiness does not confuse a connected API key with a funded-ready wallet',async()=>{
 const org='00000000-0000-0000-0000-000000000001',user='00000000-0000-0000-0000-000000000002',root='00000000-0000-0000-0000-000000000003',key='02'+'a'.repeat(64);
 const client={query:async method=>({whoami:{organizationId:org,userId:user},get_user:{user:{userId:user,apiKeys:[{credential:{publicKey:key,type:'CREDENTIAL_TYPE_API_KEY_P256'}}]}},get_organization_configs:{configs:{quorum:{threshold:1,userIds:[root]}}},get_wallets:{wallets:[]}}[method])};
 const stages=[];
 const r=await pilotPreflight({client,identity:{organizationId:org,userId:user,apiPublicKey:key},helius:{verify:async()=>{}},onStage:s=>stages.push(s)});
 assert.equal(r.identityVerified,true);assert.equal(r.mainnetReady,false);assert.equal(r.walletVerified,false);assert.match(r.missing[0],/dedicated Solana wallet/);
 assert.deepEqual(stages,['turnkey-identity','helius-network','wallet-list']);
 stages.length=0;
 await assert.rejects(()=>pilotPreflight({client,identity:{organizationId:org,userId:user,apiPublicKey:key},helius:{verify:async()=>{throw Error('synthetic secret URL');}},onStage:s=>stages.push(s)}));
 assert.deepEqual(stages,['turnkey-identity','helius-network']);
});
test('readiness failure reports contain only fixed diagnostics, never provider text or credentials',()=>{
 const secret='synthetic-secret-never-in-report';
 for(const stage of ['vault','helius-network',secret]){
  const r=readinessFailure(stage,Object.assign(Error(secret),{code:secret,response:{secret}}));
  assert.equal(r.ok,false);assert.equal(r.mainnetReady,false);assert.equal(r.code,'CHECK_FAILED');
  assert.ok(!JSON.stringify(r).includes(secret));
 }
 assert.equal(readinessFailure('vault',{code:'VAULT_LOCKED'}).code,'VAULT_LOCKED');
 assert.equal(readinessFailure('toString',{}).stage,'unknown');
});
test('native bigint converter is absent and a rebuilt native module is refused',t=>{
 assertNoNativeBigint();const dir=mkdtempSync(join(tmpdir(),'bigint-guard-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(join(dir,'bigint_buffer.node'),'synthetic native placeholder');assert.throws(()=>assertNoNativeBigint(dir),/NATIVE_BIGINT_DISABLED/);
});
test('pilot policy verification refuses absent, extra, widened and time-gated grants',()=>{
 const identity={userId:'00000000-0000-0000-0000-000000000001',walletId:'00000000-0000-0000-0000-000000000002',apiPublicKey:'02'+'a'.repeat(64),walletAddress:Keypair.generate().publicKey.toBase58()};
 const p=pilotPolicy(identity);assert.equal(matchesPilotPolicy([p],p),true);
 for(const policies of [[],[p,p],[{...p,condition:'true'}],[{...p,consensus:'true'}],[{...p,effect:'EFFECT_DENY'}],[{...p,time:'true'}]])assert.equal(matchesPilotPolicy(policies,p),false);
 assert.equal(matchesPilotPolicy([{...p,policyId:'synthetic',notes:'dashboard note'}],p),true);
 assert.throws(()=>pilotPolicy({...identity,userId:"' || true"}),/POLICY_IDENTITY/);
});
test('setup signature probe uses only a zero-value self-transfer with invalid blockhash and persists verified result',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'setup-probe-test-'));
 const journal=new ExecutionJournal(join(dir,'journal.vault'),password);t.after(()=>{journal.close();rmSync(dir,{recursive:true,force:true});});
 const pair=Keypair.generate(),address=pair.publicKey.toBase58();let calls=0,operationId;
 const originalReserve=journal.reserve.bind(journal);journal.reserve=r=>{operationId=r.operationId;originalReserve(r);};
 const client={signTransaction:async request=>{
  calls++;const tx=VersionedTransaction.deserialize(Buffer.from(request.parameters.unsignedTransaction,'hex'));
  assert.equal(tx.message.recentBlockhash,PublicKey.default.toBase58());
  const message=TransactionMessage.decompile(tx.message);assert.equal(message.instructions.length,1);
  const transfer=SystemInstruction.decodeTransfer(message.instructions[0]);assert.equal(transfer.lamports,0n);assert.equal(transfer.fromPubkey.toBase58(),address);assert.equal(transfer.toPubkey.toBase58(),address);
  assert.equal(journal.get(operationId).state,'reserved');tx.sign([pair]);
  return {activity:{id:'probe-activity',organizationId:'synthetic-org',type:request.type,status:'ACTIVITY_STATUS_COMPLETED',result:{signTransactionResult:{signedTransaction:Buffer.from(tx.serialize()).toString('hex')}}}};
 }};
 const signer=createTurnkeySigner({client,organizationId:'synthetic-org',journal});
 const result=await probePilotSigner({signer,address});assert.equal(calls,1);assert.equal(result.signatureVerified,true);assert.equal(result.broadcast,false);assert.equal(result.invalidBlockhash,true);assert.equal(journal.get(operationId).state,'signed');
});

test('zero-funded preparation preserves token and stops before gateway work or signing',async t=>{
 const f=launchFixture(t);f.pilot.connection.getBalance=async()=>0;
 const before=f.pilot.get(f.id);
 await assert.rejects(f.pilot.prepare(f.id),/LAUNCH_BALANCE_ZERO/);
 assert.deepEqual(f.pilot.get(f.id),before);assert.equal(f.calls.length,0);assert.equal(f.signs,0);
 f.pilot.connection.getBalance=async()=>1000000000;
 const review=await f.pilot.prepare(f.id);assert.equal(review.mint,before.mint);assert.equal(review.id,f.id);
});

test('order deletion revokes unsigned draft callbacks and preserves completed receipts',async t=>{
 const f=launchFixture(t),e=new PilotEngine({vault:f.vault,ownerId:123,wallet:f.owner,launch:f.pilot});
 const menu=await e.handle(update(500,'/start'));
 assert.deepEqual(menu.reply_markup.inline_keyboard[1].map(b=>b.text),['🚀 Launch','🟢 Buy','🔴 Sell']);
 assert.ok(menu.reply_markup.inline_keyboard.every(row=>row.every(b=>b.text.includes(' '))));
 const orders=await e.handle(update(501,'/orders'));assert.equal(orders.reply_markup.inline_keyboard[0][2].text,'🗑 Delete');
 assert.match((await e.handle(update(502,`delete:launch:${f.id}`))).text,/Draft deleted/);
 assert.equal(f.pilot.vault.state.launches[f.id].state,'deleted');
 assert.equal((await e.handle(update(503,'/orders'))).text,'No orders yet.');
 assert.match((await e.handle(update(504,`prepare:${f.id}`))).text,/removed/);assert.equal(f.calls.length,0);
 await assert.rejects(f.pilot.prepare(f.id),/NOT_FOUND/);
 const receipt={signature:'synthetic-receipt'};
 f.vault.transaction(s=>{s.launches.done={id:'done',owner:f.owner,symbol:'DONE',state:'complete',row:{receipts:[receipt]}};});
 assert.match((await e.handle(update(505,'delete:launch:done'))).text,/receipts are retained/);
 assert.deepEqual(f.vault.state.launches.done.row.receipts,[receipt]);assert.equal(f.vault.state.launches.done.state,'complete');
});
test('pending or journal-reserved orders cannot be hidden and other users cannot delete',async t=>{
 const f=launchFixture(t),e=new PilotEngine({vault:f.vault,ownerId:123,wallet:f.owner,launch:f.pilot});
 for(const state of ['signing','submitted','attention','pool-confirmed']){
  f.vault.transaction(s=>{s.launches[f.id].state=state;});
  assert.match((await e.command(`delete:launch:${f.id}`)).text,/still pending/);
  assert.equal(f.vault.state.launches[f.id].hiddenFromOrders,undefined);
 }
 f.vault.transaction(s=>{s.launches[f.id].state='review';});f.pilot.journal={get:()=>({state:'reserved'})};
 assert.match((await e.command(`delete:launch:${f.id}`)).text,/still pending/);
 assert.equal(await e.handle(update(1,`delete:launch:${f.id}`,456)),null);
 assert.match((await e.command('delete:launch:unknown')).text,/not found/);
});
test('skip image uses valid bounded default PNG and duplicate clicks preserve the current form',async t=>{
 const f=launchFixture(t),e=new PilotEngine({vault:f.vault,ownerId:123,wallet:f.owner,launch:f.pilot});
 await e.handle(update(1,'/launch'));await e.handle(update(2,'Example'));
 const prompt=await e.handle(update(3,'EG'));assert.equal(prompt.reply_markup.inline_keyboard[0][0].text,'⏭ Skip image');
 assert.match((await e.handle(update(4,'skip-image'))).text,/default XMR20 image/);
 const draft=structuredClone(f.vault.state.draft);assert.equal(draft.stage,'initial');
 const meta=await sharp(Buffer.from(draft.imageBase64,'base64')).metadata();assert.equal(meta.format,'png');assert.ok(meta.width<=512);
 await e.handle(update(5,'skip-image'));assert.deepEqual(f.vault.state.draft,draft);
 await e.handle(update(6,'0'));const saved=Object.values(f.vault.state.launches).at(-1);assert.equal(saved.imageBase64,draft.imageBase64);assert.equal(saved.initialSolLamports,'0');
});

test('preparation errors cross gateway as fixed codes without leaking backend text',async t=>{
 const {decodeGatewayReply}=await import('../src/launch-gateway.mjs');
 const script=`import runpy,json\nm=runpy.run_path('scripts/launch_gateway.py')\nf=m['safe_backend_error']\na='meteoraPrepare'\nmessage='Launch check failed during pool creation and the initial buy. Retry preparation; nothing was sent.'\nassert f(a,{'error':message})=='LAUNCH_POOL_CHECK'\nassert f('meteoraSubmit',{'error':message})=='LAUNCH_GATEWAY_UNAVAILABLE'\nfor payload in [{'error':'private backend payload'}, {'error':{'message':message}}, {}, None]:\n assert f(a,payload)=='LAUNCH_GATEWAY_UNAVAILABLE'\nprint(json.dumps({'ok':False,'error':f(a,{'error':message})}))\n`;
 const r=spawnSync('python3',['-c',script],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 assert.throws(()=>decodeGatewayReply(r.stdout,'meteoraPrepare'),/^Error: LAUNCH_POOL_CHECK$/);
 assert.throws(()=>decodeGatewayReply(r.stdout,'meteoraSubmit'),/^Error: GATEWAY_REQUEST$/);
 assert.throws(()=>decodeGatewayReply('{"ok":false,"error":"secret provider error"}','meteoraPrepare'),/^Error: GATEWAY_REQUEST$/);
 assert.throws(()=>decodeGatewayReply('invalid private data','meteoraPrepare'),/^Error: GATEWAY_REQUEST$/);
 const vault=setup(t),wallet=Keypair.generate().publicKey.toBase58();
 vault.transaction(s=>{s.launches={saved:{state:'draft',owner:wallet,bundle:[]}};});
 const before=structuredClone(vault.state.launches);
 const engine=new PilotEngine({vault,ownerId:123,wallet,launch:{prepare:async()=>decodeGatewayReply(r.stdout,'meteoraPrepare')}});
 const reply=await engine.handle(cb(900,'prepare:saved'));
 assert.match(reply.text,/Pool setup simulation failed/);assert.match(reply.text,/0.01 SOL/);assert.match(reply.text,/Orders → Prepare/);
 assert.deepEqual(vault.state.launches,before);
});
