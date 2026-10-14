import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, statSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createECDH} from 'node:crypto';
import {prepareTurnkeyConnection} from '../src/turnkey-setup.mjs';
import {Vault} from '../src/vault.mjs';

const organizationId = '00000000-0000-4000-8000-000000000001';
test('API setup encrypts matching P256 credentials and reopening does not rotate them', () => {
  const root = mkdtempSync(join(tmpdir(), 'turnkey-synthetic-'));
  const vaultPath = join(root, 'connection.vault'), password = 'synthetic-test-passphrase-only';
  try {
    const result = prepareTurnkeyConnection({vaultPath, password, organizationId});
    assert.deepEqual(Object.keys(result).sort(), ['apiPublicKey', 'organizationId']);
    assert.match(result.apiPublicKey, /^(02|03)[a-f0-9]{64}$/);
    const bytes = readFileSync(vaultPath);
    const vault = new Vault(vaultPath, password, {profile:'turnkey-connection'});
    try {
      const key = vault.state.connection.apiPrivateKey;
      assert.ok(!bytes.includes(Buffer.from(key)));
      const curve = createECDH('prime256v1'); curve.setPrivateKey(Buffer.from(key, 'hex'));
      assert.equal(curve.getPublicKey('hex', 'compressed'), result.apiPublicKey);
    } finally { vault.close(); }
    assert.deepEqual(prepareTurnkeyConnection({vaultPath, password, organizationId}), result);
    assert.deepEqual(readFileSync(vaultPath), bytes);
    assert.equal(statSync(vaultPath).mode & 0o777, 0o600);
    assert.ok(!existsSync(vaultPath + '.lock'));
    assert.throws(() => prepareTurnkeyConnection({vaultPath, password:'wrong-synthetic-passphrase', organizationId}), /Cannot unlock/);
    assert.throws(() => prepareTurnkeyConnection({vaultPath, password, organizationId:'00000000-0000-4000-8000-000000000002'}), /Organization mismatch/);
    assert.deepEqual(readFileSync(vaultPath), bytes);
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test('connection and paper vaults cannot be interchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'turnkey-synthetic-'));
  const vaultPath = join(root, 'state.vault'), password = 'synthetic-test-passphrase-only';
  try {
    const paper = new Vault(vaultPath, password); paper.close();
    const bytes = readFileSync(vaultPath);
    assert.throws(() => prepareTurnkeyConnection({vaultPath, password, organizationId}), /Cannot unlock/);
    assert.deepEqual(readFileSync(vaultPath), bytes);
    const reread = new Vault(vaultPath, password); assert.equal(reread.state.mode, 'paper'); reread.close();
    const other = join(root, 'connection.vault');
    prepareTurnkeyConnection({vaultPath:other, password, organizationId});
    assert.throws(() => new Vault(other, password), /Cannot unlock/);
    assert.throws(() => prepareTurnkeyConnection({vaultPath:join(root,'invalid'), password, organizationId:'not-a-uuid'}), /Invalid organization/);
    assert.ok(!existsSync(join(root,'invalid')));
  } finally { rmSync(root, {recursive:true, force:true}); }
});
