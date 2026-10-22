import test from 'node:test';
import assert from 'node:assert/strict';
import {openTradeMailbox} from './mailbox-client.mjs';
const scope={owner:'public-owner',genesis:'11'.repeat(32),offerId:'22'.repeat(32),role:'buyer',identity:'33'.repeat(32)};
test('mailbox requires explicit synchronous account and CSRF dependencies',async()=>{
 await assert.rejects(openTradeMailbox({scope}),/Trusted CSRF/);
 await assert.rejects(openTradeMailbox({scope,csrfProvider:()=> 'token',assertCurrent:()=>{},indexedDB:{},lockManager:{request(){}}}),/URL|origin/i);
});
test('caller cannot select an origin or endpoint through mailbox scope',async()=>{
 const prior=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{value:{origin:'https://market.example'},configurable:true});
 try{await assert.rejects(openTradeMailbox({scope:{...scope,origin:'https://elsewhere.example'},csrfProvider:()=> 'token',assertCurrent:()=>{},indexedDB:{},lockManager:{request(){}}}),/Exact record fields/);}
 finally{if(prior)Object.defineProperty(globalThis,'location',prior);else delete globalThis.location;}
});
