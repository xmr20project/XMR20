// Shared by the installed market signer and ordinary XMR worker in ONE browser
// origin. Web Locks serialize native signature reservations with ordinary relay;
// encrypted, durable records survive an uncertain ordinary broadcast. This does
// not coordinate other devices or recover a deleted/rolled-back browser profile.
import {ordinaryPaymentIntent as intent, MAX_PAYMENT_HEX as MAX_HEX} from './ordinary-payment-journal.mjs';
const enc = new TextEncoder(), dec = new TextDecoder();
const need = (ok, message) => { if (!ok) throw Error(message); };
const hex = bytes => [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (v, keys) => need(v && Object.getPrototypeOf(v) === Object.prototype &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(','), 'Unexpected spend receipt fields');
const MAX_ROWS = 2048;
function openDB(indexedDB, database) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('spends', {keyPath: 'id'});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(Error('Spend protection storage unavailable'));
    request.onblocked = () => reject(Error('Close the older wallet before continuing'));
  });
}
function transaction(db, mode, work) {
  return new Promise((resolve, reject) => {
    let result, failure, tx;
    try {
      tx = db.transaction('spends', mode, {durability: 'strict'});
      if (mode === 'readwrite') need(tx.durability === 'strict', 'Durable spend storage required');
      const fail = error => { failure ??= error; try { tx.abort(); } catch {} };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || Error('Spend storage outcome is unknown; recover the saved payment'));
      tx.onerror = () => {};
      work(tx.objectStore('spends'), value => { result = value; }, fail);
    } catch (error) { try { tx?.abort(); } catch {} reject(error); }
  });
}
export async function openWalletSpendGate({scope, key, journal, crypto = globalThis.crypto,
  indexedDB = globalThis.indexedDB, locks = globalThis.navigator?.locks, range = globalThis.IDBKeyRange,
  database = 'xmr20-native-ordinary-spends-v1', assertActive = () => {}}) {
  exact(scope, ['address', 'genesis']);
  need(digest(scope.genesis) && /^[1-9A-HJ-NP-Za-km-z]{95}$/.test(scope.address), 'Canonical wallet scope required');
  need(key?.type === 'secret' && key.extractable === false && key.algorithm?.name === 'AES-GCM' &&
    key.algorithm.length === 256 && key.usages.includes('encrypt') && key.usages.includes('decrypt'), 'Private spend protection key required');
  need(locks?.request && range?.bound && indexedDB && crypto?.subtle &&
    typeof journal?.lockedInputs === 'function' && typeof journal?.protectedRecipients === 'function' &&
    typeof journal?.recoveryMode === 'function' && typeof journal?.ordinaryPayments === 'function' &&
    typeof journal?.reservePayment === 'function', 'Shared wallet spend protection unavailable');
  need(/^[a-z0-9-]{1,80}$/.test(database), 'Invalid spend database');
  const scopeHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify({address: scope.address, genesis: scope.genesis})))));
  const db = await openDB(indexedDB, database), prefix = scopeHash + ':', lockName = 'xmr20-native-spend-v1:' + scopeHash;
  let closed = false;
  const current = () => { need(!closed, 'Spend protection closed'); assertActive(); };
  const exclusive = fn => { current(); return locks.request(lockName, {mode: 'exclusive'}, async () => { current(); await migrateLegacy(); return fn(); }); };
  const aad = id => enc.encode('XMR20 ordinary relay receipt v1\n' + id);
  async function legacyRows() {
    current();
    const values = await transaction(db, 'readonly', (store, done, fail) => {
      const r = store.getAll(range.bound(prefix, prefix + '\uffff'), MAX_ROWS + 1);
      r.onsuccess = () => done(r.result); r.onerror = () => fail(Error('Spend receipts could not be read'));
    });
    need(values.length <= MAX_ROWS, 'Spend receipt capacity reached; recover existing payments');
    const result = [];
    for (const row of values) {
      exact(row, ['id', 'iv', 'data']);
      need(row.id.startsWith(prefix) && digest(row.id.slice(prefix.length)) && row.iv instanceof Uint8Array && row.iv.length === 12 &&
        row.data instanceof Uint8Array && row.data.length <= MAX_HEX + 100000, 'Invalid encrypted spend receipt');
      let bytes;
      try {
        bytes = new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: row.iv, additionalData: aad(row.id)}, key, row.data));
        const value = intent(JSON.parse(dec.decode(bytes)));
        need(row.id === prefix + value.txid, 'Spend receipt identity changed'); result.push(value);
      } catch { throw Error('Spend receipt authentication failed; wallet spending is protected'); }
      finally { bytes?.fill(0); }
    }
    current(); return result;
  }
  const rows = () => journal.ordinaryPayments();
  async function migrateLegacy() {
    // Earlier UNINSTALLED candidates used another database. Authenticate and
    // retain those immutable receipts before any operation, including backup.
    // A crash between rows resumes exactly; original ciphertext is not deleted.
    const prior = await legacyRows(); if (!prior.length) return;
    const currentRows = new Map((await rows()).map(row => [row.txid, row]));
    for (const value of prior) {
      const existing = currentRows.get(value.txid);
      if (existing) need(JSON.stringify(existing) === JSON.stringify(value), 'Legacy payment differs from saved recovery');
      else { await blockedByMarket(value.keyImages); await journal.reservePayment(value); currentRows.set(value.txid, value); }
    }
    current();
  }
  async function blockedByMarket(images) {
    need(!(await journal.recoveryMode()).recoveryOnly, 'Recovered wallet is read-only; recover the original payment');
    const [inputs, recipients] = await Promise.all([journal.lockedInputs(), journal.protectedRecipients()]);
    current(); const held = new Set([...inputs.filter(v => !v.ordinaryTxid), ...recipients].map(v => v.keyImage));
    need(!images.some(image => held.has(image)), 'Payment conflicts with a reserved market input or token recipient');
  }
  async function reserve(value) {
    // Caller holds the same Web Lock used by every installed market mutation.
    await blockedByMarket(value.keyImages);
    const prior = await rows(), used = new Set(prior.flatMap(row => row.keyImages));
    need(!value.keyImages.some(image => used.has(image)), 'Payment inputs already have a saved relay; recover that exact payment');
    need(prior.length < MAX_ROWS, 'Spend receipt capacity reached');
    current(); await journal.reservePayment(value); current();
  }
  return Object.freeze({
    async market(images, operation) {
      need(Array.isArray(images) && images.every(digest), 'Market input identities required');
      return exclusive(async () => {
        const blocked = new Set((await rows()).flatMap(v => v.keyImages));
        need(!images.some(image => blocked.has(image)), 'Market inputs are reserved by an ordinary XMR payment');
        const value = await operation(); current(); return value;
      });
    },
    async ordinaryInputs() { return exclusive(async () => (await rows()).flatMap(v => v.keyImages.map(keyImage => ({keyImage, ordinaryTxid: v.txid})))); },
    async recoverySnapshot(operation) {
      // Version 2 snapshots atomically include exact ordinary payments and
      // their input locks alongside every market commitment.
      need(typeof operation === 'function', 'Installed recovery operation required');
      return exclusive(async () => {
        const value = await operation(); current(); return value;
      });
    },
    async payments() {
      return exclusive(async () => (await rows()).map(({transaction, keyImages, ...value}) => value));
    },
    async protectedInputs() {
      return exclusive(async () => {
        need(!(await journal.recoveryMode()).recoveryOnly, 'Recovered wallet is read-only');
        const [inputs, recipients, ordinary] = await Promise.all([journal.lockedInputs(), journal.protectedRecipients(), rows()]);
        current(); return [...new Set([...inputs, ...recipients, ...ordinary.flatMap(v => v.keyImages.map(keyImage => ({keyImage})))].map(v => v.keyImage))];
      });
    },
    async submit(value, relay) {
      const pinned = intent(structuredClone(value)); need(typeof relay === 'function', 'Installed relay required');
      return exclusive(async () => { await reserve(pinned); current(); const result = await relay(pinned.transaction, pinned.txid); current(); return result; });
    },
    async recover(txid) {
      need(digest(txid), 'Exact saved transaction required');
      return exclusive(async () => { const value = (await rows()).find(v => v.txid === txid); need(value, 'Saved payment not found'); return value; });
    },
    async resubmit(txid, relay) {
      need(digest(txid) && typeof relay === 'function', 'Exact saved transaction and installed relay required');
      return exclusive(async () => {
        const value = (await rows()).find(v => v.txid === txid); need(value, 'Saved payment not found');
        // A recovery-only profile may relay saved bytes, never make a new spend.
        const [inputs, recipients] = await Promise.all([journal.lockedInputs(), journal.protectedRecipients()]);
        const held = new Set([...inputs.filter(v => v.ordinaryTxid !== txid), ...recipients].map(v => v.keyImage));
        need(!value.keyImages.some(image => held.has(image)), 'Saved payment conflicts with market recovery; manual reconciliation required');
        current(); const result = await relay(value.transaction, value.txid); current(); return result;
      });
    },
    close() { closed = true; db.close(); }
  });
}
