import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {Registration,UserVault,PublicEngine,boundSigner,registrationPolicies,matchesPolicySet} from '../src/registration.mjs';
import {PilotEngine} from '../src/pilot-engine.mjs';
import {spawnSync} from 'node:child_process';
function fixture(){
 const vault={state:{owner:Keypair.generate().publicKey.toBase58()},transaction(fn){const copy=structuredClone(this.state);const result=fn(copy);this.state=copy;return result;}};
 const wallets=[],accounts=new Map();let creates=0,activations=0,lose=false;
 const client={query:async(method,args)=>method==='get_wallets'?{wallets}: {accounts:accounts.get(args.walletId)},createWallet:async request=>{
   creates++;const walletId='wallet-'+creates;wallets.push({walletId,walletName:request.parameters.walletName});
   accounts.set(walletId,[{...request.parameters.accounts[0],organizationId:'org',walletId,address:Keypair.generate().publicKey.toBase58()}]);
   if(lose)throw Error('unknown');return {activity:{id:'activity-'+creates,type:request.type,organizationId:'org',status:'ACTIVITY_STATUS_COMPLETED',result:{createWalletResult:{walletId}}}};
 }};
 const registration=new Registration({vault,client,organizationId:'org',botId:111,activateWallet:async()=>{activations++;}});
 return {vault,client,registration,accounts,wallets,get creates(){return creates;},get activations(){return activations;},lose(){lose=true;}};
}
const update=(id,user,text)=>({update_id:id,message:{from:{id:user},chat:{id:user,type:'private'},text}});
test('each user gets one distinct wallet; repeated/concurrent starts reuse it',async()=>{
 const f=fixture();const [a,b]=await Promise.all([f.registration.ensure(1),f.registration.ensure(1)]);
 assert.equal(a.walletAddress,b.walletAddress);const c=await f.registration.ensure(2);
 assert.notEqual(a.walletAddress,c.walletAddress);assert.equal(f.creates,2);assert.equal(f.activations,2);
 assert.equal((await f.registration.ensure(1)).walletAddress,a.walletAddress);assert.equal(f.creates,2);
 const one=new UserVault(f.vault,1),two=new UserVault(f.vault,2);one.transaction(s=>{s.launches={mine:{id:'mine'}};s.withdrawalAddress='mine';});
 assert.equal(two.state.launches,undefined);assert.equal(two.state.withdrawalAddress,undefined);assert.equal(f.vault.state.launches,undefined);
});
test('unknown creation is reconciled by saved unique wallet name without a second create',async()=>{
 const f=fixture();f.lose();await assert.rejects(f.registration.ensure(1));assert.equal(f.registration.get(1).state,'creating');
 const r=await f.registration.ensure(1);assert.equal(r.state,'ready');assert.equal(f.creates,1);
 const g=fixture();g.client.createWallet=async()=>{throw Error('unknown before commit');};await assert.rejects(g.registration.ensure(1));
 let again=0;g.client.createWallet=()=>{again++;};await assert.rejects(g.registration.ensure(1),/PENDING/);assert.equal(again,0);
});
test('activation uncertainty never publishes deposit address or repeats signing',async()=>{
 const f=fixture();let count=0;f.registration.activateWallet=async()=>{count++;throw Error('unknown');};
 await assert.rejects(f.registration.ensure(1),/ATTENTION/);await assert.rejects(f.registration.ensure(1),/ATTENTION/);assert.equal(count,1);
 assert.throws(()=>new UserVault(f.vault,1).state,/NOT_READY/);
});
test('registration capacity and reuse of the owner wallet fail closed',async()=>{
 const f=fixture();f.registration.maxUsers=1;await f.registration.ensure(1);await assert.rejects(f.registration.ensure(2),/CAPACITY/);
 const g=fixture(),create=g.client.createWallet;g.client.createWallet=async r=>{const out=await create(r);g.accounts.get('wallet-1')[0].address=g.vault.state.owner;return out;};
 await assert.rejects(g.registration.ensure(1),/DUPLICATE/);assert.equal(g.activations,0);
});
test('public start displays the correct address to every user without balance RPC; groups rejected',async()=>{
 const f=fixture();let network=0;
 const engine=new PublicEngine({ownerId:999,ownerEngine:{handle:()=>({text:'owner'})},registration:f.registration,
 createEngine:async(id,r)=>new PilotEngine({vault:new UserVault(f.vault,id),ownerId:id,wallet:r.walletAddress,helius:{balance:()=>{network++;}}})});
 for(const id of [1,2]){
  const reply=await engine.handle(update(id,id,'/start'));assert.equal(reply.chat_id,id);assert.ok(reply.text.includes(`<code>${f.registration.get(id).walletAddress}</code>`));assert.equal(reply.parse_mode,'HTML');
 }
 assert.equal(network,0);assert.equal(f.creates,2);
 const group=update(3,3,'/start');group.message.chat={id:-123,type:'group'};assert.equal(await engine.handle(group),null);assert.equal(f.creates,2);
 const before=f.creates;assert.match((await engine.handle(update(4,4,'/wallet'))).text,/Send \/start/);assert.equal(f.creates,before);
});
test('signer and withdrawal settings stay bound to the requesting user',async()=>{
 const f=fixture();await f.registration.ensure(1);await f.registration.ensure(2);const recipient=Keypair.generate().publicKey.toBase58();
 const one=new UserVault(f.vault,1),two=new UserVault(f.vault,2),trading={};
 const e=new PilotEngine({vault:one,ownerId:1,wallet:f.registration.get(1).walletAddress,trading});
 assert.match((await e.handle(update(1,1,'/withdraw'))).text,/separate wallet/);
 await e.handle(update(2,1,recipient));assert.equal(one.state.withdrawalAddress,recipient);assert.equal(two.state.withdrawalAddress,undefined);assert.equal(trading.withdrawalAddress,recipient);
 let calls=0;const signer=boundSigner({signReviewed:()=>{calls++;}},f.registration.get(1).walletAddress);
 assert.throws(()=>signer.signReviewed({address:f.registration.get(2).walletAddress}),/MISMATCH/);assert.equal(calls,0);
});
test('public policy set rejects widened or extra grants',()=>{
 const p=registrationPolicies({userId:'00000000-0000-0000-0000-000000000001',apiPublicKey:'02'+'a'.repeat(64),botId:123});
 assert.equal(matchesPolicySet(p,p),true);assert.equal(matchesPolicySet([...p,p[0]],p),false);assert.equal(matchesPolicySet([{...p[0],condition:'true'},p[1]],p),false);
 assert.match(p[1].condition,/wallet.label\[0\.\.13\]/);assert.ok(!p.some(x=>x.condition.includes('EXPORT')));
});
test('gateway bindings are immutable, unique, persistent and cannot select owner wallet',()=>{
 const script=`import runpy,tempfile,pathlib\nm=runpy.run_path('scripts/launch_gateway.py')\nf=m['binding_action']\nwith tempfile.TemporaryDirectory() as d:\n p=pathlib.Path(d)/'registry.json'\n b='00000000-0000-0000-0000-000000000001'\n wallet='11111111111111111111111111111111'\n q={'action':'registerWallet','data':{'binding':b,'walletAddress':wallet}}\n assert f(q,'owner',p)['walletAddress']==wallet\n assert f(q,'owner',p)['walletAddress']==wallet\n assert f({'action':'meteoraAccount','binding':b,'data':{}},'owner',p)['owner']==wallet\n assert f({'action':'meteoraAccount','data':{}},'owner',p)['owner']=='owner'\n for q in [{'action':'registerWallet','data':{'binding':b,'walletAddress':'22222222222222222222222222222222'}},{'action':'registerWallet','data':{'binding':'00000000-0000-0000-0000-000000000002','walletAddress':wallet}},{'action':'meteoraAccount','binding':b,'data':{'owner':'other'}}]:\n  try:f(q,'owner',p);raise AssertionError()\n  except ValueError:pass\n`;
 const r=spawnSync('python3',['-c',script],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});
