import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createPublicKey, ECDH, verify} from 'node:crypto';
import {TurnkeyRead, verifyTurnkeyConnection} from '../src/turnkey-check.mjs';

const organizationId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
const adminId = '00000000-0000-4000-8000-000000000003';
const pair = generateKeyPairSync('ec', {namedCurve:'prime256v1'});
const jwk = pair.privateKey.export({format:'jwk'});
const apiPrivateKey = Buffer.from(jwk.d, 'base64url').toString('hex');
const apiPublicKey = ECDH.convertKey(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]), 'prime256v1', undefined, 'hex', 'compressed');
const configs = () => ({configs:{quorum:{threshold:1, userIds:[adminId]}}});
const user = () => ({user:{userId, apiKeys:[{credential:{publicKey:apiPublicKey, type:'CREDENTIAL_TYPE_API_KEY_P256'}}, {credential:{publicKey:'synthetic-unused-key'}}]}});
const identity = () => ({organizationId, userId});

test('official SDK stamps exact read bodies; only three pinned query endpoints are reachable', async () => {
  const seen = [];
  const fetcher = async (url, options) => {
    const method = url.split('/').pop(); seen.push(method);
    assert.equal(url, 'https://api.turnkey.com/public/v1/query/' + method);
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    const stamp = JSON.parse(Buffer.from(options.headers['X-Stamp'], 'base64url'));
    assert.equal(stamp.publicKey, apiPublicKey);
    assert.equal(stamp.scheme, 'SIGNATURE_SCHEME_TK_API_P256');
    assert.ok(verify('sha256', Buffer.from(options.body), createPublicKey(pair.privateKey), Buffer.from(stamp.signature, 'hex')));
    assert.ok(!options.body.includes(apiPrivateKey));
    assert.deepEqual(JSON.parse(options.body), {organizationId, ...(method === 'get_user' ? {userId} : {})});
    return Response.json(method === 'whoami' ? identity() : method === 'get_user' ? user() : configs());
  };
  const client = new TurnkeyRead({organizationId, apiPublicKey, apiPrivateKey, fetcher});
  const report = await verifyTurnkeyConnection({client, organizationId, userId, apiPublicKey});
  assert.equal(report.rootUser, false); assert.equal(report.mainnetReady, false);
  assert.equal(report.permissionsReviewed, false); assert.equal(report.otherApiKeyCount, 1);
  assert.ok(!JSON.stringify(client).includes(apiPrivateKey));
  assert.ok(!JSON.stringify(report).includes(apiPrivateKey));
  assert.deepEqual(seen.sort(), ['get_organization_configs', 'get_user', 'whoami']);
  await assert.rejects(client.query('sign_transaction'), /TURNKEY_READ_ONLY/);
  await assert.rejects(client.query('../submit/create_wallet'), /TURNKEY_READ_ONLY/);
  assert.equal(seen.length, 3);
});

test('identity mismatch prevents further reads; incorrect keys and root membership fail closed', async () => {
  for (const variant of ['identity', 'key', 'root', 'missing-root']) {
    let calls = 0;
    const client = {async query(method) {
      calls++;
      if (method === 'whoami') return variant === 'identity' ? {...identity(), userId:adminId} : identity();
      if (method === 'get_user') return variant === 'key' ? {user:{userId, apiKeys:[]}} : user();
      if (variant === 'missing-root') return {};
      return variant === 'root' ? {configs:{quorum:{threshold:1, userIds:[userId]}}} : configs();
    }};
    await assert.rejects(verifyTurnkeyConnection({client, organizationId, userId, apiPublicKey}), /TURNKEY_/);
    if (variant === 'identity') assert.equal(calls, 1);
  }
});

test('provider errors and malformed responses never expose provider text or credentials', async () => {
  for (const fetcher of [async () => { throw Error('synthetic-private-provider-response'); }, async () => new Response('synthetic-private-provider-response', {status:403}), async () => new Response('synthetic-private-provider-response', {status:200})]) {
    const client = new TurnkeyRead({organizationId, apiPublicKey, apiPrivateKey, fetcher});
    await assert.rejects(client.query('whoami'), error => /^TURNKEY_(CONNECTION|ACCESS|RESPONSE)$/.test(error.message));
  }
});
