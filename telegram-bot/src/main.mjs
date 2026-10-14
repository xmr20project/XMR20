import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { Vault } from './vault.mjs';
import { Engine } from './engine.mjs';
import { Telegram, poll } from './telegram.mjs';

// Startup secrets come through a private pipe, never command arguments or files.
let configText = '';
for await (const chunk of process.stdin) configText += chunk;
let config;
try { config = JSON.parse(configText); configText = ''; } catch { process.exit(1); }
const path = resolve(homedir(), '.local/share/xmr20-telegram-paper/state.vault');
let vault, stage = 'unlock';
const abort = new AbortController();
for (const event of ['SIGINT','SIGTERM','SIGHUP']) process.on(event,()=>abort.abort());
const startupErrors = {
  VAULT_LOCKED:'The test bot vault is locked. Stop the other bot window first. If none is running, a leftover lock needs checking; do not delete your vault.',
  VAULT_PASSPHRASE:'Enter your existing vault passphrase (at least 16 characters), not the Telegram API token.',
  VAULT_UNLOCK:'Could not unlock the vault. Check your original passphrase. The file may also be damaged or incompatible; it has not been replaced.'
};
try {
  vault = new Vault(path, config.password); config.password = '';
  stage = 'settings';
  const credentials = vault.state.credentials;
  if (!credentials || !Array.isArray(credentials.allowedUsers) || !credentials.allowedUsers.length || credentials.allowedUsers.some(id=>!Number.isSafeInteger(id)||id<=0)) throw Error('Private tester IDs required.');
  const engine = new Engine(vault,{allowedUsers:credentials.allowedUsers});
  const api = new Telegram(credentials.token);
  stage = 'connection';
  await poll(api,engine,vault,{signal:abort.signal,onReady:()=>console.log('Private TEST bot connected. No real wallets, deposits, signing or trading.'),onTiming:({localMs,deliveryMs,totalMs})=>{
    console.log(`Reply sent: ${Math.round(totalMs)} ms (processing ${Math.round(localMs)} ms; Telegram ${Math.round(deliveryMs)} ms).`);
  }});
} catch (error) {
  if (!abort.signal.aborted) {
    const message = startupErrors[error.code] || (stage === 'settings'
      ? 'Private test settings are incomplete or invalid. Run Setup Telegram Test Bot again with your bot token, tester ID and existing vault passphrase.'
      : stage === 'connection'
      ? 'Could not connect to Telegram. Check your connection and bot token; the test bot must not have an existing webhook.'
      : 'Could not open the test vault. Check access to its folder. No secret details logged.');
    process.stderr.write(message+'\n'); process.exitCode = 1;
  }
}
finally { vault?.close(); }
