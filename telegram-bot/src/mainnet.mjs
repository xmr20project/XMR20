import {statePath} from './state-path.mjs';
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {PublicKey} from '@solana/web3.js';
import {Vault} from './vault.mjs';
import {openOfficial,existingFile,verifyOfficialBot,bindOfficialRuntime} from './official-config.mjs';
import {Telegram,poll} from './telegram.mjs';
import {TurnkeyClient} from './turnkey-client.mjs';
import {pilotPreflight} from './pilot-preflight.mjs';
import {createHelius} from './helius-mainnet.mjs';
import {LaunchGateway} from './launch-gateway.mjs';
import {ExecutionJournal} from './execution-journal.mjs';
import {createTurnkeySigner} from './turnkey.mjs';
import {LaunchPilot} from './launch-pilot.mjs';
import {TradePilot} from './trade-pilot.mjs';
import {Registration,PublicEngine,UserVault,boundSigner} from './registration.mjs';
import {probePilotSigner} from './pilot-policy.mjs';
import {PilotEngine} from './pilot-engine.mjs';
import {assertNoNativeBigint} from './dependency-guard.mjs';

// The official entry point unlocks one connection. The owner must finish the
// wallet/policy review and local settings before this can start handling funds.
let raw='',paper,turnkey,vault,journal,gateway;
let publicRegistration=false;
let connected=false,stoppedReason='startup-incomplete';
function runtimeReport(running){
  const p=statePath('mainnet-runtime.json'),tmp=p+'.'+process.pid+'.tmp';
  writeFileSync(tmp,JSON.stringify({checkedAt:new Date().toISOString(),running,connected,mode:'xmr20',privateOwnerOnly:!publicRegistration,pid:process.pid,...(!running?{reason:stoppedReason}:{})},null,2)+'\n',{flag:'wx',mode:0o600});renameSync(tmp,p);
}
const abort=new AbortController();
for(const event of ['SIGINT','SIGTERM','SIGHUP'])process.on(event,()=>abort.abort());
const need=(value,code)=>{if(!value)throw Error(code);};
try{
  assertNoNativeBigint();
  for await(const chunk of process.stdin){raw+=chunk;if(raw.length>16384)throw Error('INPUT');}
  const input=JSON.parse(raw);raw='';
  const root=new URL('../',import.meta.url);
  const identity=JSON.parse(readFileSync(statePath('turnkey-public.json'),'utf8'));
  const settings=JSON.parse(readFileSync(statePath('mainnet-settings.json'),'utf8'));
  // A policy digest is pinned only after its actual permissions are reviewed;
  // the read-only checker deliberately never enables this switch or fills it.
  need(settings.executionEnabled===true&&settings.mode==='xmr20'&&/^[a-f0-9]{64}$/.test(settings.reviewedPolicyDigest),'PILOT_NOT_ACTIVATED');
  need(settings.signingProbe?.signatureVerified===true&&settings.signingProbe?.broadcast===false,'PILOT_NOT_ACTIVATED');
  need(settings.gateway?.forcedCommand===true&&(settings.gateway.host?.startsWith('xmr20-tg-pilot@')||settings.gateway.transport==='local'),'PILOT_NOT_ACTIVATED');
  need(PublicKey.isOnCurve(new PublicKey(settings.withdrawalAddress).toBytes()),'WITHDRAWAL_SETTINGS');
  if(input.official===true){
    paper=openOfficial(statePath('official-bot.vault'),input.password);
    input.turnkeyPassword=input.password;input.heliusApiKey=paper.state.credentials.heliusApiKey;input.password='';
  }else{
    need(!settings.bot,'OFFICIAL_ENTRY_REQUIRED');
    const paperPath=resolve(homedir(),'.local/share/xmr20-telegram-paper/state.vault');existingFile(paperPath);
    paper=new Vault(paperPath,input.telegramPassword);
  }
  const credentials=paper.state.credentials;
  if(input.official===true){
    need(settings.bot?.id===credentials.bot.id&&settings.bot?.username===credentials.bot.username&&settings.telegramOwner===credentials.allowedUsers[0]&&settings.withdrawalAddress===credentials.withdrawalAddress,'OFFICIAL_SETTINGS_CHANGED');
    await verifyOfficialBot(new Telegram(credentials.token),credentials.bot);
  }
  need(credentials?.allowedUsers?.length===1&&Number.isSafeInteger(credentials.allowedUsers[0])&&credentials.allowedUsers[0]>0,'SINGLE_OWNER_REQUIRED');
  // Hold the credential lock for the entire polling session.
  existingFile(statePath('turnkey-connection.vault'));
  turnkey=new Vault(statePath('turnkey-connection.vault'),input.turnkeyPassword,{profile:'turnkey-connection'});
  need(turnkey.state.connection?.organizationId===identity.organizationId&&turnkey.state.connection.apiPublicKey===identity.apiPublicKey,'IDENTITY_SETTINGS');
  const client=new TurnkeyClient(turnkey.state.connection);turnkey.close();turnkey=null;
  const helius=createHelius(input.heliusApiKey);
  publicRegistration=settings.registration?.enabled===true;
  const report=await pilotPreflight({client,identity,helius,walletId:settings.walletId,...(publicRegistration?{registrationBotId:credentials.bot.id}:{})});
  need(report.walletVerified&&report.policyMatchesDraft&&report.policyDigest===settings.reviewedPolicyDigest,'WALLET_OR_POLICY_CHANGED');
  need(settings.walletAddress===report.walletAddress&&settings.withdrawalAddress!==report.walletAddress,'WALLET_SETTINGS');
  gateway=new LaunchGateway({...settings.gateway,owner:report.walletAddress});
  const catalog=await gateway.call('meteoraCatalog');
  need(catalog?.enabled===true&&catalog.network==='mainnet-beta'&&catalog.oneApprovalEnabled===true,'LAUNCH_UNAVAILABLE');
  vault=new Vault(statePath('mainnet.vault'),input.turnkeyPassword,{profile:'mainnet-pilot'});
  vault.transaction(s=>{if(input.official===true){bindOfficialRuntime(s,{bot:credentials.bot,ownerId:credentials.allowedUsers[0],wallet:report.walletAddress});return;}if(s.owner&&s.owner!==report.walletAddress)throw Error('WALLET_CHANGED');if(s.telegramOwner&&s.telegramOwner!==credentials.allowedUsers[0])throw Error('OWNER_CHANGED');s.owner=report.walletAddress;s.telegramOwner=credentials.allowedUsers[0];s.offset??=paper.state.offset||0;s.updates??={};});
  journal=new ExecutionJournal(statePath('mainnet-journal.vault'),input.turnkeyPassword);
  input.telegramPassword='';input.turnkeyPassword='';input.heliusApiKey='';
  const signer=createTurnkeySigner({client,organizationId:identity.organizationId,journal});
  const common={vault,owner:report.walletAddress,connection:helius.connection,signer,journal,signal:abort.signal};
  const launch=new LaunchPilot({...common,gateway});
  const trading=new TradePilot({...common,helius,withdrawalAddress:settings.withdrawalAddress});
  const api=new Telegram(credentials.token),ownerEngine=new PilotEngine({vault,ownerId:credentials.allowedUsers[0],wallet:report.walletAddress,launch,helius,api,trading});
  let engine=ownerEngine;
  if(publicRegistration){
    const capability=await gateway.call('capabilities');need(capability.separateWalletBindings===true,'REGISTRATION_GATEWAY');
    const registration=new Registration({vault,client,botId:credentials.bot.id,organizationId:identity.organizationId,
      activateWallet:async record=>{
        need(!abort.signal.aborted,'STOPPED');
        await probePilotSigner({signer:boundSigner(signer,record.walletAddress),address:record.walletAddress});
        const saved=await gateway.call('registerWallet',{binding:record.binding,walletAddress:record.walletAddress});
        need(saved.binding===record.binding&&saved.walletAddress===record.walletAddress,'REGISTRATION_GATEWAY');
      }});
    engine=new PublicEngine({ownerId:credentials.allowedUsers[0],ownerEngine,registration,createEngine:async(id,record)=>{
      const scope=new UserVault(vault,id),scoped={vault:scope,owner:record.walletAddress,connection:helius.connection,signer:boundSigner(signer,record.walletAddress),journal,signal:abort.signal};
      return new PilotEngine({vault:scope,ownerId:id,wallet:record.walletAddress,helius,api,
        launch:new LaunchPilot({...scoped,gateway:gateway.forBinding(record.binding)}),
        trading:new TradePilot({...scoped,helius,withdrawalAddress:scope.state.withdrawalAddress})});
    }});
  }
  need(!abort.signal.aborted,'STOPPED');
  await poll(api,engine,vault,{signal:abort.signal,expectedBot:credentials.bot,onReady:()=>{connected=true;runtimeReport(true);console.log('XMR20 connected on mainnet. Launches and trades require your confirmation in Telegram.');}});
  stoppedReason='stopped';
}catch(error){
  stoppedReason=error.code==='VAULT_LOCKED'?'vault-in-use':error.message==='WALLET_OR_POLICY_CHANGED'?'wallet-or-policy-changed':'startup-or-runtime-error';
  if(!abort.signal.aborted){
    const message=error.code==='ENOENT'||error.message==='PILOT_NOT_ACTIVATED'?'Mainnet setup is not complete. Finish the dedicated wallet, signing-policy review and private settings first.':error.code==='VAULT_LOCKED'?'A bot or vault process is already running. Stop it before starting this one.':'Mainnet startup stopped. Check the readiness report, private settings, unlock password and network. Saved receipts remain intact.';
    console.error(message);process.exitCode=1;
  }
}finally{gateway?.close();journal?.close();vault?.close();turnkey?.close();paper?.close();try{runtimeReport(false);}catch{}}
