import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from '../src/vault.mjs';
import { Engine, amount, address } from '../src/engine.mjs';
import { HeliusRead } from '../src/helius.mjs';
import { Telegram, deliverUpdate, poll } from '../src/telegram.mjs';

const password = 'synthetic test password never real';
function setup(t) {
 const dir=mkdtempSync(join(tmpdir(),'bot-test-')),path=join(dir,'state.vault');
 const vault=new Vault(path,password); let time=1000,seq=0;
 const engine=new Engine(vault,{allowedUsers:[11,22],now:()=>time});
 const update=(text,user=11,id=++seq)=>({update_id:id,message:{from:{id:user},chat:{type:'private',id:user},text}});
 const send=(text,user=11)=>engine.handle(update(text,user));
 const confirm=(user=11)=>send('confirm:'+vault.state.accounts[user].draft.review.id,user);
 t.after(()=>{vault.close();rmSync(dir,{recursive:true,force:true});});
 return {vault,engine,path,dir,update,send,confirm,tick:n=>time+=n};
}
test('exact atomic amounts and base58 address validation',()=>{
 assert.equal(amount('0.000000001'),1n); assert.equal(amount('0',9,true),0n);
 for(const bad of ['0','-1','1e3','0.0000000001','NaN','01','1,000']) assert.throws(()=>amount(bad));
 assert(address('11111111111111111111111111111111')); assert(!address('z'.repeat(44)));
});
test('vault encrypts identities and balances, persists restart and refuses concurrent writer',t=>{
 const s=setup(t); s.send('/fund');
 const raw=readFileSync(s.path,'utf8'); assert(!raw.includes('accounts')); assert(!raw.includes('1000000000'));
 assert.equal(statSync(s.path).mode&0o777,0o600); assert.throws(()=>new Vault(s.path,password));
 s.vault.close(); const reopened=new Vault(s.path,password); assert.equal(reopened.state.accounts[11].sol,'1000000000'); reopened.close();
});
test('wrong password and tampering fail closed preserving ciphertext',t=>{
 const s=setup(t);s.send('/fund');s.vault.close();const original=readFileSync(s.path,'utf8');
 assert.throws(()=>new Vault(s.path,'wrong synthetic password here')); assert.equal(readFileSync(s.path,'utf8'),original);
 const envelope=JSON.parse(original);const data=Buffer.from(envelope.data,'base64');data[0]^=1;envelope.data=data.toString('base64');writeFileSync(s.path,JSON.stringify(envelope));assert.throws(()=>new Vault(s.path,password));
});
test('only allowed private user can act; forwarded callback cannot act for another user',t=>{
 const s=setup(t);assert.equal(s.send('/fund',33),null);
 const u=s.update('/fund');u.message.chat.type='group';assert.equal(s.engine.handle(u),null);
 assert.equal(s.engine.handle({update_id:99,callback_query:{data:'/fund',from:{id:22},message:{chat:{id:11,type:'private'}}}}),null);
 assert.equal(Object.keys(s.vault.state.accounts).length,0);
});
test('duplicate updates and confirmations cannot debit twice',t=>{
 const s=setup(t);s.send('/fund');const u=s.update('/buy DEMO 0.1',11,100);const first=s.engine.handle(u);assert.deepEqual(s.engine.handle(u),first);
 const id=s.vault.state.accounts[11].draft.review.id;s.confirm();const balance=s.vault.state.accounts[11].sol;
 assert.match(s.send('confirm:'+id).text,/already completed/);assert.equal(s.vault.state.accounts[11].sol,balance);
});
test('other user cannot confirm an order',t=>{
 const s=setup(t);s.send('/fund');s.send('/buy DEMO 0.1');const id=s.vault.state.accounts[11].draft.review.id;
 assert.match(s.send('confirm:'+id,22).text,/does not belong/);assert.equal(s.vault.state.accounts[11].sol,'1000000000');
});
test('expired review, cancelled review and replaced review never debit',t=>{
 const s=setup(t);s.send('/fund');s.send('/buy DEMO 0.1');let id=s.vault.state.accounts[11].draft.review.id;s.tick(30000);
 assert.match(s.send('confirm:'+id).text,/expired/);s.send('/buy DEMO 0.1');id=s.vault.state.accounts[11].draft.review.id;s.send('/cancel');assert.match(s.send('confirm:'+id).text,/does not belong/);
 s.send('/buy DEMO 0.1');id=s.vault.state.accounts[11].draft.review.id;s.send('/buy DEMO 0.2');assert.match(s.send('confirm:'+id).text,/does not belong/);assert.equal(s.vault.state.accounts[11].sol,'1000000000');
});
test('launch wizard supports either mode, arbitrary ticker and 0 initial buy',t=>{
 const s=setup(t);s.send('/fund');for(const mode of ['normal','xmr20']) {for(const command of ['/launch','My Token','TST',mode,'0','skip_image'])s.send(command);s.confirm();}
 assert.equal(s.vault.state.accounts[11].orders.length,2);assert.equal(s.vault.state.accounts[11].sol,'880000000');assert(s.vault.state.accounts[11].orders.every(o=>o.asset.startsWith('demo:')));
});
test('buy then sell 25 percent and withdrawal conserve paper balances including fee',t=>{
 const s=setup(t);s.send('/fund');s.send('/buy DEMO 0.1');s.confirm();assert.equal(s.vault.state.accounts[11].tokens.DEMO,'100000000');
 s.send('/sell DEMO 25');s.confirm();assert.equal(s.vault.state.accounts[11].tokens.DEMO,'75000000');assert.equal(s.vault.state.accounts[11].sol,'924990000');
 s.send('/withdraw 11111111111111111111111111111111 0.2');s.confirm();assert.equal(s.vault.state.accounts[11].sol,'724985000');
});
test('insufficient funds, invalid input and tiny holdings leave state recoverable',t=>{
 const s=setup(t);s.send('/fund');assert.match(s.send('/buy DEMO 1').text,/Insufficient/);
 s.send('/buy');s.send('DEMO');assert.match(s.send('1e6').text,/ordinary/);assert.equal(s.vault.state.accounts[11].draft.values.length,1);
 s.send('0.1');s.confirm();s.send('/sell');s.send('DEMO');assert.match(s.send('101').text,/percentage/);s.send('25');s.confirm();
});
test('failed reply redelivery reuses saved confirmation, does not execute twice',async t=>{
 const s=setup(t);s.send('/fund');s.send('/buy DEMO 0.1');const update=s.update('confirm:'+s.vault.state.accounts[11].draft.review.id,11,100);
 await assert.rejects(deliverUpdate({call:async()=>{throw Error('offline');}},s.engine,s.vault,update));assert.equal(s.vault.state.offset,0);
 await deliverUpdate({call:async()=>true},s.engine,s.vault,update);assert.equal(s.vault.state.accounts[11].orders.length,1);assert.equal(s.vault.state.offset,101);
});
test('erasure clears account history and cached responses',t=>{
 const s=setup(t);s.send('/fund');s.send('/buy DEMO 0.1');s.confirm();s.send('/erase');assert.equal(s.vault.state.accounts[11].orders.length,0);assert.equal(Object.keys(s.vault.state.updates).length,1);
});
test('persistence failure does not commit an order in memory',t=>{
 const s=setup(t);s.send('/fund');s.send('/buy DEMO 0.1');s.vault.persist=()=>{throw Error('disk full');};assert.throws(()=>s.confirm());assert.equal(s.vault.state.accounts[11].orders.length,0);
});
test('Helius adapter pins host, bounds reads, rejects sending and redacts errors',async()=>{
 let request;const rpc=new HeliusRead('synthetic-key-only',{fetcher:async(url,opts)=>{request={url,opts};return {ok:true,json:async()=>({id:1,result:{value:42}})};}});
 assert.equal((await rpc.balance('11111111111111111111111111111111')).value,42);assert.equal(new URL(request.url).hostname,'mainnet.helius-rpc.com');assert.equal(JSON.parse(request.opts.body).params[1].commitment,'finalized');assert.equal(request.opts.redirect,'error');
 await assert.rejects(rpc.request('sendTransaction',[]));const bad=new HeliusRead('synthetic-key-only',{fetcher:async()=>{throw Error('URL api-key=DO_NOT_LOG');}});await assert.rejects(bad.balance('x'),e=>!e.message.includes('DO_NOT_LOG'));
});
test('Telegram adapter uses fixed HTTPS host and suppresses token-bearing failures',async()=>{
 const bot=new Telegram('123:synthetic_test_token_1234567890',{fetcher:async(url)=>{assert.equal(new URL(url).hostname,'api.telegram.org');throw Error(url);}});
 await assert.rejects(bot.call('getMe',{}),e=>!e.message.includes('synthetic'));await assert.rejects(bot.call('setWebhook',{}));
});

