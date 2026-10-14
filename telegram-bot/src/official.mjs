import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {Vault} from './vault.mjs';
import {Telegram} from './telegram.mjs';
import {TurnkeyClient} from './turnkey-client.mjs';
import {verifyTurnkeyConnection} from './turnkey-check.mjs';
import {createHelius} from './helius-mainnet.mjs';
import {existingFile,validateOfficialCredentials,verifyOfficialBot,saveSetupDraft,heliusKey} from './official-config.mjs';
import {assertNoNativeBigint} from './dependency-guard.mjs';

const root=new URL('../',import.meta.url),path=n=>fileURLToPath(new URL('state/'+n,root));
let raw='',stage='input',vault,turnkey,child,stopping=false;
for(const event of ['SIGINT','SIGTERM','SIGHUP'])process.on(event,()=>{stopping=true;child?.kill('SIGTERM');});
try{
  assertNoNativeBigint();
  for await(const chunk of process.stdin){raw+=chunk;if(raw.length>16384)throw Error();}
  const input=JSON.parse(raw);raw='';
  if(!['setup','start'].includes(input.action))throw Error();
  // Check the existing unlock password before creating any new encrypted file.
  stage='unlock';
  existingFile(path('turnkey-connection.vault'));
  turnkey=new Vault(path('turnkey-connection.vault'),input.password,{profile:'turnkey-connection'});
  const identity=JSON.parse(readFileSync(path('turnkey-public.json'),'utf8'));
  const connection=turnkey.state.connection;
  if(connection?.organizationId!==identity.organizationId||connection?.apiPublicKey!==identity.apiPublicKey)throw Error();
  const client=new TurnkeyClient(connection);turnkey.close();turnkey=null;
  if(input.action==='start'&&!existsSync(path('official-bot.vault')))throw Object.assign(Error(),{code:'ENOENT'});
  vault=new Vault(path('official-bot.vault'),input.password,{profile:'official-bot'});
  if(!vault.state.credentials){
    stage='save';
    const draft=saveSetupDraft(vault,input);
    console.log('Setup details saved encrypted. Connection errors will not discard them.');
    stage='turnkey-connection';await verifyTurnkeyConnection({client,...identity});
    stage='telegram';
    const bot=await verifyOfficialBot(new Telegram(draft.token));
    stage='settings';
    const credentials=validateOfficialCredentials({token:draft.token,heliusApiKey:draft.heliusApiKey,allowedUsers:[draft.ownerId],withdrawalAddress:draft.withdrawalAddress,bot});
    stage='helius';credentials.heliusApiKey=heliusKey(draft.heliusApiKey);
    await createHelius(credentials.heliusApiKey).verify();
    if(stopping)throw Error();
    stage='save';
    vault.transaction(s=>{s.credentials=credentials;delete s.setupDraft;});
    const report={checkedAt:new Date().toISOString(),connectionSaved:true,username:bot.username,ownerId:draft.ownerId,mainnetStarted:false};
    const tmp=path('official-setup.json')+'.'+process.pid+'.tmp';
    writeFileSync(tmp,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(tmp,path('official-setup.json'));
    console.log('@XMR20_Bot connection verified and saved encrypted.');
  }else{
    // Setup is idempotent once connected; cannot silently rotate a funded bot.
    stage='configured';if(input.edit===true)throw Error();
    validateOfficialCredentials(vault.state.credentials);
  }
  vault.close();vault=null;
  if(stopping)throw Error();
  stage='start';
  // Activation reads the new encrypted connection, never the old Telegram vault.
  child=spawn(process.execPath,[fileURLToPath(new URL('./activate-mainnet.mjs',import.meta.url))],{stdio:['pipe','inherit','inherit']});
  child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({official:true,password:input.password,openRegistration:input.openRegistration===true}));
  for(const key of Object.keys(input))input[key]='';
  await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{process.exitCode=code??1;resolve();});});
}catch(error){
  const messages={
    configured:'The connection is already verified. Use Start XMR20 Bot. Changing a connected wallet or bot requires a separate migration.',
    unlock:'Could not unlock XMR20. Use your existing Turnkey vault passphrase and close other setup processes.',
    'turnkey-connection':'Turnkey identity could not be verified. Check connection settings and network.',
    telegram:'Telegram connection did not pass. The token must belong to @XMR20_Bot and have no active webhook.',
    settings:'Enter your numeric Telegram user ID and a valid separate Solana withdrawal address.',
    helius:'Helius mainnet could not be verified. Use a Helius API key or its mainnet RPC URL.',
    save:'Could not save the encrypted connection. Existing files were preserved.',
    start:'XMR20 could not start. Your saved connection is preserved; use Start XMR20 Bot to retry.'
  };
  if(['turnkey-connection','telegram','settings','helius'].includes(stage))console.error('Your entries are saved encrypted. Use Start XMR20 Bot to retry, or Edit XMR20 Connection to correct an entry.');
  console.error(stage==='unlock'&&error.code==='ENOENT'?'Run Setup XMR20 Bot once before starting.':messages[stage]||'Setup stopped. No secret details logged.');process.exitCode=1;
}finally{vault?.close();turnkey?.close();}
