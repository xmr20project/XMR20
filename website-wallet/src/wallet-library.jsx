import {websiteBridgeRows,mergeWalletHoldings,bridgeActionRow} from './bridge-portfolio.js';
import PendingBridgeTokens from './wallet-pending-bridges.jsx';
import NativeMoneroTokens from './website-native-holdings.jsx';
import {loadTokenImages} from './wallet-token-images.js';
import React,{lazy,Suspense,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import WalletImport from './wallet-import.jsx';
import NativeBalance from './native-balance.jsx';
import LocalMoneroRecovery from './monero-local-recovery.jsx';
import {walletLibrary} from './wallet-import-store.js';
import {loadWalletHoldings,tokenAmount,cachedWalletHoldings,cacheWalletHoldings} from './wallet-holdings.js';
import {sitePath} from './site-path.js';
import {checkMoneroAddress} from '../shared/xmr20/address.js';
import WalletAssetAction from './wallet-asset-action.jsx';
import {NATIVE_MARKET_CONFIGURATION} from '../../services/native-market/frontend/native-market-config.js';

const TransferableHoldings=lazy(()=>import('./transferable-holdings.jsx'));
const WebsiteNativeSwap=lazy(()=>import('./website-native-swap.jsx'));
const WebsiteNativeBridge=lazy(()=>import('./website-native-bridge.jsx'));
const formatAmount=raw=>new Intl.NumberFormat('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(raw)/1e6);
const formatUsd=row=>row.stale||row.priceUsd===null||row.priceUsd===undefined?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(row.amountRaw)/1e6*row.priceUsd);

export default function WalletLibrary({owner,pair,localPair,provider,onLink,onSelectedAddress}){
 const [wallets,setWallets]=useState([]),[selected,setSelected]=useState(pair?.address||''),[importing,setImporting]=useState(false),[error,setError]=useState(''),[reload,setReload]=useState(0);
 useEffect(()=>{try{setWallets(walletLibrary(owner).read());}catch{setError('Saved wallets could not be loaded.');}},[owner]);
 const options=[...(pair?[{address:pair.address,kind:'linked'}]:[]),...(localPair&&localPair.address!==pair?.address?[{address:localPair.address,kind:'preview'}]:[]),...wallets].filter((r,i,all)=>all.findIndex(a=>a.address===r.address)===i);
 const current=options.find(r=>r.address===selected)||options[0];
 useEffect(()=>{onSelectedAddress?.(current?.address||'');},[current?.address,onSelectedAddress]);
 async function imported(row){setWallets(walletLibrary(owner).add(row));setSelected(row.address);setReload(n=>n+1);}
 return <section className="wallet-library" aria-label="Monero wallets">
  {localPair&&localPair.address!==pair?.address&&<p className="notice">Your saved launch wallet is restored. The other address remains available on this device.</p>}
  {options.length>0&&<label className="wallet-selector">Monero wallet<select value={current?.address||''} onChange={e=>setSelected(e.target.value)}>{options.map(r=><option key={r.address} value={r.address}>{r.kind==='linked'?'Linked wallet':r.kind==='imported'?'Imported wallet':r.kind==='preview'?'Earlier wallet':'Address only'} · {r.address.slice(0,8)}…{r.address.slice(-6)}</option>)}</select></label>}
  {current&&<>
   <TokenHoldings key={current.address+':'+reload} address={current.address} network="monero" actions owner={owner} pair={pair} provider={provider} onLink={!pair&&current.kind==='imported'?onLink:undefined}/>
   {current.kind!=='watch'&&<><details className="native-xmr-details"><summary>Native XMR</summary><NativeBalance key={current.address} owner={owner} address={current.address} workerPath={sitePath('/monero-native/balance.worker.js')}/></details><details className="wallet-advanced"><summary>Wallet backup</summary><LocalMoneroRecovery key={'backup:'+current.address} owner={owner} network="mainnet" address={current.address}/></details></>}
   {!pair&&current.kind==='imported'&&onLink&&<button onClick={async()=>{try{await onLink(current.address);}catch(e){setError(e.message);}}}>Link wallet for launches and bridging</button>}</>}
  {!importing?<button className="wallet-subtle-button" onClick={()=>setImporting(true)}>+ Import XMR wallet</button>:<WalletImport provider={provider} key={owner} owner={owner} onImport={imported} onClose={()=>setImporting(false)}/>}{error&&<p role="alert">{error}</p>}
 </section>;
}

export function TokenHoldings({address,network='monero',actions=false,owner,provider,pair,onLink}){
 const scope=owner+':'+network+':'+address;
 const [reading,setReading]=useState(()=>({scope,data:cachedWalletHoldings(address,{network})})),[error,setError]=useState(''),[refreshing,setRefreshing]=useState(true),[action,setAction]=useState(null);
 const data=reading.scope===scope?reading.data:null,setData=value=>setReading({scope,data:value});
 // Native (operator-verified) Monero tokens live in the private engine, not the public holdings index.
 const nativeMonero=network==='monero'&&actions&&owner&&pair?.address&&address===pair.address&&!!NATIVE_MARKET_CONFIGURATION?.display;
 const actionRow=['swap','native-bridge','native-redeem','native-send','native-balance'].includes(action?.kind)?null:bridgeActionRow(action,data?.rows||[],scope);
 // The native (operator) bridge replaces the retired transferable bridge for its token on Solana.
 const nativeMint=NATIVE_MARKET_CONFIGURATION?.backing?.mint,nativeBridge=network==='solana'&&provider?.kind!=='xmr20'&&!!nativeMint&&!!pair?.address;
 const openBridge=row=>setAction(nativeBridge&&(!row||row.mint===nativeMint)?{scope,id:'native-bridge',kind:'native-bridge'}:row?{scope,id:row.id,row,kind:'bridge'}:{scope,id:'new-bridge',kind:'bridge'});
 const [solana,setSolana]=useState(()=>({owner,rows:cachedWalletHoldings(owner,{network:'solana'})?.rows||[]})),[joint,setJoint]=useState(null);
 const [images,setImages]=useState(new Map());
 useEffect(()=>{let active=true;loadTokenImages().then(value=>{if(active)setImages(value);});return()=>{active=false;};},[]);
 const latest=useRef(data),refreshRef=useRef(()=>{});
 const bridgeRows=useMemo(()=>websiteBridgeRows({owner,address,network,linkedAddress:pair?.address,currentRows:data?.rows,solana,joint}),[owner,address,network,pair?.address,data,solana,joint]);
 const catalogRows=useMemo(()=>[...(data?.rows||[]),...(solana.owner===owner?solana.rows:[])],[data,solana,owner]);
 const refreshHoldings=useCallback(()=>{window.dispatchEvent(new Event('xmr20-holdings-refresh'));return refreshRef.current();},[]);
 useEffect(()=>{
  const abort=new AbortController();let pending=null,oppositePending=null,opposite=cachedWalletHoldings(owner,{network:'solana'});
  latest.current=cachedWalletHoldings(address,{network});setData(latest.current);setAction(null);setError('');
  setSolana({owner,rows:opposite?.rows||[]});
  const refreshCurrent=()=>{
   if(abort.signal.aborted||pending)return pending;setError('');setRefreshing(true);
   pending=loadWalletHoldings(address,{signal:abort.signal,network}).then(result=>{
    if(abort.signal.aborted)return;
    const next=mergeWalletHoldings(result,latest.current);
    latest.current=next;cacheWalletHoldings(address,next,{network});setData(next);
   }).catch(()=>{if(!abort.signal.aborted){if(latest.current){const stale={...latest.current,complete:false,rows:latest.current.rows.map(r=>({...r,stale:true}))};latest.current=stale;setData(stale);}setError('Holdings could not refresh. Saved balances are kept.');}}).finally(()=>{pending=null;if(!abort.signal.aborted)setRefreshing(false);});
   return pending;
  };
  // The opposite tab's Solana balance is independent of the Monero index.
  // Keep its cache account-scoped and let either source finish first.
  const refreshOpposite=()=>{
   if(abort.signal.aborted||network==='solana'||!actions||!owner)return;
   if(oppositePending)return oppositePending;
   oppositePending=loadWalletHoldings(owner,{signal:abort.signal,network:'solana'}).then(result=>{
    if(abort.signal.aborted)return;opposite=mergeWalletHoldings(result,opposite);
    cacheWalletHoldings(owner,opposite,{network:'solana'});setSolana({owner,rows:opposite.rows});
   }).catch(()=>{if(!abort.signal.aborted)setSolana(previous=>previous.owner===owner?{owner,rows:previous.rows.map(row=>({...row,stale:true}))}:previous);}).finally(()=>{oppositePending=null;});
   return oppositePending;
  };
  const refresh=()=>Promise.allSettled([refreshCurrent(),refreshOpposite()]);
  refreshRef.current=refresh;void refresh();
  const update=()=>{if(!document.hidden)void refresh();};const timer=setInterval(update,30000);window.addEventListener('focus',update);window.addEventListener('xmr20-holdings-refresh',update);
  return()=>{abort.abort();clearInterval(timer);window.removeEventListener('focus',update);window.removeEventListener('xmr20-holdings-refresh',update);};
 },[address,network,owner,actions]);
 return <section className="wallet-assets" aria-label={`${network==='monero'?'Monero':'Solana'} token holdings`}>
  <div className="wallet-assets-head"><h3>Tokens <span>{network==='monero'?'Monero':'Solana'}</span></h3><button type="button" disabled={refreshing} aria-label="Refresh token holdings" onClick={()=>void refreshHoldings()}>↻</button></div>
  {actions&&owner&&<div className="wallet-actions-row"><button className="wallet-primary" onClick={()=>openBridge()}>Open new bridge</button>
   {network==='solana'&&provider?.kind!=='xmr20'&&<button className="wallet-secondary" onClick={()=>setAction({scope,id:'native-swap',kind:'swap'})}>Swap SOL ↔ XMR</button>}</div>}
  {action?.kind==='native-bridge'&&action.scope===scope&&<Suspense fallback={<p role="status">Loading bridge…</p>}><WebsiteNativeBridge owner={owner} provider={provider} moneroAddress={pair.address} token={{symbol:NATIVE_MARKET_CONFIGURATION.display?.symbol||'EXTREMIST'}} image={images.get(NATIVE_MARKET_CONFIGURATION.display?.mint)} onClose={()=>setAction(null)}/></Suspense>}
  {action?.kind==='native-redeem'&&action.scope===scope&&<Suspense fallback={<p role="status">Loading bridge…</p>}><WebsiteNativeBridge mode="redeem" owner={owner} provider={provider} moneroAddress={pair.address} token={{symbol:NATIVE_MARKET_CONFIGURATION.display?.symbol||'EXTREMIST'}} image={images.get(NATIVE_MARKET_CONFIGURATION.display?.mint)} onClose={()=>setAction(null)}/></Suspense>}
  {action?.kind==='native-send'&&action.scope===scope&&<Suspense fallback={<p role="status">Loading Monero wallet…</p>}><WebsiteNativeBridge mode="send" owner={owner} provider={provider} moneroAddress={pair.address} token={{symbol:NATIVE_MARKET_CONFIGURATION.display?.symbol||'EXTREMIST'}} image={images.get(NATIVE_MARKET_CONFIGURATION.display?.mint)} onClose={()=>setAction(null)}/></Suspense>}
  {action?.kind==='native-balance'&&action.scope===scope&&<Suspense fallback={<p role="status">Loading Monero wallet…</p>}><WebsiteNativeBridge mode="balance" owner={owner} provider={provider} moneroAddress={pair.address} token={{symbol:NATIVE_MARKET_CONFIGURATION.display?.symbol||'EXTREMIST'}} onClose={()=>setAction(null)}/></Suspense>}
  {action?.kind==='swap'&&action.scope===scope&&<Suspense fallback={<p role="status">Loading exchange…</p>}><WebsiteNativeSwap owner={owner} provider={provider} moneroAddress={pair?.address} onClose={()=>setAction(null)}/></Suspense>}
  {actionRow&&<WalletAssetAction key={action.id+':'+action.kind} row={actionRow} kind={action.kind} bridgeProtocol={action.id==='new-bridge'?'transferable':undefined} network={network} address={address} owner={owner} pair={pair} provider={provider} bridgeRows={bridgeRows} refreshHoldings={refreshHoldings} onLink={onLink} onClose={()=>setAction(null)}/>}
  {nativeMonero&&<NativeMoneroTokens address={pair.address} image={images.get(NATIVE_MARKET_CONFIGURATION.display?.mint)} onCheck={()=>setAction({scope,id:'native-balance',kind:'native-balance'})}
   onSend={provider?.kind!=='xmr20'?()=>setAction({scope,id:'native-send',kind:'native-send'}):undefined}
   onBridge={provider?.kind!=='xmr20'?()=>setAction({scope,id:'native-redeem',kind:'native-redeem'}):undefined}/>}
  {actions&&owner&&pair?.address&&<Suspense fallback={network==='monero'?<p>Loading bridge balances…</p>:null}><TransferableHoldings owner={owner} address={pair.address} pair={pair} provider={provider} rows={catalogRows} visible={network==='monero'&&address===pair.address} onRows={setJoint} bridgeRows={bridgeRows} refreshHoldings={refreshHoldings}/></Suspense>}
  {network==='monero'&&actions&&owner&&<PendingBridgeTokens owner={owner} address={address} confirmed={data?.rows||[]} images={images} pair={pair} provider={provider}/>}
  {refreshing&&!data&&<p role="status">Loading tokens…</p>}{error&&<p role="alert" className="form-error">{error}</p>}
  {data&&<>{data.rows.map(r=><div className="wallet-asset-wrap" key={r.id}><article className="wallet-asset"><div className="wallet-asset-icon" aria-hidden="true">{(images.get(r.mint)||r.image)?<img key={images.get(r.mint)||r.image} src={images.get(r.mint)||r.image} alt="" loading="lazy" onError={e=>{e.currentTarget.hidden=true;e.currentTarget.parentNode.dataset.fallback=r.ticker.slice(0,1);}}/>:r.ticker.slice(0,1)}</div><div className="wallet-asset-info"><a href={r.listed?'https://xmr20.org/#inscription/'+r.id:'https://xmrchain.net/tx/'+r.deployment} target="_blank" rel="noopener noreferrer" title={r.name}>${r.ticker}</a><small>{formatAmount(r.amountRaw)} {r.ticker}{r.stale?' · last checked':''}</small></div><strong className="wallet-asset-usd" title={r.priceUsd?'Estimated USD value from recent market price':'Price unavailable'}>{formatUsd(r)}</strong>{actions&&<div className="wallet-asset-actions"><button onClick={()=>setAction({scope,id:r.id,row:r,kind:'send'})}>Send</button><button onClick={()=>openBridge(r)}>Bridge</button></div>}</article></div>)}{data.complete&&!data.rows.length&&!nativeMonero&&<p className="wallet-empty">No confirmed tokens on {network==='monero'?'Monero':'Solana'} yet.</p>}{!data.complete&&!refreshing&&<p className="wallet-index-note">Index update delayed · balances last checked</p>}</>}
 </section>;
}
