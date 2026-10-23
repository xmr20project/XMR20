import {moneroWalletVault} from './monero-wallet-vault.js';
import React,{useEffect,useRef,useState} from 'react';
import {createMoneroGenerator} from './monero-wallet-client.js';
import {localMoneroBackup} from './monero-local-backup.js';
import {checkMoneroAddress} from '../shared/xmr20/address.js';
import {saveNativeRestoreHeight} from './native-wallet-client.js';
export default function WalletImport({owner,provider,onImport,onClose}){
 const [mode,setMode]=useState('import'),[seed,setSeed]=useState(''),[address,setAddress]=useState(''),[height,setHeight]=useState(''),[backup,setBackup]=useState(false),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const client=useRef(null),alive=useRef(true),flight=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;client.current?.dispose();};},[]);
 async function submit(){if(flight.current)return;flight.current=true;setBusy(true);setError('');try{
  if(height!==''&&(!/^\d+$/.test(height)||!Number.isSafeInteger(Number(height))))throw Error('Enter a valid restore height, or 0.');
  let value=address.trim();
  if(mode==='import'){
   client.current=createMoneroGenerator();
   const result=await client.current.request('import',{network:'mainnet',seed:seed.trim(),...(value?{expectedAddress:value}:{})});
   if(!alive.current)return;value=result.address;
   if(!result.restored||result.network!=='mainnet')throw Error('Could not restore this wallet.');
   if(provider)await moneroWalletVault().save({owner,network:'mainnet',address:value},seed.trim().toLowerCase().replace(/\s+/g,' '),provider);
   if(backup)await localMoneroBackup().save({owner,network:'mainnet',address:value},seed.trim().toLowerCase().replace(/\s+/g,' '),password);
  }
  const valid=checkMoneroAddress(value,'mainnet');if(!valid.valid||valid.kind!=='standard')throw Error('Use a primary Monero mainnet address.');
  if(!alive.current)return;
  if(mode==='import'&&height!=='')saveNativeRestoreHeight(value,Number(height));
  await onImport({address:value,kind:mode==='import'?'imported':'watch'});
  if(alive.current){setSeed('');setPassword('');onClose();}
 }catch{if(alive.current)setError('Could not import this wallet. Check the 25-word Monero phrase, expected address and backup password, or use a valid primary address to view holdings. Your existing wallet is unchanged.');}finally{client.current?.dispose();client.current=null;flight.current=false;if(alive.current)setBusy(false);}}
 return <section className="wallet-import" aria-label="Import Monero wallet"><h3>Import XMR wallet</h3><label>Import method<select disabled={busy} value={mode} onChange={e=>{setMode(e.target.value);setSeed('');setPassword('');setError('');}}><option value="import">Restore with 25-word Monero phrase</option><option value="watch">View holdings with a public address</option></select></label>
 {mode==='import'&&<><p className="small">Your phrase is checked on this device in an offline worker. It is never sent to the index or a remote node. Your connected Solana wallet saves an encrypted copy on this device, so future sends need wallet approval rather than these words.</p><label>25-word Monero recovery phrase<input type="password" autoComplete="off" spellCheck={false} maxLength={400} disabled={busy} value={seed} onChange={e=>setSeed(e.target.value)}/></label></>}
 <label>{mode==='import'?'Expected primary address (optional)':'Monero primary address'}<input autoComplete="off" spellCheck={false} maxLength={106} disabled={busy} value={address} onChange={e=>setAddress(e.target.value.trim())}/></label>
 {mode==='import'?<><details><summary>Advanced scan settings</summary><label>Restore height (optional)<input inputMode="numeric" placeholder="Automatic" disabled={busy} value={height} onChange={e=>setHeight(e.target.value)}/></label><p className="small">Leave blank to use this device’s saved height. If none is saved, the full history is scanned.</p></details><label><input type="checkbox" disabled={busy} checked={backup} onChange={e=>{setBackup(e.target.checked);setPassword('');}}/> Save an encrypted backup on this device (optional)</label>{backup&&<label>Backup password (at least 12 characters)<input type="password" autoComplete="new-password" minLength={12} maxLength={256} disabled={busy} value={password} onChange={e=>setPassword(e.target.value)}/></label>}<p className="small">Only 25-word Monero phrases are supported here. For other wallet formats, view holdings by address and keep using your original wallet for signing.</p></>:<p className="small">Address-only viewing shows public XMR20 holdings. It does not prove ownership, allow spending or reveal native XMR balances.</p>}
 <button disabled={busy||(mode==='import'?seed.trim().split(/\s+/).length!==25||backup&&password.length<12:!address)} onClick={submit}>{busy?'Checking on your device…':mode==='import'?'Import wallet':'View holdings'}</button> <button disabled={busy} onClick={onClose}>Cancel</button>{error&&<p role="alert">{error}</p>}</section>;
}
