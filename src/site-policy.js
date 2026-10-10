import {supportedMint} from '../bridge/core-next/mint-policy.mjs';
export const SITE_ORIGIN='https://xmr20.org';
export const LOCAL_ORIGIN='http://127.0.0.1:8893';
const allowedOrigins=new Set([SITE_ORIGIN,LOCAL_ORIGIN]);
export function siteSender(sender,{jointBridge=false}={}){
 if(sender?.id||sender?.frameId!==0||!Number.isInteger(sender?.tab?.id)||typeof sender.documentId!=='string')throw Error('Website connection not allowed.');
 const origin=new URL(sender.url).origin;
 if((!allowedOrigins.has(origin)&&!(jointBridge&&origin==='http://127.0.0.1:8925'))||sender.origin!==origin)throw Error('Website connection not allowed.');
 return {origin,tabId:sender.tab.id,documentId:sender.documentId};
}
export function signInMessage(message,wallet,now=Date.now(),origin=SITE_ORIGIN){
 if(!allowedOrigins.has(origin))throw Error('Website connection not allowed.');
 if(typeof message!=='string'||message.length>1024)throw Error('Only XMR20 website sign-in is supported.');
 const lines=message.split('\n');
 if(lines.length!==7||lines[0]!=='Sign in to XMR20'||lines[1]!=='Website: '+origin||lines[2]!=='Wallet: '+wallet||!/^Nonce: [0-9a-f-]{36}$/.test(lines[3])||lines[6]!=='This signature proves wallet ownership. It does not authorize a transaction.')throw Error('Only XMR20 website sign-in is supported.');
 const issued=Date.parse(lines[4].slice(8)),expires=Date.parse(lines[5].slice(9));
 if(!lines[4].startsWith('Issued: ')||!lines[5].startsWith('Expires: ')||!Number.isFinite(issued)||!Number.isFinite(expires)||issued>now+30000||expires<=now||expires-issued!==300000||now-issued>300000)throw Error('Sign-in expired. Connect again.');
 return message;
}
export const publicAccount=a=>({id:a.id,name:a.name,solana:a.sol||null,monero:a.xmr||null,canSign:!!a.solSecret&&!a.watch});
export function bridgeLaunch(input){
 if(!input||Object.keys(input).sort().join(',')!=='amountRaw,direction,mint'||!supportedMint(input.mint)||!['sol-to-xmr','xmr-to-sol'].includes(input.direction)||typeof input.amountRaw!=='string'||! /^[1-9][0-9]{0,13}$/.test(input.amountRaw)||BigInt(input.amountRaw)>50000000000000n)throw Error('Only an exact supported-token bridge request is supported.');
 return {mint:input.mint,direction:input.direction,amountRaw:input.amountRaw};
}
