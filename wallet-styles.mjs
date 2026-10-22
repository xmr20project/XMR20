import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
export function walletStyles(base,{transferable=false}={}){
 const ordinary=readFileSync(resolve(base,'extension/style.css'),'utf8');
 return transferable?ordinary+'\n'+readFileSync(resolve(base,'src/joint-transferable.css'),'utf8'):ordinary;
}
