// TWO-WALLET INTEROPERABILITY on ONE pool: extension A (real popup, Playwright) and the CLI wallet B
// (cli-wallet/xmr20-private-cli.mjs, built on wallet-lib) share the same daemon, parameter server
// and pool. Flows: extension A -> CLI B -> extension A with 1-, 2- and 3-note inputs and exact change;
// recovery of A's account in the CLI from A's synthetic recovery phrase + public chain; viewing-only
// recovery (no spending authority); wrong keys, malformed records, duplicate spends, mismatched
// parameters; same pool (one indexer sees every record). SHARED COMPONENTS are recorded in the
// results (one engine; see wallet-lib/README.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startBackend} from './backend/service.mjs';
import {harness,auditBackend,dir} from './browser-harness.mjs';
import {Keypair} from '@solana/web3.js';
const CLI=dir+'cli-wallet/xmr20-private-cli.mjs';
const bal=t=>Number(/^([\d,]+(?:\.\d+)?) X/.exec(t)[1].replace(/,/g,''));
const run=(args,{input=''}={})=>new Promise((res,rej)=>{const p=spawn(process.execPath,[CLI,...args],{cwd:dir});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);if(input)p.stdin.end(input);p.on('close',code=>{try{res({code,json:code===0?JSON.parse(out):null,out,err});}catch(e){rej(Error('CLI output not JSON: '+out+err));}});});
test('extension A and CLI wallet B interoperate on one pool',{timeout:3600000},async()=>{
 const h=harness('verified-interop');await h.start();const backend=await startBackend({log:m=>h.log('backend-error',{message:m})});
 const base=['--daemon',backend.rpcUrl,'--params','http://127.0.0.1:8940','--yes'];const work=await mkdtemp(dir+'runs/cli-');const stateB=work+'/B.json',stateA2=work+'/A-restored.json',stateV=work+'/B-view.json',stateW=work+'/wrong.json',stateX=work+'/other-params.json';
 const results={shared:['holder-wasm engine (identical binary)','holder-engine.js scanner','holder-params.js loader','holder-carrier.js daemon RPC','vendored upstream crates','monero-ts 0.11.16 for phrase→key (CLI) / pinned build (extension)'],transfers:[]};
 let context=null;
 try{
  // Extension A.
  const L=await h.launch('interop-A');context=L.context;h.page=await context.newPage();const page=h.page;await page.goto(`chrome-extension://${L.id}/popup.html`);await page.waitForSelector('#start-import');
  const alpha=await h.newWallet('Alpha');const password='interop-password-1';await h.importAccount({...alpha,password,first:true});const alphaAddress=await h.tokenAddress();
  await h.fund();await h.fund();await h.openDetail();await page.click('#pf-bridge');await page.fill('#pf-amount','100');await page.click('#pf-bridge-go');await h.progress(/Deposit accepted/);await h.back();await h.closeModal();
  // CLI wallet B: fresh synthetic root; registered with the test backend only so it can be funded with test XMR.
  const rootB=Buffer.from(require_random(32)).toString('hex');
  const init=await run(['init','--root',rootB,'--state',stateB,...base]);assert.equal(init.code,0,init.err);const bAddress=init.json.address;assert.ok(bAddress.startsWith('penumbra1'));assert.equal(init.json.ledgerDomain,backend.config.domain,'B pins the same ledger domain');
  const solB=Keypair.generate().publicKey.toBase58();const reg=await run(['register','--backend','http://127.0.0.1:8940','--sol',solB,'--id','cliB','--state',stateB,...base]);assert.equal(reg.code,0,reg.err);
  const fund=await run(['fund','--backend','http://127.0.0.1:8940','--id','cliB','--blocks','2','--state',stateB,...base]);assert.equal(fund.code,0,fund.err);
  await backend.actions.mine({blocks:50});await h.mine();assert.equal(bal(await h.balanceText()),98.5);
  // 1. Extension A -> CLI B: 20 X (1 input, change 78.5).
  await h.openDetail();await page.click('#pf-send');const t1=await h.sendApprove({to:bAddress,amount:'20'});assert.match(t1.text,/1 input, change 78\.5 X/);await h.back();await h.closeModal();await h.mine();
  let b=await run(['balance','--state',stateB,...base]);assert.equal(b.code,0,b.err);const X=backend.assets.X.asset;assert.equal(b.json.balances[X],'20000000','CLI B decrypted the note the extension sent');results.transfers.push({from:'extension A',to:'CLI B',amount:'20',inputs:1,change:'78.5'});
  // 2. CLI B -> extension A: 5 X (1 note, change 15), paying its own carrier fee; then A sends 3 and 2 so B holds three notes.
  const s1=await run(['send','--to',alphaAddress,'--amount','5000000','--state',stateB,...base]);assert.equal(s1.code,0,s1.err);assert.equal(s1.json.inputs,1);assert.equal(s1.json.change,'15000000');assert.equal(s1.json.published,true);assert.equal(s1.json.recordBytes,996);results.transfers.push({from:'CLI B',to:'extension A',amount:'5',inputs:1,change:'15',carrier:s1.json.carrier});
  await h.mine();assert.equal(bal(await h.balanceText()),83.5,'extension A received the CLI wallet’s transfer');
  for(const amt of ['3','2']){await h.openDetail();await page.click('#pf-send');await h.sendApprove({to:bAddress,amount:amt});await h.back();await h.closeModal();await h.mine();}
  b=await run(['balance','--state',stateB,...base]);assert.equal(b.json.balances[X],'20000000');assert.equal(b.json.notes.length,3,'B holds 15 + 3 + 2');
  // 3. CLI B -> A with 2 notes (15 + 3 = 18 -> send 17, change 1) and 3 notes (1 + 2 + ... ) : largest-first.
  const s2=await run(['send','--to',alphaAddress,'--amount','17000000','--state',stateB,...base]);assert.equal(s2.code,0,s2.err);assert.equal(s2.json.inputs,2);assert.equal(s2.json.change,'1000000');results.transfers.push({from:'CLI B',to:'extension A',amount:'17',inputs:2,change:'1'});
  await h.mine();assert.equal(bal(await h.balanceText()),95.5);
  await h.openDetail();await page.click('#pf-send');await h.sendApprove({to:bAddress,amount:'4'});await h.back();await h.closeModal();await h.mine();// B: 2 + 1 + 4
  b=await run(['balance','--state',stateB,...base]);assert.equal(b.json.notes.length,3);assert.equal(b.json.balances[X],'7000000');
  const s3=await run(['send','--to',alphaAddress,'--amount','6500000','--state',stateB,...base]);assert.equal(s3.code,0,s3.err);assert.equal(s3.json.inputs,3);assert.equal(s3.json.change,'500000');results.transfers.push({from:'CLI B',to:'extension A',amount:'6.5',inputs:3,change:'0.5'});
  await h.mine();assert.equal(bal(await h.balanceText()),98);
  // 4. Recovery of A's account in the CLI from A's 25-word phrase + public chain: same address, balance, notes, spent status.
  const stA=await page.evaluate(async()=>await globalThis.__pfDebug.state());
  const ra=await run(['init','--seed',alpha.seed,'--state',stateA2,...base]);assert.equal(ra.code,0,ra.err);assert.equal(ra.json.address,alphaAddress,'same token address from the phrase');assert.equal(ra.json.nativeAddress,alpha.xmr,'same Monero address');
  const ba=await run(['balance','--state',stateA2,...base]);assert.equal(ba.json.balances[X],stA.holder.balances[X]);assert.deepEqual(ba.json.notes.map(n=>n.amount).sort(),stA.holder.notes.map(n=>n.amount).sort(),'same notes');
  const na=await run(['notes','--state',stateA2,...base]);assert.deepEqual(na.json.map(n=>n.commitment).sort(),stA.holder.notes.map(n=>n.commitment).sort());results.recovery={address:true,balance:ba.json.balances[X],notes:na.json.length};
  // 5. Viewing-only: B's token viewing key in a third CLI state sees B's balance and cannot spend.
  const vk=await run(['viewing-key','--state',stateB,...base]);assert.match(vk.json.viewingKey,/^penumbrafullviewingkey1/);
  const vi=await run(['init','--viewing-key',vk.json.viewingKey,'--state',stateV,...base]);assert.equal(vi.code,0,vi.err);assert.equal(vi.json.address,bAddress);assert.equal(vi.json.viewOnly,true);
  const vb=await run(['balance','--state',stateV,...base]);assert.equal(vb.json.balances[X],'500000');const vs=await run(['send','--to',alphaAddress,'--amount','100000','--state',stateV,...base]);assert.notEqual(vs.code,0);assert.match(vs.err,/viewing-only/);results.viewOnly={balance:vb.json.balances[X],sendRefused:true};
  // 6. Wrong keys: a random root sees nothing.
  const wr=await run(['init','--root',Buffer.from(require_random(32)).toString('hex'),'--state',stateW,...base]);assert.equal(wr.code,0);const wb=await run(['balance','--state',stateW,...base]);assert.deepEqual(wb.json.balances,{});
  // 7. TAMPER and DUPLICATE, separated (the earlier check mutated an already-published record, so both variants failed on the
  //    spent inputs and nothing about tampering was shown — see runs/interop-results-run3-CORRECTION.txt). Here B builds a VALID,
  //    UNSPENT record (wallet-lib over the same engine, B's root) and two INDEPENDENT verifier states (fresh engines under random
  //    roots, synced to the same tip, byte-identical public view) judge it: V1 admits the original; V2 rejects byte-level
  //    mutations of the proof, the auth signature, the binding signature and a truncation for THAT reason — not for spent
  //    inputs, a stale root, the network or the version — and V2's state is unchanged afterwards (admission never commits on
  //    rejection; it still admits the original). The holder engine refuses to pay a carrier fee for the tampered record. Only
  //    then is the original published and mined; afterwards the SAME wire is a duplicate spend for a fresh verifier and for B.
  const {openPrivateWallet,memoryCache}=await import('./wallet-lib/private-wallet.mjs');
  const wasmBytes=await readFile(dir+'holder-wasm/target/wasm32-unknown-unknown/release/xmr20_holder_wasm.wasm');const manifest=JSON.parse(await readFile(dir+'params/test-v1/manifest.json','utf8'));
  // connection:close — these wallets run in the SAME Node process as the test backend; a 30 s synchronous wasm proof would otherwise leave a stale keep-alive socket (fetch failed / ECONNRESET), as in holder-engine.test.mjs. Attempt 1 of this step failed exactly there (runs/interop-test-attempt1-tamper-step.log).
  const closeFetch=(u,o={})=>fetch(u,{...o,headers:{...(o.headers||{}),connection:'close'}});
  const openLib=o=>openPrivateWallet({wasm:wasmBytes,manifest,daemonRpc:backend.rpcUrl,parameterServer:'http://127.0.0.1:8940',cache:memoryCache(),fetch:closeFetch,...o});
  const libB=await openLib({root:rootB});await libB.sync();assert.equal(libB.status().balances[X],'500000','B holds the 0.5 change note');
  const selT=libB.select({asset:X,amount:'100000'});const builtT=await libB.prove({kind:'send',to:alphaAddress,amount:'100000',notes:selT.notes});assert.equal(builtT.bytes,996);const wire=builtT.wire,W=Buffer.from(wire,'hex');
  const V1=await openLib({root:Buffer.from(require_random(32)).toString('hex')}),V2=await openLib({root:Buffer.from(require_random(32)).toString('hex')});await V1.sync();await V2.sync();
  const view=l=>{const {tokenAddress,canSpend,...pub}=l.status();return JSON.stringify(pub);};// public view only (balances/notes are empty for random roots)
  assert.equal(view(V1),view(V2),'two independent verifier states are byte-identical before judging');const v2Before=view(V2);
  const okV1=V1.verify(wire);assert.equal(okV1.record,'accepted','V1 admits the valid unspent record');
  const mutate=i=>{const b=Buffer.from(W);b[i]^=1;return b.toString('hex');};const forTheTampering=e=>assert.doesNotMatch(e,/Spent|duplicate|root|network|domain|version|genesis/i,'rejected for the tampering itself, not for spent inputs / stale root / wrong network');
  // Two tamper classes per field (SPEC 6.1 offsets). SUBSTITUTION takes the field from ANOTHER valid record of B (decodes fine, so
  // admission reaches the cryptographic check and fails THERE with the engine's exact message); a BIT FLIP corrupts the field's
  // encoding (compressed group element / scalar no longer decodes: ark-serialize "invalid data"), also a rejection of that field.
  const stB=JSON.parse(await readFile(stateB,'utf8'));const other=Buffer.from((stB.history.find(x=>x.wire)||Object.values(stB.pending).find(x=>x.wire)).wire,'hex');assert.equal(other.length,996);
  const substitute=(a,z)=>{const b=Buffer.from(W);other.copy(b,a,a,z);return b.toString('hex');};
  const sProof=V2.verify(substitute(740,932));assert.equal(sProof.record,'rejected');assert.match(sProof.error,/Combined proof rejected/);forTheTampering(sProof.error);// Groth16 proof of another record: verification fails
  const sAuth=V2.verify(substitute(676,740));assert.equal(sAuth.record,'rejected');assert.match(sAuth.error,/signature/i);forTheTampering(sAuth.error);// SpendAuth signature of another record under this rk
  const sBind=V2.verify(substitute(932,996));assert.equal(sBind.record,'rejected');assert.match(sBind.error,/Conservation rejected/);forTheTampering(sBind.error);// binding signature of another record
  const tProof=V2.verify(mutate(800));assert.equal(tProof.record,'rejected');assert.match(tProof.error,/proof|invalid data/i);forTheTampering(tProof.error);// corrupted proof encoding
  const tAuth=V2.verify(mutate(700));assert.equal(tAuth.record,'rejected');assert.match(tAuth.error,/signature|invalid/i);forTheTampering(tAuth.error);// corrupted auth signature
  const tBind=V2.verify(mutate(950));assert.equal(tBind.record,'rejected');assert.match(tBind.error,/Conservation|signature|invalid/i);forTheTampering(tBind.error);// corrupted binding signature
  const tTrunc=V2.verify(wire.slice(0,-2));assert.equal(tTrunc.record,'rejected');assert.match(tTrunc.error,/Fixed experimental record required|Truncated|Canonical|Malformed/i);forTheTampering(tTrunc.error);// encoding/size rule (SPEC 7.2): one byte short is not a record
  assert.equal(view(V2),v2Before,'rejected records changed nothing in the verifier state');const okV2=V2.verify(wire);assert.equal(okV2.record,'accepted','V2 still admits the untampered record after the rejections');
  const qT=await libB.quoteCarrier({kind:'send'});assert.throws(()=>libB.signCarrier(qT.quoteId,substitute(740,932)),/fails local admission.*Combined proof rejected/,'the holder refuses to spend XMR on a carrier for a tampered record');libB.cancelQuote(qT.quoteId);
  const qO=await libB.quoteCarrier({kind:'send'});const carT=libB.signCarrier(qO.quoteId,wire);const pubT=await libB.publish(carT.blob);assert.equal(pubT.ok,true);
  results.transfers.push({from:'CLI B (wallet-lib, same root)',to:'extension A',amount:'0.1',inputs:builtT.inputs,change:builtT.change,carrier:{txid:carT.txid,fee:carT.fee},admittedFirstBy:'independent verifier V1'});
  await h.mine();assert.equal(bal(await h.balanceText()),98.1,'A received the record that the independent verifier admitted');
  await V1.sync();const dupV=V1.verify(wire);assert.equal(dupV.record,'rejected');assert.match(dupV.error,/Spent or duplicate/,'duplicate spend: the same wire after it was mined');
  const dupB=await run(['verify','--wire',wire,'--state',stateB,...base]);assert.equal(dupB.json.record,'rejected');assert.match(dupB.json.error||'',/Spent or duplicate/);
  results.negative={tamper:{proofSubstituted:sProof.error,authSignatureSubstituted:sAuth.error,bindingSignatureSubstituted:sBind.error,proofCorrupted:tProof.error,authSignatureCorrupted:tAuth.error,bindingSignatureCorrupted:tBind.error,truncated:tTrunc.error,verifierStateUnchanged:true,originalAdmitted:{V1:okV1.record,V2afterRejections:okV2.record},holderRefusedCarrierForTampered:true},duplicate:{independentVerifier:dupV.error,cliB:dupB.json.error}};
  for(const l of [libB,V1,V2])l.close();
  // 8. Mismatched parameters: a CLI built with the OTHER manifest refuses this server's configuration.
  const mx=await run(['init','--root',rootB,'--state',stateX,'--manifest',dir+'params/test-other/manifest.json',...base]);assert.notEqual(mx.code,0);assert.match(mx.err,/another version or ledger|different ledger/);results.mismatchedParameters=mx.err.trim().slice(0,160);
  // 9. One pool: the public indexer saw every record from both wallets (no per-wallet pool).
  const scan=await backend.indexer.call({op:'scan'});const records=results.transfers.length;assert.ok(scan.public.events.filter(e=>e.result?.record==='accepted').length>=records+1,'indexer admitted every transfer plus the credit');results.pool={accepted:scan.public.events.filter(e=>e.result?.record==='accepted').length};
  const audit=await auditBackend(backend,[...h.secrets,rootB]);assert.equal(audit.hits.length,0,'no root or phrase reached the backend');
 }finally{const {external,leaks}=await h.finish(backend,{results});await context?.close().catch(()=>{});await backend.close();await mkdir(dir+'runs',{recursive:true});await writeFile(dir+'runs/interop-results.json',JSON.stringify(results,null,1));assert.equal(leaks.length,0);assert.equal(external.filter(e=>!e.failed).length,0);}
 console.log(JSON.stringify(results));
});
function require_random(n){return globalThis.crypto.getRandomValues(new Uint8Array(n));}
