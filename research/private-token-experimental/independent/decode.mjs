// INDEPENDENT DECODER written from SPEC-XMR20-PRIVATE-TOKENS-v0.1-experimental.txt using only Node's
// crypto and the repository's existing XN1 Monero-transaction inspector. It shares NOTHING with the
// holder engine. It can: unframe tx_extra, parse XM3/XB3 record layouts, compute record ids,
// recompute the ledger domain from a parameters.json / manifest, verify manifest file hashes, parse a
// Monero carrier (inputs, key image, ring offsets, extra). It CANNOT (no established decaf377 /
// Poseidon / decaf377-rdsa library in JavaScript): check commitments, nullifiers, signatures, proofs
// or decrypt payloads. Those remain checked only by the shared engine (SPEC section 12).
import {createHash} from 'node:crypto';
const H=b=>createHash('sha256').update(b).digest();
export const XM3_MAGIC=Buffer.from([0x58,0x4d,0x33,0xfe]),XB3_MAGIC=Buffer.from([0x58,0x42,0x33,0xfe]);
export const XM3_BYTES=996,XB3_BYTES=925,PAYLOAD_BYTES=176,PROOF_BYTES=192,INPUTS=3;
export const DOMAIN_LABEL='XMR20-MIGRATION-REHEARSAL-DOMAIN-v1';
const le32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
// SPEC 4.1
export function ledgerDomain(config){const parts=[Buffer.from(DOMAIN_LABEL+'\0')];for(const k of ['chain','normal_vk','boundary_vk','issuer_vk']){const raw=Buffer.from(config[k],'hex');parts.push(le32(raw.length),raw);}return H(Buffer.concat(parts)).toString('hex');}
// SPEC 4 / 4.2: structural manifest checks that need no engine.
export function checkManifest(m){const problems=[];
 if(m.format!=='XMR20-PARAMS-1')problems.push('format');if(m.protocol?.domainLabel!==DOMAIN_LABEL)problems.push('domainLabel');
 if(m.protocol?.records?.transfer?.bytes!==XM3_BYTES||m.protocol?.records?.boundary?.bytes!==XB3_BYTES)problems.push('record sizes');
 if(m.network?.genesis!==m.config?.chain)problems.push('genesis');if(m.ledgerDomain!==m.config?.domain)problems.push('ledgerDomain field');
 if(ledgerDomain(m.config)!==m.config.domain)problems.push('ledgerDomain recomputation');
 if(m.issuerVk!==m.config.issuer_vk)problems.push('issuerVk');if(m.files?.normal?.vk!==m.config.normal_vk||m.files?.boundary?.vk!==m.config.boundary_vk)problems.push('vk pins');
 return {ok:problems.length===0,problems,ledgerDomain:ledgerDomain(m.config)};}
export function fileMatchesManifest(m,name,bytes){const f=m.files[name];return bytes.length===f.bytes&&H(bytes).toString('hex')===f.sha256;}
// SPEC 7.2: tx_extra unframing (0x01 pubkey once; 0x02 nonces: 0x7F-marked record chunks, or one 9-byte encrypted payment id).
export function unframe(extra){extra=Buffer.from(extra);let at=0,pubkeys=0,paymentIds=0;const chunks=[];let pubkey=null;
 while(at<extra.length){const tag=extra[at++];
  if(tag===1){pubkeys++;if(pubkeys!==1||at+32>extra.length)throw Error('tx pubkey');pubkey=extra.subarray(at,at+32).toString('hex');at+=32;}
  else if(tag===2){let len=0,shift=0;for(;;){if(at>=extra.length||shift>7)throw Error('nonce length');const n=extra[at++];len|=(n&127)<<shift;if(n<128){if(shift!==0&&n===0)throw Error('noncanonical nonce length');break;}shift+=7;}
   if(len<1||len>255||at+len>extra.length)throw Error('nonce bounds');const d=extra.subarray(at,at+len);at+=len;
   if(d[0]===127)chunks.push(Buffer.from(d.subarray(1)));else{paymentIds++;if(paymentIds!==1||d[0]!==1||d.length!==9)throw Error('payment id');}}
  else throw Error('unsupported extra field '+tag);}
 if(pubkeys!==1)throw Error('exactly one tx pubkey required');if(extra.length>1060)throw Error('extra too long');
 if(!chunks.length)return {pubkey,record:null};const record=Buffer.concat(chunks);
 const expected=[];for(let i=0;i<record.length;i+=254)expected.push(record.subarray(i,i+254));
 if(expected.length!==chunks.length||!expected.every((c,i)=>c.equals(chunks[i])))throw Error('chunking');
 if(!(record.length===XM3_BYTES&&record.subarray(0,4).equals(XM3_MAGIC))&&!(record.length===XB3_BYTES&&record.subarray(0,4).equals(XB3_MAGIC)))throw Error('unknown record');
 return {pubkey,record};}
