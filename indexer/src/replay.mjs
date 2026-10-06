import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {checkMoneroAddress} from './address.js';
const CONFIRMATIONS=10,SUPPLY=1000000000000000n,CAP=1000000000000000n;
const hash=v=>createHash('sha256').update(v).digest('hex');
const solAddress=v=>{try{const key=new PublicKey(v);return key.toBase58()===v&&PublicKey.isOnCurve(key.toBytes());}catch{return false;}};
// Display provenance only, rebuilt alongside accepted canonical ledger events.
// An incoming receipt is not a claim that one transaction explains the balance.
function rememberIncoming(token,event){
 const r=event.envelope.record;
 if(!/^[a-f0-9]{64}$/.test(event.txid)||!Number.isSafeInteger(event.height)||event.height<0)return;
 token.incomingTxids.add(event.txid);
 token.lastIncoming.set(r.to,{txid:event.txid,operation:r.op,amountRaw:r.amount,height:event.height,confirmations:event.confirmations});
}
export function moneroHolderRows(token){
 return [...token.balances].filter(([,n])=>n>0n).map(([address,n])=>({address,amountRaw:n.toString(),...(token.lastIncoming?.has(address)?{lastIncoming:{...token.lastIncoming.get(address)}}:{})}));
}
const LEGACY_V2_MINT='8zWcEgUZvQKcHgtUoYTnaC6AHX7FmtWVV9WeM4kPuXMR';
export async function boundMainnetDeployment(record,{launchByMint=null,v3ProgramId=null}={}){
  if(!launchByMint)return record;
  const saved=await launchByMint(record.mint);
  if(saved?.bridgeVersion===3||saved?.escrowPolicy==='platform-auto-v3'){
    if(!v3ProgramId||saved.bridgeVersion!==3||saved.bridgeProgramId!==v3ProgramId||saved.escrowPolicy!=='platform-auto-v3'||saved.transferTaxBps!==150||saved.platformFeeBps!==0||saved.mint!==record.mint||saved.owner!==record.creator||saved.ticker!==record.tick||saved.moneroTxid!==record.txid||saved.solanaFinalized!==true||saved.bridgeReady!==true)throw Error('Future-token V3 inscription is not bound to its verified escrow.');
    return {...record,bridgeVersion:3,bridgeProgramId:v3ProgramId,escrowPolicy:'platform-auto-v3'};
  }
  if(v3ProgramId&&record.fee==='150'&&record.mint!==LEGACY_V2_MINT&&!saved)throw Error('Unbound 150 bps token cannot enter the V3-era Monero ledger.');
  return record;
}
export async function replayMainnetEvents(events,{operatorAddress,network,solana,abandonedLaunches=[],transferStartHeight=null,launchByMint=null,v3ProgramId=null}) {
      const tokens=new Map(),tickers=new Set(),mints=new Set(),nonces=new Set(),deposits=new Set(),credits=new Set(),burns=new Map(),transfers=new Map();
      for(const event of events){
        const r=event.envelope.record,nonce=r.owner+':'+r.nonce;
        if(r.p!=='xmr20'||r.net!=='mainnet'||!(r.v===1||(r.v===2&&r.op==='deploy'))||event.confirmations<CONFIRMATIONS||nonces.has(nonce))continue;
        if(r.op==='deploy'){
          if(abandonedLaunches.some(x=>x.txid===event.txid&&x.mint===r.mint&&x.ticker===r.tick))continue;
          if(r.owner!==operatorAddress||r.chain!==(r.v===2&&network==='mainnet-beta'?'mainnet':network)||r.initial!=='0'||r.max!==SUPPLY.toString()||(r.v===1&&tickers.has(r.tick))||mints.has(r.mint)||!solAddress(r.mint)||!solAddress(r.creator))continue;
          tokens.set(event.txid,{record:{...r,txid:event.txid},balances:new Map(),outstanding:0n,lastIncoming:new Map(),incomingTxids:new Set()});tickers.add(r.tick);mints.add(r.mint);
        }else{
          const token=tokens.get(r.token);if(!token)continue;
          const n=BigInt(r.amount);if(n<=0n||n>50_000_000_000_000n)continue;
          if(r.op==='credit'){
            if(r.owner!==operatorAddress||deposits.has(r.deposit))continue;
            const address=checkMoneroAddress(r.to,'mainnet');if(!address.valid||address.kind!=='standard')continue;
            // This reads the finalized account owned by the pinned escrow
            // program. Operator signatures alone cannot invent XMR20 backing.
            const deployment=await boundMainnetDeployment(token.record,{launchByMint,v3ProgramId});
            const receipt=await solana.depositReceipt(deployment,r.deposit);
            if(!receipt||receipt.kind!=='deposit'||receipt.amountRaw!==r.amount||receipt.recipientHash!==hash(r.to))continue;
            if(token.outstanding+n>SUPPLY)throw Error('Monero outstanding supply exceeds the fixed supply.');
            token.balances.set(r.to,(token.balances.get(r.to)||0n)+n);token.outstanding+=n;deposits.add(r.deposit);credits.add(event.txid);
            rememberIncoming(token,event);
          }else if(r.op==='transfer'){
            if(!Number.isSafeInteger(transferStartHeight)||!Number.isSafeInteger(event.height)||event.height<transferStartHeight)continue;
            const from=checkMoneroAddress(r.owner,'mainnet'),to=checkMoneroAddress(r.to,'mainnet');
            if(!from.valid||from.kind!=='standard'||!to.valid||to.kind!=='standard'||r.owner===r.to||(token.balances.get(r.owner)||0n)<n)continue;
            token.balances.set(r.owner,token.balances.get(r.owner)-n);
            token.balances.set(r.to,(token.balances.get(r.to)||0n)+n);
            rememberIncoming(token,event);
            transfers.set(event.txid,{...r,txid:event.txid,confirmations:event.confirmations});
          }else if(r.op==='burn'){
            if(!solAddress(r.to)||(token.balances.get(r.owner)||0n)<n)continue;
            token.balances.set(r.owner,token.balances.get(r.owner)-n);token.outstanding-=n;burns.set(event.txid,{...r,txid:event.txid,confirmations:event.confirmations});
          }else continue;
        }
        nonces.add(nonce);
      }
      return {tokens,burns,credits,transfers};
}
export function reconcileSupply({mintSupply,vaultBalance,lockedRaw,moneroOutstanding,solanaHolders,moneroHolders,withheldRaw=0n}) {
 const withheld=BigInt(withheldRaw);if(withheld<0n)throw Error('Invalid withheld fees.');
 const supply=BigInt(mintSupply),vault=BigInt(vaultBalance),locked=BigInt(lockedRaw),xmr=BigInt(moneroOutstanding);
 if(supply<0n||supply>CAP||vault<0n||vault>supply||locked<0n||locked>vault||xmr<0n||xmr>locked)throw Error('Inconsistent bridge backing.');
 const sum=rows=>rows.reduce((n,r)=>{const v=BigInt(r.amountRaw);if(v<=0n)throw Error('Invalid holder balance.');return n+v;},0n);
 if(sum(solanaHolders)+withheld!==supply-vault||sum(moneroHolders)!==xmr)throw Error('Incomplete holder snapshot.');
 const holders=[...solanaHolders.map(r=>({...r,network:'solana'})),...moneroHolders.map(r=>({...r,network:'monero',kind:'XMR20 address'}))]
  .sort((a,b)=>BigInt(a.amountRaw)===BigInt(b.amountRaw)?a.address.localeCompare(b.address):BigInt(a.amountRaw)>BigInt(b.amountRaw)?-1:1)
  .map(r=>({...r,percentage:supply?Number(BigInt(r.amountRaw)*1_000_000n/supply)/10000:0}));
 return {withheldTaxRaw:withheld.toString(),capRaw:CAP.toString(),currentSupplyRaw:supply.toString(),solanaRaw:(supply-vault).toString(),moneroRaw:xmr.toString(),inTransitRaw:(locked-xmr).toString(),unassignedEscrowRaw:(vault-locked).toString(),escrowRaw:vault.toString(),burnedRaw:(CAP-supply).toString(),holders};
}
