// Abstract fork-boundary model. No wallet, native cryptography, PoW, or network.
// This complements the genuine-proof ordering and native-daemon tests; it does
// not establish a safe confirmation threshold or production atomicity.
import assert from 'node:assert/strict';
import {test} from 'node:test';

const ORIGIN_HEIGHT = 2, RESERVATION_HEIGHT = 5, RELEASE_HEIGHT = 14;
const LOT = 1000, PRICE = 100;
const OLD_FUND = 'buyer-output-existing-before-token-origin';
const CHILD_FUND = 'same-native-output-created-by-either-reservation-carrier';
const GUARD = 'buyer-native-key-image';

function fresh() {
  return {origin: false, owner: null, spent: false, offer: null,
    nativeImages: new Set(), nativeOutputs: new Set([OLD_FUND]),
    paid: 0, acceptedNative: [], rejectedNative: [], admissions: []};
}
function admitReservation(s, inline) {
  if (inline && s.offer === 'locked') return true;
  if (s.nativeImages.has(GUARD) || s.offer !== null || !s.origin || s.spent) return false;
  s.spent = true;
  s.owner = 'locked';
  s.offer = 'locked';
  return true;
}
function apply(s, event, funding = OLD_FUND) {
  if (event === 'empty') return;
  if (event === 'origin') {
    assert.equal(s.origin, false);
    s.origin = true;
    s.owner = 'seller';
    return;
  }
  const image = event === 'reservation' || event === 'replacement-carrier'
    ? 'reservation-carrier-input'
    : event === 'conflict' ? 'competing-transfer-carrier-input' : GUARD;
  if (s.nativeImages.has(image) ||
      ((event === 'purchase' || event === 'cancel') && !s.nativeOutputs.has(funding))) {
    s.rejectedNative.push(event);
    return;
  }
  s.acceptedNative.push(event);
  if (event === 'reservation' || event === 'replacement-carrier') {
    // Native consensus permits the same output key in a replacement carrier
    // whose application bytes are invalid. The preserved real daemon ancestry
    // experiment, not this model, establishes that native behavior.
    s.nativeOutputs.add(CHILD_FUND);
  }
  let admitted = null;
  if (event === 'reservation') admitted = admitReservation(s, false);
  if (event === 'replacement-carrier') admitted = false;
  if (event === 'conflict') {
    admitted = s.origin && !s.spent;
    if (admitted) { s.spent = true; s.owner = 'unrelated-recipient'; }
  }
  if (event === 'purchase') {
    s.paid += PRICE;
    admitted = admitReservation(s, true);
  }
  if (admitted !== null) s.admissions.push({event, admitted});
  if (image === GUARD && s.offer === 'locked') {
    s.offer = event === 'purchase' ? 'sold' : 'refunded';
    s.owner = event === 'purchase' ? 'buyer' : 'seller';
  }
  s.nativeImages.add(image);
}
function acceptedPrefix(cut, funding = OLD_FUND) {
  assert(cut >= 0 && cut <= RELEASE_HEIGHT);
  const s = fresh();
  for (let height = 1; height <= cut; height++) {
    apply(s, height === ORIGIN_HEIGHT ? 'origin'
      : height === RESERVATION_HEIGHT ? 'reservation' : 'empty', funding);
  }
  return s;
}
function branch(cut, events, funding = OLD_FUND) {
  const s = acceptedPrefix(cut, funding);
  for (const event of events) apply(s, event, funding);
  return s;
}
function permutations(items) {
  if (!items.length) return [[]];
  return items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index))
    .map(rest => [item, ...rest]));
}
function invariant(s) {
  assert(s.paid === 0 || s.paid === PRICE, 'Native guard permits at most one price payment');
  assert(s.origin ? ['seller', 'locked', 'buyer', 'unrelated-recipient'].includes(s.owner)
    : s.owner === null, 'Exactly one token-lot owner or reservation, with canonical origin');
  assert.equal(s.owner === 'buyer', s.offer === 'sold');
  assert.equal(s.acceptedNative.filter(e => e === 'purchase' || e === 'cancel').length,
    Number(s.nativeImages.has(GUARD)));
  // LOT is deliberately conserved symbolically, not by cryptographic arithmetic.
  const tokenSupply = s.origin ? LOT : 0;
  assert.equal(tokenSupply, s.owner === null ? 0 : LOT);
}
function paidWithoutTokens(s) { return s.paid === PRICE && s.owner !== 'buyer'; }

test('release baseline contains ten reservation confirmations, not irreversible finality', () => {
  assert.equal(RELEASE_HEIGHT - RESERVATION_HEIGHT + 1, 10);
  const s = acceptedPrefix(RELEASE_HEIGHT);
  assert.equal(s.offer, 'locked');
  assert.equal(s.paid, 0);
});

