import {siteSender,signInMessage,publicAccount,bridgeLaunch} from './site-policy.js';
const SLOT='xmr20-site-connection';
// Requests and grants are RAM-only and scoped to one tab/document and unlock session.
export function createSiteBroker({chrome,readSession,unlock,readVault,sign,jointBridge=false,now=Date.now,uuid=()=>crypto.randomUUID()}){
 const storage=chrome.storage.session;
 const load=async()=> (await storage.get(SLOT))[SLOT]||{grants:{},requests:{}};
 const save=state=>storage.set({[SLOT]:state});
 const key=s=>s.tabId+':'+s.documentId;
 const same=(a,b)=>a.origin===b.origin&&a.tabId===b.tabId&&a.documentId===b.documentId;
 async function clean(state){for(const [id,r]of Object.entries(state.requests)){if(r.expires<=now()){delete state.requests[id];continue;}if(!r.result&&!r.error){try{await chrome.windows.get(r.windowId);}catch{r.error='Request cancelled.';}}}const s=await readSession();for(const [id,g]of Object.entries(state.grants))if(!s||g.sessionId!==s.id)delete state.grants[id];return s;}
 async function external(m,sender){
  const source=siteSender(sender,{jointBridge});if(m?.channel!=='xmr20-site')throw Error('Unsupported request.');
  if(m.action==='ping')return {name:'XMR20 Wallet',version:chrome.runtime.getManifest().version,jointBridge};
  const state=await load(),session=await clean(state),grant=state.grants[key(source)];await save(state);
  if(m.action==='disconnect'){delete state.grants[key(source)];for(const [id,r]of Object.entries(state.requests))if(same(r,source))delete state.requests[id];await save(state);return true;}
  if(m.action==='status')return grant?{account:grant.account}:null;
  if(m.action==='result'){
   const r=state.requests[m.requestId];if(!r||!same(r,source))throw Error('Connection request expired. Try again.');
   if(r.result||r.error){delete state.requests[m.requestId];await save(state);if(r.error)throw Error(r.error);if(!session||r.sessionId!==session.id)throw Error('Wallet locked. Connect again.');return {done:true,value:r.result};}
   try{await chrome.windows.get(r.windowId);}catch{delete state.requests[m.requestId];await save(state);throw Error('Request cancelled.');}
   return {done:false};
  }
  if(!['connect','signIn',...(jointBridge?['openBridge']:[])].includes(m.action))throw Error('Use the extension to send or approve transactions.');
  if(Object.values(state.requests).some(r=>!r.result&&!r.error))throw Error('Finish or close the open wallet request first.');
  if(m.action==='signIn'){if(!grant)throw Error('Connect your wallet first.');signInMessage(m.message,grant.account.solana,now(),source.origin);}
  if(m.action==='openBridge'&&(!grant||!session||grant.sessionId!==session.id||!grant.account.monero))throw Error('Connect an account with linked Solana and Monero wallets first.');
  const id=uuid(),request={...source,id,action:m.action,expires:now()+300000,message:m.action==='signIn'?m.message:null,accountId:grant?.account.id,sessionId:session?.id};
  if(m.action==='openBridge')request.bridge=bridgeLaunch(m.bridge);
  const window=await chrome.windows.create({url:chrome.runtime.getURL(m.action==='openBridge'?'popup.html':'approval.html')+'?request='+id,type:'popup',width:420,height:740});
  request.windowId=window.id;request.approvalTabId=window.tabs[0].id;state.requests[id]=request;await save(state);return {requestId:id};
 }
 async function internal(m,sender){
  if(sender.id!==chrome.runtime.id||![chrome.runtime.getURL('approval.html'),...(jointBridge?[chrome.runtime.getURL('popup.html')]:[])].includes(sender.url?.split('?')[0]))throw Error('Not an approval window.');
  const state=await load();await clean(state);const r=state.requests[m.requestId];
  if(!r||r.result||r.error||sender.tab?.id!==r.approvalTabId)throw Error('Request expired or already handled.');
  if(sender.url?.split('?')[0]!==chrome.runtime.getURL(r.action==='openBridge'?'popup.html':'approval.html'))throw Error('Not the bound approval surface.');
  if(m.action==='reject'){r.error='Request rejected.';await save(state);return true;}
  if(r.action==='openBridge'){
   const session=await readSession(),grant=state.grants[key(r)];
   if(!session||session.id!==r.sessionId||grant?.sessionId!==session.id||grant.account.id!==r.accountId)throw Error('Wallet connection changed. Connect again.');
   const tab=await chrome.tabs.get(r.tabId);if(new URL(tab.url).origin!==r.origin)throw Error('The requesting website has changed.');
   const vault=await readVault(session),a=vault.accounts.find(a=>a.id===r.accountId);
   if(!a?.solSecret||!a.xmrSeed||a.watch||a.sol!==grant.account.solana||a.xmr!==grant.account.monero)throw Error('Recover the linked keys in the extension before bridging.');
   const current=await readSession();if(!current||current.id!==session.id)throw Error('Wallet locked. Connect again.');
   if(m.action==='view')return {origin:r.origin,account:publicAccount(a),bridge:bridgeLaunch(r.bridge)};
   if(m.action!=='opened'||m.accountId!==r.accountId)throw Error('Choose the originally connected account.');
   r.result={opened:true,account:publicAccount(a)};await save(state);return true;
  }
  if(m.action==='unlock')await unlock(m.password);
  const session=await readSession();
  if(m.action==='view'||m.action==='unlock'){
   const vault=session?await readVault(session):null;
   const accounts=vault?vault.accounts.filter(a=>a.sol&&!a.watch&&a.solSecret).map(publicAccount):[];
   // Connection defaults to the extension's current account; sign-in stays bound
   // to the account explicitly approved for this website, even if the popup changes.
   const preferred=r.action==='signIn'?r.accountId:(session?.activeId||vault?.accounts[0]?.id);
   const accountId=accounts.some(a=>a.id===preferred)?preferred:null;
   return {origin:r.origin,action:r.action,message:r.message,accountId,locked:!session,accounts};
  }
  if(m.action!=='approve'||!session)throw Error('Unlock your wallet first.');
  const tab=await chrome.tabs.get(r.tabId);if(new URL(tab.url).origin!==r.origin)throw Error('The requesting website has changed.');
  const vault=await readVault(session),account=vault.accounts.find(a=>a.id===m.accountId);
  if(!account?.solSecret||account.watch)throw Error('Choose an account with a Solana signing key.');
  let result;
  if(r.action==='connect')result={account:publicAccount(account)};
  else{
   const grant=state.grants[key(r)];if(!grant||grant.sessionId!==session.id||r.sessionId!==session.id||r.accountId!==account.id||grant.account.solana!==account.sol)throw Error('Wallet connection changed. Connect again.');
   result={signature:await sign(signInMessage(r.message,account.sol,now(),r.origin),account.solSecret),publicKey:account.sol};
  }
  // A manual lock or vault edit while decryption/signing was running invalidates approval.
  const current=await readSession();if(!current||current.id!==session.id)throw Error('Wallet locked. Connect again.');
  if(r.action==='connect')state.grants[key(r)]={origin:r.origin,tabId:r.tabId,documentId:r.documentId,account:publicAccount(account),sessionId:session.id};
  r.result=result;r.sessionId=session.id;await save(state);return true;
 }
 return {external,internal};
}
