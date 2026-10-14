import {PublicKey,SystemProgram,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {createHash,randomUUID} from 'node:crypto';

export function pilotPolicy({userId,apiPublicKey,walletId,walletAddress}) {
  const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
  if(!uuid(userId)||!uuid(walletId)||!/^(02|03)[a-f0-9]{64}$/i.test(apiPublicKey)||new PublicKey(walletAddress).toBase58()!==walletAddress)throw Error('POLICY_IDENTITY');
  return {
    policyName:'XMR20 private pilot — dedicated Solana wallet',effect:'EFFECT_ALLOW',
    consensus:`credentials.any(c, c.user_id == '${userId}' && c.public_key == '${apiPublicKey}')`,
    condition:`activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && wallet.id == '${walletId}' && wallet_account.address == '${walletAddress}' && solana.tx.version == 'V0' && solana.tx.account_keys[0] == '${walletAddress}'`,
    notes:'Private single-owner pilot. Allows the pinned bot credential to sign V0 Solana transactions only for the dedicated wallet. Does not grant raw signing, export or administration. Does not independently constrain transaction amounts, destinations or programs; those require the bot transaction reviewer. Not a production custody policy.'
  };
}
export function matchesPilotPolicy(policies,expected) {
  return Array.isArray(policies)&&policies.length===1&&['effect','consensus','condition'].every(k=>policies[0][k]===expected[k])&&!policies[0].time;
}

// This module intentionally has no RPC or broadcast capability. The all-zero
// recent blockhash is not a live Solana blockhash; the only instruction moves
// zero lamports to the same wallet. No usable payment signature is produced.
export async function probePilotSigner({signer,address,now=Date.now}) {
  const key=new PublicKey(address);
  const tx=new VersionedTransaction(new TransactionMessage({payerKey:key,recentBlockhash:PublicKey.default.toBase58(),instructions:[SystemProgram.transfer({fromPubkey:key,toPubkey:key,lamports:0})]}).compileToV0Message());
  const messageSha256=createHash('sha256').update(tx.message.serialize()).digest('hex');
  await signer.signReviewed({operationId:'setup-probe:'+randomUUID(),address,transaction:Buffer.from(tx.serialize()),messageSha256,expiresAt:now()+45000});
  return {checkedAt:new Date(now()).toISOString(),signatureVerified:true,broadcast:false,zeroValue:true,invalidBlockhash:true};
}
