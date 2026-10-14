import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {address} from './engine.mjs';
const ACTIONS=new Set(['meteoraCatalog','meteoraAccount','meteoraMetadata','meteoraReserve','meteoraPrepare','meteoraSubmit','meteoraStatus','meteoraRecover','registerWallet','capabilities']);
const PREPARATION_ERRORS=new Set(['LAUNCH_BALANCE','LAUNCH_TOKEN_BALANCE','LAUNCH_POOL_CHECK','LAUNCH_MINT_CHECK','LAUNCH_NETWORK_CHECK','LAUNCH_QUOTE_CHECK']);
export function decodeGatewayReply(line,action){
  let r;try{if(line.length>2000000)throw Error();r=JSON.parse(line);}catch{throw Error('GATEWAY_REQUEST');}
  if(!r||r.ok!==true||r.result?.error)throw Error(action==='meteoraPrepare'&&PREPARATION_ERRORS.has(r?.error)?r.error:'GATEWAY_REQUEST');
  return r.result;
}
// SSH authenticates the owner/operator. Public browser Origin checks stay intact.
// The helper is transmitted as source, not installed or run as a persistent service.
export class LaunchGateway {
  #child;#pending;#closed=false;
  constructor({owner,host,identityFile,knownHostsFile,forcedCommand=false,transport}) {
    if(transport!=='local'&&(!address(owner)||!/^[-A-Za-z0-9_.]+@[-A-Za-z0-9.]+$/.test(host)||![identityFile,knownHostsFile].every(p=>typeof p==='string'&&p.startsWith('/')&&!p.includes('\n'))))throw Error('GATEWAY_SETTINGS');
    const code=readFileSync(new URL('../scripts/launch_gateway.py',import.meta.url)).toString('hex');
    this.#child=transport==='local'?spawn('/usr/bin/sudo',['-n','/usr/local/libexec/xmr20-telegram-pilot-gateway'],{stdio:['pipe','pipe','ignore']}):spawn('ssh',['-T','-i',identityFile,'-o','UserKnownHostsFile='+knownHostsFile,'-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','-o','ConnectTimeout=12',host,forcedCommand?'xmr20-telegram-gateway':`python3 -u -c 'exec(bytes.fromhex("${code}"))' ${owner}`],{stdio:['pipe','pipe','ignore']});
    const lines=createInterface({input:this.#child.stdout});
    lines.on('line',line=>{const p=this.#pending;if(!p)return;this.#pending=null;clearTimeout(p.timer);
      try {p.resolve(decodeGatewayReply(line,p.action));}catch(error){p.reject(error);}
    });
    this.#child.on('error',()=>this.close());this.#child.on('exit',()=>this.close());
  }
  forBinding(binding){if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(binding))throw Error('GATEWAY_BINDING');return {call:(action,data={})=>{if(['registerWallet','capabilities'].includes(action))return Promise.reject(Error('GATEWAY_REQUEST'));return this.call(action,data,binding);}};}
  call(action,data={},binding) {
    if(this.#closed||this.#pending||!ACTIONS.has(action)||Object.hasOwn(data,'owner'))return Promise.reject(Error('GATEWAY_REQUEST'));
    const body=JSON.stringify({action,data,...(binding?{binding}:{})});if(body.length>369000)return Promise.reject(Error('GATEWAY_SIZE'));
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.close();},130000);this.#pending={resolve,reject,timer,action};this.#child.stdin.write(body+'\n',error=>{if(error)this.close();});});
  }
  close(){if(this.#closed)return;this.#closed=true;const p=this.#pending;this.#pending=null;if(p){clearTimeout(p.timer);p.reject(Error('GATEWAY_DISCONNECTED'));}this.#child.stdin.end();this.#child.kill();}
}
