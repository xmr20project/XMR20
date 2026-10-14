import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Keypair} from '@solana/web3.js';
import {Vault} from '../src/vault.mjs';
import {officialIdentity,verifyOfficialBot,openOfficial,bindOfficialRuntime,heliusKey,saveSetupDraft} from '../src/official-config.mjs';
import {poll} from '../src/telegram.mjs';

const bot={id:12345,username:'xmr20_bot'},ownerId=8001,wallet=Keypair.generate().publicKey.toBase58();
const password='synthetic common unlock passphrase';
test('official connection rejects wrong username, nonbot and changed numeric identity',async()=>{
  assert.deepEqual(officialIdentity({...bot,is_bot:true}),bot);
  assert.deepEqual(officialIdentity({...bot,username:'XMR20_Bot',is_bot:true}),bot);
  assert.throws(()=>officialIdentity({...bot,username:'xmr20bot',is_bot:true}));
  for(const me of [{...bot,username:'old_test_bot',is_bot:true},{...bot,is_bot:false},{...bot,id:54321,is_bot:true}])assert.throws(()=>officialIdentity(me,bot));
  const calls=[];
  assert.deepEqual(await verifyOfficialBot({call:async method=>{calls.push(method);return method==='getMe'?{...bot,is_bot:true}:{url:''};}},bot),bot);
  assert.deepEqual(calls,['getMe','getWebhookInfo']);
  await assert.rejects(verifyOfficialBot({call:async method=>method==='getMe'?{...bot,is_bot:true}:{url:'https://example.invalid/hook'}},bot),/OFFICIAL_WEBHOOK/);
});
test('Helius accepts a raw key or pinned mainnet URL and redacts rejected inputs',()=>{
  const key='synthetic-helius-api-key';
  assert.equal(heliusKey(key),key);
  assert.equal(heliusKey('https://mainnet.helius-rpc.com/?api-key='+key),key);
  for(const bad of ['https://devnet.helius-rpc.com/?api-key='+key,'https://example.invalid/?api-key='+key,'https://mainnet.helius-rpc.com/?api-key='+key+'&api-key=another-secret','https://mainnet.helius-rpc.com/?api-key='+key+'#secret','https://user:secret@mainnet.helius-rpc.com/?api-key='+key])assert.throws(()=>heliusKey(bad),error=>error.message==='HELIUS_INPUT');
});
test('failed verification keeps encrypted setup entries across restart without enabling execution',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'official-draft-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'draft.vault');let vault=new Vault(path,password,{profile:'official-bot'});
  saveSetupDraft(vault,{token:'synthetic-token',heliusApiKey:'synthetic-key',ownerId,withdrawalAddress:wallet,password:'must-not-save'});
  await assert.rejects(verifyOfficialBot({call:async()=>{throw Error('synthetic outage');}}));
  assert.equal(vault.state.credentials,undefined);vault.close();
  assert(!readFileSync(path,'utf8').includes('synthetic-token'));
  assert.throws(()=>openOfficial(path,password));
  vault=new Vault(path,password,{profile:'official-bot'});
  const draft=saveSetupDraft(vault,{token:'corrected-synthetic-token',heliusApiKey:'',withdrawalAddress:''});
  assert.equal(draft.token,'corrected-synthetic-token');assert.equal(draft.heliusApiKey,'synthetic-key');assert.equal(draft.withdrawalAddress,wallet);assert.equal(draft.password,undefined);
  vault.transaction(s=>{s.credentials={bot,allowedUsers:[ownerId],withdrawalAddress:wallet};delete s.setupDraft;});
  assert.throws(()=>saveSetupDraft(vault,{token:'replacement'}),/OFFICIAL_ALREADY_CONFIGURED/);vault.close();
});
test('one existing password unlocks independent credentials without touching old vault',t=>{
  const dir=mkdtempSync(join(tmpdir(),'official-bot-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const oldPath=join(dir,'old.vault'),officialPath=join(dir,'official.vault');
  let old=new Vault(oldPath,'different old synthetic password');old.transaction(s=>{s.accounts.saved={receipt:'preserve'};});old.close();
  const before=readFileSync(oldPath);
  let turnkey=new Vault(join(dir,'turnkey.vault'),password,{profile:'turnkey-connection'});turnkey.close();
  let vault=new Vault(officialPath,password,{profile:'official-bot'});
  vault.transaction(s=>{s.credentials={bot,allowedUsers:[ownerId],withdrawalAddress:wallet,token:'synthetic-secret',heliusApiKey:'synthetic-rpc-secret'};});vault.close();
  assert(!readFileSync(officialPath,'utf8').includes('synthetic-secret'));
  assert.throws(()=>openOfficial(officialPath,'wrong synthetic unlock password'));
  vault=openOfficial(officialPath,password);assert.equal(vault.state.credentials.bot.id,bot.id);vault.close();
  assert.deepEqual(readFileSync(oldPath),before);
  const missing=join(dir,'missing.vault');assert.throws(()=>openOfficial(missing,password));assert(!existsSync(missing));
  assert.throws(()=>new Vault(officialPath,password,{profile:'paper'}));
});
test('official updates and receipts are bound to exact bot, owner and wallet across restart',()=>{
  const binding={bot,ownerId,wallet};const state={mode:'mainnet-pilot'};
  bindOfficialRuntime(state,binding);assert.equal(state.offset,0);
  state.offset=99;state.launches={one:{state:'attention',signature:'saved'}};
  const before=structuredClone(state);bindOfficialRuntime(state,binding);assert.deepEqual(state,before);
  for(const changed of [{...binding,bot:{...bot,id:9988}},{...binding,ownerId:42},{...binding,wallet:Keypair.generate().publicKey.toBase58()}])assert.throws(()=>bindOfficialRuntime(structuredClone(state),changed));
  for(const legacy of [{offset:88},{owner:wallet},{telegramOwner:ownerId},{launches:{one:{state:'attention'}}},{updates:{1:{text:'old'}}},{draft:{stage:'name'}}])assert.throws(()=>bindOfficialRuntime(legacy,binding),/OFFICIAL_STATE_MIGRATION_REQUIRED/);
});
test('poll refuses wrong bot identity before processing or announcing ready',async()=>{
  const calls=[];let ready=false,handled=false;
  await assert.rejects(poll({call:async method=>{calls.push(method);return method==='getWebhookInfo'?{url:''}:{...bot,id:555,is_bot:true};}},{handle:()=>{handled=true;}},{state:{offset:0}},{expectedBot:bot,onReady:()=>{ready=true;}}),/TELEGRAM_IDENTITY_CHANGED/);
  assert.deepEqual(calls,['getWebhookInfo','getMe']);assert.equal(ready,false);assert.equal(handled,false);
});
