import {ApiKeyStamper} from '@turnkey/api-key-stamper';

// No raw-payload signing, exports, permission changes or provider broadcast.
const QUERIES=new Set(['get_activity','get_activities','get_wallet_accounts','get_wallets','whoami','get_user','get_organization_configs','get_policies']);
// Turnkey's GetWallets/GetPolicies/etc. operations use list_* HTTP routes.
const QUERY_ROUTES=Object.freeze({get_activities:'list_activities',get_wallet_accounts:'list_wallet_accounts',get_wallets:'list_wallets',get_policies:'list_policies'});
const fail=code=>{throw Object.assign(Error(code),{code});};
export class TurnkeyClient {
  #stamp; #org; #fetch;
  constructor({organizationId,apiPublicKey,apiPrivateKey,fetcher=fetch}) {
    if(!/^[a-f0-9-]{36}$/.test(organizationId)||!/^(02|03)[a-f0-9]{64}$/i.test(apiPublicKey)||!/^[a-f0-9]{64}$/i.test(apiPrivateKey)) fail('TURNKEY_SETTINGS');
    this.#org=organizationId;this.#stamp=new ApiKeyStamper({apiPublicKey,apiPrivateKey});this.#fetch=fetcher;
  }
  async #call(path,body) {
    const payload=JSON.stringify(body);
    let res;
    try {
      const stamp=await this.#stamp.stamp(payload);
      res=await this.#fetch('https://api.turnkey.com/public/v1/'+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',[stamp.stampHeaderName]:stamp.stampHeaderValue},body:payload});
    } catch {fail('TURNKEY_CONNECTION');}
    if(!res.ok) fail(({401:'TURNKEY_AUTH',403:'TURNKEY_ACCESS',404:'TURNKEY_ENDPOINT',429:'TURNKEY_RATE_LIMIT'})[res.status]||'TURNKEY_REQUEST');
    try{return await res.json();}catch{fail('TURNKEY_RESPONSE');}
  }
  query(method,args={}) {
    if(!QUERIES.has(method)||Object.hasOwn(args,'organizationId'))fail('TURNKEY_QUERY');
    // The identity checker takes a public user ID as its second argument.
    if(typeof args==='string')args={userId:args};
    return this.#call('query/'+(QUERY_ROUTES[method]||method),{...args,organizationId:this.#org});
  }
  createWallet(request) {
    const p=request.parameters,a=p?.accounts?.[0];
    if(request.organizationId!==this.#org||request.type!=='ACTIVITY_TYPE_CREATE_WALLET'||
      !/^xmr20-tg-[1-9][0-9]*-[a-f0-9-]{36}$/.test(p?.walletName||'')||p?.mnemonicLength!==24||
      p?.accounts?.length!==1||Object.keys(p).sort().join(',')!=='accounts,mnemonicLength,walletName'||
      !a||Object.keys(a).sort().join(',')!=='addressFormat,curve,path,pathFormat'||a.curve!=='CURVE_ED25519'||
      a.pathFormat!=='PATH_FORMAT_BIP32'||a.path!=="m/44'/501'/0'/0'"||a.addressFormat!=='ADDRESS_FORMAT_SOLANA')fail('TURNKEY_CREATE_REQUEST');
    return this.#call('submit/create_wallet',request);
  }
  signTransaction(request) {
    if(request.organizationId!==this.#org||request.type!=='ACTIVITY_TYPE_SIGN_TRANSACTION_V2'||request.parameters?.type!=='TRANSACTION_TYPE_SOLANA'||request.parameters?.unsignedTransaction?.length>2464)fail('TURNKEY_SIGN_REQUEST');
    return this.#call('submit/sign_transaction',request);
  }
}
