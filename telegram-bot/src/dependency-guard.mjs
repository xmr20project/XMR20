import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {readdirSync,lstatSync} from 'node:fs';
const require=createRequire(import.meta.url);

// GHSA-3gc7-fjrx-p6mg affects bigint-buffer's optional native converter.
// The pinned SDK still depends on that package. Use its shipped JS fallback;
// refuse a local rebuild/native binary rather than silently loading it.
export function assertNoNativeBigint(root=dirname(require.resolve('bigint-buffer/package.json'))) {
  const visit=path=>{for(const entry of readdirSync(path,{withFileTypes:true})){
    const file=join(path,entry.name);
    if(lstatSync(file).isSymbolicLink())throw Error('NATIVE_BIGINT_UNVERIFIED');
    if(entry.isDirectory())visit(file);
    else if(entry.name.endsWith('.node'))throw Error('NATIVE_BIGINT_DISABLED');
  }};
  visit(root);
}