test('all modeled replacement tails preserve fairness when the reservation prefix survives', () => {
  const tails = permutations(['reservation', 'replacement-carrier', 'conflict', 'purchase', 'cancel']);
  let cases = 0;
  for (const funding of [OLD_FUND, CHILD_FUND]) {
    for (let cut = RESERVATION_HEIGHT; cut <= RELEASE_HEIGHT; cut++) {
      for (const tail of tails) {
        const s = branch(cut, tail, funding);
        invariant(s);
        assert.equal(s.paid === PRICE, s.owner === 'buyer');
        assert.equal(s.owner === 'unrelated-recipient', false);
        cases++;
      }
    }
  }
  assert.equal(cases, 2400);
});

test('cross-boundary exploration retains payment losses and never confiscates conflicting receipts', () => {
  const tails = permutations(['reservation', 'replacement-carrier', 'conflict', 'purchase', 'cancel']);
  const counts = {cases: 0, originRemoved: 0, reservationRemoved: 0};
  for (const funding of [OLD_FUND, CHILD_FUND]) {
    for (let cut = 0; cut < RESERVATION_HEIGHT; cut++) {
      for (const tail of tails) {
        const s = branch(cut, tail, funding);
        invariant(s);
        if (paidWithoutTokens(s)) {
          if (cut < ORIGIN_HEIGHT) counts.originRemoved++;
          else {
            counts.reservationRemoved++;
            assert.equal(s.owner, 'unrelated-recipient');
          }
        }
        counts.cases++;
      }
    }
  }
  assert.equal(counts.cases, 1200);
  assert(counts.originRemoved > 0);
  assert(counts.reservationRemoved > 0);
  console.log(JSON.stringify({abstractForkCases: 3600, stableReservationCases: 2400,
    crossBoundaryCases: counts, productionSafetyEstablished: false}));
});

test('missing reservation alone can recover from the captured full authorization', () => {
  const s = branch(RESERVATION_HEIGHT - 1, ['purchase']);
  invariant(s);
  assert.equal(s.owner, 'buyer');
  assert.equal(s.paid, PRICE);
  assert.equal(s.admissions.at(-1).admitted, true);
});

test('unchanged proof origin does not prevent a genuine competing spend after reservation rollback', () => {
  const s = branch(RESERVATION_HEIGHT - 1, ['conflict', 'purchase']);
  invariant(s);
  assert(s.origin);
  assert(paidWithoutTokens(s));
  assert.equal(s.owner, 'unrelated-recipient');
  assert.equal(s.admissions.at(-1).admitted, false);
});

test('native child ancestry alone cannot require valid parent token data', () => {
  const missing = branch(RESERVATION_HEIGHT - 1, ['conflict', 'purchase'], CHILD_FUND);
  assert.equal(missing.paid, 0);
  assert(missing.rejectedNative.includes('purchase'));
  const recreated = branch(RESERVATION_HEIGHT - 1,
    ['replacement-carrier', 'conflict', 'purchase'], CHILD_FUND);
  invariant(recreated);
  assert(paidWithoutTokens(recreated));
  assert.equal(recreated.owner, 'unrelated-recipient');
});

test('a vanished origin root defeats inline recovery even without a competing token spend', () => {
  const s = branch(ORIGIN_HEIGHT - 1, ['purchase']);
  invariant(s);
  assert.equal(s.origin, false);
  assert(paidWithoutTokens(s));
  assert.equal(s.owner, null);
});

test('native cancellation wins protect the price; losing the race cannot recall payment', () => {
  const cancelFirst = branch(RESERVATION_HEIGHT - 1, ['conflict', 'cancel', 'purchase']);
  invariant(cancelFirst);
  assert.equal(cancelFirst.paid, 0);
  assert(cancelFirst.rejectedNative.includes('purchase'));
  const payFirst = branch(RESERVATION_HEIGHT - 1, ['conflict', 'purchase', 'cancel']);
  invariant(payFirst);
  assert(paidWithoutTokens(payFirst));
  assert(payFirst.rejectedNative.includes('cancel'));
});

test('reorganizing only the purchase can reverse or replay both legs while retaining the reservation', () => {
  const oldHistory = branch(RELEASE_HEIGHT, ['purchase']);
  assert.equal(oldHistory.owner, 'buyer');
  const replacement = branch(RELEASE_HEIGHT, ['cancel', 'purchase']);
  invariant(replacement);
  assert.equal(replacement.owner, 'seller');
  assert.equal(replacement.paid, 0);
  const replay = branch(RELEASE_HEIGHT, ['purchase', 'cancel']);
  invariant(replay);
  assert.equal(replay.owner, 'buyer');
  assert.equal(replay.paid, PRICE);
});
