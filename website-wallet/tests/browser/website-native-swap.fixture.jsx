// Local fixture only: generated keys, fake ChangeNOW and Solana replies, no network.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Keypair,Transaction,SystemInstruction} from '@solana/web3.js';
import bs58 from 'bs58';
import WebsiteNativeSwap from '../../src/website-native-swap.jsx';

const signer=Keypair.generate(),owner=signer.publicKey.toBase58(),deposit=Keypair.generate().publicKey.toBase58();
const monero='4AMg1kDaXkWckE3uyd1YqoBKvn4z8ATxmWQVdtjF6aGU4sT278XoyhUV1Ve88ZMCXNXQJpjW2553NWERfMZcNsBtCkMLiNM';
const log={quotes:[],creates:0,statuses:0,signed:0,sent:[]};let status='waiting',lastQuote='';
const json=(value,code=200)=>new Response(JSON.stringify(value),{status:code,headers:{'content-type':'application/json'}});
const realFetch=globalThis.fetch.bind(globalThis);
globalThis.fetch=async(url,options={})=>{
 const href=String(url);
 if(href==='https://xmr20.org/api/native-swap'){
  const body=JSON.parse(options.body);
  if(body.action==='quote'){log.quotes.push(body);lastQuote=crypto.randomUUID();return json({id:lastQuote,direction:body.direction,amount:body.amount,destination:body.destination,refund:body.refund,receive:body.direction==='sol-xmr'?'0.0776':'1.61',minimum:'0.12',expires:Date.now()+120000,authorization:'quote-'+body.direction,provider:'ChangeNOW',rate:'floating'});}
  if(body.action==='create'){log.creates++;const xmr=body.authorization==='quote-xmr-sol';
   return json({id:'cn'+log.creates+'abcdef',requestId:lastQuote,direction:xmr?'xmr-sol':'sol-xmr',amount:xmr?'0.25':'0.5',receive:'1',destination:xmr?owner:monero,refund:xmr?monero:owner,
    payin:xmr?'45cQVke2TNqcDi7dkQY3dRiMgVSF89V4reM1BsBeSXDrdmBdXpbrCCqTQ39zUcvyZgVYk7kGQFjNmRfnmvaACHYz3ZMwG5q':deposit,created:Date.now(),receipt:'receipt-'+log.creates,status:'waiting',provider:'ChangeNOW'});}
  if(body.action==='status'){log.statuses++;return json({id:'cn1abcdef',status,payoutHash:null});}
 }
 if(href===location.origin+'/api/wallet'){
  const {id,method,params}=JSON.parse(options.body).rpc,ctx={context:{slot:1}};
  if(method==='sendTransaction'){const tx=Transaction.from(Uint8Array.from(atob(params[0]),c=>c.charCodeAt(0)));log.sent.push({...SystemInstruction.decodeTransfer(tx.instructions[0]),valid:tx.verifySignatures()});
   return json({jsonrpc:'2.0',id,result:bs58.encode(tx.signature)});}
  const result=method==='getLatestBlockhash'?{...ctx,value:{blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}}:method==='getFeeForMessage'?{...ctx,value:5000}:
   method==='getBalance'?{...ctx,value:2000000000}:method==='getSignatureStatuses'?{...ctx,value:[{slot:1,confirmations:1,err:null,confirmationStatus:'confirmed'}]}:null;
  return json({jsonrpc:'2.0',id,result});
 }
 return realFetch(url,options);
};
const provider={kind:'phantom',publicKey:signer.publicKey,assertCurrent(){},on(){},removeListener(){},
 async signTransaction(tx){log.signed++;tx.partialSign(signer);return tx;}};
let closed=0,opened=0;const root=createRoot(document.querySelector('#host'));
// Reopening mounts a fresh window for the same wallet, as the wallet menu does.
const open=()=>root.render(<WebsiteNativeSwap key={++opened} owner={owner} provider={provider} moneroAddress={monero} onClose={()=>{closed++;}}/>);open();
globalThis.fixture={ready:true,log,reopen:open,owner,deposit,monero,setStatus:value=>{status=value;},closed:()=>closed,
 saved:()=>JSON.parse(localStorage.getItem('xmr20-native-swaps-v1:'+owner)||'[]')};
