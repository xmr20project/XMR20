// Genuine compiled-program rehearsal of the Solana custody side in LiteSVM with
// signature verification ON. Reuses the reviewed xmr20_joint_escrow program from
// proof-of-concepts/joint-escrow-wallet/core-monero-send (operator-verified
// policy: fee-once deposit tag 10, operator redeem tag 14 with one receipt per
// nonce, zero-fee legacy migration tag 9) and the real XMR20 Token-2022 mint
// layout (150 bps transfer fee). VM finality is synthetic. Synthetic keys only.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Keypair,PublicKey} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID as TOKEN,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {fixture as baseFixture,execute,signed} from '../proof-of-concepts/joint-escrow-wallet/core-next/test-fixture.mjs';
import {transaction,creditCommitment,decodePosition} from '../proof-of-concepts/joint-escrow-wallet/core-transferable/sdk.mjs';
import {bridgePolicy,initializePolicy,bridgeInstruction,decodePolicy,decodeBridgeReceipt} from '../proof-of-concepts/joint-escrow-wallet/core-monero-send/bridge-sdk.mjs';
import {XCAT_MINT,XMR20_MINT} from '../proof-of-concepts/joint-escrow-wallet/core-next/mint-policy.mjs';
export const PROGRAM=new URL('../proof-of-concepts/joint-escrow-wallet/core-monero-send/target/sbpf-solana-solana/release/xmr20_joint_escrow.so',import.meta.url);
export const MINT_OBSERVATION=new URL('../../../operations/joint-activation-20261009/evidence/xmr20-mint-public-account.json',import.meta.url);
export const digest=x=>createHash('sha256').update(x).digest('hex');
export const tax=n=>(BigInt(n)*150n+9999n)/10000n;
export const net=n=>BigInt(n)-tax(n);
const u64=b=>Buffer.from(b).readBigUInt64LE(0).toString();
// layout 'xmr20': the real XMR20 Token-2022 mint account bytes (dated public
// observation). layout 'synthetic': the fixture's other observed mint (XCAT) so
// a second asset has a distinct mint, policy PDA, vault and reserve.
// This candidate: any XMR20-launched token. `mintAddress` (the token's REAL Solana mint identity, or a stand-in) and
// `decimals` create a synthetic Token-2022 mint at that address in the VM; the program, policy PDA, vault and reserve are
// derived from it exactly as for the two original layouts, so every catalog token gets its own custody state.
// Per-token FEE POLICY: the custody program takes the fee from the mint's own Token-2022 TransferFeeConfig extension (150 bps
// on the XMR20-launched mints that have it; 0 for mints without it). `mintData` (the token's real mint account bytes, read-only
// observation) therefore makes every deposit and redemption follow that token's actual policy; `feeBps` is decoded from it.
export function transferFeeBps(mintData){const d=Buffer.from(mintData);if(d.length<=166)return 0;let i=166;let bps=0;while(i+4<=d.length){const t=d.readUInt16LE(i),l=d.readUInt16LE(i+2);i+=4;if(t===1&&l>=108)bps=d.readUInt16LE(i+64+8+18+16);i+=l;}return bps;}
export function createBridge({legacyGross,layout='xmr20',mintAddress=null,decimals=null,mintData:observedMintData=null}){
 const binary=readFileSync(PROGRAM),mintData=observedMintData?Buffer.from(observedMintData,'base64'):layout==='xmr20'?Buffer.from(JSON.parse(readFileSync(MINT_OBSERVATION)).value.data[0],'base64'):undefined;
 const legacyHolder=Keypair.generate(),f=baseFixture(legacyHolder,{mintAddress:mintAddress||(layout==='xmr20'?XMR20_MINT:XCAT_MINT),programBinary:binary,mintData});
 if(decimals!==null&&layout!=='xmr20'){const addr=f.config.mint;const m=f.vm.getAccount(addr);const d=Buffer.from(m.data);d[44]=decimals;f.vm.setAccount({...m,address:addr,programAddress:TOKEN.toBase58(),data:d});}
 // The base fixture funds the legacy holder with exactly 1e9 units; a larger synthetic legacy position (several holders x
 // 10,000 units at 6 decimals) needs the holder's balance raised first (synthetic supply; setSupply() reconciles the mint).
 if(BigInt(legacyGross)>1_000_000_000n){const lata=getAssociatedTokenAddressSync(new PublicKey(f.config.mint),legacyHolder.publicKey,false,TOKEN);const acc=f.vm.getAccount(lata.toBase58());const d=Buffer.from(acc.data);d.writeBigUInt64LE(BigInt(legacyGross),64);f.vm.setAccount({...acc,address:lata.toBase58(),programAddress:TOKEN.toBase58(),data:d});}
 const accounts=[];// every token account this bridge created, for supply snapshots
 const operator=f.verifier,config={...f.config,abi:3,binding:digest('xmr20-migration-rehearsal legacy link')};
 const options={manifest:digest('xmr20-migration-rehearsal custody manifest'),signers:[operator.publicKey.toBase58()],mode:'operator-verified-v1'};
 const a=bridgePolicy(config,options),ok=r=>{if(!r.ok)throw Error(r.logs.join('\n'));return r;};
 const policy=()=>decodePolicy(f.vm.getAccount(a.policy.toBase58()).data);
 const tokenBalance=k=>{const x=f.vm.getAccount(k.toBase58());return x?.exists===false||!x?'0':u64(Buffer.from(x.data).subarray(64,72));};
 const state=()=>({reserve:policy().reserve,vault:tokenBalance(a.vault),locked:u64(Buffer.from(f.vm.getAccount(a.pool.toBase58()).data).subarray(97,105)),legacyPosition:f.vm.getAccount(a.position.toBase58())?.exists===false?'0':decodePosition(f.vm.getAccount(a.position.toBase58()).data).balance});
 // Legacy backing: a transferable position funded with the current 1.5% fee once.
 // legacyGross 0: a NEW token with no legacy position (private format by default).
 const registration=transaction(config,{network:config.network,operation:'register',commitment:digest('legacy link commitment'),blockhash:f.vm.latestBlockhash()});registration.sign([f.owner,operator]);ok(execute(f.vm,registration));
 const feeBps=mintData?transferFeeBps(mintData):150;const taxOf=n=>(BigInt(n)*BigInt(feeBps)+9999n)/10000n;const netOf=n=>BigInt(n)-taxOf(n);
 if(BigInt(legacyGross)>0n){const dep={network:config.network,operation:'deposit',amount:String(legacyGross),nonce:digest('legacy backing deposit'),expectedFee:taxOf(legacyGross).toString(),blockhash:f.vm.latestBlockhash()};dep.commitment=creditCommitment(config,dep);const d=transaction(config,dep);d.sign([f.owner]);ok(execute(f.vm,d));}
 ok(execute(f.vm,signed(f.vm,[initializePolicy(config,options)],f.owner,[f.owner,operator])));
 const legacyNet=BigInt(legacyGross)>0n?netOf(legacyGross).toString():'0';
 const receipts=[];
 function receipt(key){const x=f.vm.getAccount(key.toBase58());if(!x||x.exists===false)return null;const r=decodeBridgeReceipt(x.data);receipts.push(r);return r;}
 function fundHolder(amount){const k=Keypair.generate();f.vm.airdrop(k.publicKey.toBase58(),10_000_000_000n);const ata=getAssociatedTokenAddressSync(a.mint,k.publicKey,false,TOKEN);ok(execute(f.vm,signed(f.vm,[createAssociatedTokenAccountIdempotentInstruction(operator.publicKey,ata,k.publicKey,a.mint,TOKEN)],operator)));
  if(amount>0n){const acc=f.vm.getAccount(ata.toBase58()),data=Buffer.from(acc.data);data.writeBigUInt64LE(BigInt(amount),64);f.vm.setAccount({...acc,address:ata.toBase58(),programAddress:TOKEN.toBase58(),data});}
  accounts.push(ata);return {key:k,ata,address:k.publicKey.toBase58(),balance:()=>tokenBalance(ata)};}
 accounts.push(getAssociatedTokenAddressSync(a.mint,legacyHolder.publicKey,false,TOKEN));
 // Make the synthetic mint supply equal to what this VM actually issued so the
 // shipping reconcileSupply invariant is checkable (the observed mainnet supply
 // bytes are otherwise unrelated to these synthetic balances).
 function setSupply(){const total=[...accounts,a.vault].reduce((n,k)=>n+BigInt(tokenBalance(k))+withheldOf(k),0n);const m=f.vm.getAccount(a.mint.toBase58()),d=Buffer.from(m.data);d.writeBigUInt64LE(total,36);f.vm.setAccount({...m,address:a.mint.toBase58(),programAddress:TOKEN.toBase58(),data:d});return total.toString();}
 function withheldOf(k){const x=f.vm.getAccount(k.toBase58());if(!x||x.exists===false)return 0n;const d=Buffer.from(x.data);if(d.length<=165)return 0n;let at=166;while(at+4<=d.length){const type=d.readUInt16LE(at),len=d.readUInt16LE(at+2);if(type===2/*TransferFeeAmount*/)return d.readBigUInt64LE(at+4);at+=4+len;}return 0n;}
 function supplySnapshot(){const m=f.vm.getAccount(a.mint.toBase58());const mintSupply=Buffer.from(m.data).readBigUInt64LE(36).toString();const rows=accounts.map(k=>({address:k.toBase58(),amountRaw:tokenBalance(k)})).filter(r=>BigInt(r.amountRaw)>0n);const withheld=[...accounts,a.vault].reduce((n,k)=>n+withheldOf(k),0n);return {mintSupply,vaultBalance:tokenBalance(a.vault),lockedRaw:state().locked,solanaHolders:rows,withheldRaw:withheld.toString()};}
 return {feeBps,tax:taxOf,net:netOf,
  vm:f.vm,operator,config,options,addresses:a,state,legacyNet,legacyGross:String(legacyGross),receipts,fundHolder,tokenBalance,setSupply,supplySnapshot,layout,mint:a.mint.toBase58(),programHash:digest(binary),mintHash:mintData?digest(mintData):'fixture-xcat-observation',
  // Tag 9: the whole legacy position becomes operator reserve. Zero token fee.
  migrateLegacy(){if(legacyNet==='0')throw Error('No legacy position for this asset');const m=bridgeInstruction(config,options,{kind:'migrate',amount:legacyNet,nonce:digest('legacy migration'),binding:config.binding});const r=execute(f.vm,signed(f.vm,[m.instruction],f.owner,[f.owner,operator]));return {...r,receipt:r.ok?receipt(m.receipt):null};},
  // Tag 10: a holder deposits gross tokens; the vault receives net after one fee.
  deposit(holder,gross,nonce){const c={...config,owner:holder.address};const r=bridgeInstruction(c,options,{kind:'deposit',amount:String(gross),fee:taxOf(gross).toString(),nonce,binding:digest('deposit binding '+nonce)});const x=execute(f.vm,signed(f.vm,[r.instruction],holder.key));return {...x,nonce,receipt:x.ok?receipt(r.receipt):null,receiptAddress:r.receipt.toBase58()};},
  // Tag 14: operator pays gross from reserve to the destination; one receipt per nonce.
  redeem(destination,gross,nonce){const c={...config,owner:operator.publicKey.toBase58(),verifier:operator.publicKey.toBase58()};const r=bridgeInstruction(c,options,{kind:'redeem',amount:String(gross),fee:taxOf(gross).toString(),nonce,destination,signers:[operator.publicKey.toBase58()]});const x=execute(f.vm,signed(f.vm,[r.instruction],operator,[operator]));return {...x,nonce,receipt:x.ok?receipt(r.receipt):null,receiptAddress:r.receipt.toBase58()};},
  redemptionReceipt(nonce){const c={...config,owner:operator.publicKey.toBase58(),verifier:operator.publicKey.toBase58()};const r=bridgeInstruction(c,options,{kind:'redeem',amount:'1000',fee:'15',nonce,destination:operator.publicKey.toBase58(),signers:[operator.publicKey.toBase58()]});const x=f.vm.getAccount(r.receipt.toBase58());return x&&x.exists!==false?decodeBridgeReceipt(x.data):null;},
 };
}
