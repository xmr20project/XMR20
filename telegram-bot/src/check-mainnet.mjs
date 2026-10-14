import {readFileSync,writeFileSync,renameSync,lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Vault} from './vault.mjs';
import {TurnkeyClient} from './turnkey-client.mjs';
import {createHelius} from './helius-mainnet.mjs';
import {pilotPreflight,readinessFailure} from './pilot-preflight.mjs';
import {assertNoNativeBigint} from './dependency-guard.mjs';

// Owner-run hidden pipe input. Prints only a bounded public readiness summary.
let raw='',vault,stage='dependencies';
function saveReport(report){
  const path=fileURLToPath(new URL('../state/mainnet-preflight.json',import.meta.url)),tmp=path+'.'+process.pid+'.tmp';
  writeFileSync(tmp,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(tmp,path);
}
try{
  assertNoNativeBigint();
  stage='input';
  for await(const chunk of process.stdin){raw+=chunk;if(raw.length>16384)throw Error();}
  const input=JSON.parse(raw);raw='';
  stage='settings';
  const identity=JSON.parse(readFileSync(new URL('../state/turnkey-public.json',import.meta.url),'utf8'));
  stage='vault';
  const vaultPath=fileURLToPath(new URL('../state/turnkey-connection.vault',import.meta.url));
  const info=lstatSync(vaultPath);if(!info.isFile()||info.isSymbolicLink())throw Error();
  vault=new Vault(vaultPath,input.password,{profile:'turnkey-connection'});
  const connection=vault.state.connection;
  if(connection.organizationId!==identity.organizationId||connection.apiPublicKey!==identity.apiPublicKey)throw Error();
  const client=new TurnkeyClient(connection);vault.close();vault=null;
  stage='helius-input';
  const helius=createHelius(input.heliusApiKey);input.password='';input.heliusApiKey='';
  const report=await pilotPreflight({client,identity,helius,onStage:value=>{stage=value;console.log('Checking: '+value);}});
  stage='report';saveReport({...report,ok:true});
  console.log('Turnkey identity and Helius mainnet verified.');
  console.log(report.walletVerified?'Dedicated Solana wallet verified.':'Dedicated Solana wallet not yet verified.');
  for(const issue of report.missing)console.log('Next: '+issue);
  console.log('Read-only check complete. No deposit address enabled, signing or transaction sent.');
}catch(error){
  const report=readinessFailure(stage,error);
  try{saveReport(report);}catch{console.error('Could not save the local readiness report.');}
  console.error('Mainnet check stopped at: '+report.stage+'. '+report.missing[0]);
  console.error('No credentials or provider response bodies logged.');process.exitCode=1;
}
finally{vault?.close();}
