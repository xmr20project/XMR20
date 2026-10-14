import {lstatSync} from 'node:fs';
import {PublicKey} from '@solana/web3.js';
import {Vault} from './vault.mjs';

export const OFFICIAL_USERNAME='xmr20_bot';
const fail=code=>{throw Object.assign(Error(code),{code});};
export function heliusKey(value){
  try{
    let key=typeof value==='string'?value.trim():'';
    if(key.startsWith('https://')){
      const url=new URL(key);
      if(url.origin!=='https://mainnet.helius-rpc.com'||url.pathname!=='/'||url.username||url.password||url.hash||[...url.searchParams.keys()].some(k=>k!=='api-key')||url.searchParams.getAll('api-key').length!==1)throw Error();
      key=url.searchParams.get('api-key');
    }
    if(!/^[a-zA-Z0-9_-]{10,200}$/.test(key))throw Error();
    return key;
  }catch{fail('HELIUS_INPUT');}
}
// Persist unverified setup separately from executable credentials. Only the
// successful verification path can promote it, so saving is not activation.
export function saveSetupDraft(vault,input){
  if(vault.state.credentials)fail('OFFICIAL_ALREADY_CONFIGURED');
  const draft={...vault.state.setupDraft};
  for(const key of ['token','heliusApiKey','withdrawalAddress','ownerId']){
    if(input[key]!==undefined&&input[key]!=='')draft[key]=input[key];
  }
  vault.transaction(s=>{s.setupDraft=draft;});
  return draft;
}
export function existingFile(path){
  const info=lstatSync(path);
  if(!info.isFile()||info.isSymbolicLink())fail('OFFICIAL_FILE');
}
export function officialIdentity(me,expected){
  if(me?.is_bot!==true||!Number.isSafeInteger(me.id)||me.id<=0||me.username?.toLowerCase()!==OFFICIAL_USERNAME)fail('OFFICIAL_BOT_IDENTITY');
  if(expected&&(me.id!==expected.id||expected.username!==OFFICIAL_USERNAME))fail('OFFICIAL_BOT_IDENTITY');
  return {id:me.id,username:OFFICIAL_USERNAME};
}
export async function verifyOfficialBot(api,expected){
  const bot=officialIdentity(await api.call('getMe',{}),expected);
  const hook=await api.call('getWebhookInfo',{});
  if(!hook||typeof hook.url!=='string'||hook.url)fail('OFFICIAL_WEBHOOK');
  return bot;
}
export function validateOfficialCredentials(c){
  if(c?.allowedUsers?.length!==1||!Number.isSafeInteger(c.allowedUsers[0])||c.allowedUsers[0]<=0)fail('OFFICIAL_OWNER');
  officialIdentity({...c.bot,is_bot:true},c.bot);
  const withdrawal=new PublicKey(c.withdrawalAddress);
  if(withdrawal.toBase58()!==c.withdrawalAddress||!PublicKey.isOnCurve(withdrawal.toBytes()))fail('OFFICIAL_WITHDRAWAL');
  return c;
}
export function openOfficial(path,password){
  existingFile(path); // A missing connection must never create a blank vault.
  const vault=new Vault(path,password,{profile:'official-bot'});
  try{validateOfficialCredentials(vault.state.credentials);return vault;}
  catch(error){vault.close();throw error;}
}
// Refuse implicit reassignment of any previous bot's updates or financial state.
export function bindOfficialRuntime(state,{bot,ownerId,wallet}){
  officialIdentity({...bot,is_bot:true},bot);
  if(state.botId!==undefined&&state.botId!==bot.id)fail('OFFICIAL_STATE_IDENTITY');
  if(state.telegramOwner!==undefined&&state.telegramOwner!==ownerId)fail('OFFICIAL_STATE_IDENTITY');
  if(state.owner!==undefined&&state.owner!==wallet)fail('OFFICIAL_STATE_IDENTITY');
  if(state.botId===undefined&&(state.owner||state.telegramOwner||state.offset||Object.keys(state.updates||{}).length||Object.keys(state.launches||{}).length||Object.keys(state.trades||{}).length||state.draft))fail('OFFICIAL_STATE_MIGRATION_REQUIRED');
  state.botId=bot.id;state.telegramOwner=ownerId;state.owner=wallet;
  state.offset??=0;state.updates??={};
}
