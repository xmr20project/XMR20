import {canonical,digest} from './records.mjs';
export function identityReceiptStore({registry,owner,moneroOwner,storage=localStorage}){
 const scope=digest(canonical({registry,owner,moneroOwner})),key='xmr20-wallet-identity-public-v1:'+scope;
 const checked=v=>{if(v?.schema!=='wallet-identity-owner-v1'||v.scope!==scope||!v.proofs||!v.operations)throw Error('Identity receipt belongs to another wallet or registry.');return v;};
 return Object.freeze({key,load(){const text=storage.getItem(key);if(text===null)return null;if(text.length>1000000)throw Error('Identity receipt is oversized. Keep the original backup.');return checked(JSON.parse(text));},save(v){const text=JSON.stringify(checked(v));if(text.length>1000000||/"(?:seed|privateKey|secretKey|password|mnemonic)"\s*:/.test(text))throw Error('Only bounded public identity receipts may be saved.');storage.setItem(key,text);if(storage.getItem(key)!==text)throw Error('Identity receipt was not saved.');}});
}

export function activationReceiptStore({registry,payer,storage=localStorage}){
 const scope=digest(canonical({registry,payer})),key='xmr20-wallet-activation-public-v1:'+scope;
 const checked=v=>{if(v?.schema!=='wallet-activation-owner-v1'||v.scope!==scope||!v.operations)throw Error('Activation receipt belongs to another wallet or registry.');return v;};
 return Object.freeze({key,load(){const text=storage.getItem(key);if(text===null)return null;if(text.length>1000000)throw Error('Activation receipt is oversized. Keep the original backup.');return checked(JSON.parse(text));},save(v){const text=JSON.stringify(checked(v));if(text.length>1000000||/"(?:seed|privateKey|secretKey|password|mnemonic)"\s*:/.test(text))throw Error('Only bounded public activation receipts may be saved.');storage.setItem(key,text);if(storage.getItem(key)!==text)throw Error('Activation receipt was not saved.');}});
}
