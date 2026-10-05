// Install next to wallet-handler.mjs. Defaults reject all extension origins.
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {ed25519} from '@noble/curves/ed25519';
import bs58 from 'bs58';
export function extensionOrigin(id=process.env.XMR20_EXTENSION_ID){
 if(!id)return null;
 if(!/^[a-p]{32}$/.test(id))throw Error('Invalid XMR20_EXTENSION_ID');
 return 'chrome-extension://'+id;
}
export function walletOriginAllowed(origin,allowed=extensionOrigin()){
 return origin==='https://xmr20.org'||!!allowed&&origin===allowed;
}
export function extensionAuth({webAuth,store,origin=extensionOrigin(),now=Date.now}){
 const codec=webAuth.codec;
 function read(token,requestOrigin){
  if(!walletOriginAllowed(requestOrigin,origin))throw Error('Unrecognized wallet origin.');
  if(requestOrigin==='https://xmr20.org')return webAuth.read(token);
  const s=codec.read(token,'xmr20-extension-session');if(s.origin!==origin)throw Error('Invalid session origin.');return s;
 }
 return {codec,read,
 async challenge(input){if(input.origin==='https://xmr20.org')return webAuth.challenge(input);
  if(!origin||input.origin!==origin)throw Error('Unrecognized wallet origin.');
  if(typeof input.wallet!=='string'||!PublicKey.isOnCurve(new PublicKey(input.wallet).toBytes()))throw Error('Invalid wallet');
  await store.limit('extension-login:'+input.wallet,10,300);
  const nonce=randomUUID(),issued=now(),message=`Sign in to XMR20\nWebsite: ${origin}\nWallet: ${input.wallet}\nNonce: ${nonce}\nIssued: ${new Date(issued).toISOString()}\nExpires: ${new Date(issued+300000).toISOString()}\nThis signature proves wallet ownership. It does not authorize a transaction.`;
  return {message,challenge:codec.seal('xmr20-extension-login',{wallet:input.wallet,origin,nonce,message},300000)};
 },
 async signin(input){if(input.origin==='https://xmr20.org')return webAuth.signin(input);
  if(!origin||input.origin!==origin)throw Error('Unrecognized wallet origin.');
  const c=codec.read(input.challenge,'xmr20-extension-login');if(c.origin!==origin)throw Error('Invalid login origin.');
  await store.limit('extension-verify:'+c.wallet,20,300);
  let good=false;try{good=ed25519.verify(bs58.decode(input.signature),new TextEncoder().encode(c.message),new PublicKey(c.wallet).toBytes());}catch{}
  if(!good)throw Error('Wallet ownership signature is invalid.');
  if(!await store.consumeNonce(c.nonce))throw Error('This sign-in request was already used.');
  return {wallet:c.wallet,token:codec.seal('xmr20-extension-session',{wallet:c.wallet,origin},30*60000)};
 }};
}
