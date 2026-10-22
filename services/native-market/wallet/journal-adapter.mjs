// Installed by the private wallet worker, never from page/relay-supplied hooks.
import {openSignatureJournal} from './signature-journal.mjs';
import {openWalletSpendGate} from './spend-gate.mjs';
const encoder = new TextEncoder();
const need = (yes, message) => { if (!yes) throw Error(message); };
const scrubReceipt = value => {
  for (const field of ['bundle', 'recoveryContext', 'authorization', 'payload']) {
    if (value?.[field] instanceof Uint8Array) value[field].fill(0);
  }
  for (const bytes of Object.values(value?.authorizations ?? {})) bytes?.fill?.(0);
};
export function nativeWalletScope({genesis, address}) {
  need(typeof genesis === 'string' && /^[0-9a-f]{64}$/.test(genesis) &&
    typeof address === 'string' && /^[1-9A-HJ-NP-Za-km-z]{95}$/.test(address), 'Canonical wallet identity required');
  return JSON.stringify(['xmr20-native-wallet-v1', genesis, address]);
}

// Use only inside the unlocked private worker. The original wallet secret never
// leaves the worker; only a nonextractable purpose-specific key is returned.
// Re-unlocking the same wallet recreates this key after a browser restart.
export async function deriveJournalKey(privateSpendBytes, scope, crypto = globalThis.crypto) {
  return deriveStorageKey(privateSpendBytes, scope, 'XMR20 native signature receipts AES-GCM v1', crypto);
}
export async function deriveRecoveryKey(privateSpendBytes, scope, crypto = globalThis.crypto) {
  return deriveStorageKey(privateSpendBytes, scope, 'XMR20 native portable recovery AES-GCM v1', crypto);
}
async function deriveStorageKey(privateSpendBytes, scope, domain, crypto) {
  need(privateSpendBytes instanceof Uint8Array && privateSpendBytes.length === 32 &&
    privateSpendBytes.some(byte => byte !== 0), 'Private wallet material required');
  const identity = nativeWalletScope(scope), bytes = new Uint8Array(privateSpendBytes);
  try {
    const material = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256',
      salt: await crypto.subtle.digest('SHA-256', encoder.encode(identity)),
      info: encoder.encode(domain)}, material,
      {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
  } finally { bytes.fill(0); }
}

export async function openNativeWalletJournal({scope, privateSpendBytes, crypto = globalThis.crypto,
  indexedDB = globalThis.indexedDB, assertActive = () => {}, guardSigningInputs = () => ({authorizedTokenImages: []})}) {
  // The production database name and primary-wallet scope cannot be chosen by
  // a trade request. Different Solana logins linked to this wallet share locks.
  const identity = nativeWalletScope(scope), pinned = Object.freeze({...scope});
  assertActive();
  const key = await deriveJournalKey(privateSpendBytes, pinned, crypto);
  const recoveryKey = await deriveRecoveryKey(privateSpendBytes, pinned, crypto);
  assertActive();
  const journal = await openSignatureJournal({scope: pinned, key, recoveryKey, crypto, indexedDB});
  let gate;
  try { gate = await openWalletSpendGate({scope: pinned, key, journal, crypto, indexedDB, assertActive}); }
  catch (error) { journal.close(); throw error; }
  let closed = false;
  const current = () => { need(!closed, 'Wallet signer closed'); assertActive(); };
  const hooks = Object.freeze({
    async reserveRecipient(request) {
      current(); need(request?.scope === identity, 'Signer wallet identity changed');
      const result = await gate.market([request.keyImage], () => journal.reserveRecipient({...request, scope: pinned}));
      current(); return result;
    },
    async reserve(request) {
      current(); need(request?.scope === identity, 'Signer wallet identity changed');
      const height = request.checkpoint?.height;
      need(typeof height === 'string' && /^(0|[1-9][0-9]*)$/.test(height) && BigInt(height) <= BigInt(Number.MAX_SAFE_INTEGER), 'Exact signer checkpoint required');
      // This callback belongs to the fixed private worker policy, never a page
      // message. Recipient protection is checked again atomically with locks.
      const permission = guardSigningInputs(structuredClone(request));
      need(permission && Array.isArray(permission.authorizedTokenImages), 'Trusted input authorization required');
      const approval = {...request, scope: pinned, checkpoint: {height: Number(height), hash: request.checkpoint.blockHash}};
      need(!permission.prepared || permission.authorizedTokenImages.length === 0, 'Conversion funding cannot consume token inputs');
      const result = await gate.market(approval.keyImages, () => permission.prepared ? journal.reservePrepared(approval, permission.prepared) :
        journal.reserveProtected(approval, permission.authorizedTokenImages));
      current(); return result;
    },
    async commit(request) {
      try { current(); await journal.commit(request); current(); }
      catch (error) { scrubReceipt(request); throw error; }
    }
  });
  try { current(); } catch (error) { gate.close(); journal.close(); throw error; }
  return Object.freeze({scope: identity, hooks,
    async recoveryMode() { current(); const value = await journal.recoveryMode(); current(); return value; },
    async exportRecovery() { current(); const value = await gate.recoverySnapshot(() => journal.exportRecovery()); current(); return value; },
    async importRecovery(bytes) { current(); const value = await gate.recoverySnapshot(() => journal.importRecovery(bytes)); current(); return value; },
    async prepareFunding(value) { current(); const result = await gate.market(value?.funding?.flatMap(part => part.keyImages), () => journal.prepareFunding(value)); current(); return result; },
    async recoverPreparation(id) {
      current(); const result = await journal.recoverPreparation(id);
      try { current(); return result; } catch (error) { scrubReceipt(result); throw error; }
    },
    async savePreparationStep(value) { current(); await journal.savePreparationStep(value); current(); },
    async completePreparation(value) { current(); const result=await journal.completePreparation(value);current();return result; },
    async listPreparations() { current(); const result = await journal.listPreparations(); current(); return result; },
    async recover(id) {
      current(); const receipt = await journal.recover(id);
      try { current(); return receipt; } catch (error) { scrubReceipt(receipt); throw error; }
    },
    // Only the private runtime may validate and cache a typed release proof.
    // This is not a page-visible operation or a caller-supplied signing hook.
    async cacheAuthorization(request) {
      try { current(); const result = await journal.cacheAuthorization(request); current(); return result; }
      catch (error) { scrubReceipt(request); throw error; }
    },
    async lockedInputs() { current(); await gate.ordinaryInputs(); const rows = await journal.lockedInputs(); current(); return rows; },
    async protectedRecipients() { current(); const rows = await journal.protectedRecipients(); current(); return rows; },
    close() { closed = true; gate.close(); journal.close(); }
  });
}
