// Public settlement authorization. Never contains wallet keys or transaction bytes.
import {Buffer} from 'buffer';
import {ed25519} from '@noble/curves/ed25519';
import {exact,hex,need,domain,join} from '../xn1/bytes.mjs';
import {publicPoint} from '../xn1/proofs.mjs';
import {canonical,clone,LIMITS} from '../trade-sessions/protocol.mjs';
export function settlementMessage(value){
 exact(value,['version','sessionId','role','key','revision','requestId','action','txid','signatureHash']);
 need(value.version===1,'Unsupported settlement authorization');hex(value.sessionId);hex(value.txid);hex(value.signatureHash);publicPoint(value.key);
 need(['buyer','seller'].includes(value.role)&&['broadcast','rebroadcast','status'].includes(value.action),'Invalid settlement role/action');
 need(Number.isSafeInteger(value.revision)&&value.revision>=1&&value.revision<=LIMITS.events,'Invalid settlement revision');
 need(typeof value.requestId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId),'Bounded settlement request ID required');
 return join(domain('XMR20-NATIVE-SETTLEMENT-1'),Buffer.from(canonical(value)));
}
export function authenticateSettlement(value){
 exact(value,['version','sessionId','role','key','revision','requestId','action','txid','signatureHash','signature']);hex(value.signature,64);
 const {signature,...unsigned}=value;need(ed25519.verify(hex(signature,64),settlementMessage(unsigned),hex(value.key),{zip215:false}),'Invalid settlement signature');return clone(value);
}
export function authorizeSettlement(state,request){
 const r=authenticateSettlement(request);need(state?.phase==='assembled'&&state.assembled&&state.hold,'Jointly assembled durable trade required');
 need(r.sessionId===state.id&&r.revision===state.revision&&r.key===state[`${r.role}Key`],'Settlement does not own this assembled mailbox revision');
 need(r.txid===state.assembled.txid&&r.signatureHash===state.assembled.signatureHash,'Settlement differs from saved exact transaction');return r;
}
