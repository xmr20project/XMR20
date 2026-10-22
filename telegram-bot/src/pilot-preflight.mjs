import {verifyTurnkeyConnection} from './turnkey-check.mjs';
import {address} from './engine.mjs';
import {createHash} from 'node:crypto';
import {registrationPolicies,matchesPolicySet} from './registration.mjs';
import {pilotPolicy,matchesPilotPolicy} from './pilot-policy.mjs';

// Policies for another exact credential cannot authorize this service. Only
// this canonical AND predicate is excluded; unfamiliar or overlapping predicates
// fail closed. Keep the original provider rows/order for the reviewed digest.
export function policiesForCredential(policies,{userId,apiPublicKey}) {
  if(!Array.isArray(policies)||typeof userId!=='string'||typeof apiPublicKey!=='string')throw Error('PILOT_POLICY_SCOPE');
  const expected=`credentials.any(c, c.user_id == '${userId}' && c.public_key == '${apiPublicKey}')`;
  const predicate=/^credentials\.any\(c, c\.user_id == '([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})' && c\.public_key == '((?:02|03)[a-f0-9]{64})'\)$/i;
  return policies.filter(policy=>{
    if(policy?.consensus===expected)return true;
    const match=typeof policy?.consensus==='string'&&predicate.exec(policy.consensus);
    if(!match||match[1].toLowerCase()===userId.toLowerCase()||match[2].toLowerCase()===apiPublicKey.toLowerCase())throw Error('PILOT_POLICY_SCOPE');
    return false;
  });
}

// Read-only and intentionally separate from transaction execution. Account
// discovery never creates a wallet or chooses an arbitrary existing account.
export async function pilotPreflight({client,identity,helius,gateway,walletId,registrationBotId,onStage=()=>{}}) {
  onStage('turnkey-identity');
  const connection=await verifyTurnkeyConnection({client,...identity});
  onStage('helius-network');
  await helius.verify();
  onStage('wallet-list');
  const wallets=await client.query('get_wallets');
  const matches=(wallets.wallets||[]).filter(w=>walletId?w.walletId===walletId:w.walletName==='xmr20-telegram-pilot');
  const report={checkedAt:new Date().toISOString(),network:'mainnet-beta',mode:'xmr20',identityVerified:true,nonRoot:true,heliusVerified:true,otherApiKeyCount:connection.otherApiKeyCount,walletVerified:false,launchGatewayVerified:false,policyReviewed:false,mainnetReady:false,missing:[]};
  if(matches.length!==1){report.missing.push('Create one dedicated Solana wallet named xmr20-telegram-pilot in Turnkey, or configure its public wallet ID.');return report;}
  onStage('wallet-account');
  const accounts=await client.query('get_wallet_accounts',{walletId:matches[0].walletId});
  const sol=(accounts.accounts||[]).filter(a=>a.organizationId===identity.organizationId&&a.walletId===matches[0].walletId&&a.curve==='CURVE_ED25519'&&a.addressFormat==='ADDRESS_FORMAT_SOLANA'&&address(a.address));
  if(sol.length!==1){report.missing.push('The dedicated pilot wallet must have exactly one Solana account.');return report;}
  report.walletVerified=true;report.walletId=matches[0].walletId;report.walletAddress=sol[0].address;
  onStage('policy-read');
  const policies=await client.query('get_policies');
  if(!Array.isArray(policies.policies))throw Error('PILOT_POLICIES_UNAVAILABLE');
  // Digest only. Reading a policy list does not prove scoped signing permission.
  const scoped=policiesForCredential(policies.policies,identity);
  report.policyDigest=createHash('sha256').update(JSON.stringify(scoped)).digest('hex');
  report.policyCount=policies.policies.length;
  const expected=pilotPolicy({...identity,walletId:report.walletId,walletAddress:report.walletAddress});
  report.policyMatchesDraft=registrationBotId?matchesPolicySet(scoped,[expected,...registrationPolicies({...identity,botId:registrationBotId})]):matchesPilotPolicy(scoped,expected);
  report.policyScope=registrationBotId?'bot wallet creation and label-scoped signing; user/amount/destination checks remain bot-enforced':'dedicated-wallet-only; amount/destination checks remain bot-enforced';
  if(gateway){onStage('launch-gateway');const catalog=await gateway.call('meteoraCatalog');report.launchGatewayVerified=catalog?.enabled===true&&catalog.network==='mainnet-beta'&&catalog.oneApprovalEnabled===true;}
  if(!report.launchGatewayVerified)report.missing.push('Verify the private XMR20 launch gateway against the current live service.');
  if(!report.policyMatchesDraft)report.missing.push('Install the exact dedicated-wallet pilot policy in Turnkey; no broader policies are accepted.');
  else report.missing.push('Verify signing and independent withdrawal recovery before funding this private pilot.');
  report.missing.push('Complete transaction/restart integration testing before enabling funded execution.');
  return report;
}

// Never persist exception text, response bodies, input values or URLs.
export function readinessFailure(stage,error) {
  const stages={
    dependencies:'The local dependency safety check did not pass.',
    input:'The hidden input could not be read.',
    settings:'The public Turnkey setup could not be loaded.',
    vault:'The Turnkey vault could not be unlocked. Check its passphrase and whether another setup process is using it.',
    'helius-input':'Enter the Helius API key itself, not the full RPC URL.',
    'turnkey-identity':'The Turnkey identity check did not complete. Check account access and network connectivity.',
    'helius-network':'Helius mainnet could not be verified. Check the Helius key and network connectivity.',
    'wallet-list':'Turnkey wallet discovery failed. Check the service user’s read access.',
    'wallet-account':'The pilot wallet account could not be read.',
    'policy-read':'Turnkey signing policies could not be read.',
    'launch-gateway':'The private launch gateway could not be verified.',
    report:'The local readiness report could not be saved.'
  };
  const codes=new Set(['VAULT_UNLOCK','VAULT_LOCKED','VAULT_PASSPHRASE','TURNKEY_REQUEST','TURNKEY_AUTH','TURNKEY_ACCESS','TURNKEY_ENDPOINT','TURNKEY_RATE_LIMIT','TURNKEY_CONNECTION','TURNKEY_RESPONSE','TURNKEY_IDENTITY_MISMATCH','TURNKEY_KEY_MISMATCH','TURNKEY_ROOT_USER','TURNKEY_ROOT_UNVERIFIED','HELIUS_UNAVAILABLE','WRONG_NETWORK']);
  const safeStage=Object.hasOwn(stages,stage)?stage:'unknown';
  const code=typeof error?.code==='string'&&codes.has(error.code)?error.code:'CHECK_FAILED';
  const reasons={TURNKEY_AUTH:'Turnkey rejected authentication.',TURNKEY_ACCESS:'Turnkey denied access to this request.',TURNKEY_ENDPOINT:'The Turnkey API route was not found. The connector needs checking.',TURNKEY_RATE_LIMIT:'Turnkey rate-limited the request. Retry later.',TURNKEY_CONNECTION:'The Turnkey request could not connect or timed out.',TURNKEY_RESPONSE:'Turnkey returned an unreadable response.'};
  return {checkedAt:new Date().toISOString(),ok:false,network:'mainnet-beta',mode:'xmr20',mainnetReady:false,stage:safeStage,code,missing:[reasons[code]||stages[safeStage]||'The readiness check did not complete. No secret details were recorded.']};
}