test('a stalled tap acknowledgement cannot block a reply or the next update',async t=>{
 const s=setup(t),calls=[];let finishAck;
 const ack=new Promise(resolve=>{finishAck=resolve;});t.after(()=>finishAck());
 const api={call:async method=>{calls.push(method);if(method==='answerCallbackQuery')return ack;return true;}};
 const update={update_id:100,callback_query:{id:'test-callback',from:{id:11},message:{chat:{id:11,type:'private'}},data:'/fund'}};
 let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Reply blocked by acknowledgement')),500);});
 try {await Promise.race([deliverUpdate(api,s.engine,s.vault,update),timeout]);}finally{clearTimeout(timer);}
 assert.deepEqual(calls,['answerCallbackQuery','sendMessage']);assert.equal(s.vault.state.offset,101);
 await deliverUpdate(api,s.engine,s.vault,s.update('/wallet',11,101));assert.equal(s.vault.state.offset,102);
});
test('reply retries use committed cache without another engine disk write',t=>{
 const s=setup(t),u=s.update('/fund');const first=s.engine.handle(u);
 s.vault.persist=()=>{throw Error('unexpected write');};assert.deepEqual(s.engine.handle(u),first);
 assert.equal(s.vault.state.accounts[11].sol,'1000000000');
});
test('launch asks for image before review and saves photo only in encrypted state',async t=>{
 const s=setup(t);s.send('/fund');for(const v of ['/launch','Photo Token','PIC','xmr20'])s.send(v);
 const prompt=s.send('0');assert.match(prompt.text,/token image/);assert(!s.vault.state.accounts[11].draft.review);
 assert.match(s.send('not a photo').text,/token image/);
 const u=s.update(undefined,11,100);u.message.photo=[{file_id:'synthetic_small',width:100,height:100},{file_id:'synthetic_photo_reference',width:800,height:600,file_size:12345}];
 let sent;await deliverUpdate({call:async(method,data)=>{sent={method,data};}},s.engine,s.vault,u);
 assert.equal(sent.method,'sendPhoto');assert.equal(sent.data.photo,'synthetic_photo_reference');assert.match(sent.data.caption,/Image: attached/);assert(sent.data.protect_content);
 assert(sent.data.reply_markup.inline_keyboard[0][0].callback_data.startsWith('confirm:'));
 assert(!readFileSync(s.path,'utf8').includes('synthetic_photo_reference'));
 s.confirm();assert.equal(s.vault.state.accounts[11].orders[0].image.fileId,'synthetic_photo_reference');
});
test('image skip creates review; unauthorized, oversized, expired and out-of-step images do not attach',t=>{
 const s=setup(t);s.send('/fund');for(const v of ['/launch','Name','N','normal','0'])s.send(v);
 const photo=user=>{const u=s.update(undefined,user);u.message.photo=[{file_id:'synthetic_photo',width:100,height:100,file_size:11*1024*1024}];return u;};
 assert.equal(s.engine.handle(photo(33)),null);assert.match(s.engine.handle(photo(11)).text,/smaller than 10 MB/);assert(s.vault.state.accounts[11].draft.awaitingImage);
 assert.match(s.send('skip_image').text,/Image: ticker default/);assert(!s.vault.state.accounts[11].draft.image);
 assert.match(s.engine.handle(photo(11)).text,/when asked/);
 s.send('/cancel');for(const v of ['/launch','Name','N','normal','0'])s.send(v);s.tick(600000);
 assert.match(s.engine.handle(photo(11)).text,/expired/);assert.equal(s.vault.state.accounts[11].draft,null);
});
test('photo reply failure retains image and cached review without applying an order',async t=>{
 const s=setup(t);s.send('/fund');for(const v of ['/launch','Name','N','normal','0'])s.send(v);
 const u=s.update(undefined,11,100);u.message.photo=[{file_id:'synthetic_photo',width:100,height:100}];
 await assert.rejects(deliverUpdate({call:async()=>{throw Error('offline');}},s.engine,s.vault,u));
 const review=s.vault.state.accounts[11].draft.review.id;
 await deliverUpdate({call:async()=>true},s.engine,s.vault,u);
 assert.equal(s.vault.state.accounts[11].draft.review.id,review);assert.equal(s.vault.state.accounts[11].orders.length,0);
});
test('caller cancellation aborts Telegram fetch without logging provider details',async()=>{
 const controller=new AbortController();
 const bot=new Telegram('123:synthetic_test_token_1234567890',{fetcher:async(_url,opts)=>new Promise((_,reject)=>{opts.signal.addEventListener('abort',()=>reject(Error('private URL')),{once:true});})});
 const pending=bot.call('getUpdates',{}, {signal:controller.signal});controller.abort();
 await assert.rejects(pending,e=>!e.message.includes('private URL'));
});
test('poll shutdown interrupts an idle long poll and does not retry',async t=>{
 const s=setup(t),controller=new AbortController();let polls=0;
 const api={call:async(method,_data,{signal})=>{if(method==='getWebhookInfo')return {url:''};if(method==='getMe')return {};polls++;controller.abort();signal.throwIfAborted();}};
 await poll(api,s.engine,s.vault,{signal:controller.signal});assert.equal(polls,1);
});
test('timings contain only durations and completed updates cannot be replayed',async t=>{
 const s=setup(t);let timing,replies=0;
 const api={call:async()=>{replies++;}};const u=s.update('/fund',11,100);
 await deliverUpdate(api,s.engine,s.vault,u,{onTiming:value=>timing=value});
 assert.deepEqual(Object.keys(timing),['localMs','deliveryMs','totalMs']);assert(Object.values(timing).every(n=>Number.isFinite(n)&&n>=0));
 await deliverUpdate(api,s.engine,s.vault,u);assert.equal(replies,1);assert.equal(s.vault.state.accounts[11].sol,'1000000000');
});

