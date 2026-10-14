import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {Vault} from './vault.mjs';
import {Telegram} from './telegram.mjs';
let input='';for await(const chunk of process.stdin) input+=chunk;
let vault;
try {
 const config=JSON.parse(input); input='';
 new Telegram(config.token); // Local format check only. No provider call.
 if(!Array.isArray(config.allowedUsers)||config.allowedUsers.some(id=>!Number.isSafeInteger(id)||id<=0)) throw Error();
 vault=new Vault(resolve(homedir(),'.local/share/xmr20-telegram-paper/state.vault'),config.password);
 vault.transaction(state=>{state.credentials={token:config.token,allowedUsers:config.allowedUsers};});
 console.log('Bot token saved encrypted. No connection or message sent. Keep your passphrase safe.');
 if(!config.allowedUsers.length) console.log('Tester IDs still needed before starting. Re-run setup to add them.');
}catch {process.stderr.write('Setup failed. Check token format, passphrase and numeric IDs. Original state preserved; secrets not logged.\n');process.exitCode=1;}
finally {vault?.close();}
