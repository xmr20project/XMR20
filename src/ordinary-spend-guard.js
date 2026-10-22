// Bundled only into the packaged native worker. Never accepts a page-selected
// journal, network, storage key or signing callback.
import {deriveJournalKey, deriveRecoveryKey} from '../services/native-market/wallet/journal-adapter.mjs';
import {openSignatureJournal} from '../services/native-market/wallet/signature-journal.mjs';
import {openWalletSpendGate} from '../services/native-market/wallet/spend-gate.mjs';
import {inspectTransactionBytes} from '../services/native-market/xn1/transaction-bytes.mjs';
import {Reader} from '../services/native-market/xn1/bytes.mjs';
import {ordinaryPaymentStatus} from './ordinary-payment-status.js';
const GENESIS = '418015bb9ae982a1975da7d79277c2705727a56894ba0fb246adaabb1f4632e3';
const need = (v, message) => { if (!v) throw Error(message); };
function inputImages(transaction) {
  const r = new Reader(Buffer.from(transaction, 'hex'));
  need(r.varint() === 2n, 'RingCT payment required'); r.varint();
  const count = Number(r.varint(1024n)), images = [];
  need(count > 0, 'Payment inputs required');
  for (let i = 0; i < count; i++) {
    need(r.u(1) === 2, 'Ordinary payment input required'); r.varint();
    const ring = Number(r.varint(4096n)); need(ring > 0, 'Payment ring required');
    for (let n = 0; n < ring; n++) r.varint(); images.push(r.hex());
  }
  need(new Set(images).size === images.length, 'Repeated payment input'); return images.sort();
}
export function verifyOrdinaryPayment(value) {
  need(inspectTransactionBytes(value.transaction).txid === value.txid, 'Saved payment hash changed');
  need(JSON.stringify(inputImages(value.transaction)) === JSON.stringify([...value.keyImages].sort()), 'Saved payment inputs changed');
}
export async function createOrdinarySpendGuard(wallet) {
  const scope = {address: await wallet.getPrimaryAddress(), genesis: GENESIS};
  let secret = await wallet.getPrivateSpendKey(), bytes, journal, gate;
  try {
    need(typeof secret === 'string' && /^[a-f0-9]{64}$/.test(secret), 'Private wallet spend protection unavailable');
    bytes = Uint8Array.from(secret.match(/../g), h => parseInt(h, 16)); secret = '';
    const key = await deriveJournalKey(bytes, scope), recoveryKey = await deriveRecoveryKey(bytes, scope);
    journal = await openSignatureJournal({scope, key, recoveryKey});
    gate = await openWalletSpendGate({scope, key, journal});
  } catch (error) { gate?.close(); journal?.close(); throw error; }
  finally { secret = ''; bytes?.fill(0); }
  const frozenHere = new Set();
  return Object.freeze({
    async recoveryStatus() {
      // Payment bytes and input identities stay private to this worker.
      return {payments: await gate.payments(), ...await journal.recoveryMode()};
    },
    async paymentStatus(hash,response,target) {
      const payment=(await gate.payments()).find(row=>row.txid===hash);
      return {...ordinaryPaymentStatus({hash,response,target,saved:!!payment}),...(payment?{payment}:{})};
    },
    async exportRecovery() { return gate.recoverySnapshot(() => journal.exportRecovery()); },
    async importRecovery(bytes) {
      need(bytes instanceof Uint8Array && bytes.length <= 16 * 1024 * 1024 + 64, 'Bounded recovery package required');
      const copy = bytes.slice();
      try { return await gate.recoverySnapshot(() => journal.importRecovery(copy)); }
      finally { copy.fill(0); }
    },
    async freeze(carriers = []) {
      const images = await gate.protectedInputs(), owned = new Set((await wallet.getOutputs({isSpent:false})).map(o => o.getKeyImage()?.getHex()));
      const protectedNow = new Set([...images, ...carriers]);
      for (const image of frozenHere) if (!protectedNow.has(image)) {
        // Only undo a freeze made by this guard, never an existing/manual or
        // native-carrier freeze. Confirmed completion can release unused fees.
        if (owned.has(image)) { await wallet.thawOutput(image); need(!await wallet.isOutputFrozen(image), 'Unused funding could not be restored'); }
        frozenHere.delete(image);
      }
      for (const image of images) if (owned.has(image)) {
        if (!await wallet.isOutputFrozen(image)) { await wallet.freezeOutput(image); frozenHere.add(image); }
        need(await wallet.isOutputFrozen(image), 'Could not protect reserved wallet input');
      }
      return images;
    },
    async relay(tx, review, submit) {
      const value = {txid: tx.getHash(), transaction: tx.getFullHex(), keyImages: tx.getInputs().map(input => input.getKeyImage()?.getHex()),
        to: review.to, amountRaw: review.amountRaw, feeRaw: String(tx.getFee())};
      verifyOrdinaryPayment(value); return gate.submit(value, (transaction, hash) => submit(transaction, hash));
    },
    async reviewRecovery(txid) {
      const value = await gate.recover(txid); verifyOrdinaryPayment(value);
      const {transaction, keyImages, ...review} = value; return {...review, hash: value.txid};
    },
    async relayRecovery(txid, submit) {
      const value = await gate.recover(txid); verifyOrdinaryPayment(value);
      return gate.resubmit(txid, (transaction, hash) => submit(transaction, hash));
    },
    close() { gate.close(); journal.close(); }
  });
}
if (typeof self !== 'undefined') self.XMR20OrdinarySpendGuard = Object.freeze({create: createOrdinarySpendGuard});
