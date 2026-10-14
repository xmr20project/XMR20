import {statePath} from './state-path.mjs';
import {readFileSync,writeFileSync,renameSync,lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {PublicKey} from '@solana/web3.js';
import {Vault} from './vault.mjs';
import {TurnkeyClient} from './turnkey-client.mjs';
import {createHelius} from './helius-mainnet.mjs';
import {pilotPreflight} from './pilot-preflight.mjs';
import {LaunchGateway} from './launch-gateway.mjs';
import {ExecutionJournal} from './execution-journal.mjs';
import {createTurnkeySigner} from './turnkey.mjs';
import {probePilotSigner} from './pilot-policy.mjs';
import {Telegram} from './telegram.mjs';
import {openOfficial,verifyOfficialBot,bindOfficialRuntime} from './official-config.mjs';
import {assertNoNativeBigint} from './dependency-guard.mjs';

const root=new URL('../',import.meta.url);
const path=statePath;
const read=name=>JSON.parse(readFileSync(path(name),'utf8'));
const save=(name,data)=>{const p=path(name),tmp=p+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(tmp,p);};
let raw='',stage='input',connectionVault,journal,gateway,child,officialVault,stateVault;
let stopping=false;
for(const event of ['SIGINT','SIGTERM','SIGHUP'])process.on(event,()=>{stopping=true;child?.kill('SIGTERM');});
try{
  assertNoNativeBigint();
  for await(const chunk of process.stdin){raw+=chunk;if(raw.length>16384)throw Error();}
  const input=JSON.parse(raw);raw='';
  let previous;try{previous=read('mainnet-settings.json');}catch(error){if(error.code!=='ENOENT')throw error;}
  stage='official-entry';if(previous?.bot&&input.official!==true)throw Error();
  let credentials;
  if(input.official===true){
    stage='official-unlock';officialVault=openOfficial(path('official-bot.vault'),input.password);
    credentials=officialVault.state.credentials;
    stage='telegram';await verifyOfficialBot(new Telegram(credentials.token),credentials.bot);
    input.turnkeyPassword=input.password;input.heliusApiKey=credentials.heliusApiKey;input.withdrawalAddress=credentials.withdrawalAddress;
  }
  stage='withdrawal-address';
  const withdrawal=new PublicKey(input.withdrawalAddress);
  if(!PublicKey.isOnCurve(withdrawal.toBytes())||withdrawal.toBase58()!==input.withdrawalAddress)throw Error();
  stage='turnkey-unlock';
  const identity=read('turnkey-public.json');
  const info=lstatSync(path('turnkey-connection.vault'));if(!info.isFile()||info.isSymbolicLink())throw Error();
  connectionVault=new Vault(path('turnkey-connection.vault'),input.turnkeyPassword,{profile:'turnkey-connection'});
  const connection=connectionVault.state.connection;
  if(connection.organizationId!==identity.organizationId||connection.apiPublicKey!==identity.apiPublicKey)throw Error();
  const client=new TurnkeyClient(connection);connectionVault.close();connectionVault=null;
  const helius=createHelius(input.heliusApiKey);
  const publicRegistration=input.openRegistration===true||previous?.registration?.enabled===true;
  const report=await pilotPreflight({client,identity,helius,...(publicRegistration?{registrationBotId:credentials?.bot.id}:{}),onStage:s=>{stage=s;console.log('Checking: '+s);}});
  save('mainnet-preflight.json',{...report,ok:true});
  stage='dedicated-wallet';if(!report.walletVerified||report.walletAddress===input.withdrawalAddress)throw Error();
  if(input.official===true){
    stage='saved-orders';stateVault=new Vault(path('mainnet.vault'),input.turnkeyPassword,{profile:'mainnet-pilot'});
    bindOfficialRuntime(structuredClone(stateVault.state),{bot:credentials.bot,ownerId:credentials.allowedUsers[0],wallet:report.walletAddress});
  }
  stage='signing-policy';if(!report.policyMatchesDraft)throw Error();
  stage='launch-gateway';
  const gatewaySettings=read('gateway-settings.json');
  if(gatewaySettings.forcedCommand!==true||!(gatewaySettings.host?.startsWith('xmr20-tg-pilot@')||gatewaySettings.transport==='local'))throw Error();
  gateway=new LaunchGateway({...gatewaySettings,owner:report.walletAddress});
  const catalog=await gateway.call('meteoraCatalog');
  if(catalog.enabled!==true||catalog.network!=='mainnet-beta'||catalog.oneApprovalEnabled!==true)throw Error();
  const account=await gateway.call('meteoraAccount');
  if(!Array.isArray(account.launches)||account.launches.some(r=>r.owner!==report.walletAddress))throw Error();
  if(publicRegistration){const cap=await gateway.call('capabilities');if(cap.separateWalletBindings!==true)throw Error();}
  gateway.close();gateway=null;
  stage='signing-probe';if(stopping)throw Error();
  let prior;try{prior=read('mainnet-settings.json');}catch(error){if(error.code!=='ENOENT')throw error;}
  const reuse=input.official===true&&prior?.bot?.id===credentials.bot.id&&prior?.bot?.username===credentials.bot.username&&prior?.telegramOwner===credentials.allowedUsers[0]&&prior?.walletId===report.walletId&&prior?.walletAddress===report.walletAddress&&prior?.reviewedPolicyDigest===report.policyDigest&&prior?.withdrawalAddress===input.withdrawalAddress&&prior?.signingProbe?.signatureVerified===true&&prior?.signingProbe?.broadcast===false;
  let probe=prior?.signingProbe;
  if(!reuse){
    journal=new ExecutionJournal(path('mainnet-setup-journal.vault'),input.turnkeyPassword);
    const signer=createTurnkeySigner({client,organizationId:identity.organizationId,journal});
    probe=await probePilotSigner({signer,address:report.walletAddress});
    journal.close();journal=null;
  }
  if(stopping)throw Error();
  stage='settings';
  save('mainnet-settings.json',{...(credentials?{bot:credentials.bot,telegramOwner:credentials.allowedUsers[0]}:{}),registration:{enabled:publicRegistration},mode:'xmr20',executionEnabled:true,walletId:report.walletId,walletAddress:report.walletAddress,withdrawalAddress:input.withdrawalAddress,reviewedPolicyDigest:report.policyDigest,policyScope:report.policyScope,signingProbe:probe,gateway:gatewaySettings});
  save('mainnet-activation.json',{checkedAt:new Date().toISOString(),setupPassed:true,readyForPrivatePilot:true,fundedEndToEndVerified:false,policyMatchesDraft:true,signingProbeVerified:true,gatewayVerified:true,botStarted:false});
  console.log('Wallet, exact policy, restricted launch gateway and non-broadcast signature check passed.');
  console.log('Starting XMR20 on mainnet. Financial actions require your review in Telegram.');
  stateVault?.close();stateVault=null;officialVault?.close();officialVault=null;
  stage='bot-start';
  if(input.activateOnly===true)process.exitCode=0;
  else {
  child=spawn(process.execPath,[fileURLToPath(new URL('./mainnet.mjs',import.meta.url))],{stdio:['pipe','inherit','inherit']});
  child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify(input.official===true?{official:true,password:input.password}:input));for(const key of Object.keys(input))input[key]='';
  await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>{process.exitCode=code??1;resolve();});});
  }
}catch{
  const messages={
    'official-entry':'Use Start XMR20 Bot for the official connection. Existing settings were preserved.',
    'official-unlock':'Could not unlock XMR20. Use your existing Turnkey passphrase.',
    telegram:'The token does not identify @XMR20_Bot, Telegram is unavailable, or a webhook is active.',
    'saved-orders':'Another bot is running or saved orders belong to a different Telegram account. Existing receipts were preserved; migration requires review.',
    'withdrawal-address':'Enter a valid Solana withdrawal address you control.',
    'turnkey-unlock':'Could not unlock the Turnkey vault. Check its passphrase and other open setup processes.',
    'dedicated-wallet':'Verify the dedicated Solana wallet; withdrawal must go to a different wallet you control.',
    'signing-policy':'Add the exact prepared wallet policy in Turnkey first. No signing was attempted.',
    'launch-gateway':'The restricted launch service connection did not pass.',
    'signing-probe':'The non-broadcast signing test did not pass. No transaction was sent; the diagnostic receipt is preserved.',
    'bot-start':'The bot could not start. Check mainnet-runtime.json and close any other bot process before retrying.'
  };
  try{save('mainnet-activation.json',{checkedAt:new Date().toISOString(),setupPassed:false,readyForPrivatePilot:false,stage,message:messages[stage]||'Setup stopped. Check the readiness report and hidden inputs.',botStarted:false});}catch{}
  console.error(messages[stage]||'Setup stopped. Check the readiness report and hidden inputs. No secret details logged.');process.exitCode=1;
}finally{officialVault?.close();stateVault?.close();connectionVault?.close();journal?.close();gateway?.close();}
