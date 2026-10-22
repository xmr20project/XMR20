// Opt-in genuine wallet2 construction check, run only by the guarded offline
// daemon runner. Generates fresh, disposable in-memory wallets; exports no keys.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {verifyOrdinaryPayment} from '../src/ordinary-spend-guard.js';
import {recoverOfflinePaymentInBrowser} from './ordinary-wallet-recovery-browser.mjs';
const require=createRequire(import.meta.url),monero=require('monero-ts');
const endpoint='http://127.0.0.1:28891';
async function rpc(method,params={}) {
 const response=await fetch(endpoint+'/json_rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'ordinary-wallet-check',method,params}),signal:AbortSignal.timeout(30000)});
 assert.equal(response.ok,true);const data=await response.json();assert.equal(data.error,undefined);return data.result;
}
const info=await rpc('get_info');
assert.equal(info.nettype,'fakechain');assert.equal(info.offline,true);assert.equal(info.mainnet,false);
assert.equal(info.incoming_connections_count,0);assert.equal(info.outgoing_connections_count,0);
let sender,recipient;
try {
 // Use the library's supported regtest network rules only after verifying the
 // isolated, offline daemon above. Production wallet validation is unchanged.
 sender=await monero.createWalletFull({networkType:0,regtest:true,password:'',server:{uri:endpoint},proxyToWorker:false,isTrustedDaemon:false});
 await sender.setRestoreHeight(info.height);
 recipient=await monero.createWalletFull({networkType:0,regtest:true,password:'',proxyToWorker:false});
 if(process.env.XMR20_OFFLINE_DIAGNOSTICS==='1')await monero.LibraryUtils.setLogLevel(1);
 await rpc('generateblocks',{wallet_address:await sender.getPrimaryAddress(),amount_of_blocks:65});
 await sender.sync();assert.ok(await sender.getUnlockedBalance()>1000000000000n);
 const to=await recipient.getPrimaryAddress(),amount=1000000000n;
 const tx=await sender.createTx({accountIndex:0,address:to,amount,relay:false});
 assert.equal(tx.getIsRelayed(),false);
 const value={txid:tx.getHash(),transaction:tx.getFullHex(),keyImages:tx.getInputs().map(i=>i.getKeyImage().getHex()),to,amountRaw:String(amount),feeRaw:String(tx.getFee())};
 verifyOrdinaryPayment(value);
 // Lose the reply, close the browser context, reopen and export, then import
 // on another origin. Only the exact recovered bytes may reach this daemon.
 const recovered=await recoverOfflinePaymentInBrowser(value,await sender.getPrimaryAddress());
 const sent=await fetch(endpoint+'/send_raw_transaction',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tx_as_hex:recovered.transaction,do_not_relay:false}),signal:AbortSignal.timeout(30000)});
 assert.equal((await sent.json()).status,'OK');
 await rpc('generateblocks',{wallet_address:await sender.getPrimaryAddress(),amount_of_blocks:1});
 const lookup=await fetch(endpoint+'/gettransactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({txs_hashes:[value.txid],decode_as_json:false}),signal:AbortSignal.timeout(30000)});
 const rows=(await lookup.json()).txs;assert.equal(rows.length,1);assert.equal(rows[0].in_pool,false);assert.equal(rows[0].tx_hash,value.txid);
 console.log(JSON.stringify({scope:'disposable offline fakechain; no existing wallet',wallet2RawAvailable:true,canonicalHashAndInputsVerified:true,browserRestartAndCrossOriginRecovery:true,rawRecoveryAccepted:true,txid:value.txid,inputs:value.keyImages.length,bytes:value.transaction.length/2}));
} finally {await sender?.close(false);await recipient?.close(false);}
