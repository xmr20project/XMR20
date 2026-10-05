import test from 'node:test';import assert from 'node:assert/strict';
import {siteSender,signInMessage,publicAccount} from '../src/site-policy.js';
const source={url:'https://xmr20.org/index',origin:'https://xmr20.org',frameId:0,tab:{id:8},documentId:'document-a'};
const now=Date.now(),wallet='11111111111111111111111111111111';
const message=`Sign in to XMR20\nWebsite: https://xmr20.org\nWallet: ${wallet}\nNonce: 00000000-0000-0000-0000-000000000000\nIssued: ${new Date(now).toISOString()}\nExpires: ${new Date(now+300000).toISOString()}\nThis signature proves wallet ownership. It does not authorize a transaction.`;
test('website requests require exact HTTPS origin and top-level document',()=>{assert.equal(siteSender(source).tabId,8);for(const bad of [{...source,url:'https://xmr20.org.evil.test/'},{...source,url:'http://xmr20.org/'},{...source,origin:'https://evil.test'},{...source,frameId:2},{...source,id:'extension'},{...source,documentId:null}])assert.throws(()=>siteSender(bad));});
test('only bounded, fresh, account-bound sign-in text can be signed',()=>{assert.equal(signInMessage(message,wallet,now),message);for(const bad of [message+'\nPay someone',message.replace(wallet,'other'),message.replace('https://xmr20.org','https://evil.test'),message.replace('Sign in','Transfer tokens'),message.replace('Nonce: ','Nonce: BAD'),message.replace('Expires: ','ExpiresX ')])assert.throws(()=>signInMessage(bad,wallet,now));assert.throws(()=>signInMessage(message,wallet,now+300001));assert.throws(()=>signInMessage(message,wallet,now-60000));});
test('site-visible account objects never contain secrets or vault metadata',()=>{const result=publicAccount({id:'a',name:'Account',sol:wallet,xmr:'public-monero',solSecret:'SECRET',xmrSeed:'SEED',password:'PASSWORD',height:123});assert.deepEqual(Object.keys(result),['id','name','solana','monero','canSign']);assert.ok(!JSON.stringify(result).includes('SECRET'));});
test('local review origin is allowed only on port 8893 and never shares the production sign-in scope',()=>{
 const local='http://127.0.0.1:8893',sender={...source,url:local+'/',origin:local};assert.equal(siteSender(sender).origin,local);
 const localMessage=message.replace('https://xmr20.org',local);
 assert.equal(signInMessage(localMessage,wallet,now,local),localMessage);
 assert.throws(()=>signInMessage(localMessage,wallet,now,'https://xmr20.org'));
 assert.throws(()=>signInMessage(message,wallet,now,local));
 for(const origin of ['http://127.0.0.1:8894','http://localhost:8893','http://192.168.1.1:8893'])assert.throws(()=>siteSender({...sender,url:origin+'/',origin}));
});
