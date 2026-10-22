// Public recovery references only; mailbox keys/signatures stay in their own
// durable stores. These references never confer balance or spending authority.
import {encodeOffer,offerId} from './native-offers/codec.mjs';
import {publicOffer} from './trade-sessions/protocol.mjs';
import {moneroWalletIdentity} from './wallet/identity.mjs';
const need=(yes,text)=>{if(!yes)throw Error(text);};
const prefix=({owner,address})=>{const native=moneroWalletIdentity(address);need(typeof owner==='string'&&(owner===native||/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)),'Wallet recovery identity is required');return 'xmr20-native-trade-reference-v1:'+owner+':'+address+':';};
function decode(value,key,scope){
 need(value.length<6000,'Saved trade reference exceeds bounds');const row=JSON.parse(value);
 need(row.version===1&&/^[a-f0-9]{64}$/.test(row.identity)&&['buyer','seller'].includes(row.role),'Saved trade reference is invalid');
 const offer=publicOffer(row.offerBytes,row.offerProof),id=offerId(offer);
 need(key===prefix(scope)+id+':'+row.role,'Saved trade reference belongs to another wallet');
 return {identity:row.identity,role:row.role,entry:{id,offer,proof:row.offerProof,status:'saved',purchasable:false}};
}
export function readTradeReferences(scope,{storage=globalThis.localStorage}={}){
 const beginning=prefix(scope),rows=[];
 for(let i=0;i<storage.length;i++){const key=storage.key(i);if(!key?.startsWith(beginning))continue;
  const value=storage.getItem(key);if(!value||/^[a-f0-9]{64}$/.test(value))continue;
  need(rows.length<64,'Too many saved trade references; recovery storage needs maintenance');rows.push(decode(value,key,scope));
 }return rows;
}
export async function saveTradeReference({context,entry,role,assertCurrent,storage=globalThis.localStorage,crypto=globalThis.crypto,lockManager=globalThis.navigator?.locks}){
 const key=prefix(context)+entry.id+':'+role;need(['buyer','seller'].includes(role)&&typeof lockManager?.request==='function','Browser coordination is required for recovery');
 const offerBytes=encodeOffer(entry.offer).toString('hex'),offerProof=structuredClone(entry.proof);need(offerId(publicOffer(offerBytes,offerProof))===entry.id,'Signed recovery offer is invalid');
 return lockManager.request(key,{mode:'exclusive',ifAvailable:true},lock=>{
  need(lock,'Another tab is opening this trade');assertCurrent();const saved=storage.getItem(key);
  if(saved&&!/^[a-f0-9]{64}$/.test(saved)){const row=decode(saved,key,context);need(encodeOffer(row.entry.offer).toString('hex')===offerBytes,'Saved trade offer changed');return row.identity;}
  need(readTradeReferences(context,{storage}).length<64,'Saved trade capacity reached; preserve pending trades before continuing');
  const identity=saved||Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
  const text=JSON.stringify({version:1,identity,role,offerBytes,offerProof});storage.setItem(key,text);need(storage.getItem(key)===text,'Trade recovery reference was not saved');return identity;
 });
}
