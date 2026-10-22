import {createOrdinarySpendGuard} from '../src/ordinary-spend-guard.js';
import {openNativeWalletJournal} from '../services/native-market/wallet/journal-adapter.mjs';
const h=n=>n.toString(16).padStart(2,'0').repeat(32),need=(v,m)=>{if(!v)throw Error(m);};
const genesis='418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3';
export async function runOrdinaryGuardBrowserChecks(){
 const scope={address:'4'+'6'.repeat(94),genesis},secret=new Uint8Array(32).fill(49);
 const manual=h(64),carrier=h(65),funding=h(66),issuance=h(67),recovery=h(68);
 const frozen=new Set([manual]),owned=[manual,carrier,funding,issuance,recovery],thaws=[];
 const wallet={getPrimaryAddress:async()=>scope.address,getPrivateSpendKey:async()=>h(49),
  getOutputs:async()=>owned.map(image=>({getKeyImage:()=>({getHex:()=>image})})),
  isOutputFrozen:async image=>frozen.has(image),freezeOutput:async image=>frozen.add(image),
  thawOutput:async image=>{thaws.push(image);frozen.delete(image);}};
 const journal=await openNativeWalletJournal({scope,privateSpendBytes:secret}),guard=await createOrdinarySpendGuard(wallet);
 const completion=operationId=>({operationId,status:'issued',conversionTxid:h(72),resolutionTxid:h(73),checkpoint:{height:20,hash:h(74)}});
 try{
  const plan={operationId:h(70),checkpoint:{height:10,hash:h(71)},funding:[{role:'publication',keyImages:[funding]},{role:'issuance',keyImages:[issuance]},{role:'recovery',keyImages:[recovery]}],payload:new Uint8Array([1,2,3])};
  const prepared=await journal.prepareFunding(plan);
  frozen.add(carrier);await guard.freeze([carrier]);
  need([manual,carrier,funding,issuance,recovery].every(i=>frozen.has(i)),'Incomplete wallet2 freezes');
  // Production completion comes from the private canonical verifier. Here we
  // test the authenticated journal and wallet freeze ownership after it.
  await journal.completePreparation({preparationId:prepared.preparationId,evidence:completion(plan.operationId)});
  await guard.freeze([carrier]);
  need(!frozen.has(funding)&&!frozen.has(issuance)&&!frozen.has(recovery),'Unused conversion fees stayed frozen');
  need(frozen.has(manual)&&frozen.has(carrier)&&thaws.length===3,'Manual or carrier freeze was removed');
  const plan2={...plan,operationId:h(75)},prepared2=await journal.prepareFunding(plan2);await guard.freeze([carrier]);
  await journal.completePreparation({preparationId:prepared2.preparationId,evidence:completion(plan2.operationId)});
  // An input frozen by this guard must stay frozen if the native carrier check
  // now protects it, even though its old conversion funding hold is gone.
  await guard.freeze([carrier,funding]);
  need(frozen.has(funding)&&frozen.has(manual)&&frozen.has(carrier),'Protection ownership was lost');
  need(!frozen.has(issuance)&&!frozen.has(recovery)&&thaws.length===5,'Unrelated fee recovery failed');
  const status=await guard.recoveryStatus();need(status.payments.length===0&&!status.recoveryOnly,'Wrong private recovery status');
  const backup=await guard.exportRecovery();need(backup instanceof Uint8Array&&backup.length>0,'Ordinary worker lacks portable recovery key');
  let rejected=false;try{await guard.importRecovery(backup);}catch{rejected=true;}need(rejected,'Recovery imported over an active source wallet');
  need(!(await guard.recoveryStatus()).recoveryOnly,'Rejected import changed wallet mode');
  return {passed:3,results:[{name:'unused conversion funding returns to ordinary spend selection',passed:true},{name:'manual and native-token carrier freezes are preserved',passed:true},{name:'ordinary worker exports encrypted commitments and refuses import over active wallet',passed:true}]};
 }finally{guard.close();journal.close();secret.fill(0);}
}
