import {signOwnerRecord,verifyOwnerRecord} from '../bridge/core-next/owner-signing.mjs';
let busy=false;
for(const name of ['log','info','warn','error','debug'])console[name]=()=>{};
const loadNative=async()=>{importScripts('monero-0.11.16.js');return self.monero_ts({print:()=>{},printErr:()=>{}});};
self.onmessage=async({data})=>{if(busy||typeof data?.id!=='string')return;busy=true;try{let result;
 if(data.action==='sign-owner-record')result=await signOwnerRecord({loadNative,seed:data.seed,review:data.review,context:data.context});
 else if(data.action==='verify-owner-record')result=await verifyOwnerRecord({loadNative,text:data.text,address:data.address,signature:data.signature});else throw Error();
 self.postMessage({id:data.id,result});
 }catch{self.postMessage({id:data.id,error:'Monero approval failed. Reopen with the original saved wallet.'});}finally{data.seed='';self.close();}};