test('startup distinguishes an existing lock without removing it',t=>{
 const s=setup(t);
 assert.throws(()=>new Vault(s.path,password),e=>e.code==='VAULT_LOCKED');
 assert.equal(statSync(s.path+'.lock').size,0);
});
test('real bot entry point releases its lock on stop and terminal hangup',async t=>{
 const {spawn}=await import('node:child_process');
 const {once}=await import('node:events');
 for(const signal of ['SIGINT','SIGTERM','SIGHUP']) {
  const dir=mkdtempSync(join(tmpdir(),'bot-stop-'));
  const path=join(dir,'.local/share/xmr20-telegram-paper/state.vault');
  const vault=new Vault(path,password);
  vault.transaction(s=>{s.credentials={token:'123:synthetic_test_token_1234567890',allowedUsers:[11]};});vault.close();
  const before=readFileSync(path);
  const mock=join(dir,'transport.mjs');
  writeFileSync(mock,`globalThis.fetch=async(url,opts)=>{
    if(url.endsWith('/getUpdates')) {console.log('SYNTHETIC_POLL_READY');return new Promise((_,reject)=>{const hold=setTimeout(()=>reject(Error('test timeout')),60000);opts.signal.addEventListener('abort',()=>{clearTimeout(hold);reject(Error('cancelled'));},{once:true});});}
    return {ok:true,json:async()=>({ok:true,result:url.endsWith('/getWebhookInfo')?{url:''}:{id:123}})};
  };`);
  const child=spawn(process.execPath,['--import',mock,new URL('../src/main.mjs',import.meta.url).pathname],{env:{...process.env,HOME:dir},stdio:['pipe','pipe','pipe']});
  const done=once(child,'exit');let output='',errors='';child.stderr.on('data',v=>errors+=v);
  try {
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Test entry point did not start')),8000);
    child.stdout.on('data',v=>{output+=v;if(output.includes('SYNTHETIC_POLL_READY')){clearTimeout(timer);resolve();}});
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',()=>{clearTimeout(timer);if(!output.includes('SYNTHETIC_POLL_READY'))reject(Error('Early test exit'));});
    child.stdin.end(JSON.stringify({password}));
   });
   child.kill(signal);
   const [code]=await done;assert.equal(code,0);assert.equal(errors,'');
   assert.throws(()=>statSync(path+'.lock'),e=>e.code==='ENOENT');
   assert.deepEqual(readFileSync(path),before);
  }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await done;}rmSync(dir,{recursive:true,force:true});}
 }
});
