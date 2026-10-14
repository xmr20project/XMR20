import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';

const need=(v,code)=>{if(!v)throw Error(code);};
const account=Object.freeze({curve:'CURVE_ED25519',pathFormat:'PATH_FORMAT_BIP32',path:"m/44'/501'/0'/0'",addressFormat:'ADDRESS_FORMAT_SOLANA'});
export function registrationPolicies({userId,apiPublicKey,botId}){
  need(/^[a-f0-9-]{36}$/.test(userId)&&/^(02|03)[a-f0-9]{64}$/i.test(apiPublicKey)&&Number.isSafeInteger(botId)&&botId>0,'REGISTRATION_IDENTITY');
  const consensus=`credentials.any(c, c.user_id == '${userId}' && c.public_key == '${apiPublicKey}')`;
  return [
    {policyName:'XMR20 Telegram — create user wallets',effect:'EFFECT_ALLOW',consensus,condition:"activity.type == 'ACTIVITY_TYPE_CREATE_WALLET'"},
    {policyName:'XMR20 Telegram — sign user wallets',effect:'EFFECT_ALLOW',consensus,condition:`activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && wallet.label[0..${('xmr20-tg-'+botId+'-').length}] == 'xmr20-tg-${botId}-' && wallet.imported == false && solana.tx.version == 'V0' && solana.tx.account_keys[0] == wallet_account.address`}
  ];
}
export function matchesPolicySet(actual,expected){
  return Array.isArray(actual)&&actual.length===expected.length&&expected.every(e=>actual.filter(a=>!a.time&&['effect','consensus','condition'].every(k=>a[k]===e[k])).length===1);
}
export class UserVault {
  constructor(vault,userId){this.vault=vault;this.userId=String(userId);}
  get state(){const r=this.vault.state.registrations?.[this.userId];need(r?.state==='ready','WALLET_NOT_READY');return r.data;}
  transaction(fn){return this.vault.transaction(s=>{const r=s.registrations?.[this.userId];need(r?.state==='ready','WALLET_NOT_READY');return fn(r.data);});}
}
export class Registration {
  constructor({vault,client,botId,organizationId,activateWallet,maxUsers=1000,dailyLimit=100,now=Date.now}){Object.assign(this,{vault,client,botId,organizationId,activateWallet,maxUsers,dailyLimit,now});this.pending=new Map();}
  get(id){return structuredClone(this.vault.state.registrations?.[String(id)]);}
  save(id,fn){return this.vault.transaction(s=>fn(s.registrations[String(id)]));}
  ensure(userId){
    if(this.pending.has(userId))return this.pending.get(userId);
    const pending=this.provision(userId).finally(()=>this.pending.delete(userId));this.pending.set(userId,pending);return pending;
  }
  async provision(userId){
    need(Number.isSafeInteger(userId)&&userId>0,'REGISTRATION_IDENTITY');
    let r=this.get(userId);
    if(r?.state==='ready')return r;
    if(!r){
      this.vault.transaction(s=>{
        s.registrations??={};const rows=Object.values(s.registrations),day=new Date(this.now()).toISOString().slice(0,10);
        need(rows.length<this.maxUsers&&rows.filter(r=>r.day===day).length<this.dailyLimit,'REGISTRATION_CAPACITY');
        const binding=randomUUID();
        s.registrations[String(userId)]={state:'reserved',binding,walletName:`xmr20-tg-${this.botId}-${binding}`,day,data:{updates:{},offset:0}};
      });r=this.get(userId);
    }
    need(!['activating','attention'].includes(r.state),'REGISTRATION_ATTENTION');
    const wallets=await this.client.query('get_wallets');
    const matches=(wallets.wallets||[]).filter(w=>w.walletName===r.walletName);
    need(matches.length<=1,'REGISTRATION_AMBIGUOUS');
    let wallet=matches[0];
    if(!wallet){
      // Reserve once before I/O. Unknown outcomes are looked up, never recreated.
      need(r.state==='reserved','REGISTRATION_PENDING');
      const request={type:'ACTIVITY_TYPE_CREATE_WALLET',timestampMs:String(this.now()),organizationId:this.organizationId,parameters:{walletName:r.walletName,accounts:[account],mnemonicLength:24}};
      this.save(userId,d=>{d.state='creating';d.request=request;});
      const result=await this.client.createWallet(request),activity=result?.activity;
      if(activity?.id)this.save(userId,d=>{d.activityId=activity.id;});
      need(activity?.organizationId===this.organizationId&&activity?.type===request.type&&activity?.status==='ACTIVITY_STATUS_COMPLETED','REGISTRATION_PENDING');
      const created=activity.result?.createWalletResult;
      need(typeof created?.walletId==='string','REGISTRATION_RESPONSE');
      const verified=await this.client.query('get_wallets');
      const found=(verified.wallets||[]).filter(w=>w.walletId===created.walletId&&w.walletName===r.walletName);
      need(found.length===1,'REGISTRATION_RESPONSE');wallet=found[0];
    }
    const result=await this.client.query('get_wallet_accounts',{walletId:wallet.walletId});
    const accounts=result?.accounts;
    need(Array.isArray(accounts)&&accounts.length===1,'REGISTRATION_ACCOUNT');
    const a=accounts[0];
    need(a.organizationId===this.organizationId&&a.walletId===wallet.walletId&&Object.entries(account).every(([k,v])=>a[k]===v),'REGISTRATION_ACCOUNT');
    const key=new PublicKey(a.address);need(key.toBase58()===a.address&&PublicKey.isOnCurve(key.toBytes()),'REGISTRATION_ACCOUNT');
    need(a.address!==this.vault.state.owner&&!Object.entries(this.vault.state.registrations).some(([id,d])=>id!==String(userId)&&d.walletAddress===a.address),'REGISTRATION_DUPLICATE_WALLET');
    this.save(userId,d=>{d.state='activating';d.walletId=wallet.walletId;d.walletAddress=a.address;});
    try{await this.activateWallet(this.get(userId));}
    catch{this.save(userId,d=>{d.state='attention';});throw Error('REGISTRATION_ATTENTION');}
    this.save(userId,d=>{d.state='ready';delete d.request;});
    return this.get(userId);
  }
}
export class PublicEngine {
  constructor({ownerId,ownerEngine,registration,createEngine}){Object.assign(this,{ownerId,ownerEngine,registration,createEngine});this.engines=new Map();}
  accepts(update){const q=update.callback_query,m=q?.message||update.message,s=q?.from||m?.from;return Number.isSafeInteger(update.update_id)&&Number.isSafeInteger(s?.id)&&s.id>0&&!s.is_bot&&m?.chat?.type==='private'&&m.chat.id===s.id;}
  async handle(update){
    if(!this.accepts(update))return null;
    const q=update.callback_query,m=q?.message||update.message,id=(q?.from||m.from).id;
    if(id===this.ownerId)return this.ownerEngine.handle(update);
    const text=q?.data||m.text;
    try{
      let record=this.registration.get(id);
      if(record?.state!=='ready'){
        if(text!=='/start')return {chat_id:id,text:'Send /start to set up your own XMR20 wallet.'};
        record=await this.registration.ensure(id);
      }
      if(!this.engines.has(id))this.engines.set(id,await this.createEngine(id,record));
      return await this.engines.get(id).handle(update);
    }catch(error){return {chat_id:id,text:error.message==='REGISTRATION_CAPACITY'?'Wallet registration is at capacity. Please try again later.':error.message==='REGISTRATION_ATTENTION'?'Wallet setup needs operator attention. No deposit address is available yet.':'Wallet setup is pending. Send /start again shortly; your wallet request is saved.'};}
  }
}

export function boundSigner(signer,wallet){return {signReviewed:args=>{need(args.address===wallet,'SIGNER_USER_MISMATCH');return signer.signReviewed(args);}};}
