// Private-worker recovery packages. Ciphertext is portable; keys and decrypted
// receipts are not. First import requires an EMPTY wallet scope; later imports
// may only advance its authenticated receipts. The scope stays recovery-only.
// A backup is not proof of the latest commitment.
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', {fatal: true});
const MAGIC = enc.encode('XMR20RECOVERY02\0'), LEGACY_MAGIC = enc.encode('XMR20RECOVERY01\0');
const LIMIT = 16 * 1024 * 1024, MAX_ROWS = 4096;
export const RECOVERY_STORES = Object.freeze(['records', 'locks', 'recipients', 'preparations', 'ordinaryPayments']);
const need = (ok, message) => { if (!ok) throw Error(message); };
const hex = b => Array.from(b, n => n.toString(16).padStart(2, '0')).join('');
const canonicalHex = s => typeof s === 'string' && /^(?:[0-9a-f]{2})*$/.test(s);
const aad = (scopeHash, legacy = false) => enc.encode(JSON.stringify([legacy ? 'xmr20-native-recovery-v1' : 'xmr20-native-recovery-v2', scopeHash]));

export function validateRecoverySnapshot(value, scopeHash) {
  need(value?.schema === 'xmr20-native-recovery-v2' && value.scopeHash === scopeHash &&
    Object.keys(value).sort().join(',') === 'schema,scopeHash,stores', 'Wrong recovery wallet or schema');
  need(value.stores && Object.keys(value.stores).sort().join(',') === [...RECOVERY_STORES].sort().join(','), 'Incomplete recovery stores');
  let count = 0;
  for (const name of RECOVERY_STORES) {
    const rows = value.stores[name], ids = new Set();
    need(Array.isArray(rows), 'Invalid recovery rows'); count += rows.length;
    need(count <= MAX_ROWS, 'Recovery package exceeds row limit');
    for (const row of rows) {
      need(row && Object.getPrototypeOf(row) === Object.prototype && typeof row.id === 'string' &&
        row.id.startsWith(scopeHash + ':') && !ids.has(row.id), 'Foreign or duplicate recovery record');
      if (name !== 'locks') need(row.scopeHash === scopeHash, 'Recovery record scope changed');
      ids.add(row.id);
    }
  }
  need(count > 0, 'No saved commitments to recover');
  return value;
}

export async function sealRecoverySnapshot(value, {scopeHash, key, crypto, assertActive}) {
  validateRecoverySnapshot(value, scopeHash);
  const text = JSON.stringify(value, (_, value) => value instanceof Uint8Array ? {$bytes: hex(value)} : value);
  need(text.length <= LIMIT, 'Recovery package exceeds byte limit');
  const bytes = enc.encode(text);
  try {
    need(bytes.length <= LIMIT, 'Recovery package exceeds byte limit'); assertActive();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: aad(scopeHash)}, key, bytes));
    assertActive(); const result = new Uint8Array(MAGIC.length + iv.length + cipher.length);
    result.set(MAGIC); result.set(iv, MAGIC.length); result.set(cipher, MAGIC.length + iv.length);
    return result;
  } finally { bytes.fill(0); }
}

export async function openRecoverySnapshot(packageBytes, {scopeHash, key, crypto, assertActive}) {
  const legacy = packageBytes instanceof Uint8Array && LEGACY_MAGIC.every((byte, i) => packageBytes[i] === byte);
  need(packageBytes instanceof Uint8Array && packageBytes.length > MAGIC.length + 28 &&
    packageBytes.length <= LIMIT + MAGIC.length + 28 && (legacy || MAGIC.every((byte, i) => packageBytes[i] === byte)), 'Invalid recovery package');
  const copy = packageBytes.slice(); let bytes;
  try {
    assertActive();
    try { bytes = new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM',
      iv: copy.subarray(MAGIC.length, MAGIC.length + 12), additionalData: aad(scopeHash, legacy)}, key, copy.subarray(MAGIC.length + 12))); }
    catch { throw Error('Recovery package could not be authenticated for this wallet'); }
    assertActive();
    const value = JSON.parse(dec.decode(bytes), (name, value) => {
      need(!['__proto__', 'constructor', 'prototype'].includes(name), 'Invalid recovery property');
      if (value && typeof value === 'object' && Object.hasOwn(value, '$bytes')) {
        need(Object.keys(value).length === 1 && canonicalHex(value.$bytes) && value.$bytes.length <= 2 * (2 * 1024 * 1024 + 100000), 'Invalid recovery bytes');
        return Uint8Array.from(value.$bytes.match(/../g) ?? [], b => parseInt(b, 16));
      }
      return value;
    });
    if (legacy) {
      need(value?.schema === 'xmr20-native-recovery-v1' && value.stores &&
        Object.keys(value.stores).sort().join(',') === 'locks,preparations,recipients,records', 'Invalid legacy recovery stores');
      value.schema = 'xmr20-native-recovery-v2'; value.stores.ordinaryPayments = [];
    }
    return validateRecoverySnapshot(value, scopeHash);
  } finally { bytes?.fill(0); copy.fill(0); }
}

