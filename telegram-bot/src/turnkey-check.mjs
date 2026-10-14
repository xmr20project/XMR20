import {ApiKeyStamper} from '@turnkey/api-key-stamper';
import {readFileSync, lstatSync, writeFileSync, renameSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Vault} from './vault.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const fail = code => { throw Object.assign(new Error(code), {code}); };
const READS = new Set(['whoami', 'get_user', 'get_organization_configs']);

export class TurnkeyRead {
  #stamper;
  #organizationId;
  #fetcher;
  constructor({organizationId, apiPublicKey, apiPrivateKey, fetcher = fetch}) {
    if (!uuid(organizationId) || !/^(02|03)[a-f0-9]{64}$/i.test(apiPublicKey) || !/^[a-f0-9]{64}$/i.test(apiPrivateKey)) fail('TURNKEY_SETTINGS');
    this.#organizationId = organizationId;
    this.#stamper = new ApiKeyStamper({apiPublicKey, apiPrivateKey});
    this.#fetcher = fetcher;
  }
  async query(method, userId) {
    if (!READS.has(method)) fail('TURNKEY_READ_ONLY');
    if (method === 'get_user' && !uuid(userId)) fail('TURNKEY_SETTINGS');
    const body = JSON.stringify({organizationId:this.#organizationId, ...(method === 'get_user' ? {userId} : {})});
    let response;
    try {
      const stamp = await this.#stamper.stamp(body);
      response = await this.#fetcher('https://api.turnkey.com/public/v1/query/' + method, {
        method:'POST', redirect:'error', signal:AbortSignal.timeout(10000),
        headers:{'Content-Type':'application/json', [stamp.stampHeaderName]:stamp.stampHeaderValue}, body
      });
    } catch { fail('TURNKEY_CONNECTION'); }
    if (response.status === 401 || response.status === 403) fail('TURNKEY_ACCESS');
    if (!response.ok) fail('TURNKEY_CONNECTION');
    try { return await response.json(); } catch { fail('TURNKEY_RESPONSE'); }
  }
}

export async function verifyTurnkeyConnection({client, organizationId, userId, apiPublicKey}) {
  if (!uuid(organizationId) || !uuid(userId) || !/^(02|03)[a-f0-9]{64}$/i.test(apiPublicKey)) fail('TURNKEY_SETTINGS');
  const identity = await client.query('whoami');
  if (identity.organizationId !== organizationId || identity.userId !== userId) fail('TURNKEY_IDENTITY_MISMATCH');
  const [userResult, configResult] = await Promise.all([client.query('get_user', userId), client.query('get_organization_configs')]);
  const user = userResult?.user, quorum = configResult?.configs?.quorum;
  if (user?.userId !== userId || !Array.isArray(user.apiKeys)) fail('TURNKEY_USER_MISMATCH');
  const matches = user.apiKeys.filter(k => k.credential?.publicKey?.toLowerCase() === apiPublicKey.toLowerCase() && k.credential?.type === 'CREDENTIAL_TYPE_API_KEY_P256');
  if (matches.length !== 1) fail('TURNKEY_KEY_MISMATCH');
  if (!Array.isArray(quorum?.userIds) || !quorum.userIds.length || quorum.userIds.some(id => !uuid(id)) || !Number.isInteger(quorum.threshold) || quorum.threshold < 1 || quorum.threshold > quorum.userIds.length) fail('TURNKEY_ROOT_UNVERIFIED');
  if (quorum.userIds.includes(userId)) fail('TURNKEY_ROOT_USER');
  return {checkedAt:new Date().toISOString(), organizationId, userId, keyMatches:true, rootUser:false, otherApiKeyCount:user.apiKeys.length - 1, permissionsReviewed:false, mainnetReady:false};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let vault, input = '';
  try {
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 16384) fail('TURNKEY_SETTINGS'); }
    const {password} = JSON.parse(input); input = '';
    const config = JSON.parse(readFileSync(new URL('../state/turnkey-public.json', import.meta.url), 'utf8'));
    const path = fileURLToPath(new URL('../state/turnkey-connection.vault', import.meta.url));
    const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink()) fail('TURNKEY_SETTINGS');
    vault = new Vault(path, password, {profile:'turnkey-connection'});
    const connection = vault.state.connection;
    if (connection?.organizationId !== config.organizationId || connection?.apiPublicKey !== config.apiPublicKey) fail('TURNKEY_SETTINGS');
    const client = new TurnkeyRead(connection);
    // The checker never writes the vault. Release its lock before network I/O.
    vault.close(); vault = undefined;
    const report = await verifyTurnkeyConnection({client, ...config});
    // Public summary only; no key material, stamps or provider response bodies.
    const reportPath = fileURLToPath(new URL('../state/turnkey-check.json', import.meta.url));
    const temp = reportPath + '.' + process.pid + '.tmp';
    writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', {flag:'wx', mode:0o600});
    renameSync(temp, reportPath);
    console.log('Connection verified: correct organization, service user and API key. Bot is not a root user.');
    console.log('Other API keys on this service user: ' + report.otherApiKeyCount);
    console.log('Signing permissions and mainnet execution are not enabled by this check.');
  } catch (error) {
    const messages = {
      TURNKEY_ACCESS:'Access denied. Check that the public key is registered to this service user.',
      TURNKEY_CONNECTION:'Turnkey connection unavailable. Check the network and try again.',
      TURNKEY_IDENTITY_MISMATCH:'The API credential belongs to a different user or organization.',
      TURNKEY_KEY_MISMATCH:'The registered API key does not match the local key.',
      TURNKEY_ROOT_USER:'The bot is a root user. Remove it from the root quorum before continuing.',
      TURNKEY_ROOT_UNVERIFIED:'Could not verify the organization root quorum.',
      VAULT_LOCKED:'The Turnkey vault is in use. Close its other setup/check process first.',
      VAULT_UNLOCK:'Could not unlock the Turnkey vault. Check your passphrase.'
    };
    console.error(messages[error.code] || 'Connection not verified. Check local setup and service-user settings. No secret details logged.');
    process.exitCode = 1;
  } finally { vault?.close(); }
}
