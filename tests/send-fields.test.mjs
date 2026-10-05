import test from 'node:test';import assert from 'node:assert/strict';
import {sendFieldState} from '../src/send-fields.js';import {checkMoneroAddress,solAddress,Keypair} from '../review/core.mjs';
const to='4AMg1kDaXkWckE3uyd1YqoBKvn4z8ATxmWQVdtjF6aGU4sT278XoyhUV1Ve88ZMCXNXQJpjW2553NWERfMZcNsBtCkMLiNM';
const options={decimals:6,validAddress:a=>{const r=checkMoneroAddress(a,'mainnet');return r.valid&&r.kind==='standard';}};
test('reversed numeric recipient/address amount is detected without changing either field',()=>{const state=sendFieldState('490000',to,options);assert.equal(state.swapped,true);assert.equal(state.to,'490000');assert.equal(state.amount,to);assert.equal(state.amountIsAddress,true);});
test('valid field order and atomic decimal precision remain unchanged',()=>{const s=sendFieldState(to,'490000.000001',options);assert.equal(s.swapped,false);assert.equal(s.addressValid,true);assert.equal(s.amountValid,true);for(const amount of ['-1','0','0.0000001','1e3','01',''])assert.equal(sendFieldState(to,amount,options).amountValid,false);});
test('never offer to swap malformed recipients or an invalid amount',()=>{assert.equal(sendFieldState('490000',to.slice(0,-1)+'1',options).swapped,false);assert.equal(sendFieldState('-1',to,options).swapped,false);assert.equal(sendFieldState('',to,options).swapped,false);});
test('Solana send forms detect reversed values using their own address validation',()=>{const address=Keypair.generate().publicKey.toBase58();assert.equal(sendFieldState('1.123456789',address,{decimals:9,validAddress:solAddress}).swapped,true);});
