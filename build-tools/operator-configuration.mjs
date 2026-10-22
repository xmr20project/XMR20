import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
// Build-time selection only; pages/API replies never configure a signer.
export function operatorConfigurationPlugin(enabled=process.env.XMR20_OPERATOR_NATIVE_CANDIDATE==='1'){
 return {name:'operator-native-candidate',setup(build){
  if(!enabled)return;
  build.onResolve({filter:/native-market-config\.js$/},()=>({path:resolve(root,'services/native-market/operator-mainnet-candidate.mjs')}));
 }};
}
export function operatorConfigurationVitePlugin(){
 return {name:'operator-native-candidate',enforce:'pre',resolveId(source){
  if(process.env.XMR20_OPERATOR_NATIVE_CANDIDATE==='1'&&source.endsWith('/native-market-config.js'))
   return resolve(root,'services/native-market/operator-mainnet-candidate.mjs');
 }};
}
