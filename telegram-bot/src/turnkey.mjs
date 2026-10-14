import {createHash, createPublicKey, verify} from 'node:crypto';

const TYPE = 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2';
const COMPLETED = 'ACTIVITY_STATUS_COMPLETED';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), {code}); };

function publicKey(address) {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) fail('SIGNER_ADDRESS');
  let value = 0n;
  for (const char of address) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) fail('SIGNER_ADDRESS');
    value = value * 58n + BigInt(digit);
  }
  let hex = value.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const decoded = Buffer.concat([Buffer.alloc(address.match(/^1*/)[0].length), value ? Buffer.from(hex, 'hex') : Buffer.alloc(0)]);
  if (decoded.length !== 32) fail('SIGNER_ADDRESS');
  return decoded;
}

// Only the wire envelope is parsed here. The existing launch/trade reviewers
// remain responsible for instruction semantics, fees, balances and slippage.
function envelope(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1232) fail('SIGNING_TRANSACTION');
  let offset = 0;
  const short = () => {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      if (offset >= bytes.length) fail('SIGNING_TRANSACTION');
      const b = bytes[offset++];
      if (i === 2 && b > 3) fail('SIGNING_TRANSACTION');
      value |= (b & 127) << (7 * i);
      if (!(b & 128)) {
        if (i > 0 && b === 0) fail('SIGNING_TRANSACTION');
        return value;
      }
    }
    fail('SIGNING_TRANSACTION');
  };
  const count = short();
  const signatureStart = offset;
  if (!count || count > 18 || offset + count * 64 >= bytes.length) fail('SIGNING_TRANSACTION');
  offset += count * 64;
  const message = bytes.subarray(offset);
  if (bytes[offset] & 128) {
    if (bytes[offset++] !== 128) fail('SIGNING_VERSION'); // legacy and v0 only
  }
  if (bytes[offset] !== count || offset + 3 >= bytes.length) fail('SIGNING_TRANSACTION');
  const readonlySigned = bytes[offset + 1];
  const readonlyUnsigned = bytes[offset + 2];
  offset += 3;
  const accountCount = short();
  if (accountCount < count || accountCount > 256 || readonlySigned >= count || readonlyUnsigned > accountCount - count || offset + accountCount * 32 + 33 > bytes.length) fail('SIGNING_TRANSACTION');
  const keys = Array.from({length:count}, (_, i) => bytes.subarray(offset + i * 32, offset + (i + 1) * 32));
  const signatures = Array.from({length:count}, (_, i) => bytes.subarray(signatureStart + i * 64, signatureStart + (i + 1) * 64));
  return {message, keys, signatures};
}

function validSignature(signature, message, key) {
  const publicKeyObject = createPublicKey({format:'der', type:'spki', key:Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key])});
  return verify(null, message, publicKeyObject, signature);
}

/**
 * Signing-only adapter for the stamped @turnkey/http client's signTransaction.
 * Not wired into Telegram. The caller must authenticate approval, independently
 * validate instructions, and atomically reserve the operation before calling.
 * journal.reserve must durably reject reused operation IDs across processes;
 * journal.complete must durably retain the signed bytes before they can be sent.
 * No automatic retries: interrupted requests require activity reconciliation.
 */
