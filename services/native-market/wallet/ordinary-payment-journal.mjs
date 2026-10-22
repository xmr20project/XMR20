// Exact signed payments share the market journal's strict transaction, input
// locks and portable recovery snapshot. This module never signs or broadcasts.
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', {fatal: true});
const need = (v, message) => { if (!v) throw Error(message); };
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const exact = (v, keys) => need(v && Object.getPrototypeOf(v) === Object.prototype &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(','), 'Unexpected spend receipt fields');
export const MAX_PAYMENT_HEX = 2 * 1024 * 1024;
const MAX_ROWS = 2048;
export function ordinaryPaymentIntent(value) {
  exact(value, ['txid', 'transaction', 'keyImages', 'to', 'amountRaw', 'feeRaw']);
  need(digest(value.txid) && typeof value.transaction === 'string' && value.transaction.length > 0 &&
    value.transaction.length <= MAX_PAYMENT_HEX && /^(?:[a-f0-9]{2})+$/.test(value.transaction), 'Bounded signed transaction required');
  need(Array.isArray(value.keyImages) && value.keyImages.length > 0 && value.keyImages.length <= 1024 &&
    value.keyImages.every(digest) && new Set(value.keyImages).size === value.keyImages.length, 'Exact spend inputs required');
  // Address/checksum and signed destinations are verified by the wallet before
  // reservation. Preserve standard, subaddress and integrated mainnet forms.
  need(typeof value.to === 'string' && /^(?:[48][1-9A-HJ-NP-Za-km-z]{94}|4[1-9A-HJ-NP-Za-km-z]{105})$/.test(value.to), 'Mainnet recipient required');
  for (const field of ['amountRaw', 'feeRaw']) need(typeof value[field] === 'string' && /^[1-9][0-9]{0,19}$/.test(value[field]) &&
    BigInt(value[field]) <= 0xffffffffffffffffn, 'Exact spend amount required');
  return {...value, keyImages: [...value.keyImages].sort()};
}
export function createOrdinaryPaymentJournal({db, scopeHash, active, hash, encrypt, decrypt, transaction}) {
  const identifier = txid => { need(digest(txid), 'Exact saved transaction required'); return scopeHash + ':ordinary:' + txid; };
  async function read(row) {
    exact(row, ['id', 'scopeHash', 'approvalHash', 'inputs', 'payment']);
    need(row.scopeHash === scopeHash && row.payment?.data instanceof Uint8Array &&
      row.payment.data.length <= MAX_PAYMENT_HEX + 100000, 'Invalid encrypted payment');
    const bytes = await decrypt(row, 'payment');
    let value;
    try {
      value = ordinaryPaymentIntent(JSON.parse(dec.decode(bytes)));
      need(row.id === identifier(value.txid) && await hash(enc.encode(JSON.stringify(value))) === row.approvalHash &&
        JSON.stringify(row.inputs) === JSON.stringify(value.keyImages.map(image => scopeHash + ':' + image)), 'Saved payment bindings changed');
    } finally { bytes.fill(0); }
    await transaction(db, 'readonly', ({get, done}) => {
      let left = row.inputs.length;
      for (const input of row.inputs) get('locks', input, lock => {
        need(lock?.recordId === row.id, 'Saved payment input lock is missing'); if (--left === 0) done();
      });
    }, ['locks']);
    active(); return {row, value};
  }
  async function list() {
    active();
    const rows = await transaction(db, 'readonly', ({tx, done}) => {
      const found = [], r = tx.objectStore('ordinaryPayments').openCursor();
      r.onsuccess = () => {
        const c = r.result; if (!c) { done(found); return; }
        if (typeof c.key === 'string' && c.key.startsWith(scopeHash + ':')) {
          if (found.length >= MAX_ROWS) { tx.abort(); return; } found.push(c.value);
        }
        c.continue();
      };
    }, ['ordinaryPayments']);
    const result = []; for (const row of rows) result.push(await read(row)); return result;
  }
  return Object.freeze({list,
    async recover(txid) {
      const row = await transaction(db, 'readonly', ({get, done}) => get('ordinaryPayments', identifier(txid), done), ['ordinaryPayments']);
      need(row, 'Saved payment not found'); return (await read(row)).value;
    },
    async reserve(input) {
      active(); const value = ordinaryPaymentIntent(structuredClone(input)), bytes = enc.encode(JSON.stringify(value));
      const id = identifier(value.txid), inputs = value.keyImages.map(image => scopeHash + ':' + image);
      let approvalHash, payment;
      try { approvalHash = await hash(bytes); payment = await encrypt(id, approvalHash, 'payment', bytes); }
      finally { bytes.fill(0); }
      const row = {id, scopeHash, approvalHash, inputs, payment}; active();
      await transaction(db, 'readwrite', ({tx, get, done}) => {
        // Capacity and all claims are checked within the same commit as the
        // receipt and holds; recovery import cannot race this mutation.
        let count = 0; const scan = tx.objectStore('ordinaryPayments').openCursor();
        scan.onsuccess = () => {
          const c = scan.result;
          if (c) { if (typeof c.key === 'string' && c.key.startsWith(scopeHash + ':') && ++count >= MAX_ROWS) { tx.abort(); return; } c.continue(); return; }
          get('ordinaryPayments', id, existing => {
            need(!existing, 'Payment already saved; recover its exact transaction'); let left = inputs.length;
            for (const image of inputs) get('locks', image, lock => {
              need(!lock, 'Payment input is already reserved'); get('recipients', image, recipient => {
                need(!recipient, 'Payment conflicts with a token recipient');
                // A damaged lock must not permit another payment to claim an
                // input still named by an immutable signature or preparation.
                let checked = 3;
                for (const store of ['records', 'preparations', 'ordinaryPayments']) {
                  const claim = tx.objectStore(store).index('inputs').getKey(image);
                  claim.onsuccess = () => {
                    if (claim.result !== undefined) { tx.abort(); return; }
                    if (--checked === 0 && --left === 0) {
                      tx.objectStore('ordinaryPayments').add(row);
                      for (const image of inputs) tx.objectStore('locks').add({id: image, recordId: id}); done();
                    }
                  };
                }
              });
            });
          });
        };
      }, ['ordinaryPayments', 'locks', 'recipients', 'records', 'preparations']);
      active(); return value;
    }
  });
}