// Capture all stores in one transaction. Prefix selection also includes
// rows whose scopeHash was corrupted, so damage cannot disappear from export.
export function collectRecoverySnapshot(tx, scopeHash, done) {
    const stores = {}; let remaining = RECOVERY_STORES.length, total = 0, size = 0;
    for (const name of RECOVERY_STORES) {
      const rows = stores[name] = [], request = tx.objectStore(name).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          if (--remaining === 0) {
            try { done({schema: 'xmr20-native-recovery-v2', scopeHash, stores}); }
            catch { tx.abort(); }
          }
          return;
        }
        if (typeof cursor.key === 'string' && cursor.key.startsWith(scopeHash + ':')) {
          try {
            // Bound collection before retaining thousands of large receipts.
            const text = JSON.stringify(cursor.value, (_, v) => v instanceof Uint8Array ? {$bytes: hex(v)} : v);
            size += enc.encode(text).length;
            if (++total > MAX_ROWS || size > LIMIT) { tx.abort(); return; } rows.push(cursor.value);
          } catch { tx.abort(); return; }
        }
        cursor.continue();
      };
    }
}

export function readRecoverySnapshot(db, scopeHash, transaction) {
  return transaction(db, 'readonly', ({tx, done}) => collectRecoverySnapshot(tx, scopeHash, done), RECOVERY_STORES);
}

// Compare actual encrypted rows, not just counts or mutable revision metadata.
// Normal journal mutations preserve existing ciphertext bytes. Re-encryption
// is deliberately not a supported migration because it obscures immutability.
export function recoveryValue(value) {
  if (value instanceof Uint8Array) return {$bytes: hex(value)};
  if (Array.isArray(value)) return value.map(recoveryValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, recoveryValue(value[k])]));
  return value;
}
const equal = (a, b) => JSON.stringify(recoveryValue(a)) === JSON.stringify(recoveryValue(b));
export const sameRecoverySnapshot = (a, b) => equal(a, b);

// BOTH snapshots must also pass the journal's cryptographic and relational
// validator. This is only the monotonic transition check. No union of forks:
// the incoming package must contain every prior irreversible commitment.
export function assertRecoveryAdvance(previous, next) {
  validateRecoverySnapshot(previous, previous.scopeHash);
  validateRecoverySnapshot(next, previous.scopeHash);
  for (const name of ['records', 'recipients', 'preparations', 'ordinaryPayments']) {
    const rows = new Map(next.stores[name].map(row => [row.id, row]));
    for (const old of previous.stores[name]) {
      const row = rows.get(old.id); need(row, 'Recovery update omitted an existing commitment');
      for (const key of Object.keys(old)) {
        if (name === 'records' && key === 'state') {
          need(row.state === old.state || old.state === 'reserved' && row.state === 'signed', 'Recovery signature state regressed');
        } else if (name === 'preparations' && key === 'inputs' && !old.completion && row.completion) {
          // The full incoming snapshot authenticates the canonical completion
          // and verifies every retained signature and released unused stage.
          need(row.inputs.every(input => old.inputs.includes(input)), 'Recovery completion added funding');
        } else need(Object.hasOwn(row, key) && equal(old[key], row[key]), 'Recovery update changed an immutable receipt');
      }
    }
  }
  const locks = new Map(next.stores.locks.map(row => [row.id, row]));
  const oldPreparations = new Map(previous.stores.preparations.map(row => [row.id, row]));
  const newPreparations = new Map(next.stores.preparations.map(row => [row.id, row]));
  for (const old of previous.stores.locks) {
    const row = locks.get(old.id);
    if (row && equal(old, row)) continue;
    // A prepared input can be claimed exactly once, or released by a verified
    // completion. A native signing reservation can NEVER disappear or move.
    const prior = oldPreparations.get(old.recordId), after = newPreparations.get(old.recordId);
    need(prior && after, 'Recovery update removed or reassigned a signature lock');
    if (!row) need(!prior.completion && after.completion && !after.inputs.includes(old.id), 'Recovery update removed a funding lock');
    else need(next.stores.records.some(record => record.id === row.recordId && record.inputs.includes(old.id)), 'Recovery funding has no signature claim');
  }
}