// SPEC 6.1 / 6.2: layouts.
export function parseRecord(b){b=Buffer.from(b);const hex=(o,n)=>b.subarray(o,o+n).toString('hex');
 const base={recordId:H(b).toString('hex'),bytes:b.length,magic:hex(0,4),anchor:hex(4,36-4+0).slice(0,64)};
 let at=4;const take=n=>{const v=b.subarray(at,at+n);at+=n;return v;};
 const anchor=take(32).toString('hex');const inputs=[];for(let i=0;i<INPUTS;i++)inputs.push({cv:take(32).toString('hex'),nullifier:take(32).toString('hex')});const rk=take(32).toString('hex');
 if(b.length===XM3_BYTES&&b.subarray(0,4).equals(XM3_MAGIC)){const outputs=[];for(let i=0;i<2;i++){const cv=take(32).toString('hex');const p=take(PAYLOAD_BYTES);outputs.push({cv,payload:{commitment:p.subarray(0,32).toString('hex'),epk:p.subarray(32,64).toString('hex'),ciphertext:p.subarray(64).toString('hex')}});}
  const publicBodyEnd=at;const auth=take(64).toString('hex'),proof=take(PROOF_BYTES).toString('hex'),binding=take(64).toString('hex');if(at!==b.length)throw Error('length');
  return {...base,kind:'XM3',anchor,inputs,rk,outputs,auth,proof,binding,publicBody:b.subarray(0,publicBodyEnd).toString('hex'),publicBodyBytes:publicBodyEnd};}
 if(b.length===XB3_BYTES&&b.subarray(0,4).equals(XB3_MAGIC)){const cv=take(32).toString('hex');const p=take(PAYLOAD_BYTES);const output={cv,payload:{commitment:p.subarray(0,32).toString('hex'),epk:p.subarray(32,64).toString('hex'),ciphertext:p.subarray(64).toString('hex')}};
  const kind=take(1)[0];const asset=take(32).toString('hex');const amount=take(8).readBigUInt64LE(0).toString();const bindingField=take(32).toString('hex');const publicBodyEnd=at;
  const auth=take(64).toString('hex'),proof=take(PROOF_BYTES).toString('hex'),conservation=take(64).toString('hex'),issuer=take(64).toString('hex');if(at!==b.length)throw Error('length');
  const kinds={1:'DEPOSIT',2:'MIGRATION',3:'REDEEM'};if(!kinds[kind])throw Error('kind');if(amount==='0')throw Error('amount');if(/^0+$/.test(bindingField))throw Error('binding zero');
  if(kind===3&&!/^0+$/.test(issuer))throw Error('redemption carries issuer');
  return {...base,kind:'XB3',boundaryKind:kinds[kind],anchor,inputs,rk,output,asset,amount,bindingField,auth,proof,conservation,issuer,publicBody:b.subarray(0,publicBodyEnd).toString('hex'),publicBodyBytes:publicBodyEnd};}
 throw Error('not an XM3/XB3 record');}
// SPEC 6.4: authorization message preimages (the signatures themselves need decaf377-rdsa; only the message is recomputed here).
export function messages(parsed,domainHex){const d=Buffer.from(domainHex,'hex');const body=Buffer.from(parsed.publicBody,'hex');
 if(parsed.kind==='XM3')return {auth:H(Buffer.concat([Buffer.from('XMR20-MULTI-INPUT-LAB-AUTH-v1\0'),d,body])).toString('hex')};
 return {auth:H(Buffer.concat([Buffer.from('XMR20-MIGRATION-REHEARSAL-BOUNDARY-AUTH-v1\0'),d,body])).toString('hex'),issuer:H(Buffer.concat([Buffer.from('XMR20-MIGRATION-REHEARSAL-ISSUER-v1\0'),d,body])).toString('hex')};}
// SPEC 3.1: Monero mnemonic -> root with the Electrum wordlist (3 words -> 4 bytes, base 1626), given the wordlist.
export function mnemonicToRoot(words,wordlist,prefixLen=3){const w=words.trim().toLowerCase().split(/\s+/);if(w.length!==25)throw Error('25 words');const idx=new Map(wordlist.map((x,i)=>[x,i]));const n=1626;const out=Buffer.alloc(32);
 for(let i=0;i<24;i+=3){const a=idx.get(w[i]),b=idx.get(w[i+1]),c=idx.get(w[i+2]);if([a,b,c].some(x=>x===undefined))throw Error('unknown word');const x=a+n*(((n-a)+b)%n)+n*n*(((n-b)+c)%n);if(x%n!==a)throw Error('invalid word group');out.writeUInt32LE(x>>>0,(i/3)*4);}
 const check=w.slice(0,24).map(x=>x.slice(0,prefixLen)).join('');const crc=crc32(Buffer.from(check));if(w[24]!==w[crc%24])throw Error('checksum word');return out.toString('hex');}
function crc32(buf){let c,crc=0xffffffff;for(let i=0;i<buf.length;i++){c=(crc^buf[i])&0xff;for(let k=0;k<8;k++)c=c&1?(c>>>1)^0xedb88320:c>>>1;crc=(crc>>>8)^c;}return (crc^0xffffffff)>>>0;}
