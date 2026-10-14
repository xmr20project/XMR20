import {Vault} from '../src/vault.mjs';
import {statePath} from '../src/state-path.mjs';
import {existingFile} from '../src/official-config.mjs';
let raw='',vaults=[];
try{
 for await(const c of process.stdin){raw+=c;if(raw.length>4096)throw Error();}
 const {password}=JSON.parse(raw);raw='';
 for(const [name,profile] of [['official-bot','official-bot'],['turnkey-connection','turnkey-connection'],['mainnet','mainnet-pilot'],['mainnet-journal','turnkey-execution'],['mainnet-setup-journal','turnkey-execution']]){
  existingFile(statePath(name+'.vault'));vaults.push(new Vault(statePath(name+'.vault'),password,{profile}));
 }
}catch{process.exitCode=1;}finally{for(const v of vaults)v.close();}