export function createTurnkeySigner({client, organizationId, journal, now = Date.now}) {
  if (!client?.signTransaction || !journal?.reserve || !journal?.complete || typeof organizationId !== 'string' || !organizationId) fail('SIGNER_CONFIGURATION');
  return Object.freeze({
    async reconcile(operationId) {
      if(!journal.get||!client.query)fail('SIGNING_RECONCILIATION_UNAVAILABLE');
      const record=await journal.get(operationId);
      if(!record||record.organizationId!==organizationId)fail('SIGNING_RESERVATION_MISSING');
      if(record.state==='signed')return {state:'signed',activityId:record.receipt.activityId};
      const request=record.request;
      if(hash(JSON.stringify(request))!==record.requestSha256||request.type!==TYPE||request.organizationId!==organizationId||request.parameters.signWith!==record.address)fail('SIGNING_RESERVATION_INVALID');
      let activity;
      try {
        if(record.activityId)activity=(await client.query('get_activity',{activityId:record.activityId})).activity;
        else {
          const result=await client.query('get_activities',{filterByType:[TYPE],paginationOptions:{limit:'100'}});
          if(!Array.isArray(result.activities)||result.activities.length>100)fail('SIGNING_RECONCILIATION_RESPONSE');
          const matches=result.activities.filter(a=>a.organizationId===organizationId&&a.type===TYPE&&['signWith','unsignedTransaction','type'].every(k=>a.intent?.signTransactionIntentV2?.[k]===request.parameters[k]));
          if(matches.length!==1)fail('SIGNING_RECONCILIATION_AMBIGUOUS');
          activity=matches[0];
        }
      }catch{fail('SIGNING_RECONCILIATION_UNAVAILABLE');}
      if(!activity||activity.organizationId!==organizationId||activity.type!==TYPE||typeof activity.id!=='string'||!activity.id||(record.activityId&&record.activityId!==activity.id))fail('SIGNING_RESPONSE_MISMATCH');
      await journal.observeActivity({operationId,activityId:activity.id,status:activity.status});
      if(activity.status!==COMPLETED)return {state:'reserved',activityId:activity.id,status:activity.status};
      const hex=activity.result?.signTransactionResult?.signedTransaction;
      if(typeof hex!=='string'||!/^(?:[a-fA-F0-9]{2}){65,1232}$/.test(hex))fail('SIGNING_RESPONSE_INVALID');
      const before=envelope(Buffer.from(request.parameters.unsignedTransaction,'hex')),after=envelope(Buffer.from(hex,'hex')),key=publicKey(record.address),index=before.keys.findIndex(k=>k.equals(key));
      if(index<0||hash(before.message)!==record.messageSha256||!before.message.equals(after.message)||before.signatures.length!==after.signatures.length)fail('SIGNING_MESSAGE_CHANGED');
      for(let i=0;i<before.signatures.length;i++)if(i!==index&&!before.signatures[i].equals(after.signatures[i]))fail('SIGNING_SIGNATURE_CHANGED');
      if(!validSignature(after.signatures[index],after.message,key))fail('SIGNING_SIGNATURE_INVALID');
      await journal.complete({operationId,activityId:activity.id,organizationId,address:record.address,messageSha256:record.messageSha256,signedTransactionHex:hex.toLowerCase()});
      // Archive only. A new user review and current blockhash check must precede
      // delivery; reconciliation never signs, broadcasts or returns live bytes.
      return {state:'signed',activityId:activity.id};
    },
    async signReviewed({operationId, address, transaction, messageSha256, expiresAt}) {
      if (typeof operationId !== 'string' || !operationId || operationId.length > 128 || !Number.isSafeInteger(expiresAt) || expiresAt <= now()) fail('SIGNING_APPROVAL');
      const bytes = Buffer.from(transaction);
      const before = envelope(bytes);
      if (!/^[a-f0-9]{64}$/.test(messageSha256) || hash(before.message) !== messageSha256) fail('SIGNING_REVIEW_MISMATCH');
      const key = publicKey(address);
      const index = before.keys.findIndex(k => k.equals(key));
      if (index < 0 || before.keys.filter(k => k.equals(key)).length !== 1) fail('SIGNER_NOT_REQUIRED');
      if (before.signatures[index].some(b => b !== 0)) fail('SIGNER_ALREADY_SIGNED');
      for (let i = 0; i < before.signatures.length; i++) {
        if (before.signatures[i].some(b => b !== 0) && !validSignature(before.signatures[i], before.message, before.keys[i])) fail('SIGNING_EXISTING_SIGNATURE');
      }
      const request = {type:TYPE, timestampMs:String(now()), organizationId, parameters:{signWith:address, unsignedTransaction:bytes.toString('hex'), type:'TRANSACTION_TYPE_SOLANA'}};
      await journal.reserve({operationId, organizationId, address, messageSha256, expiresAt, requestSha256:hash(JSON.stringify(request)), request:structuredClone(request)});
      // A reservation is intentionally retained on every failure below.
      if (expiresAt <= now()) fail('SIGNING_APPROVAL_EXPIRED');
      let response;
      try { response = await client.signTransaction(request); }
      catch { fail('SIGNING_OUTCOME_UNKNOWN'); }
      const activity = response?.activity;
      if (!activity || activity.organizationId !== organizationId || activity.type !== TYPE || typeof activity.id !== 'string' || !activity.id) fail('SIGNING_RESPONSE_MISMATCH');
      if (journal.observeActivity) await journal.observeActivity({operationId, activityId:activity.id, status:activity.status});
      if (activity.status !== COMPLETED) fail('SIGNING_REQUIRES_RECONCILIATION');
      const hex = activity.result?.signTransactionResult?.signedTransaction;
      if (typeof hex !== 'string' || !/^(?:[a-fA-F0-9]{2})+$/.test(hex) || hex.length > 2464) fail('SIGNING_RESPONSE_INVALID');
      const signed = Buffer.from(hex, 'hex');
      const after = envelope(signed);
      if (!before.message.equals(after.message) || before.signatures.length !== after.signatures.length) fail('SIGNING_MESSAGE_CHANGED');
      for (let i = 0; i < before.signatures.length; i++) {
        if (i !== index && !before.signatures[i].equals(after.signatures[i])) fail('SIGNING_SIGNATURE_CHANGED');
      }
      if (!validSignature(after.signatures[index], after.message, key)) fail('SIGNING_SIGNATURE_INVALID');
      await journal.complete({operationId, activityId:activity.id, organizationId, address, messageSha256, signedTransactionHex:hex.toLowerCase()});
      if (expiresAt <= now()) fail('SIGNING_APPROVAL_EXPIRED');
      return {transaction:Buffer.from(signed), activityId:activity.id, messageSha256};
    }
  });
}
