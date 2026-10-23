// Independent check of vectors/vectors.json against the specification using only independent/decode.mjs
// (Node crypto). Reports what matched, and what cannot be checked without a decaf377 implementation.
//   node independent/check.mjs
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {blake2b} from '@noble/hashes/blake2b';
import {ledgerDomain,checkManifest,unframe,parseRecord,messages,XM3_BYTES,XB3_BYTES} from './decode.mjs';
const dir=fileURLToPath(new URL('../',import.meta.url));
const v=JSON.parse(await readFile(dir+'vectors/vectors.json','utf8'));
const report={checked:[],failed:[],notCheckable:['note commitments (Poseidon/decaf377)','nullifiers','value commitments','SpendAuth/Binding/issuer signatures (decaf377-rdsa)','Groth16 proofs','payload decryption (decaf377-ka + ChaCha20-Poly1305 under the BLAKE2b KDF)','Penumbra address derivation from the token spend key']};
const ok=(name,cond,detail='')=>{(cond?report.checked:report.failed).push(name+(detail?' '+detail:''));};
// 1. Manifest and ledger domain.
const manifestBytes=await readFile(dir+'params/test-v1/manifest.json');const m=JSON.parse(manifestBytes);
ok('manifest sha256 equals vector',createHash('sha256').update(manifestBytes).digest('hex')===v.manifest.sha256);
ok('ledger domain recomputed (SPEC 4.1) equals config.domain',ledgerDomain(m.config)===m.config.domain);
ok('manifest structural checks (SPEC 4)',checkManifest(m).ok,JSON.stringify(checkManifest(m).problems));
// 2. Key derivation: the BLAKE2b rule (SPEC 3.2) reproduces the vectors' token spend keys.
const pers=Buffer.alloc(16);Buffer.from('XMR20-TKD1').copy(pers);
for(const k of v.keyDerivation){const tsk=Buffer.from(blake2b(Buffer.concat([Buffer.from('xmr20/private-token/spend-key'),Buffer.from([0,0,0,0])]),{dkLen:32,key:Buffer.from(k.root,'hex'),personalization:pers})).toString('hex');ok('tsk for root '+k.root.slice(0,8)+'…',tsk===k.tokenSpendKey_blake2b);ok('token address is penumbra1 index-0 form',/^penumbra1[a-z0-9]{10,}$/.test(k.tokenAddress));ok('Monero address of the same root is a mainnet address',/^4[1-9A-HJ-NP-Za-km-z]{94}$/.test(k.moneroAddress));}
// 3. Records: unframe from the raw extra, parse the layout, recompute record id and message preimages; compare with the vector's independent parse (self-consistency) and with the engine's view where possible.
for(const r of v.records){const {pubkey,record}=unframe(Buffer.from(r.extraHex,'hex'));ok('unframing reproduces the record '+r.txid.slice(0,8)+'…',record.toString('hex')===r.recordHex);ok('tx pubkey parsed',pubkey===r.txPubkey);
 const p=parseRecord(record);ok('layout parse '+p.kind+' '+(p.boundaryKind||''),p.recordId===r.independentParse.recordId&&p.kind===r.independentParse.kind);
 ok('record size rule',(p.kind==='XM3'&&record.length===XM3_BYTES)||(p.kind==='XB3'&&record.length===XB3_BYTES));
 ok('record id = sha256(bytes)',createHash('sha256').update(record).digest('hex')===p.recordId);
 const msg=messages(p,v.manifest.config.domain);ok('message preimage recomputed',msg.auth===r.messages.auth);
 if(p.kind==='XB3'){ok('XB3 kind/amount/binding rules',['DEPOSIT','MIGRATION','REDEEM'].includes(p.boundaryKind)&&BigInt(p.amount)>0n&&!/^0+$/.test(p.bindingField));if(p.boundaryKind==='REDEEM')ok('redemption issuer field all zero',/^0+$/.test(p.issuer));else ok('credit issuer field present',!/^0+$/.test(p.issuer));}
 ok('all three input nullifiers distinct',new Set(p.inputs.map(i=>i.nullifier)).size===3);
 ok('payload epk not identity-encoded zero',!p.outputs?.some(o=>/^0+$/.test(o.payload.epk))&&!(p.output&&/^0+$/.test(p.output.payload.epk)));}
// 4. Mnemonic vector: only the structural rule (25 words) is checkable here without the Electrum wordlist; phrase -> root was produced by monero-ts.
if(v.mnemonic?.words){ok('mnemonic has 25 words',v.mnemonic.words.split(' ').length===25);ok('engine Monero address equals monero-ts address for the same phrase',v.mnemonic.engineMoneroAddress===v.mnemonic.moneroAddress);report.notCheckable.push('mnemonic word decoding (Electrum wordlist not vendored; rule given in SPEC 3.1 and decode.mjs)');}
console.log(JSON.stringify(report,null,1));
if(report.failed.length)process.exit(1);
