import {generateKeyPairSync} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Vault} from './vault.mjs';

// No network access; generated material authenticates API requests, not a wallet.
export function prepareTurnkeyConnection({vaultPath, password, organizationId}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) throw Error('Invalid organization ID.');
  let vault;
  try {
    vault = new Vault(vaultPath, password, {profile:'turnkey-connection'});
    if (vault.state.connection && vault.state.connection.organizationId !== organizationId) throw Error('Organization mismatch.');
    if (!vault.state.connection) {
      const pair = generateKeyPairSync('ec', {namedCurve:'prime256v1'});
      const jwk = pair.privateKey.export({format:'jwk'});
      const x = Buffer.from(jwk.x, 'base64url'), y = Buffer.from(jwk.y, 'base64url');
      const apiPublicKey = Buffer.concat([Buffer.from([2 + (y[31] & 1)]), x]).toString('hex');
      vault.transaction(state => {
        state.connection = {organizationId, apiPublicKey, apiPrivateKey:Buffer.from(jwk.d, 'base64url').toString('hex'), registration:'pending', createdAt:new Date().toISOString()};
      });
    }
    return {organizationId, apiPublicKey:vault.state.connection.apiPublicKey};
  } finally { vault?.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = '';
  try {
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 16384) throw Error(); }
    const {password} = JSON.parse(input); input = '';
    const config = JSON.parse(readFileSync(new URL('../state/turnkey-public.json', import.meta.url), 'utf8'));
    const result = prepareTurnkeyConnection({password, organizationId:config.organizationId, vaultPath:fileURLToPath(new URL('../state/turnkey-connection.vault', import.meta.url))});
    console.log('API credential saved encrypted. No connection, wallet creation or transaction performed.');
    console.log('Organization ID: ' + result.organizationId);
    console.log('\nAPI PUBLIC KEY (safe to copy into Turnkey):\n' + result.apiPublicKey);
    console.log('\nRegister this public key for a dedicated non-root API user named xmr20-bot.');
    console.log('Keep your passkey account as administrator; do not add the bot to the root quorum.');
    console.log('The connection and permissions are not verified yet.');
  } catch {
    console.error('Turnkey setup failed. Check organization settings, passphrase and vault lock. No secret details logged.');
    process.exitCode = 1;
  }
}
