// The native library needs a wallet object to verify messages. Its throwaway
// identity exists only in RAM, is never funded/exported/saved, and has no daemon.
// The IPC protocol exposes address validation and verification only.
import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
import {checkMoneroAddress} from './address.js';
const require=createRequire(import.meta.url);
process.on('uncaughtException',()=>process.exit(1));
process.on('unhandledRejection',()=>process.exit(1));
const module=await require('./monero.cjs')({print:()=>{},printErr:()=>{}});
const keys=await new Promise((resolve,reject)=>module.create_keys_wallet_random(JSON.stringify({networkType:0,language:'English',seedOffset:''}),p=>typeof p==='number'&&p>0?resolve(p):reject(Error())));
const wallet=await new Promise((resolve,reject)=>module.create_full_wallet(JSON.stringify({networkType:0,seed:module.get_seed(keys),seedOffset:'',path:'',password:'',restoreHeight:0}),'offline-indexer-verifier',p=>typeof p==='number'&&p>0?resolve(p):reject(Error())));
await new Promise(resolve=>module.close(keys,false,0,resolve));
process.stdout.write('{"ready":true}\n');
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
  try{
    if(line.length>8192)throw Error();
    const {method,params:p}=JSON.parse(line);let result;
    if(method==='validate_address'){
      const a=checkMoneroAddress(p.address,'mainnet');
      result={valid:a.valid,nettype:'mainnet',subaddress:a.kind==='subaddress',integrated:a.kind==='integrated'};
    }else if(method==='verify'&&typeof p.data==='string'&&p.data.length<=2000&&checkMoneroAddress(p.address,'mainnet').kind==='standard'&&/^SigV2[1-9A-HJ-NP-Za-km-z]{80,110}$/.test(p.signature)){
      const r=JSON.parse(module.verify_message(wallet,p.data,p.address,p.signature));
      result={good:r.isGood===true,old:r.isOld===true,version:r.version,signature_type:r.signatureType};
    }else throw Error();
    process.stdout.write(JSON.stringify({result})+'\n');
  }catch{process.stdout.write('{"error":"verification-request-rejected"}\n');}
}
await new Promise(resolve=>module.close(wallet,false,0,resolve));
