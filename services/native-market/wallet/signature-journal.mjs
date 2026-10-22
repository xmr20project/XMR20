// Private-worker storage. No network, seeds, signing or automatic lock release.
// Native signatures cannot be cancelled by deleting a listing. Reservations
// therefore survive worker termination, tab races and wallet disconnects.
import {createFundingPreparations} from './funding-preparation-journal.mjs';
import {createOrdinaryPaymentJournal} from './ordinary-payment-journal.mjs';
import {RECOVERY_STORES, collectRecoverySnapshot, readRecoverySnapshot, sealRecoverySnapshot, openRecoverySnapshot,
  validateRecoverySnapshot, assertRecoveryAdvance, sameRecoverySnapshot} from './journal-recovery.mjs';
const encoder = new TextEncoder(), decoder = new TextDecoder();
const need = (yes, message) => { if (!yes) throw Error(message); };
const hex = bytes => [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
const hash = async (crypto, bytes) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
const isHash = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const RECOVERY_LIMIT = 128 * 1024, AUTHORIZATION_LIMIT = 16 * 1024;
const copyPayload = (value, limit, label) => {
  need(value instanceof Uint8Array && value.length <= limit, label + ' must be bounded bytes');
  return new Uint8Array(value);
};
const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const exact = (v, keys) => need(v && Object.getPrototypeOf(v) === Object.prototype &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(','), 'Unexpected journal fields');
function scopeValue(scope) {
  exact(scope, ['address', 'genesis']);
  need(isHash(scope.genesis) && /^[1-9A-HJ-NP-Za-km-z]{95}$/.test(scope.address), 'Invalid journal wallet scope');
  return {address: scope.address, genesis: scope.genesis};
}
function approvalValue(input, scope) {
  exact(input, ['signatureHash', 'contextHash', 'keyImages', 'scope', 'offerId', 'checkpoint']);
  const own = scopeValue(input.scope);
  need(own.address === scope.address && own.genesis === scope.genesis, 'Wallet journal scope changed');
  need(isHash(input.signatureHash) && isHash(input.contextHash) && isHash(input.offerId), 'Invalid signing binding');
  exact(input.checkpoint, ['height', 'hash']);
  need(Number.isSafeInteger(input.checkpoint.height) && input.checkpoint.height >= 0 && isHash(input.checkpoint.hash), 'Invalid signing checkpoint');
  need(Array.isArray(input.keyImages) && input.keyImages.length > 0 && input.keyImages.length <= 16 && input.keyImages.every(isHash), 'Invalid signing inputs');
  const keyImages = [...input.keyImages].sort();
  need(new Set(keyImages).size === keyImages.length, 'Duplicate signing inputs');
  return {scope: own, signatureHash: input.signatureHash, contextHash: input.contextHash,
    keyImages, offerId: input.offerId, checkpoint: {...input.checkpoint}};
}

function recipientValue(input, scope) {
  exact(input, ['scope', 'manifest', 'context', 'outputKey', 'keyImage', 'vout', 'quantity']);
  const own = scopeValue(input.scope);
  need(own.address === scope.address && own.genesis === scope.genesis, 'Wallet journal scope changed');
  for (const name of ['manifest', 'context', 'outputKey', 'keyImage']) need(isHash(input[name]), 'Invalid recipient binding');
  need(typeof input.vout === 'string' && /^(0|[1-9][0-9]*)$/.test(input.vout) &&
    input.vout.length <= 5 && BigInt(input.vout) <= 65535n, 'Exact recipient output index required');
  need(typeof input.quantity === 'string' && /^[1-9][0-9]*$/.test(input.quantity) &&
    input.quantity.length <= 20 && BigInt(input.quantity) <= 18446744073709551615n, 'Exact recipient quantity required');
  return {scope: own, manifest: input.manifest, context: input.context, outputKey: input.outputKey,
    keyImage: input.keyImage, vout: input.vout, quantity: input.quantity};
}

// Matches the independent Rust signer's bounded public wire format. This checks
// storage bindings; native signature validity is checked inside the signer.
export function signatureBundleMetadata(value) {
  need(value instanceof Uint8Array, 'Signature bundle bytes required');
  const bytes = new Uint8Array(value);
  need(bytes.length >= 74 && bytes.length <= 9834 && decoder.decode(bytes.subarray(0, 8)) === 'XMSIG01\0', 'Invalid signature bundle');
  const count = bytes[72] | bytes[73] << 8;
  need(count > 0 && count <= 16 && bytes.length === 74 + count * 610, 'Invalid signature bundle length');
  let previous = -1;
  for (let i = 0; i < count; i++) {
    const offset = 74 + i * 610, vin = bytes[offset] | bytes[offset + 1] << 8;
    need(vin > previous, 'Signature inputs must be ordered and unique'); previous = vin;
  }
  return {signatureHash: hex(bytes.subarray(8, 40)), contextHash: hex(bytes.subarray(40, 72)), count};
}

function openDatabase(indexedDB, name) {
  return new Promise((resolve, reject) => {
    let failed = false;
    const request = indexedDB.open(name, 5);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('records')) {
        db.createObjectStore('records', {keyPath: 'id'}).createIndex('inputs', 'inputs', {unique: true, multiEntry: true});
        db.createObjectStore('locks', {keyPath: 'id'});
      }
      if (!db.objectStoreNames.contains('recipients')) db.createObjectStore('recipients', {keyPath: 'id'});
      if (!db.objectStoreNames.contains('preparations')) db.createObjectStore('preparations', {keyPath: 'id'})
        .createIndex('inputs', 'inputs', {unique: true, multiEntry: true});
      if (!db.objectStoreNames.contains('walletState')) db.createObjectStore('walletState', {keyPath: 'id'});
      if (!db.objectStoreNames.contains('ordinaryPayments')) db.createObjectStore('ordinaryPayments', {keyPath: 'id'})
        .createIndex('inputs', 'inputs', {unique: true, multiEntry: true});
    };
    request.onerror = () => reject(Error('Wallet signing storage unavailable'));
    request.onblocked = () => { failed = true; reject(Error('Close the other wallet tab before opening signing storage')); };
    request.onsuccess = () => { if (failed) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
}

// Only IDB operations may run in work(): awaiting crypto inside a transaction
// can auto-commit it before the input locks and signature record are written.
function storageTransaction(db, mode, work, stores = ['records', 'locks']) {
  return new Promise((resolve, reject) => {
    let result, failure, tx;
    try {
      tx = db.transaction(stores, mode, {durability: 'strict'});
      if (mode === 'readwrite') need(tx.durability === 'strict', 'Durable wallet storage is required');
      const fail = error => { failure ??= error; try { tx.abort(); } catch {} };
      const get = (store, key, next) => {
        const request = tx.objectStore(store).get(key);
        request.onsuccess = () => { try { next(request.result); } catch (error) { fail(error); } };
        request.onerror = () => fail(Error('Wallet signing storage could not be read'));
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || Error('Signing storage outcome is unknown; recover the saved trade before retrying'));
      tx.onerror = () => { /* onabort owns the rejection and retains the original cause */ };
      work({tx, get, done: value => { result = value; }});
    } catch (error) { try { tx?.abort(); } catch {} reject(error); }
  });
}

export async function openSignatureJournal({scope, key, crypto = globalThis.crypto,
  indexedDB = globalThis.indexedDB, database = 'xmr20-native-signatures-v1', recoveryKey} = {}) {
  const wallet = scopeValue(scope);
  need(crypto?.subtle && indexedDB && key?.type === 'secret' && key.extractable === false &&
    key.algorithm?.name === 'AES-GCM' && key.algorithm.length === 256 &&
    key.usages.includes('encrypt') && key.usages.includes('decrypt'), 'Private wallet encryption key required');
  need(typeof database === 'string' && /^[a-z0-9-]{1,80}$/.test(database), 'Invalid journal database');
  const scopeHash = await hash(crypto, encoder.encode(JSON.stringify(wallet)));
  const db = await openDatabase(indexedDB, database), leases = new Set();
  let closed = false;
  const active = () => need(!closed, 'Wallet signing journal is closed');
  // Every normal mutation checks this marker in the SAME IDB transaction as
  // its writes. An already-open second worker cannot race a recovery import.
  const transaction = (db, mode, work, stores = ['records', 'locks']) => mode === 'readwrite'
    ? storageTransaction(db, mode, controls => controls.get('walletState', scopeHash, state => {
      need(!state, 'Recovered wallet is read-only; new signatures and releases of reservations are disabled');
      work(controls);
    }), [...new Set([...stores, 'walletState'])])
    : storageTransaction(db, mode, work, stores);
  const recoveryOptions = () => {
    active(); need(recoveryKey?.type === 'secret' && recoveryKey.extractable === false &&
      recoveryKey.algorithm?.name === 'AES-GCM' && recoveryKey.algorithm.length === 256 &&
      recoveryKey.usages.includes('encrypt') && recoveryKey.usages.includes('decrypt'), 'Private recovery encryption key required');
    return {scopeHash, key: recoveryKey, crypto, assertActive: active};
  };
  const aad = (id, digest, kind) => encoder.encode(JSON.stringify(['xmr20-signatures-v1', scopeHash, id, digest, kind]));
  async function encrypt(id, digest, kind, bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: aad(id, digest, kind)}, key, bytes);
    return {iv, data: new Uint8Array(data)};
  }
  async function decrypt(record, kind) {
    const box = record[kind];
    need(record.scopeHash === scopeHash && box?.iv instanceof Uint8Array && box.iv.length === 12 && box.data instanceof Uint8Array, 'Corrupt signing record');
    try { return new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: box.iv,
      additionalData: aad(record.id, record.approvalHash, kind)}, key, box.data)); }
    catch { throw Error('Signing record could not be authenticated; inputs remain reserved'); }
  }
  async function read(id) {
    active(); need(typeof id === 'string' && id.startsWith(scopeHash + ':') && isHash(id.slice(65)), 'Wrong signing journal scope');
    const row = await transaction(db, 'readonly', ({get, done}) => get('records', id, row => {
      need(row?.scopeHash === scopeHash && Array.isArray(row.keyImages) && row.keyImages.length > 0 && row.keyImages.length <= 16, 'Corrupt signing record');
      need(JSON.stringify(row.inputs) === JSON.stringify(row.keyImages.map(image => scopeHash + ':' + image)), 'Signing input index changed');
      let remaining = row.keyImages.length;
      for (const image of row.keyImages) get('locks', scopeHash + ':' + image, lock => {
        need(lock?.recordId === row.id, 'Signing input lock is missing');
        if (--remaining === 0) done(row);
      });
    }));
    need(row && ['reserved', 'signed'].includes(row.state), 'Saved signing record unavailable');
    const bytes = await decrypt(row, 'approval');
    let approval;
    try { approval = approvalValue(JSON.parse(decoder.decode(bytes)), wallet);
      need(await hash(crypto, encoder.encode(JSON.stringify(approval))) === row.approvalHash, 'Signing approval changed'); }
    finally { bytes.fill(0); }
    need(approval.signatureHash === row.signatureHash && approval.contextHash === row.contextHash &&
      JSON.stringify(approval.keyImages) === JSON.stringify(row.keyImages), 'Signing record bindings changed');
    active(); return {row, approval};
  }
  const preparations = createFundingPreparations({db, wallet, scopeHash, active,
    hash: bytes => hash(crypto, bytes), encrypt, decrypt, transaction});
  const payments = createOrdinaryPaymentJournal({db, scopeHash, active,
    hash: bytes => hash(crypto, bytes), encrypt, decrypt, transaction});
  // Reuse all normal cryptographic/relationship checks on an isolated encrypted
  // staging database BEFORE touching the destination. No new signing lease is
  // issued. Staging names are generated here, never supplied by a page.
  async function validateSnapshot(snapshot) {
    validateRecoverySnapshot(snapshot, scopeHash);
    const name = 'xmr20-recovery-stage-' + crypto.randomUUID();
    let staging, validator;
    try {
      staging = await openDatabase(indexedDB, name); active();
      await storageTransaction(staging, 'readwrite', ({tx}) => {
        for (const store of RECOVERY_STORES) for (const row of snapshot.stores[store]) tx.objectStore(store).add(row);
      }, RECOVERY_STORES);
      staging.close(); staging = null;
      validator = await openSignatureJournal({scope: wallet, key, crypto, indexedDB, database: name});
      const inputs = await validator.lockedInputs(), recipients = await validator.protectedRecipients();
      const ordinaryInputs = new Set(inputs.filter(input => input.ordinaryId).map(input => input.keyImage));
      need(!recipients.some(row => ordinaryInputs.has(row.keyImage)), 'Recovery payment conflicts with a token recipient');
      const expectedLocks = new Map(inputs.map(input => [scopeHash + ':' + input.keyImage,
        input.reservationId ?? input.preparationId ?? input.ordinaryId]));
      need(expectedLocks.size === inputs.length && snapshot.stores.locks.length === expectedLocks.size &&
        snapshot.stores.locks.every(row => expectedLocks.get(row.id) === row.recordId), 'Recovery input lock set differs');
      const prepared = new Map();
      for (const row of snapshot.stores.preparations) {
        const receipt = await validator.recoverPreparation(row.id);
        try { prepared.set(row.id, {row, binding: receipt.binding, claims: receipt.claims}); }
        finally { receipt.payload.fill(0); for (const bytes of Object.values(receipt.authorizations)) bytes.fill(0); }
      }
      for (const row of snapshot.stores.records) {
        const receipt = await validator.recover(row.id);
        receipt.bundle?.fill(0); receipt.recoveryContext?.fill(0); receipt.authorization?.fill(0);
        if (Object.hasOwn(row, 'funding')) {
          const bytes = await decrypt(row, 'funding');
          try {
            need(bytes.length <= 1024, 'Recovery funding link exceeds bound');
            const link = JSON.parse(decoder.decode(bytes)); exact(link, ['preparationId', 'approvalHash', 'role']);
            const parent = prepared.get(link.preparationId);
            need(parent?.row.approvalHash === link.approvalHash && parent?.claims[link.role] === row.id,
              'Recovery signature funding parent is missing or changed');
          } finally { bytes.fill(0); }
        }
      }
      for (const {binding} of prepared.values()) if (binding.purpose?.kind==='cancellation-retry') {
        const parent = prepared.get(binding.purpose.parentId);
        need(parent && !parent.binding.purpose && parent.binding.operationId === binding.purpose.conversionId &&
          Object.hasOwn(parent.row, 'cancellation-authorization'), 'Recovery retry parent is missing or changed');
      }
      active();
    } finally {
      validator?.close(); staging?.close();
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = resolve; request.onerror = () => reject(Error('Recovery staging cleanup failed'));
        request.onblocked = () => reject(Error('Recovery staging cleanup blocked'));
      });
    }
  }
  async function reserve(input, permittedRecipients, prepared = null) {
      active(); const approval = approvalValue(input, wallet), bytes = encoder.encode(JSON.stringify(approval));
      if (permittedRecipients !== null) need(Array.isArray(permittedRecipients) &&
        permittedRecipients.every(image => isHash(image) && approval.keyImages.includes(image)), 'Invalid protected-input permission');
      const approvalHash = await hash(crypto, bytes), id = scopeHash + ':' + approvalHash;
      const box = await encrypt(id, approvalHash, 'approval', bytes); bytes.fill(0); active();
      const record = {id, scopeHash, approvalHash, signatureHash: approval.signatureHash,
        contextHash: approval.contextHash, keyImages: approval.keyImages,
        inputs: approval.keyImages.map(image => scopeHash + ':' + image), state: 'reserved', approval: box};
      let preparation;
      if (prepared !== null) {
        exact(prepared, ['preparationId', 'role']);
        preparation = await preparations.read(prepared.preparationId);
        try {
          need(!preparation.completion,'Conversion preparation is complete');
          const part = preparation.binding.funding.find(p => p.role === prepared.role);
          need(part && JSON.stringify(part.keyImages) === JSON.stringify(approval.keyImages), 'Signature must consume the complete reserved funding stage');
          need(preparation.claims.get(prepared.role) === prepared.preparationId, 'Funding stage already claimed; recover its native receipt');
          need(prepared.role === 'recovery' || preparation.binding.operationId === approval.offerId, 'Signature belongs to another conversion');
          const operator=preparation.binding.purpose?.kind==='operator-credit';
          need(!preparation.binding.purpose || operator&&prepared.role==='issuance' ||
            (prepared.role === 'recovery' && preparation.binding.operationId === approval.offerId), 'Signature belongs to another recovery attempt');
          need(prepared.role === 'recovery' || !Object.hasOwn(preparation.row, 'cancellation-authorization'), 'Cancellation already authorized for this conversion');
          const step = operator ? 'custody-authorization' : prepared.role === 'recovery' ? 'cancellation-authorization' : 'holder-authorization';
          need(preparation.row[step]?.data instanceof Uint8Array && preparation.row[step].data.length <= AUTHORIZATION_LIMIT + 16, 'Saved holder authorization required');
          const authorization = await decrypt(preparation.row, step);
          try { need(authorization.length > 0 && authorization.length <= AUTHORIZATION_LIMIT, 'Saved holder authorization required'); }
          finally { authorization.fill(0); }
          const link = encoder.encode(JSON.stringify({preparationId: prepared.preparationId, approvalHash: preparation.row.approvalHash, role: prepared.role}));
          try { record.funding = await encrypt(id, approvalHash, 'funding', link); } finally { link.fill(0); }
        } finally { preparation.payload.fill(0); }
      }
      active();
      await transaction(db, 'readwrite', ({tx, get, done}) => get('records', id, existing => {
        need(!existing, 'Trade already reserved; recover exact saved signatures instead of signing again');
        let remaining = approval.keyImages.length;
        for (const image of approval.keyImages) get('locks', scopeHash + ':' + image, lock => {
          need(preparation ? lock?.recordId === prepared.preparationId : !lock, 'An input is already reserved by another signing attempt');
          const checked = recipient => {
            need(!recipient || permittedRecipients.includes(image), 'Pending token recipient cannot fund an ordinary native send');
            const lookup = tx.objectStore('preparations').index('inputs').get(scopeHash + ':' + image);
            lookup.onsuccess = () => {
              const found = lookup.result;
              if (preparation ? found?.id !== prepared.preparationId || found?.approvalHash !== preparation.row.approvalHash : Boolean(found)) { tx.abort(); return; }
              if (preparation && (found.completion || prepared.role !== 'recovery' && Object.hasOwn(found, 'cancellation-authorization'))) { tx.abort(); return; }
              if (--remaining !== 0) return;
              tx.objectStore('records').add(record);
              for (const input of approval.keyImages) tx.objectStore('locks').put({id: scopeHash + ':' + input, recordId: id});
              done(id);
            };
          };
          if (permittedRecipients !== null) get('recipients', scopeHash + ':' + image, checked); else checked(null);
        });
      }), ['records', 'locks', 'recipients', 'preparations']);
      // Only this uninterrupted worker may finish a new reservation. A restarted
      // worker can retrieve a signed record but cannot regenerate a lost bundle.
      active(); leases.add(id); return {reservationId: id};
    }
  return Object.freeze({
    async recoveryMode() {
      active(); const state = await storageTransaction(db, 'readonly', ({get, done}) => get('walletState', scopeHash, done), ['walletState']);
      active(); return {recoveryOnly: Boolean(state)};
    },
    async exportRecovery() {
      const options = recoveryOptions(), snapshot = await readRecoverySnapshot(db, scopeHash, storageTransaction);
      await validateSnapshot(snapshot); active(); return await sealRecoverySnapshot(snapshot, options);
    },
    async importRecovery(packageBytes) {
      const options = recoveryOptions();
      need(packageBytes instanceof Uint8Array && packageBytes.length <= 16 * 1024 * 1024 + 64, 'Bounded recovery package required');
      const copy = packageBytes.slice();
      try {
      const snapshot = await openRecoverySnapshot(copy, options);
      await validateSnapshot(snapshot); active();
      const packageHash = await hash(crypto, copy); active();
      const before = await storageTransaction(db, 'readonly', ({get, done}) => get('walletState', scopeHash, done), ['walletState']);
      let previous;
      if (before) {
        need(before.recoveryOnly === true && isHash(before.packageHash), 'Invalid recovery state');
        previous = await readRecoverySnapshot(db, scopeHash, storageTransaction);
        await validateSnapshot(previous); active();
        assertRecoveryAdvance(previous, snapshot);
      }
      // Updates are allowed only in an already-quarantined scope. Check both
      // marker and exact rows in the write transaction so competing imports,
      // deletion or a late signature cannot overwrite newer commitments.
      await storageTransaction(db, 'readwrite', ({tx, get, done}) => get('walletState', scopeHash, state => {
        need(before ? state?.recoveryOnly === true && state.packageHash === before.packageHash : !state, 'Recovery changed during import; retry with the latest package');
        collectRecoverySnapshot(tx, scopeHash, current => {
          need(previous ? sameRecoverySnapshot(previous, current) : RECOVERY_STORES.every(name => current.stores[name].length === 0),
            'Wallet commitments changed during recovery import');
          // No old receipt rows are removed. Only authenticated completion can
          // retire an unused preparation lock; signed input holds are forever.
          if (previous) {
            const retained = new Set(snapshot.stores.locks.map(row => row.id));
            for (const row of previous.stores.locks) if (!retained.has(row.id)) tx.objectStore('locks').delete(row.id);
          }
          for (const store of RECOVERY_STORES) for (const row of snapshot.stores[store]) tx.objectStore(store).put(row);
          tx.objectStore('walletState').put({id: scopeHash, recoveryOnly: true, packageHash}); done();
        });
      }), [...RECOVERY_STORES, 'walletState']);
      leases.clear(); active(); return {recoveryOnly: true, records: snapshot.stores.records.length,
        recipients: snapshot.stores.recipients.length, preparations: snapshot.stores.preparations.length,
        ordinaryPayments: snapshot.stores.ordinaryPayments.length};
      } finally { copy.fill(0); }
    },
    reservePayment: value => payments.reserve(value),
    recoverPayment: txid => payments.recover(txid),
    async ordinaryPayments() { return (await payments.list()).map(row => row.value); },
    prepareFunding: value => preparations.prepare(value),
    recoverPreparation: id => preparations.recover(id),
    savePreparationStep: value => preparations.saveStep(value),
    completePreparation: value => preparations.complete(value),
    async listPreparations() {
      const saved = await preparations.list();
      try { active(); return saved.map(p => ({preparationId: p.row.id, operationId: p.binding.operationId})); }
      finally { for (const p of saved) p.payload.fill(0); }
    },
    async reserveRecipient(input) {
      active();
      const binding = recipientValue(input, wallet), encoded = encoder.encode(JSON.stringify(binding));
      const approvalHash = await hash(crypto, encoded), id = scopeHash + ':' + binding.keyImage;
      let box;
      try { box = await encrypt(id, approvalHash, 'recipient', encoded); }
      finally { encoded.fill(0); }
      active();
      const fresh = {id, scopeHash, approvalHash, recipient: box};
      const row = await transaction(db, 'readwrite', ({tx, get, done}) => get('recipients', id, existing => {
        if (existing) {
          need(existing.scopeHash === scopeHash && existing.approvalHash === approvalHash,
            'Recipient output already authorized for another proposal');
          done(existing);
        } else get('locks', id, lock => {
          need(!lock, 'Recipient image is already reserved for a native spend');
          const record = tx.objectStore('records').index('inputs').get(id);
          record.onsuccess = () => {
            if (record.result) { tx.abort(); return; }
            const funding = tx.objectStore('preparations').index('inputs').get(id);
            funding.onsuccess = () => {
              if (funding.result) { tx.abort(); return; }
              tx.objectStore('recipients').add(fresh); done(fresh);
            };
          };
        });
      }), ['recipients', 'locks', 'records', 'preparations']);
      // Authenticate even an apparently identical retry before permitting proof
      // release. A saved public hash alone is not an authorization receipt.
      const restored = await decrypt(row, 'recipient');
      try {
        const prior = recipientValue(JSON.parse(decoder.decode(restored)), wallet);
        need(row.id === id && await hash(crypto, encoder.encode(JSON.stringify(prior))) === approvalHash &&
          JSON.stringify(prior) === JSON.stringify(binding), 'Recipient authorization changed');
        active(); return {authorizationId: id};
      } finally { restored.fill(0); }
    },
    // Low-level core API retained for independently authorized token fixtures.
    // Installed wallet workers must use reserveProtected instead.
    reserve: input => reserve(input, null),
    reserveOrdinary: input => reserve(input, []),
    reserveProtected: (input, authorizedTokenImages = []) => reserve(input, [...authorizedTokenImages]),
    reservePrepared: (input, prepared) => reserve(input, [], prepared),
    async commit({reservationId, bundle, recoveryContext}) {
      active(); need(leases.delete(reservationId), 'No active signing reservation; recover the saved trade');
      const bytes = new Uint8Array(bundle); let recovery;
      try {
        if (recoveryContext !== undefined) recovery = copyPayload(recoveryContext, RECOVERY_LIMIT, 'Recovery context');
        const metadata = signatureBundleMetadata(bytes), {row} = await read(reservationId);
        need(row.state === 'reserved' && metadata.signatureHash === row.signatureHash && metadata.contextHash === row.contextHash && metadata.count === row.keyImages.length, 'Signature bundle differs from reserved approval');
        const box = await encrypt(row.id, row.approvalHash, 'bundle', bytes);
        const context = recovery === undefined ? undefined : await encrypt(row.id, row.approvalHash, 'recovery', recovery);
        active();
        await transaction(db, 'readwrite', ({tx, get}) => get('records', row.id, current => {
          need(current?.state === 'reserved' && current.approvalHash === row.approvalHash, 'Signing reservation changed');
          let remaining = row.keyImages.length;
          for (const image of row.keyImages) get('locks', scopeHash + ':' + image, lock => {
            need(lock?.recordId === row.id, 'Signing input lock is missing');
            if (--remaining === 0) tx.objectStore('records').put({...current, state: 'signed', bundle: box,
              ...(context === undefined ? {} : {recovery: context})});
          });
        }));
        active();
      } finally { bytes.fill(0); recovery?.fill(0); }
    },
    async cacheAuthorization({reservationId, authorization}) {
      active(); const bytes = copyPayload(authorization, AUTHORIZATION_LIMIT, 'Release authorization'); let restored;
      try {
        const {row} = await read(reservationId);
        need(row.state === 'signed', 'Release authorization requires a signed receipt');
        const signed = await decrypt(row, 'bundle');
        try {
          const metadata = signatureBundleMetadata(signed);
          need(metadata.signatureHash === row.signatureHash && metadata.contextHash === row.contextHash && metadata.count === row.keyImages.length, 'Stored signature bundle binding differs');
        } finally { signed.fill(0); }
        const box = await encrypt(row.id, row.approvalHash, 'release', bytes); active();
        const saved = await transaction(db, 'readwrite', ({tx, get, done}) => get('records', row.id, current => {
          need(current?.state === 'signed' && current.approvalHash === row.approvalHash, 'Signed receipt changed');
          let remaining = row.keyImages.length;
          for (const image of row.keyImages) get('locks', scopeHash + ':' + image, lock => {
            need(lock?.recordId === row.id, 'Signing input lock is missing');
            if (--remaining !== 0) return;
            // The first committed value wins, including against another worker.
            // Existing ciphertext is always authenticated below before retry.
            if (Object.hasOwn(current, 'release')) done(current);
            else { const next = {...current, release: box}; tx.objectStore('records').put(next); done(next); }
          });
        }));
        need(saved.release?.data instanceof Uint8Array && saved.release.data.length <= AUTHORIZATION_LIMIT + 16, 'Corrupt release authorization');
        restored = await decrypt(saved, 'release');
        need(sameBytes(restored, bytes), 'Release authorization is immutable');
        active(); return {reservationId};
      } finally { bytes.fill(0); restored?.fill(0); }
    },
    async recover(reservationId) {
      const {row, approval} = await read(reservationId);
      if (row.state === 'reserved') return {state: 'reserved', reservationId, approval, bundle: null, recoveryContext: null, authorization: null};
      const bytes = await decrypt(row, 'bundle');
      let recoveryContext = null, authorization = null;
      try {
        const metadata = signatureBundleMetadata(bytes);
        need(metadata.signatureHash === row.signatureHash && metadata.contextHash === row.contextHash && metadata.count === row.keyImages.length, 'Stored signature bundle binding differs');
        if (Object.hasOwn(row, 'recovery')) {
          need(row.recovery?.data instanceof Uint8Array && row.recovery.data.length <= RECOVERY_LIMIT + 16, 'Corrupt recovery context');
          recoveryContext = await decrypt(row, 'recovery');
        }
        if (Object.hasOwn(row, 'release')) {
          need(row.release?.data instanceof Uint8Array && row.release.data.length <= AUTHORIZATION_LIMIT + 16, 'Corrupt release authorization');
          authorization = await decrypt(row, 'release');
        }
        active(); return {state: 'signed', reservationId, approval, bundle: bytes, recoveryContext, authorization};
      } catch (error) { bytes.fill(0); recoveryContext?.fill(0); authorization?.fill(0); throw error; }
    },
    async lockedInputs() {
      active();
      const ids = await transaction(db, 'readonly', ({tx, done}) => {
        const found = [], request = tx.objectStore('locks').openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { done(found); return; }
          if (typeof cursor.key === 'string' && cursor.key.startsWith(scopeHash + ':')) found.push(cursor.value.recordId);
          cursor.continue();
        };
      });
      const records = await transaction(db, 'readonly', ({tx, done}) => {
        const found = [], request = tx.objectStore('records').openCursor();
        request.onsuccess = () => {
          const cursor = request.result; if (!cursor) { done(found); return; }
          // Wallet scope is encoded in the primary key. A damaged public
          // scopeHash must not hide a released signature if its lock row was
          // also lost. read() authenticates the selected record below.
          if (typeof cursor.key === 'string' && cursor.key.startsWith(scopeHash + ':')) found.push(cursor.key);
          cursor.continue();
        };
      });
      // Enumerate records, not just lock rows: a missing lock must never turn a
      // released signature's input into ordinary-spend funding.
      const prepared = await preparations.list();
      const preparationIds = prepared.map(p => p.row.id);
      const inputs = [];
      try {
        const ordinary = await payments.list(), ordinaryIds = ordinary.map(p => p.row.id);
        need(ids.every(id => records.includes(id) || preparationIds.includes(id) || ordinaryIds.includes(id)), 'Orphaned wallet input lock');
        for (const saved of ordinary) for (const keyImage of saved.value.keyImages)
          inputs.push({keyImage, ordinaryTxid: saved.value.txid, ordinaryId: saved.row.id});
        for (const id of records) {
          const {approval} = await read(id);
          for (const image of approval.keyImages) inputs.push({keyImage: image, reservationId: id});
        }
        for (const saved of prepared) for (const part of saved.binding.funding) if (saved.claims.get(part.role) === saved.row.id)
          for (const keyImage of part.keyImages) inputs.push({keyImage, reservationId: null, preparationId: saved.row.id, role: part.role});
      } finally { for (const saved of prepared) saved.payload.fill(0); }
      active(); return inputs;
    },
    async protectedRecipients() {
      active();
      const rows = await transaction(db, 'readonly', ({tx, done}) => {
        const found = [], request = tx.objectStore('recipients').openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { done(found); return; }
          // Scope is also in the primary key. A corrupt scopeHash cannot make
          // an existing receiving reservation disappear from coin protection.
          if (typeof cursor.key === 'string' && cursor.key.startsWith(scopeHash + ':')) found.push(cursor.value);
          cursor.continue();
        };
      }, ['recipients']);
      const recipients = [];
      for (const row of rows) {
        const bytes = await decrypt(row, 'recipient');
        try {
          const binding = recipientValue(JSON.parse(decoder.decode(bytes)), wallet);
          need(row.id === scopeHash + ':' + binding.keyImage &&
            await hash(crypto, encoder.encode(JSON.stringify(binding))) === row.approvalHash,
            'Recipient protection binding changed');
          recipients.push({...binding, authorizationId: row.id});
        } finally { bytes.fill(0); }
      }
      active(); return recipients;
    },
    close() { closed = true; leases.clear(); db.close(); }
  });
}
