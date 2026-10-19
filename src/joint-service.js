// Shared transport for bridge actions and public balance reads. Local review
// profiles remain explicit; the installable all-token build uses the hosted gateway.
export const HOSTED_BRIDGE='https://api.xmr20.org';
export function jointService({privateTest=false,walletTest=false,endpoint}={}){
 const base=endpoint??(walletTest?HOSTED_BRIDGE:privateTest?'http://127.0.0.1:8933':'http://127.0.0.1:8928');
 return {endpoint:base,rpcEndpoint:base+(base===HOSTED_BRIDGE?'/api/bridge-solana-read':'/api/solana-read')};
}
export function bridgeConnectionMessage(error){
 if(error?.message==='Registered recipient required.')return 'Wallet linking required. The recipient must link their Monero wallet to a Solana wallet in Bridge. After the link is published, allow about 20 minutes for 10 Monero confirmations, then retry this send.';
 if(error?.name==='TimeoutError')return 'The bridge took too long to respond. Your saved approvals are kept. Check status before approving again.';
 if(error?.message==='Transferable service unavailable. Keep the public recovery receipt.')return 'The bridge service could not finish this request. Your saved approvals are kept. Check status before approving again.';
 if(error?.name==='TypeError'&&/fetch|network/i.test(error.message))return 'The wallet could not reach the bridge service. Your saved approvals are kept. Reconnect to check their status before approving again.';
 return error?.message||'The bridge request could not finish. Your saved approvals are kept.';
}
